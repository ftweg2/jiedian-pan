import { ReplicaStatus, StorageNodeStatus, type PrismaClient } from "@prisma/client";
import { backfillImportantReplicas } from "./replication.js";

/**
 * Periodically probes each non-disabled storage node by hitting its
 * /health endpoint, recording latency + ok/fail, so we can show real-time
 * uptime/ping dashboards per node.
 *
 * Probe interval: 30s.
 * Retention: 30 days (older rows pruned hourly).
 *
 * Lost-node detection:
 *   - Each failed probe increments StorageNode.consecutiveProbeFailures.
 *   - On success, the counter resets to 0.
 *   - If the counter crosses NODE_LOST_PROBE_THRESHOLD (default 10 ≈ 5 min at
 *     30s interval), the node is flipped to LOST and all its live replicas
 *     are marked MISSING. backfillImportantReplicas is kicked to start
 *     restoring redundancy on the remaining nodes.
 */

const PROBE_INTERVAL_MS = 30_000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000; // hourly
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const HEALTH_TIMEOUT_MS = 5_000;

const NODE_LOST_PROBE_THRESHOLD = Math.max(
  1,
  Math.min(1000, Number(process.env.NODE_LOST_PROBE_THRESHOLD ?? 10))
);

let probeTimer: ReturnType<typeof setInterval> | null = null;
let pruneTimer: ReturnType<typeof setInterval> | null = null;

export function startNodeProber(prisma: PrismaClient): void {
  if (probeTimer) return;
  // Fire one probe round immediately on startup so the dashboard isn't empty.
  void runProbeRound(prisma);
  probeTimer = setInterval(() => { void runProbeRound(prisma); }, PROBE_INTERVAL_MS);
  pruneTimer = setInterval(() => { void prune(prisma); }, PRUNE_INTERVAL_MS);
  // Don't keep the event loop alive just for the prober.
  probeTimer.unref?.();
  pruneTimer.unref?.();
}

export function stopNodeProber(): void {
  if (probeTimer) { clearInterval(probeTimer); probeTimer = null; }
  if (pruneTimer) { clearInterval(pruneTimer); pruneTimer = null; }
}

async function runProbeRound(prisma: PrismaClient): Promise<void> {
  try {
    const nodes = await prisma.storageNode.findMany({
      // Skip DISABLED (admin tombstone) and LOST (already declared — no point
      // probing again until admin restores). Other states get probed.
      where: { status: { notIn: [StorageNodeStatus.DISABLED, StorageNodeStatus.LOST] } },
      select: { id: true, name: true, baseUrl: true, agentToken: true, status: true, consecutiveProbeFailures: true }
    });
    // Probe all nodes in parallel.
    await Promise.all(nodes.map((node) => probeOne(prisma, node)));
  } catch (err) {
    console.error("node prober round failed", err);
  }
}

async function probeOne(
  prisma: PrismaClient,
  node: { id: string; name: string; baseUrl: string; agentToken: string; status: StorageNodeStatus; consecutiveProbeFailures: number }
): Promise<void> {
  const start = performance.now();
  let ok = false;
  let error: string | null = null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    try {
      const response = await fetch(`${node.baseUrl.replace(/\/+$/, "")}/health`, {
        method: "GET",
        signal: controller.signal
      });
      ok = response.ok;
      if (!ok) error = `HTTP ${response.status}`;
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    error = err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);
  }
  const latencyMs = Math.round(performance.now() - start);

  await prisma.nodeProbe.create({
    data: { nodeId: node.id, ok, latencyMs, error }
  }).catch(() => undefined);

  if (ok) {
    // Successful probe — reset the failure counter if it was non-zero. Don't
    // touch node.status here; refreshNodeStatus (called from the maintenance
    // tick) owns the ACTIVE/DEGRADED/OFFLINE transitions.
    if (node.consecutiveProbeFailures > 0) {
      await prisma.storageNode.update({
        where: { id: node.id },
        data: { consecutiveProbeFailures: 0 }
      }).catch(() => undefined);
    }
    return;
  }

  // Failed probe — increment the counter and maybe declare LOST.
  const nextCount = node.consecutiveProbeFailures + 1;
  await prisma.storageNode.update({
    where: { id: node.id },
    data: { consecutiveProbeFailures: nextCount }
  }).catch(() => undefined);

  if (nextCount >= NODE_LOST_PROBE_THRESHOLD && node.status !== StorageNodeStatus.LOST) {
    console.warn(
      `node-prober: ${node.name} failed ${nextCount} consecutive probes — declaring LOST`
    );
    await declareNodeLost(prisma, node.id, "automatic: probe threshold exceeded");
  }
}

/**
 * Mark a node as LOST and trigger self-heal.
 *
 * IMPORTANT: We do NOT pre-mark every replica MISSING — that would prevent
 * backfill from reading off the node if it's still briefly reachable (the
 * common case when an admin clicks "declare lost" preemptively, before the
 * VPS is actually gone). Instead:
 *
 *   1. Flip node status to LOST (so it's excluded from new writes).
 *   2. Set lostDeclaredAt so the UI can show "lost N minutes ago".
 *   3. Kick a self-heal pass: it tries to re-replicate each chunk/object
 *      using a healthy sibling as source — and falls back to reading from
 *      the LOST node itself as a best-effort last resort.
 *   4. After heal: backfillImportantReplicas internally marks replicas
 *      MISSING for chunks that no longer have any reachable copy.
 *
 * Safe to call multiple times — second call is a no-op if already LOST.
 */
export async function declareNodeLost(
  prisma: PrismaClient,
  nodeId: string,
  reason: string
): Promise<{ alreadyLost: boolean; replicasOnNode: number }> {
  const node = await prisma.storageNode.findUnique({ where: { id: nodeId } });
  if (!node) {
    throw new Error(`node ${nodeId} not found`);
  }
  if (node.status === StorageNodeStatus.LOST) {
    return { alreadyLost: true, replicasOnNode: 0 };
  }

  // Snapshot replica counts on the node so the response can show admin "I just
  // declared lost, this affects N replicas". Cheap; doesn't block heal.
  const [chunkCount, objectCount] = await Promise.all([
    prisma.chunkReplica.count({ where: { nodeId, status: { not: ReplicaStatus.DELETED } } }),
    prisma.objectReplica.count({ where: { nodeId, status: { not: ReplicaStatus.DELETED } } })
  ]);

  await prisma.storageNode.update({
    where: { id: nodeId },
    data: {
      status: StorageNodeStatus.LOST,
      lostDeclaredAt: new Date()
    }
  });

  console.warn(
    `node-prober: ${node.name} declared LOST (${reason}); ` +
    `${chunkCount} chunk + ${objectCount} whole replicas affected; self-heal starting`
  );

  // Kick a self-heal pass in the background. It will:
  //  - For each under-replicated chunk: copy from any reachable source
  //    (including the LOST node itself, best-effort) to a healthy target
  //  - Mark replicas MISSING for chunks where no source is reachable
  // We don't await it so the API request returns immediately.
  backfillImportantReplicas(prisma).catch((err) => {
    console.error("self-heal after declareNodeLost failed", err);
  });

  return {
    alreadyLost: false,
    replicasOnNode: chunkCount + objectCount
  };
}

async function prune(prisma: PrismaClient): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - RETENTION_MS);
    const result = await prisma.nodeProbe.deleteMany({
      where: { observedAt: { lt: cutoff } }
    });
    if (result.count > 0) {
      console.info(`node prober: pruned ${result.count} probes older than 30 days`);
    }
  } catch (err) {
    console.error("node prober prune failed", err);
  }
}
