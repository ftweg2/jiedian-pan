import { randomBytes, randomUUID } from "node:crypto";
import type { StoragePolicy } from "@wangpan/shared";
import type { ChunkUploadStager } from "./replication.js";

/**
 * Upload sessions live in process memory. Each session covers a single
 * chunked upload from /uploads/init through /uploads/:id/complete.
 *
 * Chunks may arrive in arbitrary index order and concurrently (parallel
 * client-side uploads). We track which indices have landed; aggregate
 * plaintext/ciphertext hashes are computed at /complete time by reading the
 * chunks back from storage in index order (see computeAggregateChunkHashes).
 */
export interface UploadSession {
  uploadId: string;
  userId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  chunkSize: number;
  expectedChunks: number;
  folderId: string | null;
  policyOverride: StoragePolicy | null;
  expiresAtIso: string | null;
  fileKey: Buffer;
  receivedIndices: Set<number>;
  totalPlaintextBytes: number;
  stager: ChunkUploadStager;
  initialPolicy: StoragePolicy;
  createdAt: number;
  lastTouchedAt: number;
}

const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour idle

const sessions = new Map<string, UploadSession>();

export function createSession(
  init: Omit<
    UploadSession,
    "uploadId" | "fileKey" | "receivedIndices" | "totalPlaintextBytes" | "createdAt" | "lastTouchedAt"
  >
): UploadSession {
  const uploadId = randomUUID();
  const session: UploadSession = {
    uploadId,
    fileKey: randomBytes(32),
    receivedIndices: new Set<number>(),
    totalPlaintextBytes: 0,
    createdAt: Date.now(),
    lastTouchedAt: Date.now(),
    ...init
  };
  sessions.set(uploadId, session);
  return session;
}

export function getSession(uploadId: string): UploadSession | undefined {
  const session = sessions.get(uploadId);
  if (!session) return undefined;
  if (Date.now() - session.lastTouchedAt > SESSION_TTL_MS) {
    sessions.delete(uploadId);
    return undefined;
  }
  session.lastTouchedAt = Date.now();
  return session;
}

export async function removeSession(uploadId: string, options: { cleanup?: boolean } = {}): Promise<void> {
  const session = sessions.get(uploadId);
  if (!session) return;
  sessions.delete(uploadId);
  if (options.cleanup) {
    try {
      await session.stager.cleanup();
    } catch {
      // ignore — orphan objects will be reaped by maintenance
    }
  }
}

export async function pruneStaleSessions(): Promise<number> {
  let pruned = 0;
  for (const [id, session] of sessions) {
    if (Date.now() - session.lastTouchedAt > SESSION_TTL_MS) {
      sessions.delete(id);
      try { await session.stager.cleanup(); } catch { /* ignore */ }
      pruned += 1;
    }
  }
  return pruned;
}

export function activeSessionCount(): number {
  return sessions.size;
}

let pruneTimer: ReturnType<typeof setInterval> | null = null;
export function startSessionPruner(): void {
  if (pruneTimer) return;
  pruneTimer = setInterval(() => { void pruneStaleSessions(); }, 5 * 60 * 1000);
}
export function stopSessionPruner(): void {
  if (pruneTimer) {
    clearInterval(pruneTimer);
    pruneTimer = null;
  }
}

// Tunables
export const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024;          // 8 MiB
export const MIN_CHUNK_SIZE = 64 * 1024;                    // 64 KiB
export const MAX_CHUNK_SIZE = 64 * 1024 * 1024;             // 64 MiB hard cap per PUT
export const DEFAULT_MAX_FILE_BYTES = 50 * 1024 * 1024 * 1024; // 50 GiB

export function parseChunkedUploadCap(): number {
  const raw = process.env.CHUNKED_UPLOAD_MAX_BYTES;
  if (!raw) return DEFAULT_MAX_FILE_BYTES;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_FILE_BYTES;
  return parsed;
}

