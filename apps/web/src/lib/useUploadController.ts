import { useCallback, useEffect, useRef, useState } from "react";
import type { FileItem, StoragePolicy } from "../api.js";
import { chunkedUpload, type ChunkedUploadProgress } from "./chunked-upload.js";
import { uploadErrorMessage } from "./errors.js";

export type UploadStatus = "waiting" | "uploading" | "completing" | "success" | "failed" | "cancelled";

export interface UploadItem {
  id: string;
  file: File;
  folderId: string | null;
  folderPolicy: StoragePolicy;
  policyOverride: StoragePolicy | "";
  expiresAtIso: string | null;
  status: UploadStatus;
  uploadedBytes: number;
  completedChunks: number;
  totalChunks: number;
  inFlight: number;
  error?: string;
  uploaded?: FileItem;
}

export interface OpenUploadOptions {
  folderId: string | null;
  folderPolicy: StoragePolicy;
}

export interface UploadController {
  queue: UploadItem[];
  isOpen: boolean;
  busy: boolean;
  activeFolderId: string | null;
  activeFolderPolicy: StoragePolicy;
  chunkSize: number;
  concurrency: number;
  policyOverride: StoragePolicy | "";
  expiresAtIso: string | null;
  inFlightCount: number;
  hasInFlight: boolean;
  setChunkSize: (value: number) => void;
  setConcurrency: (value: number) => void;
  setPolicyOverride: (value: StoragePolicy | "") => void;
  setExpiresAtIso: (value: string | null) => void;
  openDialog: (options: OpenUploadOptions) => void;
  closeDialog: () => void;
  addFiles: (files: FileList | File[]) => void;
  removeItem: (id: string) => void;
  cancelItem: (id: string) => void;
  retryItem: (id: string) => Promise<void>;
  clearSuccessful: () => void;
  startUploads: () => Promise<void>;
}

const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024;
const DEFAULT_CONCURRENCY = 4;
const LS_CHUNK_SIZE = "wangpan:upload-chunk-size";
const LS_CONCURRENCY = "wangpan:upload-concurrency";

export interface UseUploadControllerOptions {
  onUploaded: (count: number, firstName: string) => Promise<void> | void;
  onError: (message: string) => void;
}

