ALTER TYPE "FileStatus" ADD VALUE IF NOT EXISTS 'trashed';

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "disabledAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "AccessLog_actorId_createdAt_idx" ON "AccessLog"("actorId", "createdAt");
CREATE INDEX IF NOT EXISTS "AccessLog_action_createdAt_idx" ON "AccessLog"("action", "createdAt");
CREATE INDEX IF NOT EXISTS "AccessLog_result_createdAt_idx" ON "AccessLog"("result", "createdAt");
