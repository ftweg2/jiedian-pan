import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { FileVersionStorageLayout, ReplicaStatus, StorageNodeStatus, type StorageNode } from "@prisma/client";
import { decryptChunkBuffer, encryptStreamToChunks, unwrapWrappedFileKey } from "./crypto.js";
import {
  CHUNK_SIZE_BYTES,
  createStreamingChunkUploadStager,
  persistStagedChunkMetadata,
  readAuthenticatedEncryptedChunks,
  readEncryptedObject,
  replicateEncryptedChunks,
  replicateEncryptedObject
} from "./replication.js";

type NodeStatus = {
  nodeId?: string;
  freeBytes: number;
  totalBytes: number;
  usedBytes?: number;
  objectCount?: number;
  checkedAt?: string;
};

type FetchCall = {
  url: string;
  method: string;
};

type ObjectReadBehavior =
  | {
      kind: "ok";
      body: Buffer;
      verifyMatches?: boolean;
    }
  | {
      kind: "http-error";
      status: number;
      body: string;
    };

type ReadReplica = {
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

type ReadChunkReplica = {
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

type ReadChunk = {
  id: string;
  versionId: string;
  index: number;
  plaintextSizeBytes: bigint;
  ciphertextSizeBytes: bigint;
  plaintextSha256: string;
  ciphertextSha256: string;
  encryptionNonce: string | null;
  encryptionAuthTag: string | null;
  replicas: ReadChunkReplica[];
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
    consecutiveProbeFailures: 0,
    lostDeclaredAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

function createPrisma(nodes: StorageNode[]) {
  const storedNodes = new Map(nodes.map((node) => [node.id, node]));
  const storageFindManyInputs: unknown[] = [];
  const storageUpdates: Array<{ id: string; data: Partial<StorageNode> }> = [];
  const replicaCreates: unknown[] = [];
  const chunkCreates: unknown[] = [];
  const chunkReplicaCreates: unknown[] = [];
  let nextReplicaId = 1;
  let nextChunkId = 1;
  let nextChunkReplicaId = 1;

  return {
    storageFindManyInputs,
    storageUpdates,
    replicaCreates,
    chunkCreates,
    chunkReplicaCreates,
    prisma: {
      storageNode: {
        findMany: async (input: unknown) => {
          storageFindManyInputs.push(input);
          return Array.from(storedNodes.values()).filter(
            (node) => node.status !== StorageNodeStatus.DISABLED
          );
        },
        update: async ({ where, data }: { where: { id: string }; data: Partial<StorageNode> }) => {
          storageUpdates.push({ id: where.id, data });
          const current = storedNodes.get(where.id);
          assert.ok(current, `unexpected storage node update for ${where.id}`);
          const updated = { ...current, ...data, updatedAt: new Date() };
          storedNodes.set(where.id, updated);
          return updated;
        }
      },
      objectReplica: {
        create: async ({ data }: { data: unknown }) => {
          replicaCreates.push(data);
          return { id: `replica-${nextReplicaId++}`, ...(data as object) };
        },
        findMany: async () => [],
        update: async () => undefined
      },
      fileChunk: {
        create: async ({ data }: { data: unknown }) => {
          const created = { id: `chunk-${nextChunkId++}`, ...(data as object) };
          chunkCreates.push(created);
          return created;
        }
      },
      chunkReplica: {
        create: async ({ data }: { data: { nodeId: string } }) => {
          const created = { id: `chunk-replica-${nextChunkReplicaId++}`, ...data };
          chunkReplicaCreates.push(created);
          return created;
        },
        findMany: async ({ where }: { where: { id: { in: string[] } } }) => {
          return chunkReplicaCreates
            .filter((replica) => where.id.in.includes((replica as { id: string }).id))
            .map((replica) => ({
              ...(replica as object),
              node: storedNodes.get((replica as { nodeId: string }).nodeId)
            }));
        },
        update: async () => undefined
      }
    }
  };
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function makeReadReplica(overrides: Partial<ReadReplica>): ReadReplica {
  const node = overrides.node ?? makeNode({ id: overrides.nodeId ?? "node-a" });
  return {
    id: "replica-a",
    versionId: "version-read",
    nodeId: node.id,
    objectId: `object-${node.id}`,
    ciphertextSha256: "ciphertext-hash",
    status: ReplicaStatus.AVAILABLE,
    createdAt: new Date("2026-05-20T00:00:00.000Z"),
    verifiedAt: null,
    node,
    ...overrides
  };
}

function createReadPrisma(replicas: ReadReplica[]) {
  const storedReplicas = new Map(replicas.map((replica) => [replica.id, replica]));
  const replicaUpdates: Array<{ id: string; data: Partial<ReadReplica> }> = [];
  const storageUpdates: Array<{ id: string; data: Partial<StorageNode> }> = [];

  return {
    replicas: storedReplicas,
    replicaUpdates,
    storageUpdates,
    prisma: {
      objectReplica: {
        findMany: async () => {
          return Array.from(storedReplicas.values())
            .filter(
              (replica) =>
                replica.versionId === "version-read" &&
                replica.status === ReplicaStatus.AVAILABLE &&
                (replica.node.status === StorageNodeStatus.ACTIVE || replica.node.status === StorageNodeStatus.DEGRADED)
            )
            .sort((left, right) => {
              const verifiedDiff = (right.verifiedAt?.getTime() ?? 0) - (left.verifiedAt?.getTime() ?? 0);
              return verifiedDiff || left.createdAt.getTime() - right.createdAt.getTime();
            });
        },
        update: async ({ where, data }: { where: { id: string }; data: Partial<ReadReplica> }) => {
          replicaUpdates.push({ id: where.id, data });
          const current = storedReplicas.get(where.id);
          assert.ok(current, `unexpected replica update for ${where.id}`);
          const updated = { ...current, ...data };
          storedReplicas.set(where.id, updated);
          return updated;
        }
      },
      storageNode: {
        update: async ({ where, data }: { where: { id: string }; data: Partial<StorageNode> }) => {
          storageUpdates.push({ id: where.id, data });
          return { ...makeNode({ id: where.id }), ...data };
        }
      }
    }
  };
}

function makeReadChunkReplica(overrides: Partial<ReadChunkReplica>): ReadChunkReplica {
  const node = overrides.node ?? makeNode({ id: overrides.nodeId ?? "node-a" });
  return {
    id: "chunk-replica-a",
    chunkId: "chunk-a",
    nodeId: node.id,
    objectId: `chunk-object-${node.id}`,
    ciphertextSha256: "chunk-ciphertext-hash",
    status: ReplicaStatus.AVAILABLE,
    createdAt: new Date("2026-05-20T00:00:00.000Z"),
    verifiedAt: null,
    node,
    ...overrides
  };
}

function makeReadChunk(overrides: Partial<ReadChunk>): ReadChunk {
  return {
    id: "chunk-a",
    versionId: "version-chunked-read",
    index: 0,
    plaintextSizeBytes: 0n,
    ciphertextSizeBytes: 0n,
    plaintextSha256: "plaintext-hash",
    ciphertextSha256: "chunk-ciphertext-hash",
    encryptionNonce: null,
    encryptionAuthTag: null,
    replicas: [],
    ...overrides
  };
}

function createChunkReadPrisma(input: {
  versionId?: string;
  chunkCount: number | null;
  chunks: ReadChunk[];
}) {
  const versionId = input.versionId ?? "version-chunked-read";
  const storedChunks = new Map(input.chunks.map((chunk) => [chunk.id, chunk]));
  const chunkReplicaUpdates: Array<{ id: string; data: Partial<ReadChunkReplica> }> = [];
  const storageUpdates: Array<{ id: string; data: Partial<StorageNode> }> = [];

  return {
    chunks: storedChunks,
    chunkReplicaUpdates,
    storageUpdates,
    prisma: {
      fileVersion: {
        findUnique: async ({ where }: { where: { id: string } }) => {
          if (where.id !== versionId) return null;
          return {
            storageLayout: FileVersionStorageLayout.CHUNKED,
            chunkCount: input.chunkCount
          };
        }
      },
      fileChunk: {
        findMany: async () => {
          return Array.from(storedChunks.values())
            .filter((chunk) => chunk.versionId === versionId)
            .sort((left, right) => left.index - right.index)
            .map((chunk) => ({
              ...chunk,
              replicas: chunk.replicas
                .filter(
                  (replica) =>
                    replica.status === ReplicaStatus.AVAILABLE &&
                    (replica.node.status === StorageNodeStatus.ACTIVE || replica.node.status === StorageNodeStatus.DEGRADED)
                )
                .sort((left, right) => {
                  const verifiedDiff = (right.verifiedAt?.getTime() ?? 0) - (left.verifiedAt?.getTime() ?? 0);
                  return verifiedDiff || left.createdAt.getTime() - right.createdAt.getTime();
                })
            }));
        }
      },
      chunkReplica: {
        update: async ({ where, data }: { where: { id: string }; data: Partial<ReadChunkReplica> }) => {
          chunkReplicaUpdates.push({ id: where.id, data });
          for (const chunk of storedChunks.values()) {
            const index = chunk.replicas.findIndex((replica) => replica.id === where.id);
            if (index >= 0) {
              chunk.replicas[index] = { ...chunk.replicas[index], ...data };
              return chunk.replicas[index];
            }
          }
          assert.fail(`unexpected chunk replica update for ${where.id}`);
        }
      },
      storageNode: {
        update: async ({ where, data }: { where: { id: string }; data: Partial<StorageNode> }) => {
          storageUpdates.push({ id: where.id, data });
          return { ...makeNode({ id: where.id }), ...data };
        }
      }
    }
  };
}

function createChunkReadPrismaFromReplication(input: {
  versionId: string;
  chunkCount: number;
  ciphertext: Buffer;
  chunkCreates: unknown[];
  chunkReplicaCreates: unknown[];
  nodesById: Map<string, StorageNode>;
}) {
  const chunks = input.chunkCreates.map((chunkCreate) => {
    const chunkRecord = chunkCreate as {
      id: string;
      index: number;
      plaintextSizeBytes: bigint;
      ciphertextSizeBytes: bigint;
      plaintextSha256: string;
      ciphertextSha256: string;
      encryptionNonce?: string | null;
      encryptionAuthTag?: string | null;
    };
    const replicas = input.chunkReplicaCreates
      .filter((replica) => (replica as { chunkId: string }).chunkId === chunkRecord.id)
      .map((replica) => {
        const replicaRecord = replica as {
          id: string;
          chunkId: string;
          nodeId: string;
          objectId: string;
          ciphertextSha256: string;
          status: ReplicaStatus;
          verifiedAt: Date | null;
        };
        return makeReadChunkReplica({
          ...replicaRecord,
          node: input.nodesById.get(replicaRecord.nodeId)
        });
      });
    return makeReadChunk({
      id: chunkRecord.id,
      versionId: input.versionId,
      index: chunkRecord.index,
      plaintextSizeBytes: chunkRecord.plaintextSizeBytes,
      ciphertextSizeBytes: chunkRecord.ciphertextSizeBytes,
      plaintextSha256: chunkRecord.plaintextSha256,
      ciphertextSha256: chunkRecord.ciphertextSha256,
      encryptionNonce: chunkRecord.encryptionNonce ?? null,
      encryptionAuthTag: chunkRecord.encryptionAuthTag ?? null,
      replicas
    });
  });

  return createChunkReadPrisma({
    versionId: input.versionId,
    chunkCount: input.chunkCount,
    chunks
  });
}

function splitCiphertextForTest(ciphertext: Buffer, chunkSizeBytes = CHUNK_SIZE_BYTES): Buffer[] {
  const chunks: Buffer[] = [];
  const count = Math.max(1, Math.ceil(ciphertext.byteLength / chunkSizeBytes));
  for (let index = 0; index < count; index += 1) {
    const start = index * chunkSizeBytes;
    chunks.push(Buffer.from(ciphertext.subarray(start, Math.min(start + chunkSizeBytes, ciphertext.byteLength))));
  }
  return chunks;
}

async function collectAsync<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) {
    items.push(item);
  }
  return items;
}

async function* chunksFrom(parts: Buffer[]): AsyncGenerator<Buffer> {
  for (const part of parts) {
    yield part;
  }
}

function makeReadChunkFromEncryptedChunk(
  chunk: {
    index: number;
    plaintextSizeBytes: number;
    ciphertextSizeBytes: number;
    plaintextSha256: string;
    ciphertextSha256: string;
    encryptionNonce: string;
    encryptionAuthTag: string;
  },
  replicas: ReadChunkReplica[]
): ReadChunk {
  return makeReadChunk({
    id: `chunk-${chunk.index}`,
    versionId: "version-chunked-read",
    index: chunk.index,
    plaintextSizeBytes: BigInt(chunk.plaintextSizeBytes),
    ciphertextSizeBytes: BigInt(chunk.ciphertextSizeBytes),
    plaintextSha256: chunk.plaintextSha256,
    ciphertextSha256: chunk.ciphertextSha256,
    encryptionNonce: chunk.encryptionNonce,
    encryptionAuthTag: chunk.encryptionAuthTag,
    replicas
  });
}

async function withMockAgent(
  statuses: Record<string, NodeStatus | Error>,
  run: (calls: FetchCall[]) => Promise<void>
): Promise<void> {
  const originalFetch = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    const parsed = new URL(url);
    const origin = parsed.origin;

    if (parsed.pathname === "/status") {
      const status = statuses[origin];
      if (status instanceof Error) {
        throw status;
      }
      if (!status) {
        return new Response("missing test status", { status: 500 });
      }
      return Response.json({
        usedBytes: 0,
        objectCount: 0,
        checkedAt: "2026-05-20T00:00:00.000Z",
        ...status
      });
    }

    if (method === "PUT" && parsed.pathname.startsWith("/objects/")) {
      const headers = new Headers(init?.headers);
      return Response.json({
        objectId: decodeURIComponent(parsed.pathname.slice("/objects/".length)),
        sizeBytes: Number(headers.get("x-size-bytes") ?? 0),
        ciphertextSha256: headers.get("x-ciphertext-sha256") ?? ""
      });
    }

    if (method === "DELETE" && parsed.pathname.startsWith("/objects/")) {
      return new Response(null, { status: 204 });
    }

    return new Response(`unexpected fetch in replication test: ${method} ${url}`, { status: 500 });
  }) as typeof fetch;

  try {
    await run(calls);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function withMockObjectReads(
  behaviors: Record<string, ObjectReadBehavior>,
  run: (calls: FetchCall[]) => Promise<void>
): Promise<void> {
  const originalFetch = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    const parsed = new URL(url);

    if (method === "GET" && parsed.pathname.startsWith("/objects/")) {
      const objectId = decodeURIComponent(parsed.pathname.slice("/objects/".length));
      const behavior = behaviors[objectId];
      if (!behavior) {
        return new Response("missing test object behavior", { status: 500 });
      }
      if (behavior.kind === "http-error") {
        return new Response(behavior.body, { status: behavior.status });
      }
      return new Response(behavior.body as BodyInit);
    }

    if (method === "POST" && parsed.pathname.startsWith("/objects/") && parsed.pathname.endsWith("/verify")) {
      const objectId = decodeURIComponent(parsed.pathname.slice("/objects/".length, -"/verify".length));
      const behavior = behaviors[objectId];
      if (!behavior || behavior.kind !== "ok") {
        return new Response("missing test verify behavior", { status: 500 });
      }
      return Response.json({
        objectId,
        exists: true,
        sizeBytes: behavior.body.byteLength,
        ciphertextSha256: sha256(behavior.body),
        matches: behavior.verifyMatches ?? true
      });
    }

    return new Response(`unexpected fetch in readEncryptedObject test: ${method} ${url}`, { status: 500 });
  }) as typeof fetch;

  try {
    await run(calls);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("standard file selects one active node with enough capacity", async () => {
  const ciphertext = Buffer.from("standard ciphertext");
  const prisma = createPrisma([
    makeNode({ id: "node-a", name: "node-a", baseUrl: "http://node-a.local" })
  ]);

  await withMockAgent(
    {
      "http://node-a.local": {
        nodeId: "node-a",
        freeBytes: ciphertext.byteLength + 1,
        totalBytes: 1024
      }
    },
    async (fetchCalls) => {
      const result = await replicateEncryptedObject(
        prisma.prisma as never,
        "version-standard",
        "standard",
        ciphertext,
        "ciphertext-hash"
      );

      assert.deepEqual(result.nodeIds, ["node-a"]);
      assert.deepEqual(result.replicaIds, ["replica-1"]);
      assert.equal(prisma.replicaCreates.length, 1);
      assert.equal((prisma.replicaCreates[0] as { nodeId: string }).nodeId, "node-a");
      assert.equal(fetchCalls.filter((call) => call.method === "PUT").length, 1);
    }
  );
});

test("important file fails when only one active storage node is available", async () => {
  const ciphertext = Buffer.from("important ciphertext");
  const prisma = createPrisma([
    makeNode({ id: "node-a", name: "node-a", baseUrl: "http://node-a.local" })
  ]);

  await withMockAgent(
    {
      "http://node-a.local": {
        nodeId: "node-a",
        freeBytes: ciphertext.byteLength + 1,
        totalBytes: 1024
      }
    },
    async () => {
      await assert.rejects(
        () =>
          replicateEncryptedObject(
            prisma.prisma as never,
            "version-important",
            "important",
            ciphertext,
            "ciphertext-hash"
          ),
        /not enough active storage nodes/
      );

      assert.equal(prisma.replicaCreates.length, 0);
    }
  );
});

test("standard file fails when active nodes do not have enough capacity", async () => {
  const ciphertext = Buffer.from("oversized ciphertext");
  const prisma = createPrisma([
    makeNode({ id: "node-a", name: "node-a", baseUrl: "http://node-a.local" })
  ]);

  await withMockAgent(
    {
      "http://node-a.local": {
        nodeId: "node-a",
        freeBytes: ciphertext.byteLength - 1,
        totalBytes: 1024
      }
    },
    async () => {
      await assert.rejects(
        () =>
          replicateEncryptedObject(
            prisma.prisma as never,
            "version-standard",
            "standard",
            ciphertext,
            "ciphertext-hash"
          ),
        /not enough storage capacity/
      );

      assert.equal(prisma.replicaCreates.length, 0);
    }
  );
});

test("important file fails when active nodes are available but replica capacity is insufficient", async () => {
  const ciphertext = Buffer.from("important ciphertext");
  const prisma = createPrisma([
    makeNode({ id: "node-a", name: "node-a", baseUrl: "http://node-a.local", priority: 1 }),
    makeNode({ id: "node-b", name: "node-b", baseUrl: "http://node-b.local", priority: 2 })
  ]);

  await withMockAgent(
    {
      "http://node-a.local": {
        nodeId: "node-a",
        freeBytes: ciphertext.byteLength + 1,
        totalBytes: 1024
      },
      "http://node-b.local": {
        nodeId: "node-b",
        freeBytes: ciphertext.byteLength - 1,
        totalBytes: 1024
      }
    },
    async () => {
      await assert.rejects(
        () =>
          replicateEncryptedObject(
            prisma.prisma as never,
            "version-important",
            "important",
            ciphertext,
            "ciphertext-hash"
          ),
        /not enough capacity for important replicas/
      );

      assert.equal(prisma.replicaCreates.length, 0);
    }
  );
});

test("replication marks a node OFFLINE when status refresh fails and continues to another node", async () => {
  const ciphertext = Buffer.from("standard ciphertext");
  const prisma = createPrisma([
    makeNode({ id: "node-a", name: "node-a", baseUrl: "http://node-a.local", priority: 1 }),
    makeNode({ id: "node-b", name: "node-b", baseUrl: "http://node-b.local", priority: 2 })
  ]);

  await withMockAgent(
    {
      "http://node-a.local": new Error("status unavailable"),
      "http://node-b.local": {
        nodeId: "node-b",
        freeBytes: ciphertext.byteLength + 1,
        totalBytes: 1024
      }
    },
    async () => {
      const result = await replicateEncryptedObject(
        prisma.prisma as never,
        "version-standard",
        "standard",
        ciphertext,
        "ciphertext-hash"
      );

      assert.deepEqual(result.nodeIds, ["node-b"]);
      assert.ok(
        prisma.storageUpdates.some(
          (update) => update.id === "node-a" && update.data.status === StorageNodeStatus.OFFLINE
        )
      );
      assert.equal((prisma.replicaCreates[0] as { status: ReplicaStatus }).status, ReplicaStatus.AVAILABLE);
    }
  );
});

test("disabled storage nodes are excluded from writable node selection", async () => {
  const ciphertext = Buffer.from("standard ciphertext");
  const prisma = createPrisma([
    makeNode({
      id: "disabled-node",
      name: "disabled-node",
      baseUrl: "http://disabled.local",
      status: StorageNodeStatus.DISABLED,
      priority: 1
    }),
    makeNode({ id: "node-a", name: "node-a", baseUrl: "http://node-a.local", priority: 2 })
  ]);

  await withMockAgent(
    {
      "http://disabled.local": new Error("disabled nodes must not be refreshed"),
      "http://node-a.local": {
        nodeId: "node-a",
        freeBytes: ciphertext.byteLength + 1,
        totalBytes: 1024
      }
    },
    async (fetchCalls) => {
      const result = await replicateEncryptedObject(
        prisma.prisma as never,
        "version-standard",
        "standard",
        ciphertext,
        "ciphertext-hash"
      );

      assert.deepEqual(result.nodeIds, ["node-a"]);
      assert.deepEqual(
        (prisma.storageFindManyInputs[0] as { where: { status: { not: StorageNodeStatus } } }).where.status,
        { not: StorageNodeStatus.DISABLED }
      );
      assert.equal(fetchCalls.some((call) => call.url.startsWith("http://disabled.local")), false);
    }
  );
});

test("readEncryptedObject falls back after read failure or hash mismatch and marks the bad replica MISSING", async () => {
  const scenarios: Array<{ name: string; failedBehavior: ObjectReadBehavior }> = [
    {
      name: "read failure",
      failedBehavior: { kind: "http-error", status: 500, body: "object unavailable" }
    },
    {
      name: "hash mismatch",
      failedBehavior: { kind: "ok", body: Buffer.from("corrupt ciphertext") }
    }
  ];

  for (const scenario of scenarios) {
    const goodCiphertext = Buffer.from(`healthy ciphertext for ${scenario.name}`);
    const goodHash = sha256(goodCiphertext);
    const failedReplica = makeReadReplica({
      id: `replica-failed-${scenario.name.replace(" ", "-")}`,
      node: makeNode({ id: `node-failed-${scenario.name.replace(" ", "-")}`, baseUrl: `http://failed-${scenario.name.replace(" ", "-")}.local` }),
      objectId: `object-failed-${scenario.name.replace(" ", "-")}`,
      ciphertextSha256: goodHash,
      createdAt: new Date("2026-05-20T00:00:00.000Z")
    });
    const healthyReplica = makeReadReplica({
      id: `replica-healthy-${scenario.name.replace(" ", "-")}`,
      node: makeNode({ id: `node-healthy-${scenario.name.replace(" ", "-")}`, baseUrl: `http://healthy-${scenario.name.replace(" ", "-")}.local` }),
      objectId: `object-healthy-${scenario.name.replace(" ", "-")}`,
      ciphertextSha256: goodHash,
      createdAt: new Date("2026-05-20T00:00:01.000Z")
    });
    const prisma = createReadPrisma([failedReplica, healthyReplica]);

    await withMockObjectReads(
      {
        [failedReplica.objectId]: scenario.failedBehavior,
        [healthyReplica.objectId]: { kind: "ok", body: goodCiphertext }
      },
      async (fetchCalls) => {
        const result = await readEncryptedObject(prisma.prisma as never, "version-read");

        assert.deepEqual(result, goodCiphertext);
        assert.equal(prisma.replicas.get(failedReplica.id)?.status, ReplicaStatus.MISSING);
        assert.equal(prisma.replicas.get(healthyReplica.id)?.status, ReplicaStatus.AVAILABLE);
        assert.ok(
          prisma.replicaUpdates.some(
            (update) => update.id === failedReplica.id && update.data.status === ReplicaStatus.MISSING
          )
        );
        assert.ok(
          prisma.replicaUpdates.some(
            (update) =>
              update.id === healthyReplica.id &&
              update.data.status === ReplicaStatus.AVAILABLE &&
              update.data.verifiedAt instanceof Date
          )
        );
        assert.deepEqual(
          fetchCalls.filter((call) => call.method === "GET").map((call) => new URL(call.url).pathname),
          [`/objects/${failedReplica.objectId}`, `/objects/${healthyReplica.objectId}`]
        );
        assert.equal(fetchCalls.some((call) => call.url.endsWith(`${failedReplica.objectId}/verify`)), false);
        assert.ok(fetchCalls.some((call) => call.url.endsWith(`${healthyReplica.objectId}/verify`)));
      }
    );
  }
});

test("replicateEncryptedChunks creates one standard chunk with correct metadata", async () => {
  const plaintext = Buffer.from("small plaintext");
  const ciphertext = Buffer.from("small ciphertext");
  const node = makeNode({ id: "node-a", name: "node-a", baseUrl: "http://node-a.local" });
  const prisma = createPrisma([node]);

  await withMockAgent(
    {
      "http://node-a.local": {
        nodeId: "node-a",
        freeBytes: ciphertext.byteLength + 1,
        totalBytes: 1024
      }
    },
    async (fetchCalls) => {
      const result = await replicateEncryptedChunks(
        prisma.prisma as never,
        "version-small-chunked",
        "standard",
        ciphertext,
        plaintext
      );

      assert.equal(result.chunkCount, 1);
      assert.equal(result.chunkSizeBytes, CHUNK_SIZE_BYTES);
      assert.deepEqual(result.chunkIds, ["chunk-1"]);
      assert.deepEqual(result.replicaIds, ["chunk-replica-1"]);
      assert.deepEqual(result.nodeIds, ["node-a"]);

      const chunk = prisma.chunkCreates[0] as {
        versionId: string;
        index: number;
        plaintextSizeBytes: bigint;
        ciphertextSizeBytes: bigint;
        plaintextSha256: string;
        ciphertextSha256: string;
        encryptionNonce: string | null;
        encryptionAuthTag: string | null;
      };
      assert.equal(chunk.versionId, "version-small-chunked");
      assert.equal(chunk.index, 0);
      assert.equal(chunk.plaintextSizeBytes, BigInt(plaintext.byteLength));
      assert.equal(chunk.ciphertextSizeBytes, BigInt(ciphertext.byteLength));
      assert.equal(chunk.plaintextSha256, sha256(plaintext));
      assert.equal(chunk.ciphertextSha256, sha256(ciphertext));
      assert.equal(chunk.encryptionNonce, null);
      assert.equal(chunk.encryptionAuthTag, null);

      const replica = prisma.chunkReplicaCreates[0] as {
        chunkId: string;
        nodeId: string;
        ciphertextSha256: string;
        status: ReplicaStatus;
      };
      assert.equal(replica.chunkId, "chunk-1");
      assert.equal(replica.nodeId, "node-a");
      assert.equal(replica.ciphertextSha256, sha256(ciphertext));
      assert.equal(replica.status, ReplicaStatus.AVAILABLE);
      assert.equal(fetchCalls.filter((call) => call.method === "PUT").length, 1);
    }
  );
});

test("replicateEncryptedChunks splits larger than 8 MiB and readEncryptedObject reassembles chunked ciphertext", async () => {
  const plaintext = Buffer.alloc(CHUNK_SIZE_BYTES + 17, 3);
  const ciphertext = Buffer.alloc(CHUNK_SIZE_BYTES + 17, 7);
  const node = makeNode({ id: "node-a", name: "node-a", baseUrl: "http://node-a.local" });
  const nodesById = new Map([[node.id, node]]);
  const prisma = createPrisma([node]);

  await withMockAgent(
    {
      "http://node-a.local": {
        nodeId: "node-a",
        freeBytes: ciphertext.byteLength + 1,
        totalBytes: ciphertext.byteLength + 1024
      }
    },
    async () => {
      const result = await replicateEncryptedChunks(
        prisma.prisma as never,
        "version-large-chunked",
        "standard",
        ciphertext,
        plaintext
      );

      assert.equal(result.chunkCount, 2);
      assert.deepEqual(
        prisma.chunkCreates.map((chunk) => (chunk as { index: number }).index),
        [0, 1]
      );

      const chunkBuffers = splitCiphertextForTest(ciphertext);
      assert.deepEqual(
        prisma.chunkCreates.map((chunk) => (chunk as { ciphertextSha256: string }).ciphertextSha256),
        chunkBuffers.map(sha256)
      );

      const readPrisma = createChunkReadPrismaFromReplication({
        versionId: "version-large-chunked",
        chunkCount: result.chunkCount,
        ciphertext,
        chunkCreates: prisma.chunkCreates,
        chunkReplicaCreates: prisma.chunkReplicaCreates,
        nodesById
      });
      const behaviors: Record<string, ObjectReadBehavior> = {};
      for (const chunk of readPrisma.chunks.values()) {
        for (const replica of chunk.replicas) {
          behaviors[replica.objectId] = { kind: "ok", body: chunkBuffers[chunk.index] };
        }
      }

      await withMockObjectReads(behaviors, async () => {
        const reassembled = await readEncryptedObject(readPrisma.prisma as never, "version-large-chunked");
        assert.deepEqual(reassembled, ciphertext);
      });
    }
  );
});

test("replicateEncryptedChunks writes two distinct node replicas per important chunk", async () => {
  const plaintext = Buffer.alloc(CHUNK_SIZE_BYTES + 5, 1);
  const ciphertext = Buffer.alloc(CHUNK_SIZE_BYTES + 5, 2);
  const nodes = [
    makeNode({ id: "node-a", name: "node-a", baseUrl: "http://node-a.local", priority: 1 }),
    makeNode({ id: "node-b", name: "node-b", baseUrl: "http://node-b.local", priority: 2 })
  ];
  const prisma = createPrisma(nodes);

  await withMockAgent(
    {
      "http://node-a.local": {
        nodeId: "node-a",
        freeBytes: ciphertext.byteLength + 1,
        totalBytes: ciphertext.byteLength + 1024
      },
      "http://node-b.local": {
        nodeId: "node-b",
        freeBytes: ciphertext.byteLength + 1,
        totalBytes: ciphertext.byteLength + 1024
      }
    },
    async () => {
      const result = await replicateEncryptedChunks(
        prisma.prisma as never,
        "version-important-chunked",
        "important",
        ciphertext,
        plaintext
      );

      assert.equal(result.chunkCount, 2);
      assert.deepEqual(result.nodeIds.sort(), ["node-a", "node-b"]);
      assert.equal(prisma.chunkReplicaCreates.length, 4);
      for (const chunkId of result.chunkIds) {
        const nodeIds = prisma.chunkReplicaCreates
          .filter((replica) => (replica as { chunkId: string }).chunkId === chunkId)
          .map((replica) => (replica as { nodeId: string }).nodeId)
          .sort();
        assert.deepEqual(nodeIds, ["node-a", "node-b"]);
      }
    }
  );
});

test("replicateEncryptedChunks fails clearly for important chunks when nodes or capacity are insufficient", async () => {
  const plaintext = Buffer.from("important plaintext");
  const ciphertext = Buffer.from("important ciphertext");

  const oneNodePrisma = createPrisma([
    makeNode({ id: "node-a", name: "node-a", baseUrl: "http://node-a.local" })
  ]);
  await withMockAgent(
    {
      "http://node-a.local": {
        nodeId: "node-a",
        freeBytes: ciphertext.byteLength + 1,
        totalBytes: 1024
      }
    },
    async () => {
      await assert.rejects(
        () =>
          replicateEncryptedChunks(
            oneNodePrisma.prisma as never,
            "version-important-one-node",
            "important",
            ciphertext,
            plaintext
          ),
        /not enough active storage nodes/
      );
      assert.equal(oneNodePrisma.chunkCreates.length, 0);
      assert.equal(oneNodePrisma.chunkReplicaCreates.length, 0);
    }
  );

  const lowCapacityPrisma = createPrisma([
    makeNode({ id: "node-a", name: "node-a", baseUrl: "http://node-a.local", priority: 1 }),
    makeNode({ id: "node-b", name: "node-b", baseUrl: "http://node-b.local", priority: 2 })
  ]);
  await withMockAgent(
    {
      "http://node-a.local": {
        nodeId: "node-a",
        freeBytes: ciphertext.byteLength + 1,
        totalBytes: 1024
      },
      "http://node-b.local": {
        nodeId: "node-b",
        freeBytes: ciphertext.byteLength - 1,
        totalBytes: 1024
      }
    },
    async () => {
      await assert.rejects(
        () =>
          replicateEncryptedChunks(
            lowCapacityPrisma.prisma as never,
            "version-important-low-capacity",
            "important",
            ciphertext,
            plaintext
          ),
        /not enough capacity for important replicas/
      );
      assert.equal(lowCapacityPrisma.chunkCreates.length, 0);
      assert.equal(lowCapacityPrisma.chunkReplicaCreates.length, 0);
    }
  );
});

test("readEncryptedObject falls back to another replica in the same chunk after read failure", async () => {
  const chunkCiphertext = Buffer.from("chunk ciphertext");
  const chunkHash = sha256(chunkCiphertext);
  const failedReplica = makeReadChunkReplica({
    id: "chunk-replica-failed",
    chunkId: "chunk-0",
    node: makeNode({ id: "node-failed", baseUrl: "http://node-failed.local" }),
    objectId: "chunk-object-failed",
    ciphertextSha256: chunkHash,
    createdAt: new Date("2026-05-20T00:00:00.000Z")
  });
  const healthyReplica = makeReadChunkReplica({
    id: "chunk-replica-healthy",
    chunkId: "chunk-0",
    node: makeNode({ id: "node-healthy", baseUrl: "http://node-healthy.local" }),
    objectId: "chunk-object-healthy",
    ciphertextSha256: chunkHash,
    createdAt: new Date("2026-05-20T00:00:01.000Z")
  });
  const prisma = createChunkReadPrisma({
    chunkCount: 1,
    chunks: [
      makeReadChunk({
        id: "chunk-0",
        index: 0,
        plaintextSizeBytes: BigInt(chunkCiphertext.byteLength),
        ciphertextSizeBytes: BigInt(chunkCiphertext.byteLength),
        plaintextSha256: sha256(chunkCiphertext),
        ciphertextSha256: chunkHash,
        replicas: [failedReplica, healthyReplica]
      })
    ]
  });

  await withMockObjectReads(
    {
      [failedReplica.objectId]: { kind: "http-error", status: 500, body: "chunk unavailable" },
      [healthyReplica.objectId]: { kind: "ok", body: chunkCiphertext }
    },
    async () => {
      const result = await readEncryptedObject(prisma.prisma as never, "version-chunked-read");

      assert.deepEqual(result, chunkCiphertext);
      assert.equal(prisma.chunks.get("chunk-0")?.replicas[0].status, ReplicaStatus.MISSING);
      assert.ok(
        prisma.chunkReplicaUpdates.some(
          (update) => update.id === failedReplica.id && update.data.status === ReplicaStatus.MISSING
        )
      );
      assert.ok(
        prisma.chunkReplicaUpdates.some(
          (update) =>
            update.id === healthyReplica.id &&
            update.data.status === ReplicaStatus.AVAILABLE &&
            update.data.verifiedAt instanceof Date
        )
      );
    }
  );
});

test("readEncryptedObject reports chunk hash mismatch and marks the failed chunk replica MISSING", async () => {
  const expectedCiphertext = Buffer.from("expected chunk ciphertext");
  const corruptCiphertext = Buffer.from("corrupt chunk ciphertext");
  const chunkHash = sha256(expectedCiphertext);
  const replica = makeReadChunkReplica({
    id: "chunk-replica-corrupt",
    chunkId: "chunk-0",
    objectId: "chunk-object-corrupt",
    ciphertextSha256: chunkHash
  });
  const prisma = createChunkReadPrisma({
    chunkCount: 1,
    chunks: [
      makeReadChunk({
        id: "chunk-0",
        index: 0,
        plaintextSizeBytes: BigInt(expectedCiphertext.byteLength),
        ciphertextSizeBytes: BigInt(expectedCiphertext.byteLength),
        plaintextSha256: sha256(expectedCiphertext),
        ciphertextSha256: chunkHash,
        replicas: [replica]
      })
    ]
  });

  await withMockObjectReads(
    {
      [replica.objectId]: { kind: "ok", body: corruptCiphertext }
    },
    async () => {
      await assert.rejects(
        () => readEncryptedObject(prisma.prisma as never, "version-chunked-read"),
        /no readable chunk replica found: chunk 0: chunk 0 ciphertext hash mismatch/
      );
      assert.equal(prisma.chunks.get("chunk-0")?.replicas[0].status, ReplicaStatus.MISSING);
      assert.ok(
        prisma.chunkReplicaUpdates.some(
          (update) => update.id === replica.id && update.data.status === ReplicaStatus.MISSING
        )
      );
    }
  );
});

test("readEncryptedObject rejects chunked versions with missing chunk metadata", async () => {
  const chunkCiphertext = Buffer.from("chunk zero");
  const chunkHash = sha256(chunkCiphertext);
  const chunk0 = makeReadChunk({
    id: "chunk-0",
    index: 0,
    plaintextSizeBytes: BigInt(chunkCiphertext.byteLength),
    ciphertextSizeBytes: BigInt(chunkCiphertext.byteLength),
    plaintextSha256: sha256(chunkCiphertext),
    ciphertextSha256: chunkHash,
    replicas: [
      makeReadChunkReplica({
        id: "chunk-replica-0",
        chunkId: "chunk-0",
        objectId: "chunk-object-0",
        ciphertextSha256: chunkHash
      })
    ]
  });

  const missingDeclaredCount = createChunkReadPrisma({
    chunkCount: null,
    chunks: [chunk0]
  });
  await assert.rejects(
    () => readEncryptedObject(missingDeclaredCount.prisma as never, "version-chunked-read"),
    /missing chunk metadata: declared chunk count is null/
  );

  const missingChunkRecord = createChunkReadPrisma({
    chunkCount: 2,
    chunks: [chunk0]
  });
  await assert.rejects(
    () => readEncryptedObject(missingChunkRecord.prisma as never, "version-chunked-read"),
    /missing chunk metadata: declared 2, found 1/
  );

  const chunk2 = makeReadChunk({
    id: "chunk-2",
    index: 2,
    plaintextSizeBytes: BigInt(chunkCiphertext.byteLength),
    ciphertextSizeBytes: BigInt(chunkCiphertext.byteLength),
    plaintextSha256: sha256(chunkCiphertext),
    ciphertextSha256: chunkHash,
    replicas: [
      makeReadChunkReplica({
        id: "chunk-replica-2",
        chunkId: "chunk-2",
        objectId: "chunk-object-2",
        ciphertextSha256: chunkHash
      })
    ]
  });
  const missingIndex = createChunkReadPrisma({
    chunkCount: 2,
    chunks: [chunk0, chunk2]
  });
  await withMockObjectReads(
    {
      "chunk-object-0": { kind: "ok", body: chunkCiphertext }
    },
    async () => {
      await assert.rejects(
        () => readEncryptedObject(missingIndex.prisma as never, "version-chunked-read"),
        /chunk metadata incomplete: expected chunk index 1/
      );
    }
  );
});

test("encryptStreamToChunks emits per-chunk auth metadata without waiting for the full plaintext", async () => {
  const masterKey = Buffer.alloc(32, 7);
  const parts = [Buffer.from("ab"), Buffer.from("cd"), Buffer.from("ef")];
  const emitted: Array<{
    index: number;
    plaintextSizeBytes: number;
    ciphertextSizeBytes: number;
    plaintextSha256: string;
    ciphertextSha256: string;
    encryptionNonce: string;
    encryptionAuthTag: string;
    ciphertext: Buffer;
  }> = [];
  const readsAtEmit: number[] = [];
  let sourceReads = 0;

  async function* source() {
    for (const part of parts) {
      sourceReads += 1;
      yield part;
    }
  }

  const result = await encryptStreamToChunks(source(), masterKey, 4, async (chunk) => {
    emitted.push(chunk);
    readsAtEmit.push(sourceReads);
  });

  assert.equal(result.plaintextSizeBytes, 6);
  assert.equal(result.ciphertextSizeBytes, emitted.reduce((total, chunk) => total + chunk.ciphertextSizeBytes, 0));
  assert.equal(result.chunkCount, 2);
  assert.deepEqual(emitted.map((chunk) => chunk.index), [0, 1]);
  assert.deepEqual(emitted.map((chunk) => chunk.plaintextSizeBytes), [4, 2]);
  assert.ok(readsAtEmit[0] < parts.length, "first encrypted chunk should be emitted before the full source is consumed");
  assert.ok(emitted.every((chunk) => chunk.encryptionNonce.length > 0));
  assert.ok(emitted.every((chunk) => chunk.encryptionAuthTag.length > 0));
  assert.notEqual(emitted[0].encryptionNonce, emitted[1].encryptionNonce);
  assert.deepEqual(
    emitted.map((chunk) => chunk.plaintextSha256),
    [sha256(Buffer.from("abcd")), sha256(Buffer.from("ef"))]
  );
});

test("streaming chunk upload staging persists per-chunk encryption metadata", async () => {
  const masterKey = Buffer.alloc(32, 8);
  const plaintext = Buffer.from("streamed plaintext");
  const node = makeNode({ id: "node-a", name: "node-a", baseUrl: "http://node-a.local" });
  const prisma = createPrisma([node]);

  await withMockAgent(
    {
      "http://node-a.local": {
        nodeId: "node-a",
        freeBytes: 1024,
        totalBytes: 2048
      }
    },
    async (fetchCalls) => {
      const stager = await createStreamingChunkUploadStager(prisma.prisma as never, "standard", 5);
      const emittedChunks: Array<{
        index: number;
        plaintextSizeBytes: number;
        ciphertextSizeBytes: number;
        plaintextSha256: string;
        ciphertextSha256: string;
        encryptionNonce: string;
        encryptionAuthTag: string;
        ciphertext: Buffer;
      }> = [];
      const encrypted = await encryptStreamToChunks(
        chunksFrom([plaintext.subarray(0, 3), plaintext.subarray(3)]),
        masterKey,
        5,
        async (chunk) => {
          emittedChunks.push(chunk);
          await stager.stageChunk(chunk);
        }
      );
      await stager.ensureReplicaPolicy("standard");
      const staged = stager.finish();
      const result = await persistStagedChunkMetadata(prisma.prisma as never, "version-streamed", staged);

      assert.equal(encrypted.chunkCount, 4);
      assert.equal(staged.chunkCount, 4);
      assert.equal(result.chunkCount, 4);
      assert.equal(prisma.chunkCreates.length, 4);
      assert.equal(prisma.chunkReplicaCreates.length, 4);
      assert.deepEqual(emittedChunks.map((chunk) => chunk.index), [0, 1, 2, 3]);
      for (const [index, chunk] of prisma.chunkCreates.entries()) {
        const record = chunk as {
          index: number;
          plaintextSizeBytes: bigint;
          ciphertextSizeBytes: bigint;
          plaintextSha256: string;
          ciphertextSha256: string;
          encryptionNonce: string | null;
          encryptionAuthTag: string | null;
        };
        const emittedChunk = emittedChunks[index];
        assert.equal(record.index, index);
        assert.equal(record.plaintextSizeBytes, BigInt(emittedChunk.plaintextSizeBytes));
        assert.equal(record.ciphertextSizeBytes, BigInt(emittedChunk.ciphertextSizeBytes));
        assert.equal(record.plaintextSha256, emittedChunk.plaintextSha256);
        assert.equal(record.ciphertextSha256, emittedChunk.ciphertextSha256);
        const encryptionNonce = record.encryptionNonce;
        const encryptionAuthTag = record.encryptionAuthTag;
        assert.ok(encryptionNonce !== null, "streamed chunks must persist per-chunk nonce");
        assert.ok(encryptionAuthTag !== null, "streamed chunks must persist per-chunk auth tag");
        assert.ok(encryptionNonce.length > 0);
        assert.ok(encryptionAuthTag.length > 0);
        assert.equal(encryptionNonce, emittedChunk.encryptionNonce);
        assert.equal(encryptionAuthTag, emittedChunk.encryptionAuthTag);
      }
      assert.equal(fetchCalls.filter((call) => call.method === "PUT").length, 4);
    }
  );
});

test("readAuthenticatedEncryptedChunks yields chunks in order, falls back, and decrypts to original plaintext", async () => {
  const masterKey = Buffer.alloc(32, 9);
  const plaintext = Buffer.from("authenticated streamed plaintext");
  const encryptedChunks: Array<{
    index: number;
    plaintextSizeBytes: number;
    ciphertextSizeBytes: number;
    plaintextSha256: string;
    ciphertextSha256: string;
    encryptionNonce: string;
    encryptionAuthTag: string;
    ciphertext: Buffer;
  }> = [];
  const encrypted = await encryptStreamToChunks(
    chunksFrom([plaintext]),
    masterKey,
    8,
    async (chunk) => {
      encryptedChunks.push(chunk);
    }
  );
  const fileKey = unwrapWrappedFileKey(encrypted.metadata.wrappedKey, masterKey);
  const chunks = encryptedChunks.map((chunk) => {
    const replicas = [
      makeReadChunkReplica({
        id: `chunk-replica-${chunk.index}-healthy`,
        chunkId: `chunk-${chunk.index}`,
        node: makeNode({ id: `node-${chunk.index}`, baseUrl: `http://node-${chunk.index}.local` }),
        objectId: `chunk-object-${chunk.index}`,
        ciphertextSha256: chunk.ciphertextSha256
      })
    ];
    if (chunk.index === 0) {
      replicas.unshift(
        makeReadChunkReplica({
          id: "chunk-replica-0-failed",
          chunkId: "chunk-0",
          node: makeNode({ id: "node-failed", baseUrl: "http://node-failed.local" }),
          objectId: "chunk-object-0-failed",
          ciphertextSha256: chunk.ciphertextSha256,
          createdAt: new Date("2026-05-20T00:00:00.000Z")
        })
      );
    }
    return makeReadChunkFromEncryptedChunk(chunk, replicas);
  });
  const prisma = createChunkReadPrisma({
    chunkCount: encrypted.chunkCount,
    chunks
  });
  const behaviors: Record<string, ObjectReadBehavior> = {
    "chunk-object-0-failed": { kind: "http-error", status: 500, body: "staged object unavailable" }
  };
  for (const chunk of encryptedChunks) {
    behaviors[`chunk-object-${chunk.index}`] = { kind: "ok", body: chunk.ciphertext };
  }

  await withMockObjectReads(behaviors, async () => {
    const authenticated = await collectAsync(readAuthenticatedEncryptedChunks(prisma.prisma as never, "version-chunked-read"));
    assert.deepEqual(authenticated.map((chunk) => chunk.index), encryptedChunks.map((chunk) => chunk.index));
    assert.equal(prisma.chunks.get("chunk-0")?.replicas[0].status, ReplicaStatus.MISSING);
    assert.ok(
      prisma.chunkReplicaUpdates.some(
        (update) => update.id === "chunk-replica-0-failed" && update.data.status === ReplicaStatus.MISSING
      )
    );

    const decrypted = Buffer.concat(
      authenticated.map((chunk) => decryptChunkBuffer(chunk.ciphertext, chunk, fileKey))
    );
    assert.deepEqual(decrypted, plaintext);
    assert.equal(sha256(decrypted), encrypted.metadata.plaintextSha256);
    assert.equal(sha256(Buffer.concat(authenticated.map((chunk) => chunk.ciphertext))), encrypted.metadata.ciphertextSha256);
  });
});

test("readAuthenticatedEncryptedChunks preserves hash mismatch errors and marks the chunk replica MISSING", async () => {
  const masterKey = Buffer.alloc(32, 10);
  const chunks: Array<{
    index: number;
    plaintextSizeBytes: number;
    ciphertextSizeBytes: number;
    plaintextSha256: string;
    ciphertextSha256: string;
    encryptionNonce: string;
    encryptionAuthTag: string;
    ciphertext: Buffer;
  }> = [];
  await encryptStreamToChunks(
    chunksFrom([Buffer.from("hash mismatch plaintext")]),
    masterKey,
    64,
    async (item) => {
      chunks.push(item);
    }
  );
  const [chunk] = chunks;
  assert.ok(chunk);
  const replica = makeReadChunkReplica({
    id: "chunk-replica-corrupt-authenticated",
    chunkId: "chunk-0",
    objectId: "chunk-object-corrupt-authenticated",
    ciphertextSha256: chunk.ciphertextSha256
  });
  const prisma = createChunkReadPrisma({
    chunkCount: 1,
    chunks: [makeReadChunkFromEncryptedChunk(chunk, [replica])]
  });

  await withMockObjectReads(
    {
      [replica.objectId]: { kind: "ok", body: Buffer.from("not the encrypted chunk") }
    },
    async () => {
      await assert.rejects(
        async () => collectAsync(readAuthenticatedEncryptedChunks(prisma.prisma as never, "version-chunked-read")),
        /chunk read failure: no readable chunk replica found: chunk 0: chunk 0 ciphertext hash mismatch/
      );
      assert.equal(prisma.chunks.get("chunk-0")?.replicas[0].status, ReplicaStatus.MISSING);
      assert.ok(
        prisma.chunkReplicaUpdates.some(
          (update) => update.id === replica.id && update.data.status === ReplicaStatus.MISSING
        )
      );
    }
  );
});
