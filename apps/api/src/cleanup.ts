import { randomUUID } from "node:crypto";
import { FileStatus, ReplicaStatus, ShareStatus, StorageNodeStatus, StoragePolicy, type PrismaClient } from "@prisma/client";
import { AgentStorageDriver } from "@wangpan/storage-driver";
import { deleteReplicasForFile, backfillImportantReplicas, refreshNodeStatus } from "./replication.js";

const ORPHAN_SWEEP_INTERVAL_MS = 60 * 60 * 1000; // run orphan sweep at most every hour
let lastOrphanSweepAt = 0;

const DECOMMISSION_CHUNKS_PER_TICK = Math.max(
  1,
  Math.min(500, Number(process.env.DECOMMISSION_CHUNKS_PER_TICK ?? 50))
);

export function startBackgroundJobs(prisma: PrismaClient, intervalMs = 60_000): NodeJS.Timeout {
  const timer = setInterval(() => {
    runMaintenance(prisma).catch((error) => {
      console.error("maintenance job failed", error);
    });
  }, intervalMs);
  timer.unref();
  return timer;
}

export async function runMaintenance(prisma: PrismaClient): Promise<void> {
  const now = new Date();
  await prisma.shareLink.updateMany({
    where: { status: ShareStatus.ACTIVE, expiresAt: { lte: now } },
    data: { status: ShareStatus.EXPIRED }
  });

  const expiredTemporaryFiles = await prisma.file.findMany({
    where: {
      status: FileStatus.ACTIVE,
      expiresAt: { lte: now },
      OR: [
        { policyOverride: StoragePolicy.TEMPORARY },
        { policyOverride: null, folder: { defaultPolicy: StoragePolicy.TEMPORARY } }
      ]
    },
    select: { id: true }
  });

  for (const file of expiredTemporaryFiles) {
    await deleteReplicasForFile(prisma, file.id);
    await prisma.file.update({
      where: { id: file.id },
      data: { status: FileStatus.DELETED }
    });
  }

  await refreshStorageNodes(prisma);
  await backfillImportantReplicas(prisma);

  // Drain any node in DECOMMISSIONING state: migrate up to N chunks per tick.
  await drainDecommissioningNodes(prisma).catch((error) => {
    console.error("decommission drain failed", error);
  });

  // Sweep orphan chunk-upload objects at most once an hour. Cleans up bytes
  // left on storage agents when the API process crashed mid-upload (in-memory
  // session lost) or when /chunk PUT failed without an explicit abort.
  if (Date.now() - lastOrphanSweepAt > ORPHAN_SWEEP_INTERVAL_MS) {
    lastOrphanSweepAt = Date.now();
    sweepOrphanChunkUploads(prisma).catch((error) => {
      console.error("orphan sweep failed", error);
    });
  }
}

async function drainDecommissioningNodes(prisma: PrismaClient): Promise<void> {
  const draining = await prisma.storageNode.findMany({
    where: { status: StorageNodeStatus.DECOMMISSIONING }
  });
  for (const node of draining) {
    await drainOneNode(prisma, node);
  }
}

async function drainOneNode(
  prisma: PrismaClient,
  node: { id: string; name: string; baseUrl: string; agentToken: string }
): Promise<void> {
  const targets = await prisma.storageNode.findMany({
    where: {
      id: { not: node.id },
      status: { in: [StorageNodeStatus.ACTIVE, StorageNodeStatus.DEGRADED] }
    },
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }]
  });
  if (targets.length === 0) {
    console.warn(`drain ${node.name}: no other active nodes — pausing migration`);
    return;
  }

  const sourceDriver = new AgentStorageDriver({ baseUrl: node.baseUrl, token: node.agentToken });

  // Pull a batch of live chunkReplicas + objectReplicas to migrate.
  const chunkReplicas = await prisma.chunkReplica.findMany({
    where: { nodeId: node.id, status: { not: ReplicaStatus.DELETED } },
    include: { chunk: { include: { replicas: true } } },
    take: DECOMMISSION_CHUNKS_PER_TICK
  });
  for (const replica of chunkReplicas) {
    await migrateChunkReplica(prisma, sourceDriver, replica, targets);
  }

  const objectReplicas = await prisma.objectReplica.findMany({
    where: { nodeId: node.id, status: { not: ReplicaStatus.DELETED } },
    include: { version: { include: { replicas: true } } },
    take: DECOMMISSION_CHUNKS_PER_TICK
  });
  for (const replica of objectReplicas) {
    await migrateWholeReplica(prisma, sourceDriver, replica, targets);
  }

  // If totally drained, auto-flip to DISABLED so admin can remove the node.
  const [chunkLeft, wholeLeft] = await Promise.all([
    prisma.chunkReplica.count({ where: { nodeId: node.id, status: { not: ReplicaStatus.DELETED } } }),
    prisma.objectReplica.count({ where: { nodeId: node.id, status: { not: ReplicaStatus.DELETED } } })
  ]);
  if (chunkLeft + wholeLeft === 0) {
    await prisma.storageNode.update({
      where: { id: node.id },
      data: { status: StorageNodeStatus.DISABLED }
    });
    console.info(`drain ${node.name}: complete, flipped to DISABLED`);
  }
}

