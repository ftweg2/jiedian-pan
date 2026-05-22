import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import {
  FileStatus,
  FileVersionStorageLayout,
  PermissionLevel,
  ReplicaStatus,
  StorageNodeStatus,
  StoragePolicy,
  UserRole,
  type StorageNode
} from "@prisma/client";
import { createPasswordHash, sessionCookieName } from "./auth.js";
import { encryptBuffer, hashToken } from "./crypto.js";
import type { ApiEnv } from "./env.js";
import { buildServer } from "./server.js";

const now = new Date("2026-05-21T00:00:00.000Z");
const future = new Date("2999-01-01T00:00:00.000Z");

const testEnv: ApiEnv = {
  port: 0,
  host: "127.0.0.1",
  databaseUrl: "postgresql://example.invalid/test",
  cookieSecret: "stage-8-cookie-secret-32-byte-value",
  cookieSecure: false,
  masterKey: Buffer.alloc(32, 8),
  sessionTtlDays: 1,
  corsOrigin: "http://localhost:5173",
  publicBaseUrl: "http://localhost:5173",
  maxUploadBytes: 1024 * 1024
};

const sessionTokens = {
  admin: "stage-8-admin-session",
  member: "stage-8-member-session",
  owner: "stage-8-owner-session",
  manager: "stage-8-manager-session",
  reader: "stage-8-reader-session",
  target: "stage-8-target-session"
} as const;

type SessionKey = keyof typeof sessionTokens;

