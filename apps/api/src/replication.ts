import { createDecipheriv, createHash, randomUUID } from "node:crypto";
import type { PrismaClient, StorageNode } from "@prisma/client";
import { FileStatus, FileVersionStorageLayout, ReplicaStatus, StorageNodeStatus } from "@prisma/client";
import { AgentStorageDriver } from "@wangpan/storage-driver";
import { requiredReplicaCount, resolveStoragePolicy, type StoragePolicy } from "@wangpan/shared";
import type { EncryptedStreamChunk } from "./crypto.js";
import { toSharedPolicy } from "./mappers.js";

export const CHUNK_SIZE_BYTES = 8 * 1024 * 1024;

export interface ReplicationResult {
  replicaIds: string[];
  nodeIds: string[];
}

export interface ChunkedReplicationResult {
  chunkIds: string[];
  replicaIds: string[];
  nodeIds: string[];
  chunkCount: number;
  chunkSizeBytes: number;
}

export interface StagedChunkReplica {
  nodeId: string;
  objectId: string;
  ciphertextSha256: string;
  node: StorageNode;
}

export interface StagedEncryptedChunk {
  index: number;
  plaintextSizeBytes: number;
  ciphertextSizeBytes: number;
  plaintextSha256: string;
  ciphertextSha256: string;
  encryptionNonce: string | null;
  encryptionAuthTag: string | null;
  replicas: StagedChunkReplica[];
}

export interface StagedChunkUploadResult {
  chunks: StagedEncryptedChunk[];
  nodeIds: string[];
  chunkCount: number;
  chunkSizeBytes: number;
}

export interface ChunkUploadStager {
  stageChunk: (chunk: EncryptedStreamChunk) => Promise<void>;
  finish: () => StagedChunkUploadResult;
  cleanup: () => Promise<void>;
}

export interface StreamingChunkUploadStager extends ChunkUploadStager {
  ensureReplicaPolicy: (policy: StoragePolicy) => Promise<void>;
}

export interface AuthenticatedEncryptedChunk {
  index: number;
  plaintextSizeBytes: number;
  ciphertextSizeBytes: number;
  plaintextSha256: string;
  ciphertextSha256: string;
  encryptionNonce: string;
  encryptionAuthTag: string;
  ciphertext: Buffer;
}

export async function replicateEncryptedObject(
  prisma: PrismaClient,
  versionId: string,
  policy: StoragePolicy,
  ciphertext: Buffer,
  ciphertextSha256: string
): Promise<ReplicationResult> {
  const nodes = await selectWritableNodes(prisma, policy, ciphertext.byteLength);
  const replicaIds: string[] = [];

  try {
    for (const node of nodes) {
      const replica = await replicateToNode(prisma, node, versionId, ciphertext, ciphertextSha256);
      replicaIds.push(replica.id);
    }
  } catch (error) {
    await cleanupReplicas(prisma, replicaIds);
    throw error;
  }

  return {
    replicaIds,
    nodeIds: nodes.map((node) => node.id)
  };
}

export async function replicateEncryptedChunks(
  prisma: PrismaClient,
  versionId: string,
  policy: StoragePolicy,
  ciphertext: Buffer,
  plaintext: Buffer,
  chunkSizeBytes = CHUNK_SIZE_BYTES
): Promise<ChunkedReplicationResult> {
  const chunks = splitIntoChunks(ciphertext, plaintext, chunkSizeBytes);
  const reservedBytesByNodeId = new Map<string, bigint>();
  const plans: Array<{ chunk: ChunkPlan; nodes: StorageNode[] }> = [];

  for (const chunk of chunks) {
    const nodes = await selectWritableNodes(prisma, policy, chunk.ciphertext.byteLength, reservedBytesByNodeId);
    plans.push({ chunk, nodes });
    for (const node of nodes) {
      reservedBytesByNodeId.set(
        node.id,
        (reservedBytesByNodeId.get(node.id) ?? 0n) + BigInt(chunk.ciphertext.byteLength)
      );
    }
  }

  const chunkIds: string[] = [];
  const replicaIds: string[] = [];
  const nodeIds = new Set<string>();

  try {
    for (const plan of plans) {
      const chunk = await prisma.fileChunk.create({
        data: {
          versionId,
          index: plan.chunk.index,
          plaintextSizeBytes: BigInt(plan.chunk.plaintext.byteLength),
          ciphertextSizeBytes: BigInt(plan.chunk.ciphertext.byteLength),
          plaintextSha256: sha256(plan.chunk.plaintext),
          ciphertextSha256: plan.chunk.ciphertextSha256,
          encryptionNonce: null,
          encryptionAuthTag: null
        }
      });
      chunkIds.push(chunk.id);

      for (const node of plan.nodes) {
        const replica = await replicateChunkToNode(prisma, node, chunk.id, plan.chunk.ciphertext, plan.chunk.ciphertextSha256);
        replicaIds.push(replica.id);
        nodeIds.add(node.id);
      }
    }
  } catch (error) {
    await cleanupChunkReplicas(prisma, replicaIds);
    throw error;
  }

  return {
    chunkIds,
    replicaIds,
    nodeIds: Array.from(nodeIds),
    chunkCount: chunks.length,
    chunkSizeBytes
  };
}

export async function createChunkUploadStager(
  prisma: PrismaClient,
  policy: StoragePolicy,
  plaintextSizeBytes: number,
  chunkSizeBytes = CHUNK_SIZE_BYTES
): Promise<ChunkUploadStager> {
  const chunkSizes = plannedChunkSizes(plaintextSizeBytes, chunkSizeBytes);
  const reservedBytesByNodeId = new Map<string, bigint>();
  const plans: Array<{ index: number; sizeBytes: number; nodes: StorageNode[] }> = [];

  for (const [index, sizeBytes] of chunkSizes.entries()) {
    const nodes = await selectWritableNodes(prisma, policy, sizeBytes, reservedBytesByNodeId);
    plans.push({ index, sizeBytes, nodes });
    for (const node of nodes) {
      reservedBytesByNodeId.set(node.id, (reservedBytesByNodeId.get(node.id) ?? 0n) + BigInt(sizeBytes));
    }
  }

  const uploadId = randomUUID();
  const chunks: StagedEncryptedChunk[] = [];
  const stagedReplicas: StagedChunkReplica[] = [];

  return {
    async stageChunk(chunk) {
      const expectedIndex = chunks.length;
      if (chunk.index !== expectedIndex) {
        throw new Error(`chunk upload failure: expected chunk index ${expectedIndex}, got ${chunk.index}`);
      }

      const plan = plans[chunk.index];
      if (!plan) {
        throw new Error(`chunk upload failure: unexpected chunk index ${chunk.index}`);
      }

      if (chunk.ciphertextSizeBytes !== plan.sizeBytes) {
        throw new Error(
          `chunk upload failure: chunk ${chunk.index} size changed, expected ${plan.sizeBytes}, got ${chunk.ciphertextSizeBytes}`
        );
      }

      const replicas: StagedChunkReplica[] = [];
      for (const node of plan.nodes) {
        try {
          const replica = await putStagedChunkObject(node, uploadId, chunk);
          replicas.push(replica);
          stagedReplicas.push(replica);
        } catch (error) {
          throw new Error(`chunk upload failure: chunk ${chunk.index} replica write failed: ${errorMessage(error)}`);
        }
      }

      chunks.push({
        index: chunk.index,
        plaintextSizeBytes: chunk.plaintextSizeBytes,
        ciphertextSizeBytes: chunk.ciphertextSizeBytes,
        plaintextSha256: chunk.plaintextSha256,
        ciphertextSha256: chunk.ciphertextSha256,
        encryptionNonce: chunk.encryptionNonce,
        encryptionAuthTag: chunk.encryptionAuthTag,
        replicas
      });
    },
    finish() {
      if (chunks.length !== plans.length) {
        throw new Error(`chunk upload failure: missing encrypted chunk ${chunks.length}`);
      }

      return {
        chunks,
        nodeIds: Array.from(new Set(stagedReplicas.map((replica) => replica.nodeId))),
        chunkCount: chunks.length,
        chunkSizeBytes
      };
    },
    async cleanup() {
      await cleanupStagedReplicas(stagedReplicas);
    }
  };
}

