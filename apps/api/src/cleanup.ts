import { FileStatus, ShareStatus, StorageNodeStatus, StoragePolicy, type PrismaClient } from "@prisma/client";
import { AgentStorageDriver } from "@wangpan/storage-driver";
import { deleteReplicasForFile, backfillImportantReplicas, refreshNodeStatus } from "./replication.js";

const ORPHAN_SWEEP_INTERVAL_MS = 60 * 60 * 1000; // run orphan sweep at most every hour
let lastOrphanSweepAt = 0;

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
