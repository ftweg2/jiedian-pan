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

const now = new Date("2026-05-20T00:00:00.000Z");
const later = new Date("2026-05-20T00:01:00.000Z");
const future = new Date("2999-01-01T00:00:00.000Z");

const testEnv: ApiEnv = {
  port: 0,
  host: "127.0.0.1",
  databaseUrl: "postgresql://example.invalid/test",
  cookieSecret: "stage-4-cookie-secret-32-byte-value",
  cookieSecure: false,
  masterKey: Buffer.alloc(32, 1),
  sessionTtlDays: 1,
  corsOrigin: "http://localhost:5173",
  publicBaseUrl: "http://localhost:5173",
  maxUploadBytes: 1024 * 1024
};

const sessionTokens = {
  admin: "stage-4-admin-session",
  owner: "stage-4-owner-session",
  manager: "stage-4-manager-session",
  reader: "stage-4-reader-session",
  stranger: "stage-4-stranger-session"
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

type MockReplica = {
  id: string;
  versionId: string;
  nodeId: string;
  objectId: string;
  ciphertextSha256: string;
  status: ReplicaStatus;
  verifiedAt: Date | null;
  createdAt: Date;
  node: StorageNode;
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
  replicas: MockReplica[];
  chunks: [];
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

type MockAccessLog = {
  id: string;
  actorId: string | null;
  fileId: string | null;
  shareLinkId: string | null;
  nodeId: string | null;
  action: string;
  result: string;
  createdAt: Date;
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
  accessLogs: MockAccessLog[];
};

function makeUser(id: string, role: UserRole = UserRole.MEMBER): MockUser {
  return {
    id,
    email: `${id}@example.com`,
    name: id,
    role,
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
    agentToken: "secret-agent-token-active",
    status: StorageNodeStatus.ACTIVE,
    priority: 100,
    lastSeenAt: now,
    freeBytes: 900n,
    totalBytes: 1000n,
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

function makeReplica(overrides: Partial<MockReplica>): MockReplica {
  const node = overrides.node ?? makeNode({ id: overrides.nodeId ?? "node-active" });
  return {
    id: "replica-active",
    versionId: "version-1",
    nodeId: node.id,
    objectId: `object-${node.id}`,
    ciphertextSha256: "ciphertext-sha256",
    status: ReplicaStatus.AVAILABLE,
    verifiedAt: now,
    createdAt: now,
    node,
    ...overrides
  };
}

function makeVersion(replicas: MockReplica[]): MockVersion {
  return {
    id: "version-1",
    fileId: "file-1",
    objectKey: "file-1/v1",
    plaintextSha256: "plaintext-sha256",
    ciphertextSha256: "ciphertext-sha256",
    encryptionNonce: "secret-encryption-nonce",
    encryptionAuthTag: "secret-encryption-auth-tag",
    wrappedKey: "secret-wrapped-key",
    sizeBytes: 1234n,
    storageLayout: "WHOLE",
    chunkSizeBytes: null,
    chunkCount: null,
    createdAt: now,
    replicas,
    chunks: []
  };
}

function makeShare(): MockShare {
  return {
    id: "share-1",
    tokenHash: "secret-token-hash",
    fileId: "file-1",
    createdById: "owner",
    passwordHash: "secret-password-hash",
    expiresAt: future,
    maxDownloads: 5,
    downloadCount: 1,
    status: ShareStatus.ACTIVE,
    createdAt: later,
    lastAccessAt: null
  };
}

function makeAccessLog(overrides: Partial<MockAccessLog> = {}): MockAccessLog {
  return {
    id: "access-1",
    actorId: "owner",
    fileId: "file-1",
    shareLinkId: "share-1",
    nodeId: "node-active",
    action: "download",
    result: "ok",
    createdAt: later,
    ...overrides
  };
}

function makeImportantFile(): MockFile {
  const activeNode = makeNode({
    id: "node-active",
    name: "node-active",
    baseUrl: "http://node-active.local",
    agentToken: "secret-agent-token-active",
    status: StorageNodeStatus.ACTIVE
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

  const replicas = [
    makeReplica({ id: "replica-healthy", node: activeNode, nodeId: activeNode.id }),
    makeReplica({ id: "replica-missing", node: activeNode, nodeId: activeNode.id, status: ReplicaStatus.MISSING }),
    makeReplica({ id: "replica-offline", node: offlineNode, nodeId: offlineNode.id }),
    makeReplica({ id: "replica-disabled", node: disabledNode, nodeId: disabledNode.id })
  ];

  return {
    id: "file-1",
    name: "important-report.pdf",
    mimeType: "application/pdf",
    sizeBytes: 1234n,
    ownerId: "owner",
    folderId: null,
    policyOverride: StoragePolicy.IMPORTANT,
    expiresAt: null,
    status: FileStatus.ACTIVE,
    createdAt: now,
    updatedAt: later,
    folder: null,
    versions: [makeVersion(replicas)],
    shares: [makeShare()],
    accessLogs: [
      makeAccessLog(),
      makeAccessLog({ id: "access-2", actorId: null, action: "share_download", result: "bad_password" })
    ]
  };
}

function createPrisma(files: MockFile[] = [makeImportantFile()]) {
  const users = new Map<SessionKey, MockUser>([
    ["admin", makeUser("admin", UserRole.ADMIN)],
    ["owner", makeUser("owner")],
    ["manager", makeUser("manager")],
    ["reader", makeUser("reader")],
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
      fileId: "file-1",
      folderId: null,
      level: PermissionLevel.MANAGE,
      createdAt: now
    },
    {
      id: "permission-reader",
      userId: "reader",
      fileId: "file-1",
      folderId: null,
      level: PermissionLevel.READ,
      createdAt: now
    }
  ];

  return {
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
        findUnique: async ({ where }: { where: { id: string } }) => fileMap.get(where.id) ?? null,
        findMany: async () => files.filter((file) => file.status !== FileStatus.DELETED)
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

test("GET /files/:id/detail is readable by owner admin and manage users without leaking secrets", async () => {
  for (const user of ["owner", "admin", "manager"] as const) {
    const prisma = createPrisma();
    const response = await inject(prisma.prisma, {
      url: "/files/file-1/detail",
      user
    });

    assert.equal(response.statusCode, 200);
    const body = response.json() as {
      file: Record<string, unknown>;
      latestVersion: Record<string, unknown>;
      storageLayout: Record<string, unknown>;
      replicas: Array<Record<string, unknown>>;
      chunks: Array<Record<string, unknown>>;
      shares: Array<Record<string, unknown>>;
      recentAccess: Array<Record<string, unknown>>;
      risks: Array<Record<string, unknown>>;
    };

    assert.equal(body.file.id, "file-1");
    assert.equal(body.file.effectivePolicy, "important");
    assert.equal(body.file.storageLayout, "whole");
    assert.equal(body.file.isChunked, false);
    assert.equal(body.file.chunkCount, null);
    assert.equal(body.latestVersion.id, "version-1");
    assert.equal(body.latestVersion.storageLayout, "whole");
    assert.equal(body.latestVersion.isChunked, false);
    assert.equal(body.latestVersion.declaredChunkCount, null);
    assert.equal(body.latestVersion.chunkCount, 0);
    assert.equal(body.storageLayout.layout, "whole");
    assert.equal(body.storageLayout.isChunked, false);
    assert.equal(body.storageLayout.chunkedUploadDownloadSupported, true);
    assert.equal(body.storageLayout.chunkCount, 0);
    assert.equal(body.latestVersion.replicaCount, 4);
    assert.equal(body.latestVersion.availableReplicaCount, 1);
    assert.deepEqual(body.chunks, []);
    assert.deepEqual(body.replicas.map((replica) => replica.id), [
      "replica-healthy",
      "replica-missing",
      "replica-offline",
      "replica-disabled"
    ]);
    assert.equal(body.shares.length, 1);
    assert.equal(body.shares[0].needsPassword, true);
    assert.deepEqual(body.recentAccess.map((log) => log.id), ["access-1", "access-2"]);
    assert.ok(body.risks.some((risk) => risk.type === "important_replica_shortage"));
    assert.ok(body.risks.some((risk) => risk.type === "replica_unavailable"));
    assert.ok(body.risks.some((risk) => risk.type === "replica_node_unavailable"));

    assertNoSensitiveFields(body);
    assertNoSensitiveMarkers(body);
  }

  for (const user of ["reader", "stranger"] as const) {
    const prisma = createPrisma();
    const response = await inject(prisma.prisma, {
      url: "/files/file-1/detail",
      user
    });
    assert.equal(response.statusCode, 404);
  }
});

test("GET /files/risks reports important replica shortage and replica health identifiers", async () => {
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
  assert.equal(riskItem.file.id, "file-1");
  assert.equal(riskItem.latestVersionId, "version-1");

  const shortage = riskItem.risks.find((risk) => risk.type === "important_replica_shortage");
  assert.ok(shortage);
  assert.equal(shortage.fileId, "file-1");
  assert.equal(shortage.versionId, "version-1");

  const missingReplica = riskItem.risks.find((risk) => risk.type === "replica_unavailable");
  assert.ok(missingReplica);
  assert.equal(missingReplica.fileId, "file-1");
  assert.equal(missingReplica.versionId, "version-1");
  assert.equal(missingReplica.replicaId, "replica-missing");
  assert.equal(missingReplica.nodeId, "node-active");

  const unavailableNodes = riskItem.risks.filter((risk) => risk.type === "replica_node_unavailable");
  assert.deepEqual(
    unavailableNodes.map((risk) => [risk.replicaId, risk.nodeId]).sort(),
    [
      ["replica-disabled", "node-disabled"],
      ["replica-offline", "node-offline"]
    ]
  );

  assertNoSensitiveFields(body);
  assertNoSensitiveMarkers(body);
});
