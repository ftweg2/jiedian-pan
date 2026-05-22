CREATE TYPE "FileVersionStorageLayout" AS ENUM ('whole', 'chunked');

ALTER TABLE "FileVersion"
  ADD COLUMN "storageLayout" "FileVersionStorageLayout" NOT NULL DEFAULT 'whole',
  ADD COLUMN "chunkSizeBytes" BIGINT,
  ADD COLUMN "chunkCount" INTEGER;

CREATE TABLE "FileChunk" (
  "id" TEXT NOT NULL,
  "versionId" TEXT NOT NULL,
  "index" INTEGER NOT NULL,
  "plaintextSizeBytes" BIGINT NOT NULL,
  "ciphertextSizeBytes" BIGINT NOT NULL,
  "plaintextSha256" TEXT NOT NULL,
  "ciphertextSha256" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FileChunk_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ChunkReplica" (
  "id" TEXT NOT NULL,
  "chunkId" TEXT NOT NULL,
  "nodeId" TEXT NOT NULL,
  "objectId" TEXT NOT NULL,
  "ciphertextSha256" TEXT NOT NULL,
  "status" "ReplicaStatus" NOT NULL DEFAULT 'pending',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "verifiedAt" TIMESTAMP(3),
  CONSTRAINT "ChunkReplica_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "FileVersion_storageLayout_idx" ON "FileVersion"("storageLayout");
CREATE UNIQUE INDEX "FileChunk_versionId_index_key" ON "FileChunk"("versionId", "index");
CREATE INDEX "FileChunk_versionId_idx" ON "FileChunk"("versionId");
CREATE UNIQUE INDEX "ChunkReplica_nodeId_objectId_key" ON "ChunkReplica"("nodeId", "objectId");
CREATE INDEX "ChunkReplica_chunkId_status_idx" ON "ChunkReplica"("chunkId", "status");
CREATE INDEX "ChunkReplica_nodeId_status_idx" ON "ChunkReplica"("nodeId", "status");

ALTER TABLE "FileChunk" ADD CONSTRAINT "FileChunk_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "FileVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChunkReplica" ADD CONSTRAINT "ChunkReplica_chunkId_fkey" FOREIGN KEY ("chunkId") REFERENCES "FileChunk"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChunkReplica" ADD CONSTRAINT "ChunkReplica_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "StorageNode"("id") ON DELETE CASCADE ON UPDATE CASCADE;