/**
 * Parallel-safe chunk stager.
 *
 * Pre-plans node assignment for each chunk at construction time (eager
 * reservation by size), so concurrent stageChunk() calls don't race on
 * capacity selection. Chunks may arrive in arbitrary index order.
 *
 *   const stager = await createPlannedChunkStager(prisma, policy, totalBytes, chunkSize);
 *   await Promise.all([
 *     stager.stageChunk(encryptChunkWithKey(buf0, key, 0)),
 *     stager.stageChunk(encryptChunkWithKey(buf2, key, 2)),
 *     stager.stageChunk(encryptChunkWithKey(buf1, key, 1))
 *   ]);
 *   const upload = stager.finish();   // throws if any index missing
 */
/**
 * Cross-upload capacity coordination.
 *
 * When multiple uploads plan concurrently, each one must see the others'
 * pending reservations or both will think they own the same free bytes and
 * the slower one will hit ENOSPC mid-upload.
 *
 * Module-level state, keyed by session: each session's per-node reserved bytes.
 * Getter sums across sessions. Decrement on successful write (so as bytes
 * physically land on disk and the agent's reported freeBytes drops to reflect
 * them, the reservation stops double-counting). Release any remainder on
 * session finish/abort.
 */
const reservationsBySession = new Map<string /*sessionId*/, Map<string /*nodeId*/, bigint>>();

function totalReservedFor(nodeId: string): bigint {
  let total = 0n;
  for (const sessionMap of reservationsBySession.values()) {
    total += sessionMap.get(nodeId) ?? 0n;
  }
  return total;
}

function addReservation(sessionId: string, nodeId: string, bytes: bigint): void {
  let sessionMap = reservationsBySession.get(sessionId);
  if (!sessionMap) { sessionMap = new Map(); reservationsBySession.set(sessionId, sessionMap); }
  sessionMap.set(nodeId, (sessionMap.get(nodeId) ?? 0n) + bytes);
}

function decrementReservation(sessionId: string, nodeId: string, bytes: bigint): void {
  const sessionMap = reservationsBySession.get(sessionId);
  if (!sessionMap) return;
  const next = (sessionMap.get(nodeId) ?? 0n) - bytes;
  if (next <= 0n) sessionMap.delete(nodeId);
  else sessionMap.set(nodeId, next);
  if (sessionMap.size === 0) reservationsBySession.delete(sessionId);
}

function releaseSessionReservations(sessionId: string): void {
  reservationsBySession.delete(sessionId);
}

/**
 * Snapshot the current reservation map as a Map<nodeId, bigint> for the
 * synchronous pickNodesFromCache() helper to consume.
 */
function snapshotReservations(): Map<string, bigint> {
  const out = new Map<string, bigint>();
  for (const sessionMap of reservationsBySession.values()) {
    for (const [nodeId, bytes] of sessionMap) {
      out.set(nodeId, (out.get(nodeId) ?? 0n) + bytes);
    }
  }
  return out;
}

export async function createPlannedChunkStager(
  prisma: PrismaClient,
  policy: StoragePolicy,
  totalSizeBytes: number,
  chunkSizeBytes = CHUNK_SIZE_BYTES
): Promise<ChunkUploadStager> {
  const chunkSizes = plannedChunkSizes(totalSizeBytes, chunkSizeBytes);
  const plans: Array<{ index: number; sizeBytes: number; nodes: StorageNode[] }> = [];

  // Refresh node status ONCE at planning time. Without this, the per-chunk
  // selectWritableNodes() call below would hit each agent over HTTP for every
  // chunk — 64 HTTP roundtrips on a 1 GB upload, adding seconds of latency to
  // /uploads/init. We freeze the freeBytes snapshot here and let the per-chunk
  // reservation map drive subsequent capacity decisions.
  const activeNodes = await refreshActiveNodesOnce(prisma);
  const requiredReplicas = requiredReplicaCount(policy);
  const sessionId = randomUUID();

  // Plan all chunks. Reserve cumulatively against the GLOBAL reservation map
  // so other concurrent uploads' planners see this session's commitments.
  for (const [index, sizeBytes] of chunkSizes.entries()) {
    const reservedSnapshot = snapshotReservations();
    let nodes: StorageNode[];
    try {
      nodes = pickNodesFromCache(activeNodes, policy, requiredReplicas, sizeBytes, reservedSnapshot);
    } catch (err) {
      // Roll back this session's reservations so far before bubbling the error.
      releaseSessionReservations(sessionId);
      throw err;
    }
    plans.push({ index, sizeBytes, nodes });
    for (const node of nodes) {
      addReservation(sessionId, node.id, BigInt(sizeBytes));
    }
  }

  const uploadId = sessionId;
  const chunks = new Map<number, StagedEncryptedChunk>();
  const stagedReplicas: StagedChunkReplica[] = [];
  const stagedReplicasLock = { value: Promise.resolve() };
  const excludedNodeIds = new Set<string>();

  /**
   * Try writing the chunk to each node in `nodes`. Returns the replica records on
   * full success. Throws on first failure (caller handles failover).
   */
  async function writeToNodes(chunk: EncryptedStreamChunk, nodes: StorageNode[]): Promise<StagedChunkReplica[]> {
    const replicas: StagedChunkReplica[] = [];
    for (const node of nodes) {
      const replica = await putStagedChunkObject(node, uploadId, chunk);
      replicas.push(replica);
    }
    return replicas;
  }

  /**
   * If the chunk's planned nodes have failed and we want to find new ones,
   * pick fresh nodes (excluding the previously-failed ones for this session)
   * and update the plan AND ALL future plans that also reference those nodes.
   */
  function reroutePlans(badNodeIds: string[], fromIndex: number): void {
    for (const nodeId of badNodeIds) excludedNodeIds.add(nodeId);
    for (let i = fromIndex; i < plans.length; i += 1) {
      const p = plans[i];
      if (!p.nodes.some((n) => badNodeIds.includes(n.id))) continue;
      // Release this chunk's reservations on bad nodes; will re-add on new nodes
      for (const node of p.nodes) {
        if (badNodeIds.includes(node.id)) {
          decrementReservation(sessionId, node.id, BigInt(p.sizeBytes));
        }
      }
      const reservedSnapshot = snapshotReservations();
      const newNodes = pickNodesFromCache(activeNodes, policy, requiredReplicas, p.sizeBytes, reservedSnapshot, excludedNodeIds);
      // Keep nodes that were good, replace bad ones from newNodes
      const merged: StorageNode[] = [];
      for (const old of p.nodes) {
        if (!badNodeIds.includes(old.id)) merged.push(old);
      }
      for (const fresh of newNodes) {
        if (merged.length >= requiredReplicas) break;
        if (!merged.some((m) => m.id === fresh.id)) merged.push(fresh);
      }
      p.nodes = merged;
      // Reserve on newly-introduced nodes
      for (const node of merged) {
        if (badNodeIds.includes(node.id)) continue; // shouldn't happen but safe
        // Only add reservation if it's a NEW node (not one we kept)
        // To keep it simple, decrement+re-add for ALL chunks of this plan:
      }
      // Simpler: just add for all current nodes (we already decremented bad ones)
      // For the kept-good nodes, their reservation is unchanged.
      // For the newly-added nodes, add fresh reservation.
      const oldNodeIds = new Set(p.nodes.filter((n) => !badNodeIds.includes(n.id)).map((n) => n.id));
      for (const node of merged) {
        if (!oldNodeIds.has(node.id)) {
          addReservation(sessionId, node.id, BigInt(p.sizeBytes));
        }
      }
    }
  }

  return {
    async stageChunk(chunk) {
      const plan = plans[chunk.index];
      if (!plan) {
        throw new Error(`chunk upload failure: unexpected chunk index ${chunk.index}`);
      }
      if (chunks.has(chunk.index)) {
        throw new Error(`chunk upload failure: chunk ${chunk.index} already staged`);
      }
      if (chunk.ciphertextSizeBytes !== plan.sizeBytes) {
        throw new Error(
          `chunk upload failure: chunk ${chunk.index} size changed, expected ${plan.sizeBytes}, got ${chunk.ciphertextSizeBytes}`
        );
      }

      let replicas: StagedChunkReplica[];
      try {
        replicas = await writeToNodes(chunk, plan.nodes);
      } catch (error) {
        if (!isNodeConnectivityError(error)) {
          throw new Error(`chunk upload failure: chunk ${chunk.index} replica write failed: ${errorMessage(error)}`);
        }
        // Connectivity failure → assume the assigned nodes are dead, reroute
        // this chunk + all subsequent chunks that referenced the same nodes.
        const badNodeIds = plan.nodes.map((n) => n.id);
        for (const nodeId of badNodeIds) {
          await prisma.storageNode.update({
            where: { id: nodeId },
            data: { status: StorageNodeStatus.OFFLINE }
          }).catch(() => undefined);
        }
        try {
          reroutePlans(badNodeIds, chunk.index);
        } catch (planErr) {
          throw new Error(`chunk upload failure: chunk ${chunk.index} could not be rerouted: ${errorMessage(planErr)}`);
        }
        // Single retry on the new plan
        try {
          replicas = await writeToNodes(chunk, plan.nodes);
        } catch (retryError) {
          throw new Error(`chunk upload failure: chunk ${chunk.index} write failed after reroute: ${errorMessage(retryError)}`);
        }
      }

      // Decrement reservation for the bytes we just successfully wrote.
      // The agent's freeBytes (refreshed on the next planner round) now reflects
      // these bytes, so we MUST stop counting them in the reservation map.
      for (const node of plan.nodes) {
        decrementReservation(sessionId, node.id, BigInt(plan.sizeBytes));
      }

      // serialize the push into the shared array
      stagedReplicasLock.value = stagedReplicasLock.value.then(() => {
        for (const r of replicas) stagedReplicas.push(r);
      });
      await stagedReplicasLock.value;

      chunks.set(chunk.index, {
        index: chunk.index,
        plaintextSizeBytes: chunk.plaintextSizeBytes,
        ciphertextSizeBytes: chunk.ciphertextSizeBytes,
        plaintextSha256: chunk.plaintextSha256,
        ciphertextSha256: chunk.ciphertextSha256,
        encryptionNonce: chunk.encryptionNonce,
        encryptionAuthTag: chunk.encryptionAuthTag,
        replicas
      });
    },
    finish() {
      // All chunks committed → any leftover reservation slots release now.
      releaseSessionReservations(sessionId);
      if (chunks.size !== plans.length) {
        const missing: number[] = [];
        for (let i = 0; i < plans.length; i += 1) if (!chunks.has(i)) missing.push(i);
        throw new Error(`chunk upload failure: missing chunks [${missing.slice(0, 10).join(",")}${missing.length > 10 ? ",..." : ""}]`);
      }
      const ordered = [...chunks.values()].sort((a, b) => a.index - b.index);
      return {
        chunks: ordered,
        nodeIds: Array.from(new Set(stagedReplicas.map((r) => r.nodeId))),
        chunkCount: ordered.length,
        chunkSizeBytes
      };
    },
    async cleanup() {
      releaseSessionReservations(sessionId);
      await cleanupStagedReplicas(stagedReplicas);
    }
  };
}