export function useUploadController(opts: UseUploadControllerOptions): UploadController {
  const [queue, setQueue] = useState<UploadItem[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [activeFolderId, setActiveFolderId] = useState<string | null>(null);
  const [activeFolderPolicy, setActiveFolderPolicy] = useState<StoragePolicy>("standard");
  const [policyOverride, setPolicyOverride] = useState<StoragePolicy | "">("");
  const [expiresAtIso, setExpiresAtIso] = useState<string | null>(null);
  const [chunkSize, setChunkSize] = useState<number>(() => readPreset(LS_CHUNK_SIZE, DEFAULT_CHUNK_SIZE));
  const [concurrency, setConcurrency] = useState<number>(() => readPreset(LS_CONCURRENCY, DEFAULT_CONCURRENCY));

  const controllersRef = useRef<Map<string, AbortController>>(new Map());
  const cancelledRef = useRef<Set<string>>(new Set());
  const onUploadedRef = useRef(opts.onUploaded);
  const onErrorRef = useRef(opts.onError);
  useEffect(() => { onUploadedRef.current = opts.onUploaded; }, [opts.onUploaded]);
  useEffect(() => { onErrorRef.current = opts.onError; }, [opts.onError]);

  const inFlightCount = queue.filter((item) => isInFlight(item.status)).length;
  const hasInFlight = inFlightCount > 0;

  // Block accidental navigation/close while uploads are in flight.
  useEffect(() => {
    if (!hasInFlight) return;
    function handle(event: BeforeUnloadEvent) {
      event.preventDefault();
      // returnValue is required by older browsers; modern browsers show their own generic message.
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", handle);
    return () => window.removeEventListener("beforeunload", handle);
  }, [hasInFlight]);

  const updateItem = useCallback((id: string, patch: Partial<UploadItem>) => {
    setQueue((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }, []);

  const setChunkSizePersisted = useCallback((value: number) => {
    setChunkSize(value);
    try { localStorage.setItem(LS_CHUNK_SIZE, String(value)); } catch { /* ignore */ }
  }, []);

  const setConcurrencyPersisted = useCallback((value: number) => {
    setConcurrency(value);
    try { localStorage.setItem(LS_CONCURRENCY, String(value)); } catch { /* ignore */ }
  }, []);

  const openDialog = useCallback((options: OpenUploadOptions) => {
    setActiveFolderId(options.folderId);
    setActiveFolderPolicy(options.folderPolicy);
    setIsOpen(true);
  }, []);

  const closeDialog = useCallback(() => {
    setIsOpen(false);
  }, []);

  const addFiles = useCallback((files: FileList | File[]) => {
    const arr = Array.from(files);
    if (arr.length === 0) return;
    const effectivePolicy: StoragePolicy = (policyOverride || activeFolderPolicy) as StoragePolicy;
    const expiresForPolicy = effectivePolicy === "temporary" ? expiresAtIso : null;
    setQueue((current) => [
      ...current,
      ...arr.map<UploadItem>((file) => ({
        id: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2, 8)}`,
        file,
        folderId: activeFolderId,
        folderPolicy: activeFolderPolicy,
        policyOverride,
        expiresAtIso: expiresForPolicy,
        status: "waiting",
        uploadedBytes: 0,
        completedChunks: 0,
        totalChunks: 0,
        inFlight: 0
      }))
    ]);
  }, [activeFolderId, activeFolderPolicy, policyOverride, expiresAtIso]);

  const removeItem = useCallback((id: string) => {
    setQueue((current) => current.filter((item) => item.id !== id || isInFlight(item.status)));
  }, []);

  const cancelItem = useCallback((id: string) => {
    const item = queue.find((q) => q.id === id);
    if (!item) return;
    if (!isInFlight(item.status)) {
      cancelledRef.current.add(id);
      setQueue((current) => current.filter((q) => q.id !== id));
      return;
    }
    controllersRef.current.get(id)?.abort();
  }, [queue]);

  const clearSuccessful = useCallback(() => {
    setQueue((current) => current.filter((item) => item.status !== "success"));
  }, []);

  const uploadIds = useCallback(async (ids: string[]) => {
    if (ids.length === 0 || busy) return;
    setBusy(true);
    let uploadedCount = 0;
    let firstName = "";
    let failed = 0;
    for (const id of ids) cancelledRef.current.delete(id);

    try {
      // capture current queue snapshot to iterate items in their saved order
      const snapshot = queue.filter((q) => ids.includes(q.id));
      for (const item of snapshot) {
        if (cancelledRef.current.has(item.id)) {
          cancelledRef.current.delete(item.id);
          continue;
        }
        const itemEffectivePolicy: StoragePolicy = (item.policyOverride || item.folderPolicy) as StoragePolicy;
        if (itemEffectivePolicy === "temporary" && !item.expiresAtIso) {
          updateItem(item.id, { status: "failed", error: "临时文件必须设置过期时间" });
          failed += 1;
          continue;
        }
        const controller = new AbortController();
        controllersRef.current.set(item.id, controller);
        updateItem(item.id, {
          status: "uploading",
          error: undefined,
          uploadedBytes: 0,
          completedChunks: 0,
          totalChunks: 0,
          inFlight: 0
        });

        try {
          const uploaded = await chunkedUpload({
            file: item.file,
            folderId: item.folderId,
            policyOverride: (item.policyOverride || null) as StoragePolicy | null,
            expiresAt: item.expiresAtIso,
            chunkSize,
            concurrency,
            signal: controller.signal,
            onProgress: (progress: ChunkedUploadProgress) => {
              updateItem(item.id, {
                status: progress.stage === "completing" ? "completing" : "uploading",
                uploadedBytes: progress.uploadedBytes,
                completedChunks: progress.completedChunks,
                totalChunks: progress.totalChunks,
                inFlight: progress.inFlight
              });
            }
          });
          uploadedCount += 1;
          if (!firstName) firstName = item.file.name;
          updateItem(item.id, {
            status: "success",
            uploaded,
            uploadedBytes: item.file.size,
            completedChunks: 0,
            totalChunks: 0,
            inFlight: 0
          });
        } catch (err) {
          const aborted = isAbortError(err);
          if (!aborted) failed += 1;
          updateItem(item.id, {
            status: aborted ? "cancelled" : "failed",
            error: aborted ? "已取消" : uploadErrorMessage(err, itemEffectivePolicy)
          });
        } finally {
          controllersRef.current.delete(item.id);
        }
      }

      if (uploadedCount > 0) await onUploadedRef.current(uploadedCount, firstName);
      if (failed > 0) onErrorRef.current(`${failed} 个文件上传失败,可在队列中重试。`);
    } finally {
      setBusy(false);
    }
  }, [busy, queue, chunkSize, concurrency, updateItem]);

  const startUploads = useCallback(async () => {
    const ids = queue
      .filter((item) => item.status === "waiting" || item.status === "failed" || item.status === "cancelled")
      .map((item) => item.id);
    await uploadIds(ids);
  }, [queue, uploadIds]);

  const retryItem = useCallback(async (id: string) => {
    await uploadIds([id]);
  }, [uploadIds]);

  return {
    queue,
    isOpen,
    busy,
    activeFolderId,
    activeFolderPolicy,
    chunkSize,
    concurrency,
    policyOverride,
    expiresAtIso,
    inFlightCount,
    hasInFlight,
    setChunkSize: setChunkSizePersisted,
    setConcurrency: setConcurrencyPersisted,
    setPolicyOverride,
    setExpiresAtIso,
    openDialog,
    closeDialog,
    addFiles,
    removeItem,
    cancelItem,
    retryItem,
    clearSuccessful,
    startUploads
  };
}

export function isInFlight(status: UploadStatus): boolean {
  return status === "uploading" || status === "completing";
}

function isAbortError(err: unknown): boolean {
  return (err instanceof DOMException || err instanceof Error) && err.name === "AbortError";
}

function readPreset(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  } catch {
    return fallback;
  }
}
