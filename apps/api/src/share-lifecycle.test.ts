import assert from "node:assert/strict";
import test from "node:test";
import { FileStatus, PermissionLevel, ShareStatus, UserRole } from "@prisma/client";
import { sessionCookieName } from "./auth.js";
import { hashToken } from "./crypto.js";
import type { ApiEnv } from "./env.js";
import { buildServer } from "./server.js";

const now = new Date("2026-05-20T00:00:00.000Z");
const future = new Date("2999-01-01T00:00:00.000Z");
const publicToken = "public-share-token";
const secondPublicToken = "second-public-token";

const testEnv: ApiEnv = {
  port: 0,
  host: "127.0.0.1",
  databaseUrl: "postgresql://example.invalid/test",
  cookieSecret: "stage-3-cookie-secret-32-byte-value",
  cookieSecure: false,
  masterKey: Buffer.alloc(32, 1),
  sessionTtlDays: 1,
  corsOrigin: "http://localhost:5173",
  publicBaseUrl: "http://localhost:5173",
  maxUploadBytes: 1024 * 1024
};

const sessionTokens = {
  admin: "stage-3-admin-session",
  creator: "stage-3-creator-session",
  manager: "stage-3-manager-session",
  reader: "stage-3-reader-session",
  stranger: "stage-3-stranger-session"
} as const;

type SessionKey = keyof typeof sessionTokens;

type MockUser = {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  passwordHash: string;
  createdAt: Date;
  updatedAt: Date;
};

type MockFile = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: bigint;
  ownerId: string;
  folderId: string | null;
  policyOverride: null;
  expiresAt: Date | null;
  status: FileStatus;
  createdAt: Date;
  updatedAt: Date;
  folder: null;
  versions?: unknown[];
};

type MockPermission = {
  id: string;
  userId: string;
  fileId: string | null;
  folderId: string | null;
  level: PermissionLevel;
  createdAt: Date;
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

function makeFile(): MockFile {
  return {
    id: "file-1",
    name: "report.pdf",
    mimeType: "application/pdf",
    sizeBytes: 1234n,
    ownerId: "owner",
    folderId: null,
    policyOverride: null,
    expiresAt: null,
    status: FileStatus.ACTIVE,
    createdAt: now,
    updatedAt: now,
    folder: null
  };
}

function makeShare(overrides: Partial<MockShare> = {}): MockShare {
  return {
    id: "share-1",
    tokenHash: hashToken(publicToken),
    fileId: "file-1",
    createdById: "creator",
    passwordHash: "hashed-password",
    expiresAt: future,
    maxDownloads: 3,
    downloadCount: 1,
    status: ShareStatus.ACTIVE,
    createdAt: now,
    lastAccessAt: null,
    ...overrides
  };
}

function createPrisma() {
  const users = new Map<SessionKey, MockUser>([
    ["admin", makeUser("admin", UserRole.ADMIN)],
    ["creator", makeUser("creator")],
    ["manager", makeUser("manager")],
    ["reader", makeUser("reader")],
    ["stranger", makeUser("stranger")]
  ]);
  const sessions = new Map<string, MockUser>(
    Object.entries(sessionTokens).map(([key, token]) => [hashToken(token), users.get(key as SessionKey)!])
  );
  const file = makeFile();
  const shares = new Map<string, MockShare>([
    ["share-1", makeShare()],
    [
      "share-2",
      makeShare({
        id: "share-2",
        tokenHash: hashToken(secondPublicToken),
        passwordHash: null,
        expiresAt: null,
        maxDownloads: null,
        downloadCount: 0,
        createdAt: new Date("2026-05-20T00:01:00.000Z")
      })
    ]
  ]);
  const updates: Array<{ id: string; data: Partial<MockShare> }> = [];
  const permissions: MockPermission[] = [
    {
      id: "permission-manager",
      userId: "manager",
      fileId: file.id,
      folderId: null,
      level: PermissionLevel.MANAGE,
      createdAt: now
    },
    {
      id: "permission-reader",
      userId: "reader",
      fileId: file.id,
      folderId: null,
      level: PermissionLevel.READ,
      createdAt: now
    }
  ];

  function shareWithFile(share: MockShare) {
    return { ...share, file: { ...file, versions: [] } };
  }

  return {
    shares,
    updates,
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
        findUnique: async ({ where }: { where: { id: string } }) => {
          return where.id === file.id ? file : null;
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
      },
      shareLink: {
        findMany: async ({ where }: { where: { fileId: string } }) => {
          return Array.from(shares.values())
            .filter((share) => share.fileId === where.fileId)
            .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
        },
        findUnique: async ({ where }: { where: { id?: string; tokenHash?: string } }) => {
          if (where.id) {
            const share = shares.get(where.id);
            return share ? shareWithFile(share) : null;
          }
          if (where.tokenHash) {
            const share = Array.from(shares.values()).find((item) => item.tokenHash === where.tokenHash);
            return share ? shareWithFile(share) : null;
          }
          return null;
        },
        update: async ({ where, data }: { where: { id: string }; data: Partial<MockShare> }) => {
          const current = shares.get(where.id);
          assert.ok(current, `unexpected share update for ${where.id}`);
          const updated = { ...current };
          for (const [key, value] of Object.entries(data)) {
            if (value !== undefined) {
              (updated as Record<string, unknown>)[key] = value;
            }
          }
          shares.set(where.id, updated);
          updates.push({ id: where.id, data });
          return updated;
        }
      }
    }
  };
}