/**
 * Compute the aggregate plaintext + ciphertext SHA-256 hashes for a parallel
 * chunked upload by reading each chunk back from a storage agent in index order
 * and (for plaintext) decrypting with the file key.
 *
 * Necessary because parallel uploads can't maintain a streaming hash across
 * out-of-order chunks. Network cost: one extra read per chunk.
 */
export async function computeAggregateChunkHashes(
  staged: StagedChunkUploadResult,
  fileKey: Buffer
): Promise<{ plaintextSha256: string; ciphertextSha256: string }> {
  const plaintextHash = createHash("sha256");
  const ciphertextHash = createHash("sha256");
  const ordered = [...staged.chunks].sort((a, b) => a.index - b.index);

  for (const chunk of ordered) {
    const replica = chunk.replicas[0];
    if (!replica) throw new Error(`chunk upload failure: chunk ${chunk.index} has no staged replica`);
    if (!chunk.encryptionNonce || !chunk.encryptionAuthTag) {
      throw new Error(`chunk upload failure: chunk ${chunk.index} missing encryption metadata`);
    }

    const stream = await driverForNode(replica.node).getObject(replica.objectId);
    const ciphertext = await streamToBuffer(stream);
    if (sha256(ciphertext) !== chunk.ciphertextSha256) {
      throw new Error(`chunk upload failure: chunk ${chunk.index} ciphertext hash mismatch on readback`);
    }
    ciphertextHash.update(ciphertext);

    const decipher = createDecipheriv("aes-256-gcm", fileKey, Buffer.from(chunk.encryptionNonce, "base64url"));
    decipher.setAuthTag(Buffer.from(chunk.encryptionAuthTag, "base64url"));
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (plaintext.byteLength !== chunk.plaintextSizeBytes) {
      throw new Error(`chunk upload failure: chunk ${chunk.index} plaintext size mismatch after decrypt`);
    }
    if (sha256(plaintext) !== chunk.plaintextSha256) {
      throw new Error(`chunk upload failure: chunk ${chunk.index} plaintext hash mismatch after decrypt`);
    }
    plaintextHash.update(plaintext);
  }

  return {
    plaintextSha256: plaintextHash.digest("hex"),
    ciphertextSha256: ciphertextHash.digest("hex")
  };
}

export async function createStreamingChunkUploadStager(
  prisma: PrismaClient,
  initialPolicy: StoragePolicy,
  chunkSizeBytes = CHUNK_SIZE_BYTES
): Promise<StreamingChunkUploadStager> {
  const reservedBytesByNodeId = new Map<string, bigint>();
  const uploadId = randomUUID();
  const chunks: StagedEncryptedChunk[] = [];
  const stagedReplicas: StagedChunkReplica[] = [];
  let currentPolicy = initialPolicy;

  return {
    async stageChunk(chunk) {
      const expectedIndex = chunks.length;
      if (chunk.index !== expectedIndex) {
        throw new Error(`chunk upload failure: expected chunk index ${expectedIndex}, got ${chunk.index}`);
      }

      const stagedChunk: StagedEncryptedChunk = {
        index: chunk.index,
        plaintextSizeBytes: chunk.plaintextSizeBytes,
        ciphertextSizeBytes: chunk.ciphertextSizeBytes,
        plaintextSha256: chunk.plaintextSha256,
        ciphertextSha256: chunk.ciphertextSha256,
        encryptionNonce: chunk.encryptionNonce,
        encryptionAuthTag: chunk.encryptionAuthTag,
        replicas: []
      };
      await addReplicasToStagedChunk(
        prisma,
        uploadId,
        stagedChunk,
        chunk.ciphertext,
        requiredReplicaCount(currentPolicy),
        currentPolicy,
        reservedBytesByNodeId,
        stagedReplicas
      );
      chunks.push(stagedChunk);
    },
    async ensureReplicaPolicy(policy) {
      currentPolicy = policy;
      const targetReplicaCount = requiredReplicaCount(policy);
      for (const chunk of chunks) {
        if (chunk.replicas.length >= targetReplicaCount) {
          continue;
        }

        const ciphertext = await readStagedChunkCiphertext(prisma, chunk);
        await addReplicasToStagedChunk(
          prisma,
          uploadId,
          chunk,
          ciphertext,
          targetReplicaCount,
          policy,
          reservedBytesByNodeId,
          stagedReplicas
        );
      }
    },
    finish() {
      return {
        chunks,
        nodeIds: Array.from(new Set(stagedReplicas.map((replica) => replica.nodeId))),
        chunkCount: chunks.length,
        chunkSizeBytes
      };
    },
    async cleanup() {
      await cleanupStagedReplicas(stagedReplicas);
    }
  };
}

export async function persistStagedChunkMetadata(
  prisma: PrismaClient,
  versionId: string,
  stagedUpload: StagedChunkUploadResult
): Promise<ChunkedReplicationResult> {
  const chunkIds: string[] = [];
  const replicaIds: string[] = [];
  const nodeIds = new Set<string>();

  for (const chunk of stagedUpload.chunks) {
    const chunkRecord = await prisma.fileChunk.create({
      data: {
        versionId,
        index: chunk.index,
        plaintextSizeBytes: BigInt(chunk.plaintextSizeBytes),
        ciphertextSizeBytes: BigInt(chunk.ciphertextSizeBytes),
        plaintextSha256: chunk.plaintextSha256,
        ciphertextSha256: chunk.ciphertextSha256,
        encryptionNonce: chunk.encryptionNonce,
        encryptionAuthTag: chunk.encryptionAuthTag
      }
    });
    chunkIds.push(chunkRecord.id);

    for (const stagedReplica of chunk.replicas) {
      const replica = await prisma.chunkReplica.create({
        data: {
          chunkId: chunkRecord.id,
          nodeId: stagedReplica.nodeId,
          objectId: stagedReplica.objectId,
          ciphertextSha256: stagedReplica.ciphertextSha256,
          status: ReplicaStatus.AVAILABLE,
          verifiedAt: new Date()
        }
      });
      replicaIds.push(replica.id);
      nodeIds.add(stagedReplica.nodeId);
    }
  }

  return {
    chunkIds,
    replicaIds,
    nodeIds: Array.from(nodeIds),
    chunkCount: stagedUpload.chunkCount,
    chunkSizeBytes: stagedUpload.chunkSizeBytes
  };
}

