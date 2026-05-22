-- Add LOST status to StorageNodeStatus enum. Placed before DISABLED, after
-- DECOMMISSIONING, matching the order in the Prisma schema (cosmetic; PG
-- internally just appends).
ALTER TYPE "StorageNodeStatus" ADD VALUE IF NOT EXISTS 'lost' BEFORE 'disabled';

-- Track consecutive failed probes so the prober can declare LOST when the
-- count crosses NODE_LOST_PROBE_THRESHOLD. Reset to 0 on any successful probe.
ALTER TABLE "StorageNode"
  ADD COLUMN IF NOT EXISTS "consecutiveProbeFailures" INTEGER NOT NULL DEFAULT 0;

-- When did the node enter LOST state — useful for UI ("lost 3h ago") and for
-- deciding whether a /restore is allowed without manual confirmation.
ALTER TABLE "StorageNode"
  ADD COLUMN IF NOT EXISTS "lostDeclaredAt" TIMESTAMP(3);
