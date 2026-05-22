-- Store the raw share token, encrypted with APP_MASTER_KEY, so the owner can
-- look up an existing share's URL after the create-time UI has been closed.
-- Nullable: pre-existing shares have no envelope and can only be revoked+recreated.
ALTER TABLE "ShareLink" ADD COLUMN "tokenEncrypted" TEXT;