export async function readEncryptedObject(prisma: PrismaClient, versionId: string): Promise<Buffer> {
  const storageMetadata = await getVersionStorageMetadata(prisma, versionId);
  if (storageMetadata.storageLayout === FileVersionStorageLayout.CHUNKED) {
    return readChunkedEncryptedObject(prisma, versionId, storageMetadata.chunkCount);
  }

  return readWholeEncryptedObject(prisma, versionId);
}

export async function chunkedVersionHasPerChunkEncryption(
  prisma: PrismaClient,
  versionId: string
): Promise<boolean> {
  const version = await prisma.fileVersion.findUnique({
    where: { id: versionId },
    select: { storageLayout: true, chunkCount: true }
  });
  if (version?.storageLayout !== FileVersionStorageLayout.CHUNKED || version.chunkCount == null) {
    return false;
  }

  const encryptedChunkCount = await prisma.fileChunk.count({
    where: {
      versionId,
      encryptionNonce: { not: null },
      encryptionAuthTag: { not: null }
    }
  });
  return encryptedChunkCount === version.chunkCount;
}

const READ_AHEAD_DEFAULT = 4;

export async function* readAuthenticatedEncryptedChunks(
  prisma: PrismaClient,
  versionId: string
): AsyncGenerator<AuthenticatedEncryptedChunk> {
  const storageMetadata = await getVersionStorageMetadata(prisma, versionId);
  if (storageMetadata.storageLayout !== FileVersionStorageLayout.CHUNKED) {
    throw new Error("chunk read failure: version is not chunked");
  }

  const chunks = await loadReadableChunks(prisma, versionId);
  validateChunkSequence(chunks, storageMetadata.chunkCount);

  // Pipeline: while the consumer is decrypting / hashing chunk N, kick off
  // the agent fetch for chunks N+1..N+READ_AHEAD in parallel. Cap the in-flight
  // window so memory stays bounded (each chunk is up to chunkSize bytes — the
  // default 8 MiB × 2 chunks read-ahead = 16 MiB peak buffer).
  const readAhead = Math.max(1, Math.min(READ_AHEAD_DEFAULT, chunks.length));
  const fetchOne = async (chunk: typeof chunks[number]): Promise<AuthenticatedEncryptedChunk> => {
    if (!chunk.encryptionNonce || !chunk.encryptionAuthTag) {
      throw new Error(`chunk metadata incomplete: expected per-chunk encryption metadata for chunk ${chunk.index}`);
    }
    const ciphertext = await readEncryptedChunk(prisma, chunk);
    if (ciphertext.byteLength !== Number(chunk.ciphertextSizeBytes)) {
      throw new Error(`chunk read failure: chunk ${chunk.index} size mismatch after download`);
    }
    return {
      index: chunk.index,
      plaintextSizeBytes: Number(chunk.plaintextSizeBytes),
      ciphertextSizeBytes: Number(chunk.ciphertextSizeBytes),
      plaintextSha256: chunk.plaintextSha256,
      ciphertextSha256: chunk.ciphertextSha256,
      encryptionNonce: chunk.encryptionNonce,
      encryptionAuthTag: chunk.encryptionAuthTag,
      ciphertext
    };
  };

  const queue: Array<Promise<AuthenticatedEncryptedChunk>> = [];
  let nextToSchedule = 0;
  // Prime the pipeline.
  while (nextToSchedule < readAhead && nextToSchedule < chunks.length) {
    queue.push(fetchOne(chunks[nextToSchedule]));
    nextToSchedule += 1;
  }
  while (queue.length > 0) {
    const chunk = await queue.shift()!;
    if (nextToSchedule < chunks.length) {
      queue.push(fetchOne(chunks[nextToSchedule]));
      nextToSchedule += 1;
    }
    yield chunk;
  }
}

async function getVersionStorageMetadata(
  prisma: PrismaClient,
  versionId: string
): Promise<{ storageLayout: FileVersionStorageLayout; chunkCount: number | null }> {
  const fileVersion = (prisma as unknown as {
    fileVersion?: {
      findUnique?: (input: {
        where: { id: string };
        select: { storageLayout: true; chunkCount: true };
      }) => Promise<{ storageLayout: FileVersionStorageLayout; chunkCount: number | null } | null>;
    };
  }).fileVersion;

  if (!fileVersion?.findUnique) {
    return { storageLayout: FileVersionStorageLayout.WHOLE, chunkCount: null };
  }

  const version = await fileVersion.findUnique({
    where: { id: versionId },
    select: { storageLayout: true, chunkCount: true }
  });
  return {
    storageLayout: version?.storageLayout ?? FileVersionStorageLayout.WHOLE,
    chunkCount: version?.chunkCount ?? null
  };
}

async function readWholeEncryptedObject(prisma: PrismaClient, versionId: string): Promise<Buffer> {
  const replicas = await prisma.objectReplica.findMany({
    where: {
      versionId,
      status: ReplicaStatus.AVAILABLE,
      // Allow reads from DECOMMISSIONING nodes — data is still live until drained.
      node: { status: { in: [StorageNodeStatus.ACTIVE, StorageNodeStatus.DEGRADED, StorageNodeStatus.DECOMMISSIONING] } }
    },
    include: { node: true },
    orderBy: [{ verifiedAt: "desc" }, { createdAt: "asc" }]
  });

  let lastError: unknown;
  for (const replica of replicas) {
    try {
      const stream = await driverForNode(replica.node).getObject(replica.objectId);
      const buffer = await streamToBuffer(stream);
      // Single sha256 pass; skip the extra verifyObject() round-trip
      // (it would make the agent re-hash the file unnecessarily on every read).
      if (sha256(buffer) !== replica.ciphertextSha256) {
        throw new Error("replica ciphertext hash mismatch");
      }
      return buffer;
    } catch (error) {
      lastError = error;
      if (isNodeConnectivityError(error)) {
        await prisma.storageNode.update({
          where: { id: replica.nodeId },
          data: { status: StorageNodeStatus.OFFLINE }
        }).catch(() => undefined);
        continue;
      }

      // Verify before flagging MISSING — protects against transient errors.
      let confirmed = false;
      try {
        const verification = await driverForNode(replica.node).verifyObject(replica.objectId, replica.ciphertextSha256);
        confirmed = !verification.exists || !verification.matches;
      } catch {
        confirmed = false;
      }

      if (confirmed) {
        await prisma.objectReplica.update({
          where: { id: replica.id },
          data: { status: ReplicaStatus.MISSING }
        }).catch(() => undefined);
      }
    }
  }

  throw new Error(`no readable replica found${lastError ? `: ${(lastError as Error).message}` : ""}`);
}

async function readChunkedEncryptedObject(
  prisma: PrismaClient,
  versionId: string,
  declaredChunkCount: number | null
): Promise<Buffer> {
  const chunks = await loadReadableChunks(prisma, versionId);
  validateChunkSequence(chunks, declaredChunkCount);

  const declaredChunkSizes = chunks.map((chunk) => safeSizeNumber(chunk.ciphertextSizeBytes));
  const canPreallocate = declaredChunkSizes.every((size) => size != null);
  const ciphertext = canPreallocate
    ? Buffer.allocUnsafe(declaredChunkSizes.reduce((total, size) => total + (size ?? 0), 0))
    : null;
  const buffers: Buffer[] = [];
  let offset = 0;
  for (let expectedIndex = 0; expectedIndex < chunks.length; expectedIndex += 1) {
    const chunk = chunks[expectedIndex];
    if (!chunk || chunk.index !== expectedIndex) {
      throw new Error(`chunk metadata incomplete: expected chunk index ${expectedIndex}`);
    }

    const chunkBuffer = await readEncryptedChunk(prisma, chunk);
    const declaredSize = declaredChunkSizes[expectedIndex];
    if (declaredSize != null && chunkBuffer.byteLength !== declaredSize) {
      throw new Error(`chunk read failure: chunk ${chunk.index} size mismatch after download`);
    }

    if (ciphertext) {
      chunkBuffer.copy(ciphertext, offset);
      offset += chunkBuffer.byteLength;
    } else {
      buffers.push(chunkBuffer);
    }
  }

  return ciphertext ?? Buffer.concat(buffers);
}

