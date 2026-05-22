-- Enforce that every ShareLink references exactly one of file or folder.
-- Catches data corruption / app bugs (both null or both set) at the DB layer.
ALTER TABLE "ShareLink" ADD CONSTRAINT "ShareLink_target_xor"
  CHECK ((("fileId" IS NOT NULL)::int + ("folderId" IS NOT NULL)::int) = 1);
