import assert from "node:assert/strict";
import test from "node:test";
import { StorageNodeStatus, UserRole, type StorageNode } from "@prisma/client";
import { sessionCookieName } from "./auth.js";
import { hashToken } from "./crypto.js";
import type { ApiEnv } from "./env.js";
import { buildServer } from "./server.js";

type AgentBehavior =
  | {
      kind: "status";
      nodeId?: string;
      freeBytes: number;
      totalBytes: number;
    }
  | {
      kind: "http-error";
      status: number;
      body: string;
    }
  | {
      kind: "throw";
      error: Error;
    };

type FetchCall = {
  url: string;
  method: string;
};

const sessionToken = "stage-2-session-token";

const testEnv: ApiEnv = {
  port: 0,
  host: "127.0.0.1",
  databaseUrl: "postgresql://example.invalid/test",
  cookieSecret: "stage-2-cookie-secret-32-byte-value",
  cookieSecure: false,
  masterKey: Buffer.alloc(32, 1),
  sessionTtlDays: 1,
  corsOrigin: "http://localhost:5173",
  publicBaseUrl: "http://localhost:5173",
  maxUploadBytes: 1024 * 1024
};

function makeNode(overrides: Partial<StorageNode>): StorageNode {
  const now = new Date("2026-05-20T00:00:00.000Z");
  return {
    id: "node-a",
    name: "node-a",
    baseUrl: "http://node-a.local",
    agentToken: "agent-token-node-a-123456",
    status: StorageNodeStatus.ACTIVE,
    priority: 100,
    lastSeenAt: null,
    freeBytes: null,
    totalBytes: null,
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

function createPrisma(nodes: StorageNode[]) {
  const storedNodes = new Map(nodes.map((node) => [node.id, node]));
  const storageUpdates: Array<{ id: string; data: Partial<StorageNode> }> = [];
  const adminUser = {
    id: "admin-user",
    email: "admin@example.com",
    name: "Admin",
    role: UserRole.ADMIN,
    passwordHash: "not-used",
    createdAt: new Date("2026-05-20T00:00:00.000Z"),
    updatedAt: new Date("2026-05-20T00:00:00.000Z")
  };

  return {
    storageUpdates,
    prisma: {
      session: {
        findUnique: async ({ where }: { where: { tokenHash: string } }) => {
          assert.equal(where.tokenHash, hashToken(sessionToken));
          return {
            id: "session-1",
            userId: adminUser.id,
            tokenHash: where.tokenHash,
            expiresAt: new Date("2999-01-01T00:00:00.000Z"),
            createdAt: new Date("2026-05-20T00:00:00.000Z"),
            user: adminUser
          };
        },
        delete: async () => undefined
      },
      storageNode: {
        findMany: async () => Array.from(storedNodes.values()),
        update: async ({ where, data }: { where: { id: string }; data: Partial<StorageNode> }) => {
          storageUpdates.push({ id: where.id, data });
          const current = storedNodes.get(where.id);
          assert.ok(current, `unexpected storage node update for ${where.id}`);
          const updated = { ...current, ...data, updatedAt: new Date("2026-05-20T00:00:01.000Z") };
          storedNodes.set(where.id, updated);
          return updated;
        }
      }
    }
  };
}

async function withMockAgent(
  behaviors: Record<string, AgentBehavior>,
  run: (calls: FetchCall[]) => Promise<void>
): Promise<void> {
  const originalFetch = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    const parsed = new URL(url);
    const behavior = behaviors[parsed.origin];

    if (parsed.pathname !== "/status") {
      return new Response(`unexpected fetch in /nodes test: ${method} ${url}`, { status: 500 });
    }

    if (!behavior) {
      return new Response("missing test behavior", { status: 500 });
    }

    if (behavior.kind === "throw") {
      throw behavior.error;
    }

    if (behavior.kind === "http-error") {
      return new Response(behavior.body, { status: behavior.status });
    }

    return Response.json({
      nodeId: behavior.nodeId,
      freeBytes: behavior.freeBytes,
      totalBytes: behavior.totalBytes,
      usedBytes: behavior.totalBytes - behavior.freeBytes,
      objectCount: 0,
      checkedAt: "2026-05-20T00:00:00.000Z"
    });
  }) as typeof fetch;

  try {
    await run(calls);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function injectNodes(prisma: unknown) {
  const app = await buildServer(testEnv, prisma as never);
  try {
    const response = await app.inject({
      method: "GET",
      url: "/nodes",
      headers: {
        cookie: `${sessionCookieName}=${sessionToken}`
      }
    });
    return response;
  } finally {
    await app.close();
  }
}

test("GET /nodes refreshes a reachable node and does not expose agentToken", async () => {
  const prisma = createPrisma([
    makeNode({ id: "node-a", name: "node-a", baseUrl: "http://node-a.local" })
  ]);

  await withMockAgent(
    {
      "http://node-a.local": {
        kind: "status",
        nodeId: "node-a",
        freeBytes: 900,
        totalBytes: 1000
      }
    },
    async () => {
      const response = await injectNodes(prisma.prisma);
      assert.equal(response.statusCode, 200);
      const body = response.json() as { nodes: Array<Record<string, unknown>> };
      assert.equal(body.nodes.length, 1);
      assert.equal(body.nodes[0].status, "active");
      assert.equal(body.nodes[0].freeBytes, "900");
      assert.equal(body.nodes[0].totalBytes, "1000");
      assert.equal(body.nodes[0].lastError, null);
      assert.equal(body.nodes[0].healthMessage, "storage-agent is reachable");
      assert.equal(Object.hasOwn(body.nodes[0], "agentToken"), false);
    }
  );
});

test("GET /nodes does not refresh disabled nodes", async () => {
  const prisma = createPrisma([
    makeNode({
      id: "disabled-node",
      name: "disabled-node",
      baseUrl: "http://disabled.local",
      status: StorageNodeStatus.DISABLED
    })
  ]);

  await withMockAgent(
    {
      "http://disabled.local": {
        kind: "throw",
        error: new Error("disabled node should not be checked")
      }
    },
    async (fetchCalls) => {
      const response = await injectNodes(prisma.prisma);
      assert.equal(response.statusCode, 200);
      const body = response.json() as { nodes: Array<Record<string, unknown>> };
      assert.equal(body.nodes[0].status, "disabled");
      assert.equal(body.nodes[0].lastError, null);
      assert.match(String(body.nodes[0].healthMessage), /disabled.*not checked/);
      assert.equal(fetchCalls.length, 0);
      assert.equal(prisma.storageUpdates.length, 0);
    }
  );
});

test("GET /nodes marks failed health checks OFFLINE with readable health fields", async () => {
  const prisma = createPrisma([
    makeNode({ id: "node-401", name: "node-401", baseUrl: "http://node-401.local" })
  ]);

  await withMockAgent(
    {
      "http://node-401.local": {
        kind: "http-error",
        status: 401,
        body: "{\"error\":\"unauthorized\"}"
      }
    },
    async () => {
      const response = await injectNodes(prisma.prisma);
      assert.equal(response.statusCode, 200);
      const body = response.json() as { nodes: Array<Record<string, unknown>> };
      assert.equal(body.nodes[0].status, "offline");
      assert.match(String(body.nodes[0].healthMessage), /authentication failed/);
      assert.match(String(body.nodes[0].lastError), /authentication failed/);
      assert.equal(prisma.storageUpdates[0].data.status, StorageNodeStatus.OFFLINE);
    }
  );
});