async function inject(
  prisma: unknown,
  options: {
    method: "GET" | "POST" | "PATCH" | "DELETE";
    url: string;
    user?: SessionKey;
    payload?: unknown;
  }
) {
  const app = await buildServer(testEnv, prisma as never);
  try {
    return await app.inject({
      method: options.method,
      url: options.url,
      headers: {
        ...(options.user ? { cookie: `${sessionCookieName}=${sessionTokens[options.user]}` } : {}),
        ...(options.payload === undefined ? {} : { "content-type": "application/json" })
      },
      payload: options.payload === undefined ? undefined : JSON.stringify(options.payload)
    });
  } finally {
    await app.close();
  }
}

function assertNoSensitiveShareFields(share: Record<string, unknown>) {
  assert.equal(Object.hasOwn(share, "token"), false);
  assert.equal(Object.hasOwn(share, "tokenHash"), false);
  assert.equal(Object.hasOwn(share, "url"), false);
  assert.equal(Object.hasOwn(share, "passwordHash"), false);
}

async function assertPublicShareUnavailable(prisma: unknown, token: string) {
  const publicResponse = await inject(prisma, {
    method: "GET",
    url: `/shares/${token}`
  });
  assert.equal(publicResponse.statusCode, 404);
}

test("manage users can list share metadata without leaking secrets", async () => {
  const prisma = createPrisma();

  const response = await inject(prisma.prisma, {
    method: "GET",
    url: "/files/file-1/shares",
    user: "manager"
  });

  assert.equal(response.statusCode, 200);
  const body = response.json() as { shares: Array<Record<string, unknown>> };
  assert.deepEqual(body.shares.map((share) => share.id), ["share-2", "share-1"]);
  assert.equal(body.shares[0].needsPassword, false);
  assert.equal(body.shares[1].needsPassword, true);
  for (const share of body.shares) {
    assertNoSensitiveShareFields(share);
  }
});

test("read-only users cannot list or manage shares", async () => {
  const prisma = createPrisma();

  const listResponse = await inject(prisma.prisma, {
    method: "GET",
    url: "/files/file-1/shares",
    user: "reader"
  });
  assert.equal(listResponse.statusCode, 404);

  const patchResponse = await inject(prisma.prisma, {
    method: "PATCH",
    url: "/shares/share-1",
    user: "reader",
    payload: { maxDownloads: 2 }
  });
  assert.equal(patchResponse.statusCode, 403);

  const revokeResponse = await inject(prisma.prisma, {
    method: "POST",
    url: "/shares/share-1/revoke",
    user: "reader"
  });
  assert.equal(revokeResponse.statusCode, 403);

  const deleteResponse = await inject(prisma.prisma, {
    method: "DELETE",
    url: "/shares/share-1",
    user: "reader"
  });
  assert.equal(deleteResponse.statusCode, 403);
  assert.equal(prisma.shares.get("share-1")?.status, ShareStatus.ACTIVE);
});

test("POST /shares/:id/revoke marks shares REVOKED and disables public token access", async () => {
  const prisma = createPrisma();

  const revokeResponse = await inject(prisma.prisma, {
    method: "POST",
    url: "/shares/share-1/revoke",
    user: "manager"
  });
  assert.equal(revokeResponse.statusCode, 200);
  const revokeBody = revokeResponse.json() as { share: Record<string, unknown> };
  assert.equal(revokeBody.share.status, "revoked");
  assertNoSensitiveShareFields(revokeBody.share);
  assert.equal(prisma.shares.get("share-1")?.status, ShareStatus.REVOKED);

  await assertPublicShareUnavailable(prisma.prisma, publicToken);
});

