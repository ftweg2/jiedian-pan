CREATE TYPE "UserRole" AS ENUM ('admin', 'member');
CREATE TYPE "StoragePolicy" AS ENUM ('standard', 'important', 'temporary');
CREATE TYPE "PermissionLevel" AS ENUM ('read', 'write', 'manage');
CREATE TYPE "FileStatus" AS ENUM ('pending', 'active', 'failed', 'deleted');
CREATE TYPE "ReplicaStatus" AS ENUM ('pending', 'available', 'missing', 'deleted');
CREATE TYPE "StorageNodeStatus" AS ENUM ('active', 'degraded', 'offline', 'disabled');
CREATE TYPE "ShareStatus" AS ENUM ('active', 'expired', 'revoked');
CREATE TYPE "JobStatus" AS ENUM ('pending', 'running', 'done', 'failed');

CREATE TABLE "User" (
  "id" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "role" "UserRole" NOT NULL DEFAULT 'member',
  "passwordHash" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Session" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Folder" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "parentId" TEXT,
  "defaultPolicy" "StoragePolicy" NOT NULL DEFAULT 'standard',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Folder_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "File" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "sizeBytes" BIGINT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "folderId" TEXT,
  "policyOverride" "StoragePolicy",
  "expiresAt" TIMESTAMP(3),
  "status" "FileStatus" NOT NULL DEFAULT 'pending',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "File_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FileVersion" (
  "id" TEXT NOT NULL,
  "fileId" TEXT NOT NULL,
  "objectKey" TEXT NOT NULL,
  "plaintextSha256" TEXT NOT NULL,
  "ciphertextSha256" TEXT NOT NULL,
  "encryptionNonce" TEXT NOT NULL,
  "encryptionAuthTag" TEXT NOT NULL,
  "wrappedKey" TEXT NOT NULL,
  "sizeBytes" BIGINT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FileVersion_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "StorageNode" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "baseUrl" TEXT NOT NULL,
  "agentToken" TEXT NOT NULL,
  "status" "StorageNodeStatus" NOT NULL DEFAULT 'active',
  "priority" INTEGER NOT NULL DEFAULT 100,
  "lastSeenAt" TIMESTAMP(3),
  "freeBytes" BIGINT,
  "totalBytes" BIGINT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StorageNode_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ObjectReplica" (
  "id" TEXT NOT NULL,
  "versionId" TEXT NOT NULL,
  "nodeId" TEXT NOT NULL,
  "objectId" TEXT NOT NULL,
  "ciphertextSha256" TEXT NOT NULL,
  "status" "ReplicaStatus" NOT NULL DEFAULT 'pending',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "verifiedAt" TIMESTAMP(3),
  CONSTRAINT "ObjectReplica_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Permission" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "folderId" TEXT,
  "fileId" TEXT,
  "level" "PermissionLevel" NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Permission_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ShareLink" (
  "id" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "fileId" TEXT NOT NULL,
  "createdById" TEXT NOT NULL,
  "passwordHash" TEXT,
  "expiresAt" TIMESTAMP(3),
  "maxDownloads" INTEGER,
  "downloadCount" INTEGER NOT NULL DEFAULT 0,
  "status" "ShareStatus" NOT NULL DEFAULT 'active',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastAccessAt" TIMESTAMP(3),
  CONSTRAINT "ShareLink_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AccessLog" (
  "id" TEXT NOT NULL,
  "actorId" TEXT,
  "fileId" TEXT,
  "shareLinkId" TEXT,
  "nodeId" TEXT,
  "action" TEXT NOT NULL,
  "result" TEXT NOT NULL,
  "ip" TEXT,
  "userAgent" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AccessLog_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BackgroundJob" (
  "id" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "status" "JobStatus" NOT NULL DEFAULT 'pending',
  "payload" JSONB NOT NULL,
  "lastError" TEXT,
  "scheduledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BackgroundJob_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");
CREATE INDEX "Session_userId_idx" ON "Session"("userId");
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");
CREATE INDEX "Folder_ownerId_parentId_idx" ON "Folder"("ownerId", "parentId");
CREATE INDEX "File_ownerId_folderId_idx" ON "File"("ownerId", "folderId");
CREATE INDEX "File_status_expiresAt_idx" ON "File"("status", "expiresAt");
CREATE INDEX "FileVersion_fileId_createdAt_idx" ON "FileVersion"("fileId", "createdAt");
CREATE INDEX "StorageNode_status_priority_idx" ON "StorageNode"("status", "priority");
CREATE UNIQUE INDEX "ObjectReplica_nodeId_objectId_key" ON "ObjectReplica"("nodeId", "objectId");
CREATE INDEX "ObjectReplica_versionId_status_idx" ON "ObjectReplica"("versionId", "status");
CREATE UNIQUE INDEX "Permission_userId_folderId_key" ON "Permission"("userId", "folderId");
CREATE UNIQUE INDEX "Permission_userId_fileId_key" ON "Permission"("userId", "fileId");
CREATE INDEX "Permission_folderId_idx" ON "Permission"("folderId");
CREATE INDEX "Permission_fileId_idx" ON "Permission"("fileId");
CREATE UNIQUE INDEX "ShareLink_tokenHash_key" ON "ShareLink"("tokenHash");
CREATE INDEX "ShareLink_fileId_idx" ON "ShareLink"("fileId");
CREATE INDEX "ShareLink_status_expiresAt_idx" ON "ShareLink"("status", "expiresAt");
CREATE INDEX "AccessLog_fileId_createdAt_idx" ON "AccessLog"("fileId", "createdAt");
CREATE INDEX "AccessLog_shareLinkId_createdAt_idx" ON "AccessLog"("shareLinkId", "createdAt");
CREATE INDEX "BackgroundJob_type_status_scheduledAt_idx" ON "BackgroundJob"("type", "status", "scheduledAt");

ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Folder" ADD CONSTRAINT "Folder_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Folder" ADD CONSTRAINT "Folder_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Folder"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "File" ADD CONSTRAINT "File_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "File" ADD CONSTRAINT "File_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "Folder"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "FileVersion" ADD CONSTRAINT "FileVersion_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "File"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ObjectReplica" ADD CONSTRAINT "ObjectReplica_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "FileVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ObjectReplica" ADD CONSTRAINT "ObjectReplica_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "StorageNode"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Permission" ADD CONSTRAINT "Permission_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Permission" ADD CONSTRAINT "Permission_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "Folder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Permission" ADD CONSTRAINT "Permission_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "File"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ShareLink" ADD CONSTRAINT "ShareLink_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "File"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ShareLink" ADD CONSTRAINT "ShareLink_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AccessLog" ADD CONSTRAINT "AccessLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AccessLog" ADD CONSTRAINT "AccessLog_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "File"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AccessLog" ADD CONSTRAINT "AccessLog_shareLinkId_fkey" FOREIGN KEY ("shareLinkId") REFERENCES "ShareLink"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AccessLog" ADD CONSTRAINT "AccessLog_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "StorageNode"("id") ON DELETE SET NULL ON UPDATE CASCADE;