async function loadReadableChunks(prisma: PrismaClient, versionId: string) {
  return prisma.fileChunk.findMany({
    where: { versionId },
    orderBy: { index: "asc" },
    include: {
      replicas: {
        where: {
          status: ReplicaStatus.AVAILABLE,
          // DECOMMISSIONING nodes are not write targets, but their data is still
          // valid and reachable until the drain finishes. Excluding them here
          // would brick reads for any chunk that hasn't been migrated yet.
          node: { status: { in: [StorageNodeStatus.ACTIVE, StorageNodeStatus.DEGRADED, StorageNodeStatus.DECOMMISSIONING] } }
        },
        include: { node: true },
        orderBy: [{ verifiedAt: "desc" }, { createdAt: "asc" }]
      }
    }
  });
}

function validateChunkSequence(
  chunks: Array<{ index: number }>,
  declaredChunkCount: number | null
): void {
  if (chunks.length === 0) {
    throw new Error("chunked version has no chunks");
  }

  if (declaredChunkCount == null) {
    throw new Error("missing chunk metadata: declared chunk count is null");
  }

  if (chunks.length !== declaredChunkCount) {
    throw new Error(`missing chunk metadata: declared ${declaredChunkCount}, found ${chunks.length}`);
  }

  for (let expectedIndex = 0; expectedIndex < declaredChunkCount; expectedIndex += 1) {
    const chunk = chunks[expectedIndex];
    if (!chunk || chunk.index !== expectedIndex) {
      throw new Error(`chunk metadata incomplete: expected chunk index ${expectedIndex}`);
    }
  }
}

export async function deleteReplicasForFile(prisma: PrismaClient, fileId: string): Promise<void> {
  const versions = await prisma.fileVersion.findMany({
    where: { fileId },
    include: {
      replicas: { include: { node: true } },
      chunks: { include: { replicas: { include: { node: true } } } }
    }
  });

  for (const version of versions) {
    for (const replica of version.replicas) {
      try {
        await driverForNode(replica.node).deleteObject(replica.objectId);
      } finally {
        await prisma.objectReplica.update({
          where: { id: replica.id },
          data: { status: ReplicaStatus.DELETED }
        });
      }
    }

    for (const chunk of version.chunks ?? []) {
      for (const replica of chunk.replicas) {
        try {
          await driverForNode(replica.node).deleteObject(replica.objectId);
        } finally {
          await prisma.chunkReplica.update({
            where: { id: replica.id },
            data: { status: ReplicaStatus.DELETED }
          });
        }
      }
    }
  }
}

/**
 * Self-heal: walk every ACTIVE file, count its healthy replicas per chunk
 * (or per whole-file replica for non-chunked layouts), and create new replicas
 * on healthy nodes whenever the count is below requiredReplicaCount(policy).
 *
 * Originally only IMPORTANT, whole-file. Extended for B3 (node-lost recovery)
 * to cover all policies + chunked layouts, so a LOST node triggers a real
 * self-heal pass instead of leaving STANDARD files silently under-replicated.
 *
 * Sources for the re-replication are restricted to ACTIVE/DEGRADED nodes
 * (skipping LOST, OFFLINE, DECOMMISSIONING — they can't be trusted as a source
 * for new copies). Targets are restricted to ACTIVE/DEGRADED and exclude any
 * node that already has a replica of the same chunk/object.
 *
 * Returns total number of new replicas created across all files this pass.
 */
export async function backfillImportantReplicas(prisma: PrismaClient): Promise<number> {
  const files = await prisma.file.findMany({
    where: { status: FileStatus.ACTIVE },
    include: {
      folder: true,
      versions: {
        orderBy: { createdAt: "desc" },
        take: 1,
        include: { replicas: { include: { node: true } } }
      }
    }
  });

  let created = 0;
  for (const file of files) {
    const folderPolicy = file.folder ? toSharedPolicy(file.folder.defaultPolicy) : "standard";
    const policy = resolveStoragePolicy(folderPolicy, file.policyOverride ? toSharedPolicy(file.policyOverride) : null);
    const required = requiredReplicaCount(policy);
    if (required <= 0) continue;

    const version = file.versions[0];
    if (!version) continue;

    if (version.storageLayout === FileVersionStorageLayout.CHUNKED) {
      created += await backfillChunkedVersion(prisma, version.id, required);
      continue;
    }

    // Whole-file path (original behavior, extended to all policies + LOST fallback).
    const healthyReplicas = version.replicas.filter(isHealthyReplica);
    if (healthyReplicas.length >= required) continue;

    const needed = required - healthyReplicas.length;
    const usedNodeIds = new Set(version.replicas.map((r) => r.nodeId));

    // Source: try healthy replicas first, then non-DELETED replicas on any node
    // (including LOST). readEncryptedObject already filters healthy; here we
    // emulate the LOST fallback inline.
    let sourceCiphertext: Buffer | null = null;
    try {
      sourceCiphertext = await readEncryptedObject(prisma, version.id);
    } catch {
      // Healthy read failed — try every other live replica including LOST.
      const ordered = [...version.replicas].sort((a, b) => (isHealthyReplica(a) ? 0 : 1) - (isHealthyReplica(b) ? 0 : 1));
      for (const candidate of ordered) {
        if (!isPotentialReadSource(candidate)) continue;
        try {
          const stream = await driverForNode(candidate.node).getObject(candidate.objectId);
          sourceCiphertext = await streamToBuffer(stream);
          break;
        } catch (err) {
          console.warn(`backfill: whole-source ${candidate.node.name} for v${version.id} failed:`, err);
        }
      }
    }

    if (!sourceCiphertext) {
      // No source was reachable. That doesn't mean the data is gone — it
      // could just be a transient network/auth issue (we hit this in
      // production when an agent's token got out of sync). DON'T bulk-mark
      // replicas MISSING here; that previously caused 73 chunks to become
      // un-readable just because the API briefly couldn't auth to the
      // agent. The dedicated reverify pass (POST /nodes/:id/reverify) is
      // the right place to definitively mark MISSING — it asks each node
      // directly whether the object still exists.
      console.warn(`backfill: version ${version.id} has no reachable source this tick — will retry on next maintenance`);
      continue;
    }

    const targets = await prisma.storageNode.findMany({
      where: {
        status: { in: [StorageNodeStatus.ACTIVE, StorageNodeStatus.DEGRADED] },
        id: { notIn: Array.from(usedNodeIds) }
      },
      orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
      take: needed
    });
    if (targets.length === 0) continue;

    for (const target of targets) {
      try {
        await replicateToNode(prisma, target, version.id, sourceCiphertext, version.ciphertextSha256);
        created += 1;
      } catch (err) {
        console.warn(`backfill: replicateToNode failed for version ${version.id} → ${target.name}`, err);
      }
    }
  }

  return created;
}

function isHealthyReplica(replica: { status: ReplicaStatus; node: { status: StorageNodeStatus } }): boolean {
  return (
    replica.status === ReplicaStatus.AVAILABLE &&
    (replica.node.status === StorageNodeStatus.ACTIVE ||
      replica.node.status === StorageNodeStatus.DEGRADED ||
      // DECOMMISSIONING data is still valid, just not getting new writes — it
      // counts toward "healthy" so we don't over-replicate while the drain runs.
      replica.node.status === StorageNodeStatus.DECOMMISSIONING)
  );
}

/**
 * A replica we can attempt to read from. Includes LOST as a last-ditch source
 * because the node may still be briefly reachable (common when an admin
 * declares LOST preemptively). Order callers should prefer healthy first,
 * then fall back to this.
 */