test("DELETE /shares/:id marks shares REVOKED and disables public token access", async () => {
  const prisma = createPrisma();

  const deleteResponse = await inject(prisma.prisma, {
    method: "DELETE",
    url: "/shares/share-2",
    user: "manager"
  });
  assert.equal(deleteResponse.statusCode, 200);
  const deleteBody = deleteResponse.json() as { share: Record<string, unknown> };
  assert.equal(deleteBody.share.status, "revoked");
  assertNoSensitiveShareFields(deleteBody.share);
  assert.equal(prisma.shares.get("share-2")?.status, ShareStatus.REVOKED);

  await assertPublicShareUnavailable(prisma.prisma, secondPublicToken);
});

test("PATCH /shares/:id updates lifecycle fields and rejects extra fields", async () => {
  const prisma = createPrisma();
  const originalPasswordHash = prisma.shares.get("share-1")?.passwordHash;

  const updateResponse = await inject(prisma.prisma, {
    method: "PATCH",
    url: "/shares/share-1",
    user: "creator",
    payload: {
      expiresAt: "2999-02-01T00:00:00.000Z",
      maxDownloads: 8,
      password: "new-password"
    }
  });
  assert.equal(updateResponse.statusCode, 200);
  const updateBody = updateResponse.json() as { share: Record<string, unknown> };
  assert.equal(updateBody.share.expiresAt, "2999-02-01T00:00:00.000Z");
  assert.equal(updateBody.share.maxDownloads, 8);
  assert.equal(updateBody.share.needsPassword, true);
  assertNoSensitiveShareFields(updateBody.share);
  const updatedPasswordHash = prisma.shares.get("share-1")?.passwordHash;
  assert.equal(typeof updatedPasswordHash, "string");
  assert.notEqual(updatedPasswordHash, originalPasswordHash);
  assert.notEqual(updatedPasswordHash, "new-password");

  const clearPasswordResponse = await inject(prisma.prisma, {
    method: "PATCH",
    url: "/shares/share-1",
    user: "creator",
    payload: { password: null }
  });
  assert.equal(clearPasswordResponse.statusCode, 200);
  const clearPasswordBody = clearPasswordResponse.json() as { share: Record<string, unknown> };
  assert.equal(clearPasswordBody.share.needsPassword, false);
  assertNoSensitiveShareFields(clearPasswordBody.share);
  assert.equal(prisma.shares.get("share-1")?.passwordHash, null);

  const downloadCountResponse = await inject(prisma.prisma, {
    method: "PATCH",
    url: "/shares/share-1",
    user: "creator",
    payload: { downloadCount: 0 }
  });
  assert.equal(downloadCountResponse.statusCode, 400);

  const unknownFieldResponse = await inject(prisma.prisma, {
    method: "PATCH",
    url: "/shares/share-1",
    user: "creator",
    payload: { label: "Quarterly report" }
  });
  assert.equal(unknownFieldResponse.statusCode, 400);
});

test("creator admin and manage users can update and revoke shares while other users are forbidden", async () => {
  for (const user of ["creator", "admin", "manager"] as const) {
    const updatePrisma = createPrisma();
    const updateResponse = await inject(updatePrisma.prisma, {
      method: "PATCH",
      url: "/shares/share-1",
      user,
      payload: { maxDownloads: 5 }
    });
    assert.equal(updateResponse.statusCode, 200);
    assert.equal(updatePrisma.shares.get("share-1")?.maxDownloads, 5);

    const postRevokePrisma = createPrisma();
    const postRevokeResponse = await inject(postRevokePrisma.prisma, {
      method: "POST",
      url: "/shares/share-1/revoke",
      user
    });
    assert.equal(postRevokeResponse.statusCode, 200);
    assert.equal(postRevokePrisma.shares.get("share-1")?.status, ShareStatus.REVOKED);

    const deletePrisma = createPrisma();
    const deleteResponse = await inject(deletePrisma.prisma, {
      method: "DELETE",
      url: "/shares/share-1",
      user
    });
    assert.equal(deleteResponse.statusCode, 200);
    assert.equal(deletePrisma.shares.get("share-1")?.status, ShareStatus.REVOKED);
  }

  const forbiddenRequests = [
    {
      method: "PATCH" as const,
      url: "/shares/share-1",
      payload: { maxDownloads: 6 }
    },
    {
      method: "POST" as const,
      url: "/shares/share-1/revoke"
    },
    {
      method: "DELETE" as const,
      url: "/shares/share-1"
    }
  ];

  for (const request of forbiddenRequests) {
    const prisma = createPrisma();
    const response = await inject(prisma.prisma, {
      ...request,
      user: "stranger"
    });
    assert.equal(response.statusCode, 403);
    assert.equal(prisma.shares.get("share-1")?.status, ShareStatus.ACTIVE);
    assert.equal(prisma.shares.get("share-1")?.maxDownloads, 3);
  }
});
