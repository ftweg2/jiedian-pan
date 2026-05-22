import { StorageNodeStatus, type PrismaClient } from "@prisma/client";

/**
 * Periodically probes each non-disabled storage node by hitting its
 * /health endpoint, recording latency + ok/fail, so we can show real-time
 * uptime/ping dashboards per node.
 *
 * Probe interval: 30s.
 * Retention: 30 days (older rows pruned hourly).
 */

const PROBE_INTERVAL_MS = 30_000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000; // hourly
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const HEALTH_TIMEOUT_MS = 5_000;

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
      where: { status: { not: StorageNodeStatus.DISABLED } },
      select: { id: true, baseUrl: true, agentToken: true }
    });
    // Probe all nodes in parallel.
    await Promise.all(nodes.map((node) => probeOne(prisma, node)));
  } catch (err) {
    console.error("node prober round failed", err);
  }
}

async function probeOne(
  prisma: PrismaClient,
  node: { id: string; baseUrl: string; agentToken: string }
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
