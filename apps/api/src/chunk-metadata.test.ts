import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";
import {
  FileStatus,
  PermissionLevel,
  ReplicaStatus,
  ShareStatus,
  StorageNodeStatus,
  StoragePolicy,
  UserRole,
  type StorageNode
} from "@prisma/client";
import { sessionCookieName } from "./auth.js";
import { hashToken } from "./crypto.js";
import type { ApiEnv } from "./env.js";
import { buildServer } from "./server.js";

const now = new Date("2026-05-21T00:00:00.000Z");
const later = new Date("2026-05-21T00:01:00.000Z");
const future = new Date("2999-01-01T00:00:00.000Z");

const testEnv: ApiEnv = {
  port: 0,
  host: "127.0.0.1",
  databaseUrl: "postgresql://example.invalid/test",
  cookieSecret: "stage-5-cookie-secret-32-byte-value",
  cookieSecure: false,
  masterKey: Buffer.alloc(32, 1),
  sessionTtlDays: 1,
  corsOrigin: "http://localhost:5173",
  publicBaseUrl: "http://localhost:5173",
  maxUploadBytes: 1024 * 1024
};

const sessionTokens = {
  manager: "stage-5-manager-session",
  stranger: "stage-5-stranger-session"
} as const;

type SessionKey = keyof typeof sessionTokens;
type MockStorageLayout = "WHOLE" | "CHUNKED";

type MockUser = {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  passwordHash: string;
  createdAt: Date;
  updatedAt: Date;
};

type MockPermission = {
  id: string;
  userId: string;
  fileId: string | null;
  folderId: string | null;
  level: PermissionLevel;
  createdAt: Date;
};

type MockChunkReplica = {
  id: string;
  chunkId: string;
  nodeId: string;
  objectId: string;
  ciphertextSha256: string;
  status: ReplicaStatus;
  verifiedAt: Date | null;
  createdAt: Date;
  node: StorageNode;
};

type MockChunk = {
  id: string;
  versionId: string;
  index: number;
  plaintextSizeBytes: bigint;
  ciphertextSizeBytes: bigint;
  plaintextSha256: string;
  ciphertextSha256: string;
  createdAt: Date;
  replicas: MockChunkReplica[];
};

type MockVersion = {
  id: string;
  fileId: string;
  objectKey: string;
  plaintextSha256: string;
  ciphertextSha256: string;
  encryptionNonce: string;
  encryptionAuthTag: string;
  wrappedKey: string;
  sizeBytes: bigint;
  storageLayout: MockStorageLayout;
  chunkSizeBytes: bigint | null;
  chunkCount: number | null;
  createdAt: Date;
  replicas: [];
  chunks: MockChunk[];
};

type MockShare = {
  id: string;
  tokenHash: string;
  fileId: string;
  createdById: string;
  passwordHash: string | null;
  expiresAt: Date | null;
  maxDownloads: number | null;
  downloadCount: number;
  status: ShareStatus;
  createdAt: Date;
  lastAccessAt: Date | null;
};

type MockFile = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: bigint;
  ownerId: string;
  folderId: string | null;
  policyOverride: StoragePolicy | null;
  expiresAt: Date | null;
  status: FileStatus;
  createdAt: Date;
  updatedAt: Date;
  folder: null;
  versions: MockVersion[];
  shares: MockShare[];
  accessLogs: [];
};

function makeUser(id: string): MockUser {
  return {
    id,
    email: `${id}@example.com`,
    name: id,
    role: UserRole.MEMBER,
    passwordHash: "not-used",
    createdAt: now,
    updatedAt: now
  };
}

