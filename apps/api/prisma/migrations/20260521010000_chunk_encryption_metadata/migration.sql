ALTER TABLE "FileChunk" ADD COLUMN "encryptionNonce" TEXT;
ALTER TABLE "FileChunk" ADD COLUMN "encryptionAuthTag" TEXT;