async function migrateChunkReplica(
  prisma: PrismaClient,
  sourceDriver: AgentStorageDriver,
  replica: { id: string; nodeId: string; objectId: string; ciphertextSha256: string;
             chunk: { id: string; ciphertextSizeBytes: bigint; replicas: Array<{ id: string; nodeId: string; status: ReplicaStatus }> } },
  targets: Array<{ id: string; name: string; baseUrl: string; agentToken: string; freeBytes: bigint | null }>
): Promise<void> {
  // Does the chunk have another live replica on a non-source, non-decommissioning node?
  const hasOtherLiveReplica = replica.chunk.replicas.some(
    (r) => r.id !== replica.id && r.status === ReplicaStatus.AVAILABLE && r.nodeId !== replica.nodeId
  );
  if (hasOtherLiveReplica) {
    // No copy needed — just remove this replica.
    await deleteAndMarkChunkReplica(prisma, sourceDriver, replica);
    return;
  }
  // Need to copy first.
  const sizeBytes = Number(replica.chunk.ciphertextSizeBytes);
  const target = targets.find((t) => Number(t.freeBytes ?? 0n) >= sizeBytes);
  if (!target) {
    console.warn(`drain: no target with capacity for chunk replica ${replica.id} (${sizeBytes}B)`);
    return;
  }
  // Read ciphertext from source agent.
  let buffer: Buffer;
  try {
    const stream = await sourceDriver.getObject(replica.objectId);
    buffer = await collectStream(stream);
  } catch (err) {
    console.warn(`drain: cannot read ${replica.objectId} from source:`, err);
    return;
  }
  // Write to target agent under new objectId.
  const targetDriver = new AgentStorageDriver({ baseUrl: target.baseUrl, token: target.agentToken });
  const newObjectId = `chunk:${replica.chunk.id}:${target.id}:${randomUUID()}`;
  try {
    await targetDriver.putObject({
      objectId: newObjectId,
      body: buffer,
      ciphertextSha256: replica.ciphertextSha256,
      sizeBytes
    });
  } catch (err) {
    console.warn(`drain: cannot write ${newObjectId} to target:`, err);
    return;
  }
  // Record new replica + delete old.
  try {
    await prisma.chunkReplica.create({
      data: {
        chunkId: replica.chunk.id,
        nodeId: target.id,
        objectId: newObjectId,
        ciphertextSha256: replica.ciphertextSha256,
        status: ReplicaStatus.AVAILABLE,
        verifiedAt: new Date()
      }
    });
  } catch (err) {
    // Rollback the agent-side write so we don't leak.
    await targetDriver.deleteObject(newObjectId).catch(() => undefined);
    console.warn(`drain: failed to record new chunk replica:`, err);
    return;
  }
  await deleteAndMarkChunkReplica(prisma, sourceDriver, replica);
}

async function deleteAndMarkChunkReplica(
  prisma: PrismaClient,
  sourceDriver: AgentStorageDriver,
  replica: { id: string; objectId: string }
): Promise<void> {
  try {
    await sourceDriver.deleteObject(replica.objectId);
  } catch (err) {
    // Even if the delete fails, mark the replica DELETED in DB so we don't
    // try to migrate it again. The orphan sweep will reclaim the bytes later.
    console.warn(`drain: source delete of ${replica.objectId} failed, marking row deleted anyway:`, err);
  }
  await prisma.chunkReplica.update({
    where: { id: replica.id },
    data: { status: ReplicaStatus.DELETED }
  });
}