function makeNode(overrides: Partial<StorageNode>): StorageNode {
  return {
    id: "node-active",
    name: "node-active",
    baseUrl: "http://node-active.local",
    agentToken: "secret-agent-token",
    status: StorageNodeStatus.ACTIVE,
    priority: 100,
    lastSeenAt: now,
    freeBytes: 10_000n,
    totalBytes: 20_000n,
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

function makeChunkReplica(overrides: Partial<MockChunkReplica>): MockChunkReplica {
  const node = overrides.node ?? makeNode({ id: overrides.nodeId ?? "node-active" });
  return {
    id: "chunk-replica-active",
    chunkId: "chunk-0",
    nodeId: node.id,
    objectId: `chunk-object-${node.id}`,
    ciphertextSha256: "chunk-ciphertext-sha256",
    status: ReplicaStatus.AVAILABLE,
    verifiedAt: now,
    createdAt: now,
    node,
    ...overrides
  };
}

function makeChunk(overrides: Partial<MockChunk>): MockChunk {
  const id = overrides.id ?? "chunk-0";
  const index = overrides.index ?? 0;
  return {
    id,
    versionId: "version-chunked",
    index,
    plaintextSizeBytes: 1000n,
    ciphertextSizeBytes: 1100n,
    plaintextSha256: `plaintext-sha256-${index}`,
    ciphertextSha256: `ciphertext-sha256-${index}`,
    createdAt: now,
    replicas: [],
    ...overrides
  };
}

function makeShare(): MockShare {
  return {
    id: "share-chunked",
    tokenHash: "secret-token-hash",
    fileId: "file-chunked",
    createdById: "manager",
    passwordHash: "secret-password-hash",
    expiresAt: future,
    maxDownloads: null,
    downloadCount: 0,
    status: ShareStatus.ACTIVE,
    createdAt: later,
    lastAccessAt: null
  };
}

function makeChunkedFile(): MockFile {
  const activeNode = makeNode({
    id: "node-active",
    name: "node-active",
    baseUrl: "http://node-active.local",
    agentToken: "secret-agent-token-active"
  });
  const offlineNode = makeNode({
    id: "node-offline",
    name: "node-offline",
    baseUrl: "http://node-offline.local",
    agentToken: "secret-agent-token-offline",
    status: StorageNodeStatus.OFFLINE
  });
  const disabledNode = makeNode({
    id: "node-disabled",
    name: "node-disabled",
    baseUrl: "http://node-disabled.local",
    agentToken: "secret-agent-token-disabled",
    status: StorageNodeStatus.DISABLED
  });

  const chunk0 = makeChunk({
    id: "chunk-0",
    index: 0,
    replicas: [
      makeChunkReplica({
        id: "chunk-replica-healthy",
        chunkId: "chunk-0",
        node: activeNode,
        nodeId: activeNode.id,
        objectId: "chunk-0-node-active-object",
        verifiedAt: now
      })
    ]
  });
  const chunk1 = makeChunk({
    id: "chunk-1",
    index: 1,
    replicas: [
      makeChunkReplica({
        id: "chunk-replica-missing",
        chunkId: "chunk-1",
        node: activeNode,
        nodeId: activeNode.id,
        objectId: "chunk-1-node-active-missing-object",
        status: ReplicaStatus.MISSING,
        verifiedAt: null
      }),
      makeChunkReplica({
        id: "chunk-replica-offline",
        chunkId: "chunk-1",
        node: offlineNode,
        nodeId: offlineNode.id,
        objectId: "chunk-1-node-offline-object"
      }),
      makeChunkReplica({
        id: "chunk-replica-disabled",
        chunkId: "chunk-1",
        node: disabledNode,
        nodeId: disabledNode.id,
        objectId: "chunk-1-node-disabled-object"
      })
    ]
  });

  return {
    id: "file-chunked",
    name: "chunked-report.bin",
    mimeType: "application/octet-stream",
    sizeBytes: 2000n,
    ownerId: "owner",
    folderId: null,
    policyOverride: StoragePolicy.STANDARD,
    expiresAt: null,
    status: FileStatus.ACTIVE,
    createdAt: now,
    updatedAt: later,
    folder: null,
    versions: [
      {
        id: "version-chunked",
        fileId: "file-chunked",
        objectKey: "file-chunked/v1",
        plaintextSha256: "version-plaintext-sha256",
        ciphertextSha256: "version-ciphertext-sha256",
        encryptionNonce: "secret-encryption-nonce",
        encryptionAuthTag: "secret-encryption-auth-tag",
        wrappedKey: "secret-wrapped-key",
        sizeBytes: 2200n,
        storageLayout: "CHUNKED",
        chunkSizeBytes: 1024n,
        chunkCount: 3,
        createdAt: now,
        replicas: [],
        chunks: [chunk1, chunk0]
      }
    ],
    shares: [makeShare()],
    accessLogs: []
  };
}

function createPrisma(files: MockFile[] = [makeChunkedFile()]) {
  const users = new Map<SessionKey, MockUser>([
    ["manager", makeUser("manager")],
    ["stranger", makeUser("stranger")]
  ]);
  const sessions = new Map<string, MockUser>(
    Object.entries(sessionTokens).map(([key, token]) => [hashToken(token), users.get(key as SessionKey)!])
  );
  const fileMap = new Map(files.map((file) => [file.id, file]));
  const permissions: MockPermission[] = [
    {
      id: "permission-manager",
      userId: "manager",
      fileId: "file-chunked",
      folderId: null,
      level: PermissionLevel.MANAGE,
      createdAt: now
    }
  ];
  const fileFindUniqueInputs: unknown[] = [];
  const fileFindManyInputs: unknown[] = [];

  function materialize(file: MockFile): MockFile {
    return {
      ...file,
      versions: file.versions.map((version) => ({
        ...version,
        chunks: [...version.chunks]
          .sort((left, right) => left.index - right.index)
          .map((chunk) => ({
            ...chunk,
            replicas: [...chunk.replicas].sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
          }))
      }))
    };
  }

  return {
    fileFindUniqueInputs,
    fileFindManyInputs,
    prisma: {
      session: {
        findUnique: async ({ where }: { where: { tokenHash: string } }) => {
          const user = sessions.get(where.tokenHash);
          if (!user) return null;
          return {
            id: `session-${user.id}`,
            userId: user.id,
            tokenHash: where.tokenHash,
            expiresAt: future,
            createdAt: now,
            user
          };
        },
        delete: async () => undefined
      },
      file: {
        findUnique: async (input: { where: { id: string } }) => {
          fileFindUniqueInputs.push(input);
          const file = fileMap.get(input.where.id);
          return file ? materialize(file) : null;
        },
        findMany: async (input: unknown) => {
          fileFindManyInputs.push(input);
          return files.filter((file) => file.status !== FileStatus.DELETED).map(materialize);
        }
      },
      folder: {
        findUnique: async () => null
      },
      permission: {
        findMany: async ({ where }: { where: { fileId?: string; folderId?: { in: string[] } } }) => {
          if (where.fileId) {
            return permissions.filter((permission) => permission.fileId === where.fileId);
          }
          const folderIds = where.folderId?.in ?? [];
          return permissions.filter((permission) => permission.folderId && folderIds.includes(permission.folderId));
        }
      }
    }
  };
}

async function inject(
  prisma: unknown,
  options: {
    url: string;
    user?: SessionKey;
  }
) {
  const app = await buildServer(testEnv, prisma as never);
  try {
    return await app.inject({
      method: "GET",
      url: options.url,
      headers: {
        ...(options.user ? { cookie: `${sessionCookieName}=${sessionTokens[options.user]}` } : {})
      }
    });
  } finally {
    await app.close();
  }
}

function assertNoSensitiveFields(value: unknown) {
  const sensitiveKeys = new Set([
    "agentToken",
    "tokenHash",
    "passwordHash",
    "wrappedKey",
    "encryptionNonce",
    "encryptionAuthTag"
  ]);

  if (Array.isArray(value)) {
    for (const item of value) assertNoSensitiveFields(item);
    return;
  }

  if (!value || typeof value !== "object") {
    return;
  }

  for (const [key, nested] of Object.entries(value)) {
    assert.equal(sensitiveKeys.has(key), false, `response leaked ${key}`);
    assertNoSensitiveFields(nested);
  }
}

function assertNoSensitiveMarkers(value: unknown) {
  const json = JSON.stringify(value);
  assert.equal(json.includes("secret-agent-token"), false);
  assert.equal(json.includes("secret-token-hash"), false);
  assert.equal(json.includes("secret-password-hash"), false);
  assert.equal(json.includes("secret-wrapped-key"), false);
  assert.equal(json.includes("secret-encryption-nonce"), false);
  assert.equal(json.includes("secret-encryption-auth-tag"), false);
}

function assertHasChunkRiskFields(risk: Record<string, unknown>) {
  for (const field of ["fileId", "versionId", "chunkId", "chunkIndex", "replicaId", "nodeId"]) {
    assert.equal(Object.hasOwn(risk, field), true, `${String(risk.type)} missing ${field}`);
  }
}

function findRisk(risks: Array<Record<string, unknown>>, type: string) {
  const risk = risks.find((item) => item.type === type);
  assert.ok(risk, `expected risk ${type}`);
  assertHasChunkRiskFields(risk);
  return risk;
}

test("chunk metadata schema and migration are additive and keep init migration whole-file only", async () => {
  const schema = await readFile(new URL("../prisma/schema.prisma", import.meta.url), "utf8");
  const chunkMigration = await readFile(
    new URL("../prisma/migrations/20260521000000_chunked_storage_metadata/migration.sql", import.meta.url),
    "utf8"
  );
  const initMigration = await readFile(
    new URL("../prisma/migrations/20260520000000_init/migration.sql", import.meta.url),
    "utf8"
  );

  assert.match(schema, /enum FileVersionStorageLayout\s*{[\s\S]*WHOLE\s+@map\("whole"\)[\s\S]*CHUNKED\s+@map\("chunked"\)[\s\S]*}/);
  assert.match(schema, /storageLayout\s+FileVersionStorageLayout\s+@default\(WHOLE\)/);
  assert.match(schema, /model FileChunk\s*{[\s\S]*@@unique\(\[versionId, index\]\)[\s\S]*@@index\(\[versionId\]\)[\s\S]*}/);
  assert.match(schema, /model ChunkReplica\s*{[\s\S]*@@unique\(\[nodeId, objectId\]\)[\s\S]*@@index\(\[chunkId, status\]\)[\s\S]*@@index\(\[nodeId, status\]\)[\s\S]*}/);

  assert.match(chunkMigration, /CREATE TYPE "FileVersionStorageLayout" AS ENUM \('whole', 'chunked'\)/);
  assert.match(chunkMigration, /ADD COLUMN "storageLayout" "FileVersionStorageLayout" NOT NULL DEFAULT 'whole'/);
  assert.match(chunkMigration, /CREATE TABLE "FileChunk"/);
  assert.match(chunkMigration, /CREATE TABLE "ChunkReplica"/);
  assert.match(chunkMigration, /CREATE INDEX "FileVersion_storageLayout_idx" ON "FileVersion"\("storageLayout"\)/);
  assert.match(chunkMigration, /CREATE UNIQUE INDEX "FileChunk_versionId_index_key" ON "FileChunk"\("versionId", "index"\)/);
  assert.match(chunkMigration, /CREATE INDEX "ChunkReplica_chunkId_status_idx" ON "ChunkReplica"\("chunkId", "status"\)/);
  assert.match(chunkMigration, /CREATE INDEX "ChunkReplica_nodeId_status_idx" ON "ChunkReplica"\("nodeId", "status"\)/);
  assert.match(chunkMigration, /"FileChunk_versionId_fkey" FOREIGN KEY \("versionId"\) REFERENCES "FileVersion"\("id"\) ON DELETE CASCADE/);
  assert.match(chunkMigration, /"ChunkReplica_chunkId_fkey" FOREIGN KEY \("chunkId"\) REFERENCES "FileChunk"\("id"\) ON DELETE CASCADE/);
  assert.match(chunkMigration, /"ChunkReplica_nodeId_fkey" FOREIGN KEY \("nodeId"\) REFERENCES "StorageNode"\("id"\) ON DELETE CASCADE/);

  for (const unexpected of [
    "FileVersionStorageLayout",
    "CREATE TABLE \"FileChunk\"",
    "CREATE TABLE \"ChunkReplica\"",
    "\"storageLayout\"",
    "\"chunkSizeBytes\"",
    "\"chunkCount\""
  ]) {
    assert.equal(initMigration.includes(unexpected), false, `init migration should not contain ${unexpected}`);
  }
  assert.match(initMigration, /CREATE TABLE "FileVersion" \([\s\S]*"wrappedKey" TEXT NOT NULL[\s\S]*CONSTRAINT "FileVersion_pkey"/);
});

test("GET /files/:id/detail returns ordered chunk metadata with chunked upload/download enabled", async () => {
  const prisma = createPrisma();

  const response = await inject(prisma.prisma, {
    url: "/files/file-chunked/detail",
    user: "manager"
  });

  assert.equal(response.statusCode, 200);
  const body = response.json() as {
    file: Record<string, unknown>;
    latestVersion: Record<string, unknown>;
    storageLayout: Record<string, unknown>;
    chunks: Array<Record<string, unknown> & { replicas: Array<Record<string, unknown>> }>;
  };

  assert.equal(body.file.storageLayout, "chunked");
  assert.equal(body.file.isChunked, true);
  assert.equal(body.file.chunkCount, 3);
  assert.equal(body.latestVersion.storageLayout, "chunked");
  assert.equal(body.latestVersion.isChunked, true);
  assert.equal(body.latestVersion.chunkSizeBytes, "1024");
  assert.equal(body.latestVersion.declaredChunkCount, 3);
  assert.equal(body.latestVersion.chunkCount, 2);
  assert.equal(body.latestVersion.chunkReplicaCount, 4);
  assert.equal(body.latestVersion.availableChunkReplicaCount, 1);
  assert.equal(body.storageLayout.layout, "chunked");
  assert.equal(body.storageLayout.isChunked, true);
  assert.equal(body.storageLayout.chunkedUploadDownloadSupported, true);
  assert.equal(body.storageLayout.declaredChunkCount, 3);
  assert.equal(body.storageLayout.chunkCount, 2);
  assert.equal(body.storageLayout.wholeReplicaCount, 0);
  assert.equal(body.storageLayout.chunkReplicaCount, 4);
  assert.deepEqual(body.chunks.map((chunk) => chunk.index), [0, 1]);

  const [chunk0, chunk1] = body.chunks;
  assert.equal(chunk0.id, "chunk-0");
  assert.equal(chunk0.replicaCount, 1);
  assert.equal(chunk0.availableReplicaCount, 1);
  assert.equal(chunk0.replicas[0].nodeId, "node-active");
  assert.equal(chunk0.replicas[0].objectId, "chunk-0-node-active-object");
  assert.equal(chunk0.replicas[0].status, "available");
  assert.equal(chunk0.replicas[0].verifiedAt, "2026-05-21T00:00:00.000Z");

  assert.equal(chunk1.id, "chunk-1");
  assert.equal(chunk1.replicaCount, 3);
  assert.equal(chunk1.availableReplicaCount, 0);
  assert.deepEqual(
    chunk1.replicas.map((replica) => [replica.id, replica.nodeId, replica.objectId, replica.status]),
    [
      ["chunk-replica-missing", "node-active", "chunk-1-node-active-missing-object", "missing"],
      ["chunk-replica-offline", "node-offline", "chunk-1-node-offline-object", "available"],
      ["chunk-replica-disabled", "node-disabled", "chunk-1-node-disabled-object", "available"]
    ]
  );

  const detailInclude = prisma.fileFindUniqueInputs[0] as {
    include: { versions: { include: { chunks: { orderBy: { index: string } } } } };
  };
  assert.deepEqual(detailInclude.include.versions.include.chunks.orderBy, { index: "asc" });
  assertNoSensitiveFields(body);
  assertNoSensitiveMarkers(body);
});

test("GET /files summaries expose chunk layout metadata", async () => {
  const prisma = createPrisma();

  const response = await inject(prisma.prisma, {
    url: "/files",
    user: "manager"
  });

  assert.equal(response.statusCode, 200);
  const body = response.json() as { files: Array<Record<string, unknown>> };
  assert.equal(body.files.length, 1);
  assert.equal(body.files[0].id, "file-chunked");
  assert.equal(body.files[0].storageLayout, "chunked");
  assert.equal(body.files[0].isChunked, true);
  assert.equal(body.files[0].chunkCount, 3);
});

test("GET /files/risks reports chunk metadata and replica health risks with identifiers", async () => {
  const prisma = createPrisma();

  const response = await inject(prisma.prisma, {
    url: "/files/risks",
    user: "manager"
  });

  assert.equal(response.statusCode, 200);
  const body = response.json() as {
    risks: Array<{
      file: Record<string, unknown>;
      latestVersionId: string | null;
      risks: Array<Record<string, unknown>>;
    }>;
  };
  assert.equal(body.risks.length, 1);
  const [riskItem] = body.risks;
  assert.equal(riskItem.file.id, "file-chunked");
  assert.equal(riskItem.latestVersionId, "version-chunked");

  const incomplete = findRisk(riskItem.risks, "chunk_metadata_incomplete");
  assert.equal(incomplete.fileId, "file-chunked");
  assert.equal(incomplete.versionId, "version-chunked");
  assert.equal(incomplete.chunkId, null);
  assert.equal(incomplete.chunkIndex, null);
  assert.equal(incomplete.replicaId, null);
  assert.equal(incomplete.nodeId, null);

  const shortage = findRisk(riskItem.risks, "chunk_replica_shortage");
  assert.equal(shortage.fileId, "file-chunked");
  assert.equal(shortage.versionId, "version-chunked");
  assert.equal(shortage.chunkId, "chunk-1");
  assert.equal(shortage.chunkIndex, 1);
  assert.equal(shortage.replicaId, null);
  assert.equal(shortage.nodeId, null);

  const unavailable = findRisk(riskItem.risks, "chunk_replica_unavailable");
  assert.equal(unavailable.chunkId, "chunk-1");
  assert.equal(unavailable.chunkIndex, 1);
  assert.equal(unavailable.replicaId, "chunk-replica-missing");
  assert.equal(unavailable.nodeId, "node-active");

  const nodeUnavailable = riskItem.risks.filter((risk) => risk.type === "chunk_replica_node_unavailable");
  assert.equal(nodeUnavailable.length, 2);
  for (const risk of nodeUnavailable) assertHasChunkRiskFields(risk);
  assert.deepEqual(
    nodeUnavailable.map((risk) => [risk.chunkId, risk.chunkIndex, risk.replicaId, risk.nodeId]).sort(),
    [
      ["chunk-1", 1, "chunk-replica-disabled", "node-disabled"],
      ["chunk-1", 1, "chunk-replica-offline", "node-offline"]
    ]
  );

  const riskInclude = prisma.fileFindManyInputs[0] as {
    include: { versions: { include: { chunks: { orderBy: { index: string } } } } };
  };
  assert.deepEqual(riskInclude.include.versions.include.chunks.orderBy, { index: "asc" });
  assertNoSensitiveFields(body);
  assertNoSensitiveMarkers(body);
});