type MockUser = {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  passwordHash: string;
  disabledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type MockSession = {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  createdAt: Date;
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
  createdAt: Date;
  verifiedAt: Date | null;
  node: StorageNode;
};

type MockChunkReplica = {
  id: string;
  chunkId: string;
  nodeId: string;
  objectId: string;
  ciphertextSha256: string;
  status: ReplicaStatus;
  createdAt: Date;
  verifiedAt: Date | null;
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
  encryptionNonce: string | null;
  encryptionAuthTag: string | null;
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
  storageLayout: FileVersionStorageLayout;
  chunkSizeBytes: bigint | null;
  chunkCount: number | null;
  createdAt: Date;
  replicas: MockReplica[];
  chunks: MockChunk[];
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
};

type MockAccessLog = {
  id: string;
  actorId: string | null;
  fileId: string | null;
  shareLinkId: string | null;
  nodeId: string | null;
  action: string;
  result: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: Date;
};

function makeUser(id: string, role: UserRole = UserRole.MEMBER): MockUser {
  return {
    id,
    email: `${id}@example.com`,
    name: id,
    role,
    passwordHash: "not-used",
    disabledAt: null,
    createdAt: now,
    updatedAt: now
  };
}

function makeNode(overrides: Partial<StorageNode> = {}): StorageNode {
  return {
    id: "node-a",
    name: "node-a",
    baseUrl: "http://node-a.local",
    agentToken: "secret-agent-token-node-a",
    status: StorageNodeStatus.ACTIVE,
    priority: 100,
    lastSeenAt: now,
    freeBytes: 1024n,
    totalBytes: 2048n,
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

function makeReplica(versionId: string, overrides: Partial<MockReplica> = {}): MockReplica {
  const node = overrides.node ?? makeNode({ id: overrides.nodeId ?? "node-a" });
  return {
    id: `replica-${versionId}`,
    versionId,
    nodeId: node.id,
    objectId: `object-${versionId}`,
    ciphertextSha256: "ciphertext-sha256",
    status: ReplicaStatus.AVAILABLE,
    createdAt: now,
    verifiedAt: now,
    node,
    ...overrides
  };
}

function makeWholeVersion(overrides: Partial<MockVersion> = {}): MockVersion {
  const id = overrides.id ?? "version-current";
  return {
    id,
    fileId: "file-1",
    objectKey: `file-1/${id}`,
    plaintextSha256: "plaintext-sha256",
    ciphertextSha256: "ciphertext-sha256",
    encryptionNonce: `secret-version-nonce-${id}`,
    encryptionAuthTag: `secret-version-auth-tag-${id}`,
    wrappedKey: `secret-wrapped-key-${id}`,
    sizeBytes: 1234n,
    storageLayout: FileVersionStorageLayout.WHOLE,
    chunkSizeBytes: null,
    chunkCount: null,
    createdAt: now,
    replicas: [],
    chunks: [],
    ...overrides
  };
}

function makeFile(overrides: Partial<MockFile> = {}): MockFile {
  const version = makeWholeVersion({
    id: "version-current",
    replicas: [makeReplica("version-current")]
  });
  return {
    id: "file-1",
    name: "stage8-report.txt",
    mimeType: "text/plain",
    sizeBytes: 19n,
    ownerId: "owner",
    folderId: null,
    policyOverride: null,
    expiresAt: null,
    status: FileStatus.ACTIVE,
    createdAt: now,
    updatedAt: now,
    folder: null,
    versions: [version],
    ...overrides
  };
}

function makeAccessLog(overrides: Partial<MockAccessLog>): MockAccessLog {
  return {
    id: "log-1",
    actorId: "target",
    fileId: "file-1",
    shareLinkId: "share-1",
    nodeId: "node-a",
    action: "download",
    result: "ok",
    ip: "127.0.0.1",
    userAgent: "stage8-test",
    createdAt: now,
    ...overrides
  };
}

function createFixture() {
  const users = new Map<string, MockUser>([
    ["admin", makeUser("admin", UserRole.ADMIN)],
    ["member", makeUser("member")],
    ["owner", makeUser("owner")],
    ["manager", makeUser("manager")],
    ["reader", makeUser("reader")],
    ["target", makeUser("target")]
  ]);
  const sessions = new Map<string, MockSession>();
  const files = new Map<string, MockFile>([["file-1", makeFile()]]);
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
  const objectReplicaUpdates: Array<{ id: string; data: Partial<MockReplica> }> = [];
  const chunkReplicaUpdates: Array<{ id: string; data: Partial<MockChunkReplica> }> = [];
  const fileUpdates: Array<{ id: string; data: Partial<MockFile> }> = [];
  const sessionDeleteManyInputs: unknown[] = [];
  const accessLogs: MockAccessLog[] = [];

  for (const key of Object.keys(sessionTokens) as SessionKey[]) {
    addSession(key);
  }

  function addSession(key: SessionKey) {
    const user = users.get(key);
    assert.ok(user, `missing test user ${key}`);
    sessions.set(hashToken(sessionTokens[key]), {
      id: `session-${key}`,
      userId: user.id,
      tokenHash: hashToken(sessionTokens[key]),
      expiresAt: future,
      createdAt: now
    });
  }

  function fileWithIncludes(file: MockFile) {
    return {
      ...file,
      versions: [...file.versions].sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
    };
  }

  function allVersions() {
    return Array.from(files.values()).flatMap((file) => file.versions);
  }

  function allReplicas() {
    return allVersions().flatMap((version) => version.replicas);
  }

  function allChunkReplicas() {
    return allVersions().flatMap((version) => version.chunks.flatMap((chunk) => chunk.replicas));
  }

  function accessLogMatchesWhere(log: MockAccessLog, where: Record<string, unknown>) {
    const createdAt = where.createdAt as { gte?: Date; lte?: Date } | undefined;
    if (createdAt?.gte && log.createdAt < createdAt.gte) return false;
    if (createdAt?.lte && log.createdAt > createdAt.lte) return false;
    for (const key of ["action", "result", "fileId", "shareLinkId", "actorId"] as const) {
      if (where[key] && log[key] !== where[key]) return false;
    }
    return true;
  }

  const prisma = {
    session: {
      findUnique: async ({ where }: { where: { tokenHash: string } }) => {
        const session = sessions.get(where.tokenHash);
        if (!session) return null;
        const user = users.get(session.userId);
        return user ? { ...session, user } : null;
      },
      create: async ({ data }: { data: { userId: string; tokenHash: string; expiresAt: Date } }) => {
        const session: MockSession = {
          id: `session-created-${sessions.size + 1}`,
          userId: data.userId,
          tokenHash: data.tokenHash,
          expiresAt: data.expiresAt,
          createdAt: now
        };
        sessions.set(session.tokenHash, session);
        return session;
      },
      delete: async ({ where }: { where: { id: string } }) => {
        for (const [tokenHash, session] of sessions) {
          if (session.id === where.id) {
            sessions.delete(tokenHash);
          }
        }
      },
      deleteMany: async ({ where }: { where: { tokenHash?: string; userId?: string } }) => {
        sessionDeleteManyInputs.push({ where });
        let count = 0;
        for (const [tokenHash, session] of Array.from(sessions.entries())) {
          if (
            (where.tokenHash && tokenHash === where.tokenHash) ||
            (where.userId && session.userId === where.userId)
          ) {
            sessions.delete(tokenHash);
            count += 1;
          }
        }
        return { count };
      }
    },
    user: {
      findUnique: async ({ where }: { where: { id?: string; email?: string } }) => {
        if (where.id) return users.get(where.id) ?? null;
        if (where.email) {
          return Array.from(users.values()).find((user) => user.email === where.email) ?? null;
        }
        return null;
      },
      findMany: async () => Array.from(users.values()).sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime()),
      update: async ({ where, data }: { where: { id: string }; data: Partial<MockUser> }) => {
        const current = users.get(where.id);
        assert.ok(current, `unexpected user update for ${where.id}`);
        const updated = { ...current, ...data, updatedAt: new Date("2026-05-21T00:00:01.000Z") };
        users.set(where.id, updated);
        return updated;
      },
      create: async ({ data }: { data: Pick<MockUser, "email" | "name" | "role" | "passwordHash"> }) => {
        const user = {
          id: `user-${users.size + 1}`,
          disabledAt: null,
          createdAt: now,
          updatedAt: now,
          ...data
        };
        users.set(user.id, user);
        return user;
      }
    },
    folder: {
      findUnique: async () => null,
      findMany: async () => []
    },
    permission: {
      findMany: async ({ where }: { where: { fileId?: string; folderId?: { in: string[] } } }) => {
        if (where.fileId) {
          return permissions.filter((permission) => permission.fileId === where.fileId);
        }
        const folderIds = where.folderId?.in ?? [];
        return permissions.filter((permission) => permission.folderId && folderIds.includes(permission.folderId));
      }
    },
    file: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const file = files.get(where.id);
        return file ? fileWithIncludes(file) : null;
      },
      findMany: async ({ where }: { where?: { status?: FileStatus | { notIn?: FileStatus[] }; folderId?: string | null } }) => {
        let result = Array.from(files.values());
        if (where?.folderId !== undefined) {
          result = result.filter((file) => file.folderId === where.folderId);
        }
        const status = where?.status;
        if (status) {
          if (typeof status === "string") {
            result = result.filter((file) => file.status === status);
          } else if (status.notIn) {
            const excluded = status.notIn ?? [];
            result = result.filter((file) => !excluded.includes(file.status));
          }
        }
        return result
          .map(fileWithIncludes)
          .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime());
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<MockFile> }) => {
        const current = files.get(where.id);
        assert.ok(current, `unexpected file update for ${where.id}`);
        const updated = { ...current, ...data, updatedAt: new Date("2026-05-21T00:00:02.000Z") };
        fileUpdates.push({ id: where.id, data });
        files.set(where.id, updated);
        return fileWithIncludes(updated);
      }
    },
    fileVersion: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const version = allVersions().find((candidate) => candidate.id === where.id);
        if (!version) return null;
        return version;
      },
      findFirst: async ({ where }: { where: { id: string; fileId: string } }) => {
        return allVersions().find((version) => version.id === where.id && version.fileId === where.fileId) ?? null;
      },
      findMany: async ({ where }: { where: { fileId: string } }) => {
        const file = files.get(where.fileId);
        return file ? file.versions : [];
      }
    },
    fileChunk: {
      findMany: async ({ where }: { where: { versionId: string } }) => {
        const version = allVersions().find((candidate) => candidate.id === where.versionId);
        return version ? [...version.chunks].sort((left, right) => left.index - right.index) : [];
      },
      count: async ({ where }: { where: { versionId: string } }) => {
        const version = allVersions().find((candidate) => candidate.id === where.versionId);
        return version?.chunks.filter((chunk) => chunk.encryptionNonce && chunk.encryptionAuthTag).length ?? 0;
      }
    },
    objectReplica: {
      findMany: async ({ where }: { where: { versionId?: string; id?: { in: string[] } } }) => {
        let replicas = allReplicas();
        if (where.versionId) {
          replicas = replicas.filter((replica) => replica.versionId === where.versionId);
        }
        if (where.id?.in) {
          replicas = replicas.filter((replica) => where.id?.in.includes(replica.id));
        }
        return replicas
          .filter((replica) => replica.status === ReplicaStatus.AVAILABLE)
          .sort((left, right) => (right.verifiedAt?.getTime() ?? 0) - (left.verifiedAt?.getTime() ?? 0));
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<MockReplica> }) => {
        objectReplicaUpdates.push({ id: where.id, data });
        const replica = allReplicas().find((candidate) => candidate.id === where.id);
        assert.ok(replica, `unexpected object replica update for ${where.id}`);
        Object.assign(replica, data);
        return replica;
      }
    },
    chunkReplica: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) => {
        return allChunkReplicas().filter((replica) => where.id.in.includes(replica.id));
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<MockChunkReplica> }) => {
        chunkReplicaUpdates.push({ id: where.id, data });
        const replica = allChunkReplicas().find((candidate) => candidate.id === where.id);
        assert.ok(replica, `unexpected chunk replica update for ${where.id}`);
        Object.assign(replica, data);
        return replica;
      }
    },
    storageNode: {
      update: async () => undefined
    },
    accessLog: {
      create: async ({ data }: { data: Partial<MockAccessLog> }) => {
        const log = makeAccessLog({
          id: `log-created-${accessLogs.length + 1}`,
          actorId: data.actorId ?? null,
          fileId: data.fileId ?? null,
          shareLinkId: data.shareLinkId ?? null,
          nodeId: data.nodeId ?? null,
          action: data.action ?? "unknown",
          result: data.result ?? "unknown",
          ip: data.ip ?? null,
          userAgent: data.userAgent ?? null,
          createdAt: now
        });
        accessLogs.push(log);
        return log;
      },
      count: async ({ where }: { where: Record<string, unknown> }) => {
        return accessLogs.filter((log) => accessLogMatchesWhere(log, where)).length;
      },
      findMany: async ({
        where,
        skip,
        take
      }: {
        where: Record<string, unknown>;
        skip: number;
        take: number;
      }) => {
        return accessLogs
          .filter((log) => accessLogMatchesWhere(log, where))
          .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
          .slice(skip, skip + take)
          .map((log) => ({
            ...log,
            actor: log.actorId ? users.get(log.actorId) ?? null : null,
            file: log.fileId ? files.get(log.fileId) ?? null : null,
            shareLink: log.shareLinkId ? { id: log.shareLinkId } : null,
            node: log.nodeId ? makeNode({ id: log.nodeId }) : null
          }));
      }
    }
  };

  return {
    users,
    sessions,
    files,
    permissions,
    accessLogs,
    objectReplicaUpdates,
    chunkReplicaUpdates,
    fileUpdates,
    sessionDeleteManyInputs,
    addSession,
    prisma
  };
}