function isPotentialReadSource(replica: { status: ReplicaStatus; node: { status: StorageNodeStatus } }): boolean {
  // Even MISSING is worth trying — the node might still have the bytes on disk
  // and we have nothing else to lose.
  if (replica.status === ReplicaStatus.DELETED) return false;
  return true;
}

/**
 * Backfill chunked versions: for each chunk, count healthy replicas; if below
 * required, copy the ciphertext from a healthy source onto a fresh target.
 * Returns count of newly created replicas across all chunks.
 */
async function backfillChunkedVersion(
  prisma: PrismaClient,
  versionId: string,
  required: number
): Promise<number> {
  const chunks = await prisma.fileChunk.findMany({
    where: { versionId },
    orderBy: { index: "asc" },
    include: { replicas: { include: { node: true } } }
  });

  let created = 0;
  for (const chunk of chunks) {
    const healthy = chunk.replicas.filter(isHealthyReplica);
    if (healthy.length >= required) continue;

    const needed = required - healthy.length;

    // Source preference order:
    //   1. Healthy (AVAILABLE on ACTIVE/DEGRADED/DECOMMISSIONING)
    //   2. Anything else not DELETED — including LOST nodes and MISSING-marked
    //      replicas. The LOST node may still be briefly reachable; that's our
    //      whole reason to try.
    let ciphertext: Buffer | null = null;
    let sourceUsed: typeof chunk.replicas[number] | null = null;
    const ordered = [...chunk.replicas].sort((a, b) => {
      const aH = isHealthyReplica(a) ? 0 : 1;
      const bH = isHealthyReplica(b) ? 0 : 1;
      return aH - bH;
    });
    for (const candidate of ordered) {
      if (!isPotentialReadSource(candidate)) continue;
      try {
        const stream = await driverForNode(candidate.node).getObject(candidate.objectId);
        ciphertext = await streamToBuffer(stream);
        sourceUsed = candidate;
        break;
      } catch (err) {
        console.warn(`backfill: source candidate ${candidate.node.name} for chunk ${chunk.id} failed:`, err);
      }
    }

    if (!ciphertext || !sourceUsed) {
      // No source reachable this tick. Could be a transient connection /
      // auth issue rather than real data loss. Don't bulk-mark MISSING
      // here — that's what burned us when one bad token cascaded into
      // 73 chunks being marked MISSING. The reverify endpoint is the
      // authoritative place to mark MISSING; it asks the agent directly.
      console.warn(`backfill: chunk ${chunk.id} has no reachable source this tick — will retry`);
      continue;
    }

    // If we recovered the ciphertext from a non-healthy source, mark the
    // original replica AVAILABLE again only if it's on a still-acceptable
    // node. Otherwise leave it as-is so the UI can show "we re-replicated
    // off this dying node".

    // Excludes nodes that already have a replica (whether MISSING or AVAILABLE).
    const usedNodeIds = new Set(chunk.replicas.map((r) => r.nodeId));
    const targets = await prisma.storageNode.findMany({
      where: {
        status: { in: [StorageNodeStatus.ACTIVE, StorageNodeStatus.DEGRADED] },
        id: { notIn: Array.from(usedNodeIds) }
      },
      orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
      take: needed
    });
    if (targets.length === 0) continue;

    for (const target of targets) {
      try {
        await replicateChunkToNode(prisma, target, chunk.id, ciphertext, sourceUsed.ciphertextSha256);
        created += 1;
      } catch (err) {
        console.warn(`backfill: replicateChunkToNode failed for chunk ${chunk.id} → ${target.name}`, err);
      }
    }
  }

  return created;
}

/**
 * Walk MISSING replicas on a node, ask the agent via verifyObject whether the
 * bytes are actually still there + match the expected SHA. If yes, flip the
 * replica back to AVAILABLE. Used in three places:
 *   - POST /nodes/:id/reverify (admin button)
 *   - prober (auto-fires when a node recovers from probe failures)
 *   - runMaintenance (idle pass — 60s tick, limited)
 *
 * `maxReplicas` caps the work so the maintenance tick doesn't run forever
 * on huge MISSING piles. Omit (or pass Infinity) for the admin endpoint.
 */
export async function reverifyNodeMissingReplicas(
  prisma: PrismaClient,
  node: StorageNode,
  options: { maxReplicas?: number; concurrency?: number } = {}
): Promise<{ checked: number; chunkRecovered: number; chunkStillMissing: number; objectRecovered: number; objectStillMissing: number }> {
  const maxReplicas = options.maxReplicas ?? Infinity;
  const concurrency = options.concurrency ?? 6;

  // Skip nodes that aren't reachable (no point calling verify).
  if (node.status === StorageNodeStatus.DISABLED || node.status === StorageNodeStatus.LOST) {
    return { checked: 0, chunkRecovered: 0, chunkStillMissing: 0, objectRecovered: 0, objectStillMissing: 0 };
  }

  const chunkBudget = Math.max(0, Math.floor(maxReplicas));
  const chunkMissing = await prisma.chunkReplica.findMany({
    where: { nodeId: node.id, status: ReplicaStatus.MISSING },
    select: { id: true, objectId: true, ciphertextSha256: true },
    take: chunkBudget,
    orderBy: { createdAt: "asc" }
  });
  const objectBudget = Math.max(0, chunkBudget - chunkMissing.length);
  const objectMissing = objectBudget > 0 ? await prisma.objectReplica.findMany({
    where: { nodeId: node.id, status: ReplicaStatus.MISSING },
    select: { id: true, objectId: true, ciphertextSha256: true },
    take: objectBudget,
    orderBy: { createdAt: "asc" }
  }) : [];

  if (chunkMissing.length === 0 && objectMissing.length === 0) {
    return { checked: 0, chunkRecovered: 0, chunkStillMissing: 0, objectRecovered: 0, objectStillMissing: 0 };
  }

  const driver = driverForNode(node);
  let chunkRecovered = 0;
  let chunkStillMissing = 0;
  let objectRecovered = 0;
  let objectStillMissing = 0;

  async function pool<T>(items: T[], width: number, fn: (item: T) => Promise<void>): Promise<void> {
    let i = 0;
    const workers = Array.from({ length: Math.min(width, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        await fn(items[idx]).catch(() => undefined);
      }
    });
    await Promise.all(workers);
  }

  await pool(chunkMissing, concurrency, async (r) => {
    try {
      const v = await driver.verifyObject(r.objectId, r.ciphertextSha256);
      if (v.exists && v.matches) {
        await prisma.chunkReplica.update({
          where: { id: r.id },
          data: { status: ReplicaStatus.AVAILABLE, verifiedAt: new Date() }
        });
        chunkRecovered += 1;
      } else {
        chunkStillMissing += 1;
      }
    } catch {
      chunkStillMissing += 1;
    }
  });

  await pool(objectMissing, concurrency, async (r) => {
    try {
      const v = await driver.verifyObject(r.objectId, r.ciphertextSha256);
      if (v.exists && v.matches) {
        await prisma.objectReplica.update({
          where: { id: r.id },
          data: { status: ReplicaStatus.AVAILABLE, verifiedAt: new Date() }
        });
        objectRecovered += 1;
      } else {
        objectStillMissing += 1;
      }
    } catch {
      objectStillMissing += 1;
    }
  });

  return {
    checked: chunkMissing.length + objectMissing.length,
    chunkRecovered,
    chunkStillMissing,
    objectRecovered,
    objectStillMissing
  };
}

export async function refreshNodeStatus(prisma: PrismaClient, node: StorageNode) {
  const status = await driverForNode(node).getStatus();
  if (status.nodeId && status.nodeId !== node.name && status.nodeId !== node.id) {
    throw new Error(`storage node identity mismatch: expected ${node.name} (${node.id}), got ${status.nodeId}`);
  }

  // Only auto-promote OFFLINE/DEGRADED nodes back to ACTIVE on successful probe.
  // DECOMMISSIONING / DISABLED must be preserved — they're admin-driven states
  // and we must not silently override them just because the agent is reachable.
  const nextStatus = (node.status === StorageNodeStatus.DECOMMISSIONING || node.status === StorageNodeStatus.DISABLED)
    ? node.status
    : StorageNodeStatus.ACTIVE;

  return prisma.storageNode.update({
    where: { id: node.id },
    data: {
      status: nextStatus,
      lastSeenAt: new Date(),
      freeBytes: BigInt(status.freeBytes),
      totalBytes: BigInt(status.totalBytes)
    }
  });
}

