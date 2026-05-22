import { apiBase, ApiError, type FileItem, type StoragePolicy } from "../api.js";

export interface ChunkedUploadOptions {
  file: File;
  folderId: string | null;
  policyOverride: StoragePolicy | null;
  expiresAt: string | null;          // ISO string
  chunkSize?: number;
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?: (progress: ChunkedUploadProgress) => void;
}

export interface ChunkedUploadProgress {
  stage: "init" | "uploading" | "completing";
  uploadedBytes: number;
  totalBytes: number;
  inFlight: number;
  completedChunks: number;
  totalChunks: number;
}

interface InitResponse {
  uploadId: string;
  chunkSize: number;
  expectedChunks: number;
  recommendedConcurrency: number;
  expiresInSeconds: number;
}

interface ChunkAckResponse {
  received: true;
  index: number;
  receivedCount: number;
  expectedChunks: number;
  uploadedBytes: number;
  totalBytes: number;
}

interface CompleteResponse {
  file: FileItem;
}

const PER_CHUNK_RETRY_LIMIT = 3;
const RETRY_BACKOFF_MS = [1000, 2500, 6000];

export async function chunkedUpload(opts: ChunkedUploadOptions): Promise<FileItem> {
  const { file, folderId, policyOverride, expiresAt, chunkSize, concurrency, signal, onProgress } = opts;

  // 1) initialize the session
  const initBody = {
    filename: file.name,
    mimeType: file.type || "application/octet-stream",
    sizeBytes: file.size,
    folderId: folderId ?? null,
    policyOverride: policyOverride ?? null,
    expiresAt: expiresAt ?? null,
    chunkSize
  };
  const init = await jsonRequest<InitResponse>("/uploads/init", "POST", initBody, signal);

  const { uploadId, chunkSize: serverChunkSize, expectedChunks } = init;
  const parallelism = Math.max(1, Math.min(concurrency ?? init.recommendedConcurrency, 8));

  // shared progress state
  let uploadedBytes = 0;
  let completedChunks = 0;
  let inFlight = 0;
  let nextIndex = 0;
  let firstError: unknown = null;

  function emit(stage: ChunkedUploadProgress["stage"]) {
    onProgress?.({
      stage,
      uploadedBytes,
      totalBytes: file.size,
      inFlight,
      completedChunks,
      totalChunks: expectedChunks
    });
  }

  emit("init");

  // 2) upload chunks via a fixed-size concurrency pool
  try {
    const workers: Promise<void>[] = [];
    for (let w = 0; w < parallelism; w += 1) {
      workers.push((async () => {
        while (true) {
          if (firstError) return;
          throwIfAborted(signal);
          const index = nextIndex++;
          if (index >= expectedChunks) return;

          const start = index * serverChunkSize;
          const end = Math.min(start + serverChunkSize, file.size);
          const blob = file.slice(start, end);
          const chunkBytes = end - start;

          inFlight += 1;
          emit("uploading");
          try {
            await putChunkWithRetry(uploadId, index, blob, signal);
            uploadedBytes += chunkBytes;
            completedChunks += 1;
          } catch (err) {
            if (!firstError) firstError = err;
          } finally {
            inFlight -= 1;
            emit("uploading");
          }
        }
      })());
    }
    await Promise.all(workers);
    if (firstError) throw firstError;

    emit("completing");

    // 3) finalize (server reads all chunks back in order to compute aggregate hash)
    const completed = await jsonRequest<CompleteResponse>(
      `/uploads/${uploadId}/complete`,
      "POST",
      {},
      signal
    );
    return completed.file;
  } catch (err) {
    // best-effort abort to release server-side staged objects
    await tryAbort(uploadId).catch(() => undefined);
    throw err;
  }
}

async function putChunkWithRetry(
  uploadId: string,
  index: number,
  blob: Blob,
  signal: AbortSignal | undefined
): Promise<ChunkAckResponse> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < PER_CHUNK_RETRY_LIMIT; attempt += 1) {
    throwIfAborted(signal);
    try {
      const response = await fetch(`${apiBase}/uploads/${uploadId}/chunk/${index}`, {
        method: "PUT",
        credentials: "include",
        headers: { "content-type": "application/octet-stream" },
        body: blob,
        signal
      });
      if (response.status === 410 || response.status === 403) {
        throw new ApiError(response.status, await readErrorText(response));
      }
      if (response.status === 409) {
        // chunk already received (e.g. retry of an already-acked PUT); treat as success
        return {
          received: true,
          index,
          receivedCount: 0,
          expectedChunks: 0,
          uploadedBytes: 0,
          totalBytes: 0
        };
      }
      if (!response.ok) {
        throw new ApiError(response.status, await readErrorText(response));
      }
      return (await response.json()) as ChunkAckResponse;
    } catch (err) {
      lastError = err;
      if (isAbortError(err)) throw err;
      if (err instanceof ApiError && (err.status === 410 || err.status === 403)) throw err;
      const wait = RETRY_BACKOFF_MS[attempt] ?? 6000;
      await delay(wait, signal);
    }
  }
  throw lastError ?? new Error(`chunk ${index} upload failed after ${PER_CHUNK_RETRY_LIMIT} attempts`);
}

async function jsonRequest<T>(path: string, method: string, body: unknown, signal: AbortSignal | undefined): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    method,
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal
  });
  if (!response.ok) {
    throw new ApiError(response.status, await readErrorText(response));
  }
  return (await response.json()) as T;
}

async function tryAbort(uploadId: string): Promise<void> {
  try {
    await fetch(`${apiBase}/uploads/${uploadId}/abort`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
  } catch {
    /* ignore */
  }
}

async function readErrorText(response: Response): Promise<string> {
  const fallback = response.statusText || `HTTP ${response.status}`;
  const text = await response.text();
  if (!text) return fallback;
  try {
    const body = JSON.parse(text) as { error?: string; message?: string };
    return body.error ?? body.message ?? text;
  } catch {
    return text;
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException("upload aborted", "AbortError");
}

function isAbortError(err: unknown): boolean {
  return (err instanceof DOMException || err instanceof Error) && err.name === "AbortError";
}

function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      window.clearTimeout(timer);
      reject(new DOMException("upload aborted", "AbortError"));
    }, { once: true });
  });
}

// ===== Settings preset helpers =====

export const CHUNK_SIZE_PRESETS: Array<{ value: number; label: string }> = [
  { value: 1 * 1024 * 1024, label: "1 MB" },
  { value: 4 * 1024 * 1024, label: "4 MB" },
  { value: 8 * 1024 * 1024, label: "8 MB" },
  { value: 16 * 1024 * 1024, label: "16 MB" },
  { value: 32 * 1024 * 1024, label: "32 MB" },
  { value: 64 * 1024 * 1024, label: "64 MB" }
];

export const CONCURRENCY_PRESETS: number[] = [1, 2, 3, 4, 6, 8];