type TestInjectResponse = {
  statusCode: number;
  body: string;
  headers: Record<string, unknown>;
  json: <T = unknown>() => T;
};

async function withServer<T>(
  prisma: unknown,
  run: (inject: (input: {
    method: "GET" | "POST" | "DELETE" | "PATCH";
    url: string;
    session?: SessionKey;
    payload?: Record<string, unknown> | string | Buffer;
  }) => Promise<TestInjectResponse>) => Promise<T>
): Promise<T> {
  const app = await buildServer(testEnv, prisma as never);
  try {
    return await run((input) =>
      app.inject({
        method: input.method,
        url: input.url,
        headers: input.session ? { cookie: `${sessionCookieName}=${sessionTokens[input.session]}` } : undefined,
        payload: input.payload
      }) as Promise<TestInjectResponse>
    );
  } finally {
    await app.close();
  }
}

async function withMockStorage(
  objects: Map<string, Buffer>,
  run: (deletedObjectIds: string[]) => Promise<void>
): Promise<void> {
  const originalFetch = globalThis.fetch;
  const deletedObjectIds: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const parsed = new URL(url);
    if (!parsed.pathname.startsWith("/objects/")) {
      return new Response(`unexpected storage request: ${method} ${url}`, { status: 500 });
    }
    const objectId = decodeURIComponent(
      parsed.pathname.slice("/objects/".length).replace(/\/verify$/, "")
    );

    if (method === "GET") {
      const body = objects.get(objectId);
      return body ? new Response(body as BodyInit) : new Response("missing object", { status: 404 });
    }

    if (method === "POST" && parsed.pathname.endsWith("/verify")) {
      const body = objects.get(objectId);
      return Response.json({
        objectId,
        exists: Boolean(body),
        sizeBytes: body?.byteLength ?? 0,
        ciphertextSha256: body ? sha256(body) : null,
        matches: Boolean(body)
      });
    }

    if (method === "DELETE") {
      deletedObjectIds.push(objectId);
      objects.delete(objectId);
      return new Response(null, { status: 204 });
    }

    return new Response(`unexpected storage request: ${method} ${url}`, { status: 500 });
  }) as typeof fetch;

  try {
    await run(deletedObjectIds);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function assertNoSecretFields(payload: string) {
  for (const secret of [
    "wrappedKey",
    "encryptionNonce",
    "encryptionAuthTag",
    "agentToken",
    "secret-agent-token",
    "secret-version-nonce",
    "secret-version-auth-tag",
    "secret-wrapped-key",
    "secret-chunk-nonce",
    "secret-chunk-auth-tag"
  ]) {
    assert.equal(payload.includes(secret), false, `response leaked ${secret}`);
  }
}

test("recycle bin moves files to trash, restores them, and only purges replicas on purge", async () => {
  const fixture = createFixture();

  await withServer(fixture.prisma, async (inject) => {
    const deleted = await inject({ method: "DELETE", url: "/files/file-1", session: "manager" });
    assert.equal(deleted.statusCode, 204);
    assert.equal(fixture.files.get("file-1")?.status, FileStatus.TRASHED);
    assert.equal(fixture.objectReplicaUpdates.length, 0);

    const trash = await inject({ method: "GET", url: "/files/trash", session: "manager" });
    assert.equal(trash.statusCode, 200);
    assert.deepEqual(
      (trash.json() as { files: Array<{ id: string; status: string }> }).files.map((file) => [file.id, file.status]),
      [["file-1", "trashed"]]
    );

    const readerTrash = await inject({ method: "GET", url: "/files/trash", session: "reader" });
    assert.equal(readerTrash.statusCode, 200);
    assert.deepEqual((readerTrash.json() as { files: unknown[] }).files, []);

    const restored = await inject({ method: "POST", url: "/files/file-1/restore", session: "manager", payload: {} });
    assert.equal(restored.statusCode, 200);
    assert.equal((restored.json() as { file: { status: string } }).file.status, "active");
    assert.equal(fixture.files.get("file-1")?.status, FileStatus.ACTIVE);

    await inject({ method: "DELETE", url: "/files/file-1", session: "manager" });
    const objects = new Map([["object-version-current", Buffer.from("ciphertext")]]);
    await withMockStorage(objects, async (deletedObjectIds) => {
      const purged = await inject({ method: "POST", url: "/files/file-1/purge", session: "manager", payload: {} });
      assert.equal(purged.statusCode, 204);
      assert.deepEqual(deletedObjectIds, ["object-version-current"]);
      assert.equal(fixture.files.get("file-1")?.status, FileStatus.DELETED);
      assert.ok(
        fixture.objectReplicaUpdates.some(
          (update) => update.id === "replica-version-current" && update.data.status === ReplicaStatus.DELETED
        )
      );
    });
  });
});

test("non-manage users cannot restore or purge trashed files", async () => {
  const fixture = createFixture();
  fixture.files.get("file-1")!.status = FileStatus.TRASHED;

  await withServer(fixture.prisma, async (inject) => {
    const restore = await inject({ method: "POST", url: "/files/file-1/restore", session: "reader", payload: {} });
    assert.equal(restore.statusCode, 404);
    assert.equal(fixture.files.get("file-1")?.status, FileStatus.TRASHED);

    await withMockStorage(new Map([["object-version-current", Buffer.from("ciphertext")]]), async (deletedObjectIds) => {
      const purge = await inject({ method: "POST", url: "/files/file-1/purge", session: "reader", payload: {} });
      assert.equal(purge.statusCode, 404);
      assert.deepEqual(deletedObjectIds, []);
      assert.equal(fixture.files.get("file-1")?.status, FileStatus.TRASHED);
    });
  });
});

test("version history is newest first, hides secrets, and can download an old whole version", async () => {
  const fixture = createFixture();
  const plaintext = Buffer.from("old version plaintext");
  const encrypted = encryptBuffer(plaintext, testEnv.masterKey);
  const oldVersion = makeWholeVersion({
    id: "version-old",
    createdAt: new Date("2026-05-20T00:00:00.000Z"),
    plaintextSha256: encrypted.metadata.plaintextSha256,
    ciphertextSha256: encrypted.metadata.ciphertextSha256,
    encryptionNonce: encrypted.metadata.encryptionNonce,
    encryptionAuthTag: encrypted.metadata.encryptionAuthTag,
    wrappedKey: encrypted.metadata.wrappedKey,
    sizeBytes: BigInt(encrypted.ciphertext.byteLength),
    replicas: [
      makeReplica("version-old", {
        id: "replica-version-old",
        objectId: "object-version-old",
        ciphertextSha256: encrypted.metadata.ciphertextSha256
      })
    ]
  });
  const chunkedVersion = makeWholeVersion({
    id: "version-new",
    createdAt: new Date("2026-05-21T00:00:00.000Z"),
    storageLayout: FileVersionStorageLayout.CHUNKED,
    chunkSizeBytes: 8n,
    chunkCount: 1,
    encryptionNonce: "secret-version-nonce-new",
    encryptionAuthTag: "secret-version-auth-tag-new",
    wrappedKey: "secret-wrapped-key-new",
    replicas: [],
    chunks: [
      {
        id: "chunk-new-0",
        versionId: "version-new",
        index: 0,
        plaintextSizeBytes: 8n,
        ciphertextSizeBytes: 8n,
        plaintextSha256: "chunk-plain-hash",
        ciphertextSha256: "chunk-cipher-hash",
        encryptionNonce: "secret-chunk-nonce-new",
        encryptionAuthTag: "secret-chunk-auth-tag-new",
        createdAt: now,
        replicas: [
          {
            id: "chunk-replica-new",
            chunkId: "chunk-new-0",
            nodeId: "node-a",
            objectId: "chunk-object-new",
            ciphertextSha256: "chunk-cipher-hash",
            status: ReplicaStatus.AVAILABLE,
            createdAt: now,
            verifiedAt: now,
            node: makeNode()
          }
        ]
      }
    ]
  });
  fixture.files.get("file-1")!.versions = [oldVersion, chunkedVersion];

  await withServer(fixture.prisma, async (inject) => {
    const versions = await inject({ method: "GET", url: "/files/file-1/versions", session: "reader" });
    assert.equal(versions.statusCode, 200);
    const body = versions.json() as { versions: Array<{ id: string; storageLayout: string; streamingDownloadSupported: boolean }> };
    assert.deepEqual(body.versions.map((version) => version.id), ["version-new", "version-old"]);
    assert.equal(body.versions[0].storageLayout, "chunked");
    assert.equal(body.versions[0].streamingDownloadSupported, true);
    assertNoSecretFields(versions.body);

    await withMockStorage(new Map([["object-version-old", encrypted.ciphertext]]), async () => {
      const download = await inject({
        method: "GET",
        url: "/files/file-1/versions/version-old/download",
        session: "reader"
      });
      assert.equal(download.statusCode, 200);
      assert.equal(download.body, plaintext.toString("utf8"));
    });
  });
});

test("access logs support pagination and action/result/time/file/share/actor filters", async () => {
  const fixture = createFixture();
  fixture.accessLogs.push(
    makeAccessLog({ id: "match-new", createdAt: new Date("2026-05-21T12:00:00.000Z") }),
    makeAccessLog({ id: "match-old", createdAt: new Date("2026-05-21T10:00:00.000Z") }),
    makeAccessLog({ id: "wrong-action", action: "preview", createdAt: new Date("2026-05-21T11:30:00.000Z") }),
    makeAccessLog({ id: "wrong-result", result: "failed", createdAt: new Date("2026-05-21T11:20:00.000Z") }),
    makeAccessLog({ id: "wrong-file", fileId: "file-2", createdAt: new Date("2026-05-21T11:10:00.000Z") }),
    makeAccessLog({ id: "wrong-share", shareLinkId: "share-2", createdAt: new Date("2026-05-21T11:00:00.000Z") }),
    makeAccessLog({ id: "wrong-actor", actorId: "member", createdAt: new Date("2026-05-21T10:50:00.000Z") }),
    makeAccessLog({ id: "too-early", createdAt: new Date("2026-05-21T08:59:59.000Z") }),
    makeAccessLog({ id: "too-late", createdAt: new Date("2026-05-21T13:00:01.000Z") })
  );

  await withServer(fixture.prisma, async (inject) => {
    const response = await inject({
      method: "GET",
      url: "/access-logs?page=2&pageSize=1&from=2026-05-21T09:00:00.000Z&to=2026-05-21T13:00:00.000Z&action=download&result=ok&fileId=file-1&shareLinkId=share-1&actorId=target",
      session: "admin"
    });
    assert.equal(response.statusCode, 200);
    const body = response.json() as {
      items: Array<{ id: string; actorId: string | null; fileId: string | null; shareLinkId: string | null }>;
      logs: unknown[];
      page: number;
      pageSize: number;
      total: number;
    };
    assert.equal(body.page, 2);
    assert.equal(body.pageSize, 1);
    assert.equal(body.total, 2);
    assert.deepEqual(body.items.map((item) => item.id), ["match-old"]);
    assert.deepEqual(body.logs, body.items);
    assert.equal(body.items[0].actorId, "target");
    assert.equal(body.items[0].fileId, "file-1");
    assert.equal(body.items[0].shareLinkId, "share-1");
  });
});

test("admin user lifecycle disables sessions, restores login, resets password, and rejects non-admins", async () => {
  const fixture = createFixture();
  fixture.users.get("target")!.passwordHash = await createPasswordHash("old-password-123");

  await withServer(fixture.prisma, async (inject) => {
    const disabled = await inject({ method: "POST", url: "/users/target/disable", session: "admin", payload: {} });
    assert.equal(disabled.statusCode, 200);
    assert.equal((disabled.json() as { user: { enabled: boolean; disabledAt: string | null } }).user.enabled, false);
    assert.ok(fixture.users.get("target")?.disabledAt instanceof Date);
    assert.ok(
      fixture.sessionDeleteManyInputs.some(
        (input) => (input as { where: { userId?: string } }).where.userId === "target"
      )
    );

    const disabledLogin = await inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "target@example.com", password: "old-password-123" }
    });
    assert.equal(disabledLogin.statusCode, 403);

    fixture.addSession("target");
    const disabledSession = await inject({ method: "GET", url: "/auth/me", session: "target" });
    assert.equal(disabledSession.statusCode, 401);

    const enabled = await inject({ method: "POST", url: "/users/target/enable", session: "admin", payload: {} });
    assert.equal(enabled.statusCode, 200);
    assert.equal((enabled.json() as { user: { enabled: boolean; disabledAt: string | null } }).user.enabled, true);
    assert.equal(fixture.users.get("target")?.disabledAt, null);

    const enabledLogin = await inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "target@example.com", password: "old-password-123" }
    });
    assert.equal(enabledLogin.statusCode, 200);
    assert.ok(enabledLogin.headers["set-cookie"]);

    fixture.addSession("target");
    const reset = await inject({
      method: "POST",
      url: "/users/target/reset-password",
      session: "admin",
      payload: { password: "new-password-123" }
    });
    assert.equal(reset.statusCode, 200);
    assert.ok(
      fixture.sessionDeleteManyInputs.some(
        (input) => (input as { where: { userId?: string } }).where.userId === "target"
      )
    );

    const oldPassword = await inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "target@example.com", password: "old-password-123" }
    });
    assert.equal(oldPassword.statusCode, 401);

    const newPassword = await inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "target@example.com", password: "new-password-123" }
    });
    assert.equal(newPassword.statusCode, 200);

    for (const [url, payload] of [
      ["/users/target/disable", {}],
      ["/users/target/enable", {}],
      ["/users/target/reset-password", { password: "another-password-123" }]
    ] as const) {
      const forbidden = await inject({ method: "POST", url, session: "member", payload });
      assert.equal(forbidden.statusCode, 403);
    }
  });
});