async function migrateWholeReplica(
  prisma: PrismaClient,
  sourceDriver: AgentStorageDriver,
  replica: { id: string; nodeId: string; objectId: string; ciphertextSha256: string; versionId: string;
             version: { id: string; sizeBytes: bigint; replicas: Array<{ id: string; nodeId: string; status: ReplicaStatus }> } },
  targets: Array<{ id: string; name: string; baseUrl: string; agentToken: string; freeBytes: bigint | null }>
): Promise<void> {
  const hasOtherLiveReplica = replica.version.replicas.some(
    (r) => r.id !== replica.id && r.status === ReplicaStatus.AVAILABLE && r.nodeId !== replica.nodeId
  );
  if (hasOtherLiveReplica) {
    try { await sourceDriver.deleteObject(replica.objectId); } catch { /* tolerate */ }
    await prisma.objectReplica.update({ where: { id: replica.id }, data: { status: ReplicaStatus.DELETED } });
    return;
  }
  const sizeBytes = Number(replica.version.sizeBytes);
  const target = targets.find((t) => Number(t.freeBytes ?? 0n) >= sizeBytes);
  if (!target) {
    console.warn(`drain: no target with capacity for whole-file replica ${replica.id}`);
    return;
  }
  let buffer: Buffer;
  try {
    const stream = await sourceDriver.getObject(replica.objectId);
    buffer = await collectStream(stream);
  } catch (err) {
    console.warn(`drain: cannot read ${replica.objectId} (whole) from source:`, err);
    return;
  }
  const targetDriver = new AgentStorageDriver({ baseUrl: target.baseUrl, token: target.agentToken });
  const newObjectId = `version:${replica.versionId}:${target.id}:${randomUUID()}`;
  try {
    await targetDriver.putObject({
      objectId: newObjectId,
      body: buffer,
      ciphertextSha256: replica.ciphertextSha256,
      sizeBytes
    });
    await prisma.objectReplica.create({
      data: {
        versionId: replica.versionId,
        nodeId: target.id,
        objectId: newObjectId,
        ciphertextSha256: replica.ciphertextSha256,
        status: ReplicaStatus.AVAILABLE,
        verifiedAt: new Date()
      }
    });
  } catch (err) {
    await targetDriver.deleteObject(newObjectId).catch(() => undefined);
    console.warn(`drain: failed to migrate whole replica:`, err);
    return;
  }
  try { await sourceDriver.deleteObject(replica.objectId); } catch { /* tolerate */ }
  await prisma.objectReplica.update({ where: { id: replica.id }, data: { status: ReplicaStatus.DELETED } });
}

async function collectStream(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function sweepOrphanChunkUploads(prisma: PrismaClient): Promise<void> {
  const nodes = await prisma.storageNode.findMany({
    where: { status: { in: [StorageNodeStatus.ACTIVE, StorageNodeStatus.DEGRADED] } }
  });
  for (const node of nodes) {
    const driver = new AgentStorageDriver({ baseUrl: node.baseUrl, token: node.agentToken });
    let candidates: Array<{ objectId: string; sizeBytes: number; ageSeconds: number }>;
    try {
      // Only consider objects older than 2 hours (matches in-memory session TTL + headroom).
      candidates = await driver.listObjects({
        prefix: "chunk-upload:",
        olderThanSeconds: 7200,
        limit: 5000
      });
    } catch (error) {
      console.warn(`orphan sweep: list failed on node ${node.name}`, error);
      continue;
    }
    if (candidates.length === 0) continue;

    const known = await prisma.chunkReplica.findMany({
      where: { nodeId: node.id, objectId: { in: candidates.map((c) => c.objectId) } },
      select: { objectId: true }
    });
    const knownSet = new Set(known.map((r) => r.objectId));
    let purged = 0;
    let purgedBytes = 0;
    for (const obj of candidates) {
      if (knownSet.has(obj.objectId)) continue;
      try {
        await driver.deleteObject(obj.objectId);
        purged += 1;
        purgedBytes += obj.sizeBytes;
      } catch (error) {
        console.warn(`orphan sweep: delete failed for ${obj.objectId}`, error);
      }
    }
    if (purged > 0) {
      console.info(`orphan sweep: deleted ${purged} orphans (${purgedBytes} bytes) from ${node.name}`);
    }
  }
}

async function refreshStorageNodes(prisma: PrismaClient): Promise<void> {
  const nodes = await prisma.storageNode.findMany({
    where: { status: { not: StorageNodeStatus.DISABLED } }
  });

  for (const node of nodes) {
    try {
      await refreshNodeStatus(prisma, node);
    } catch {
      await prisma.storageNode.update({
        where: { id: node.id },
        data: { status: StorageNodeStatus.OFFLINE }
      });
    }
  }
}