function driverForNode(node: Pick<StorageNode, "baseUrl" | "agentToken">): AgentStorageDriver {
  return new AgentStorageDriver({ baseUrl: node.baseUrl, token: node.agentToken });
}

async function selectWritableNodes(
  prisma: PrismaClient,
  policy: StoragePolicy,
  objectSizeBytes: number,
  reservedBytesByNodeId = new Map<string, bigint>()
): Promise<StorageNode[]> {
  return selectWritableNodeCount(
    prisma,
    policy,
    requiredReplicaCount(policy),
    objectSizeBytes,
    reservedBytesByNodeId
  );
}

async function selectWritableNodeCount(
  prisma: PrismaClient,
  policy: StoragePolicy,
  count: number,
  objectSizeBytes: number,
  reservedBytesByNodeId = new Map<string, bigint>(),
  excludedNodeIds = new Set<string>()
): Promise<StorageNode[]> {
  if (count <= 0) {
    return [];
  }

  const candidates = await prisma.storageNode.findMany({
    where: { status: { in: [StorageNodeStatus.ACTIVE, StorageNodeStatus.DEGRADED, StorageNodeStatus.OFFLINE] } },
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }]
  });

  const activeNodes: StorageNode[] = [];
  const nodesWithCapacity: StorageNode[] = [];
  for (const node of candidates) {
    if (excludedNodeIds.has(node.id)) {
      continue;
    }

    try {
      const refreshed = await refreshNodeStatus(prisma, node);
      activeNodes.push(refreshed);
      if (hasCapacity(refreshed, objectSizeBytes, reservedBytesByNodeId.get(refreshed.id) ?? 0n)) {
        nodesWithCapacity.push(refreshed);
      }
    } catch {
      await prisma.storageNode.update({
        where: { id: node.id },
        data: { status: StorageNodeStatus.OFFLINE }
      });
    }

    if (nodesWithCapacity.length >= count) {
      break;
    }
  }

  if (activeNodes.length < count) {
    throw new Error(`not enough active storage nodes: required ${count}, found ${activeNodes.length}`);
  }

  if (nodesWithCapacity.length < count) {
    if (policy === "important") {
      throw new Error(
        `not enough capacity for important replicas: required ${count} nodes with ${objectSizeBytes} bytes free, found ${nodesWithCapacity.length}`
      );
    }

    throw new Error(`not enough storage capacity: required ${objectSizeBytes} bytes on one active node`);
  }

  return nodesWithCapacity;
}

function hasCapacity(node: StorageNode, objectSizeBytes: number, reservedBytes: bigint): boolean {
  return node.freeBytes != null && node.freeBytes - reservedBytes >= BigInt(objectSizeBytes);
}

/**
 * Refresh every non-disabled node ONCE. Used by the planner to avoid hitting
 * each agent per-chunk on big uploads. Nodes that fail to refresh are marked
 * OFFLINE and excluded.
 */
async function refreshActiveNodesOnce(prisma: PrismaClient): Promise<StorageNode[]> {
  // Planner skips DISABLED (never write) and DECOMMISSIONING (draining, no new writes).
  const candidates = await prisma.storageNode.findMany({
    where: { status: { in: [StorageNodeStatus.ACTIVE, StorageNodeStatus.DEGRADED, StorageNodeStatus.OFFLINE] } },
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }]
  });
  const active: StorageNode[] = [];
  for (const node of candidates) {
    try {
      active.push(await refreshNodeStatus(prisma, node));
    } catch {
      await prisma.storageNode.update({
        where: { id: node.id },
        data: { status: StorageNodeStatus.OFFLINE }
      }).catch(() => undefined);
    }
  }
  return active;
}

/**
 * Pure-arithmetic node selection from a pre-refreshed list.
 * Does NOT hit storage agents — uses cached freeBytes and the running
 * reservation map.
 */
function pickNodesFromCache(
  nodes: StorageNode[],
  policy: StoragePolicy,
  required: number,
  objectSizeBytes: number,
  reservedBytesByNodeId: Map<string, bigint>,
  excludedNodeIds: Set<string> = new Set()
): StorageNode[] {
  if (required <= 0) return [];
  const eligible = nodes.filter((n) => !excludedNodeIds.has(n.id));
  if (eligible.length < required) {
    throw new Error(`not enough active storage nodes: required ${required}, found ${eligible.length}`);
  }
  const picked: StorageNode[] = [];
  for (const node of eligible) {
    if (hasCapacity(node, objectSizeBytes, reservedBytesByNodeId.get(node.id) ?? 0n)) {
      picked.push(node);
      if (picked.length >= required) break;
    }
  }
  if (picked.length < required) {
    if (policy === "important") {
      throw new Error(
        `not enough capacity for important replicas: required ${required} nodes with ${objectSizeBytes} bytes free, found ${picked.length}`
      );
    }
    throw new Error(`not enough storage capacity: required ${objectSizeBytes} bytes on one active node`);
  }
  return picked;
}

interface ChunkPlan {
  index: number;
  plaintext: Buffer;
  ciphertext: Buffer;
  ciphertextSha256: string;
}

function splitIntoChunks(ciphertext: Buffer, plaintext: Buffer, chunkSizeBytes: number): ChunkPlan[] {
  const chunks: ChunkPlan[] = [];
  const totalChunks = Math.max(1, Math.ceil(ciphertext.byteLength / chunkSizeBytes));
  for (let index = 0; index < totalChunks; index += 1) {
    const start = index * chunkSizeBytes;
    const end = Math.min(start + chunkSizeBytes, ciphertext.byteLength);
    const ciphertextChunk = ciphertext.subarray(start, end);
    const plaintextChunk = plaintext.subarray(start, Math.min(start + chunkSizeBytes, plaintext.byteLength));
    chunks.push({
      index,
      plaintext: Buffer.from(plaintextChunk),
      ciphertext: Buffer.from(ciphertextChunk),
      ciphertextSha256: sha256(ciphertextChunk)
    });
  }

  return chunks;
}

function plannedChunkSizes(totalSizeBytes: number, chunkSizeBytes: number): number[] {
  if (!Number.isSafeInteger(totalSizeBytes) || totalSizeBytes < 0) {
    throw new Error("chunk upload failure: invalid upload size");
  }

  if (!Number.isSafeInteger(chunkSizeBytes) || chunkSizeBytes <= 0) {
    throw new Error("chunk upload failure: invalid chunk size");
  }

  const totalChunks = Math.max(1, Math.ceil(totalSizeBytes / chunkSizeBytes));
  const sizes: number[] = [];
  for (let index = 0; index < totalChunks; index += 1) {
    const remaining = Math.max(0, totalSizeBytes - index * chunkSizeBytes);
    sizes.push(Math.min(chunkSizeBytes, remaining));
  }

  return sizes;
}

async function replicateToNode(
  prisma: PrismaClient,
  node: StorageNode,
  versionId: string,
  ciphertext: Buffer,
  ciphertextSha256: string
): Promise<{ id: string }> {
  const objectId = `${versionId}:${node.id}:${randomUUID()}`;
  const driver = driverForNode(node);
  await driver.putObject({
    objectId,
    body: ciphertext,
    ciphertextSha256,
    sizeBytes: ciphertext.byteLength
  });

  try {
    return await prisma.objectReplica.create({
      data: {
        versionId,
        nodeId: node.id,
        objectId,
        ciphertextSha256,
        status: ReplicaStatus.AVAILABLE,
        verifiedAt: new Date()
      }
    });
  } catch (error) {
    await driver.deleteObject(objectId).catch(() => undefined);
    throw error;
  }
}

async function putStagedChunkObject(
  node: StorageNode,
  uploadId: string,
  chunk: EncryptedStreamChunk
): Promise<StagedChunkReplica> {
  const objectId = `chunk-upload:${uploadId}:${chunk.index}:${node.id}:${randomUUID()}`;
  const driver = driverForNode(node);
  try {
    await driver.putObject({
      objectId,
      body: chunk.ciphertext,
      ciphertextSha256: chunk.ciphertextSha256,
      sizeBytes: chunk.ciphertextSizeBytes
    });
  } catch (error) {
    await driver.deleteObject(objectId).catch(() => undefined);
    throw error;
  }
  return {
    nodeId: node.id,
    objectId,
    ciphertextSha256: chunk.ciphertextSha256,
    node
  };
}

async function addReplicasToStagedChunk(
  prisma: PrismaClient,
  uploadId: string,
  chunk: StagedEncryptedChunk,
  ciphertext: Buffer,
  targetReplicaCount: number,
  policy: StoragePolicy,
  reservedBytesByNodeId: Map<string, bigint>,
  stagedReplicas: StagedChunkReplica[]
): Promise<void> {
  const missingReplicaCount = targetReplicaCount - chunk.replicas.length;
  if (missingReplicaCount <= 0) {
    return;
  }

  if (ciphertext.byteLength !== chunk.ciphertextSizeBytes) {
    throw new Error(
      `chunk upload failure: chunk ${chunk.index} size changed, expected ${chunk.ciphertextSizeBytes}, got ${ciphertext.byteLength}`
    );
  }

  if (sha256(ciphertext) !== chunk.ciphertextSha256) {
    throw new Error(`chunk upload failure: chunk ${chunk.index} ciphertext hash mismatch before replica write`);
  }

  const excludedNodeIds = new Set(chunk.replicas.map((replica) => replica.nodeId));
  const nodes = await selectWritableNodeCount(
    prisma,
    policy,
    missingReplicaCount,
    chunk.ciphertextSizeBytes,
    reservedBytesByNodeId,
    excludedNodeIds
  );

  for (const node of nodes) {
    try {
      const replica = await putStagedChunkObject(
        node,
        uploadId,
        {
          index: chunk.index,
          plaintextSizeBytes: chunk.plaintextSizeBytes,
          ciphertextSizeBytes: chunk.ciphertextSizeBytes,
          plaintextSha256: chunk.plaintextSha256,
          ciphertextSha256: chunk.ciphertextSha256,
          encryptionNonce: chunk.encryptionNonce ?? "",
          encryptionAuthTag: chunk.encryptionAuthTag ?? "",
          ciphertext
        }
      );
      chunk.replicas.push(replica);
      stagedReplicas.push(replica);
      reservedBytesByNodeId.set(
        node.id,
        (reservedBytesByNodeId.get(node.id) ?? 0n) + BigInt(chunk.ciphertextSizeBytes)
      );
    } catch (error) {
      throw new Error(`chunk upload failure: chunk ${chunk.index} replica write failed: ${errorMessage(error)}`);
    }
  }
}

async function readStagedChunkCiphertext(
  prisma: PrismaClient,
  chunk: StagedEncryptedChunk
): Promise<Buffer> {
  const sourceReplica = chunk.replicas[0];
  if (!sourceReplica) {
    throw new Error(`chunk upload failure: chunk ${chunk.index} has no staged replica to copy`);
  }

  try {
    const stream = await driverForNode(sourceReplica.node).getObject(sourceReplica.objectId);
    const buffer = await streamToBuffer(stream);
    if (buffer.byteLength !== chunk.ciphertextSizeBytes || sha256(buffer) !== chunk.ciphertextSha256) {
      throw new Error("staged chunk ciphertext hash mismatch");
    }
    return buffer;
  } catch (error) {
    if (isNodeConnectivityError(error)) {
      await prisma.storageNode.update({
        where: { id: sourceReplica.nodeId },
        data: { status: StorageNodeStatus.OFFLINE }
      }).catch(() => undefined);
    }

    throw new Error(`chunk upload failure: chunk ${chunk.index} staged replica read failed: ${errorMessage(error)}`);
  }
}

async function replicateChunkToNode(
  prisma: PrismaClient,
  node: StorageNode,
  chunkId: string,
  ciphertext: Buffer,
  ciphertextSha256: string
): Promise<{ id: string }> {
  const objectId = `${chunkId}:${node.id}:${randomUUID()}`;
  const driver = driverForNode(node);
  await driver.putObject({
    objectId,
    body: ciphertext,
    ciphertextSha256,
    sizeBytes: ciphertext.byteLength
  });

  try {
    return await prisma.chunkReplica.create({
      data: {
        chunkId,
        nodeId: node.id,
        objectId,
        ciphertextSha256,
        status: ReplicaStatus.AVAILABLE,
        verifiedAt: new Date()
      }
    });
  } catch (error) {
    await driver.deleteObject(objectId).catch(() => undefined);
    throw error;
  }
}

async function readEncryptedChunk(
  prisma: PrismaClient,
  chunk: {
    id: string;
    index: number;
    ciphertextSha256: string;
    ciphertextSizeBytes: bigint;
    replicas: Array<{
      id: string;
      nodeId: string;
      objectId: string;
      ciphertextSha256: string;
      node: StorageNode;
    }>;
  }
): Promise<Buffer> {
  let lastError: unknown;
  for (const replica of chunk.replicas) {
    try {
      const stream = await driverForNode(replica.node).getObject(replica.objectId);
      const buffer = await streamToBuffer(stream);
      // Integrity for chunked downloads is enforced by:
      //   1) AES-256-GCM auth tag — decryption fails on any ciphertext tamper
      //   2) Final aggregate plaintext SHA-256 check at end of stream
      // So we don't SHA each chunk on receive. Trust the size; the size check
      // catches truncation, and any byte corruption surfaces at GCM verify.
      if (buffer.byteLength !== Number(chunk.ciphertextSizeBytes)) {
        throw new Error(`chunk ${chunk.index} ciphertext size mismatch on read`);
      }
      return buffer;
    } catch (error) {
      lastError = error;
      if (isNodeConnectivityError(error)) {
        await prisma.storageNode.update({
          where: { id: replica.nodeId },
          data: { status: StorageNodeStatus.OFFLINE }
        }).catch(() => undefined);
        // Don't flip the replica to MISSING on connectivity issues — the data
        // is probably still there; we just can't reach the node right now.
        continue;
      }

      // Before declaring the replica permanently lost, ask the agent whether
      // it can still see the object. Many "failures" turn out to be transient
      // (stream aborted, hash check stricter than needed). Only mark MISSING
      // when the agent confirms the object is gone or corrupted.
      let confirmed = false;
      try {
        const verification = await driverForNode(replica.node).verifyObject(replica.objectId, replica.ciphertextSha256);
        confirmed = !verification.exists || !verification.matches;
      } catch {
        confirmed = false;
      }

      if (confirmed) {
        await prisma.chunkReplica.update({
          where: { id: replica.id },
          data: { status: ReplicaStatus.MISSING }
        }).catch(() => undefined);
      }
    }
  }

  throw new Error(`chunk read failure: no readable chunk replica found: chunk ${chunk.index}${lastError ? `: ${errorMessage(lastError)}` : ""}`);
}

async function cleanupReplicas(prisma: PrismaClient, replicaIds: string[]): Promise<void> {
  const replicas = await prisma.objectReplica.findMany({
    where: { id: { in: replicaIds } },
    include: { node: true }
  });

  for (const replica of replicas) {
    try {
      await driverForNode(replica.node).deleteObject(replica.objectId);
    } finally {
      await prisma.objectReplica.update({
        where: { id: replica.id },
        data: { status: ReplicaStatus.DELETED }
      });
    }
  }
}

async function cleanupChunkReplicas(prisma: PrismaClient, replicaIds: string[]): Promise<void> {
  const replicas = await prisma.chunkReplica.findMany({
    where: { id: { in: replicaIds } },
    include: { node: true }
  });

  for (const replica of replicas) {
    try {
      await driverForNode(replica.node).deleteObject(replica.objectId);
    } finally {
      await prisma.chunkReplica.update({
        where: { id: replica.id },
        data: { status: ReplicaStatus.DELETED }
      });
    }
  }
}

async function cleanupStagedReplicas(replicas: StagedChunkReplica[]): Promise<void> {
  const errors: string[] = [];
  for (const replica of replicas) {
    try {
      await driverForNode(replica.node).deleteObject(replica.objectId);
    } catch (error) {
      errors.push(`${replica.objectId}: ${errorMessage(error)}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`cleanup incomplete: ${errors.join("; ")}`);
  }
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function safeSizeNumber(value: unknown): number | null {
  const size = Number(value);
  return Number.isSafeInteger(size) && size >= 0 ? size : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNodeConnectivityError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    message.includes("fetch failed") ||
    message.includes("econnrefused") ||
    message.includes("etimedout") ||
    message.includes("unauthorized") ||
    message.includes(" 401 ")
  );
}
