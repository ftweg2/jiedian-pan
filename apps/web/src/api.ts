export const apiBase = import.meta.env.VITE_API_BASE_URL ?? "/api";

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: "admin" | "member";
  status?: "active" | "disabled" | string;
  disabled?: boolean;
  disabledAt?: string | null;
  enabled?: boolean;
  createdAt?: string;
}

export interface FolderItem {
  id: string;
  name: string;
  parentId: string | null;
  defaultPolicy: StoragePolicy;
}

export interface FileItem {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: string;
  folderId: string | null;
  policyOverride: StoragePolicy | null;
  effectivePolicy: StoragePolicy;
  expiresAt: string | null;
  status: "pending" | "active" | "failed" | "deleted" | "trashed";
  replicaCount: number;
  createdAt: string;
  updatedAt?: string;
  latestVersionId?: string | null;
  storageLayout?: StorageLayout | "whole" | "chunked" | string | null;
  isChunked?: boolean;
  chunkCount?: number | null;
}

export interface NodeItem {
  id: string;
  name: string;
  baseUrl: string;
  status: "active" | "degraded" | "offline" | "decommissioning" | "disabled";
  priority: number;
  lastSeenAt: string | null;
  freeBytes: string | null;
  totalBytes: string | null;
  lastError?: string | null;
  healthMessage?: string | null;
}

export interface AccessLog {
  id: string;
  actor: string | null;
  file: string | null;
  action: string;
  result: string;
  ip: string | null;
  userAgent?: string | null;
  createdAt: string;
}

export type StoragePolicy = "standard" | "important" | "temporary";
export type ShareLinkStatus = "active" | "expired" | "revoked";

export interface ShareLink {
  id: string;
  fileId?: string;
  status: ShareLinkStatus;
  expiresAt: string | null;
  maxDownloads: number | null;
  downloadCount: number;
  hasPassword?: boolean;
  needsPassword?: boolean;
  createdAt?: string;
  lastAccessAt?: string | null;
  /** Set if the share was created after the token-envelope feature shipped. */
  url?: string | null;
}

export interface ShareList {
  shares: ShareLink[];
}

export interface ShareCreateResponse {
  share: ShareLink & { url: string };
}

export interface SharePublicShareMeta {
  needsPassword: boolean;
  expiresAt: string | null;
  maxDownloads: number | null;
  downloadCount: number;
}

export type SharePublicMeta =
  | {
      kind: "file";
      file: { name: string; mimeType?: string; sizeBytes: string };
      share: SharePublicShareMeta;
    }
  | {
      kind: "folder";
      folder: { id: string; name: string };
      share: SharePublicShareMeta;
    };

export interface FolderShareListingFile {
  kind: "file";
  id: string;
  name: string;
  sizeBytes: string;
  mimeType: string;
  effectivePolicy: string;
  createdAt: string;
}

export interface FolderShareListingFolder {
  kind: "folder";
  id: string;
  name: string;
  childCount: number;
}

export interface FolderShareListing {
  share: {
    rootFolder: { id: string; name: string };
    needsPassword: boolean;
    expiresAt: string | null;
    maxDownloads: number | null;
    downloadCount: number;
  };
  breadcrumb: Array<{ id: string; name: string }>;
  folders: FolderShareListingFolder[];
  files: FolderShareListingFile[];
}

export interface FileReplicaDetail {
  id?: string;
  nodeId?: string | null;
  nodeName?: string | null;
  nodeStatus?: NodeItem["status"] | string | null;
  status: string;
  verifiedAt?: string | null;
  lastError?: string | null;
}

export interface StorageLayout {
  layout?: "whole" | "chunked" | string;
  isChunked?: boolean;
  chunkedUploadDownloadSupported?: boolean;
  chunkSizeBytes?: string | number | null;
  declaredChunkCount?: number | null;
  chunkCount?: number | null;
  wholeReplicaCount?: number | null;
  chunkReplicaCount?: number | null;
}

export interface FileChunkDetail {
  index: number;
  sizeBytes?: string | number | null;
  size?: string | number | null;
  hash?: string | null;
  sha256?: string | null;
  replicas?: FileReplicaDetail[];
}

export interface FileVersionDetail {
  id: string;
  createdAt?: string;
  sizeBytes?: string | number | null;
  size?: string | number | null;
  replicaCount?: number;
  availableReplicaCount?: number;
  storageLayout?: StorageLayout | "whole" | "chunked" | string | null;
  isChunked?: boolean;
  chunkSizeBytes?: string | number | null;
  declaredChunkCount?: number | null;
  chunkCount?: number | null;
  streamingDownloadSupported?: boolean;
  replicaHealth?: {
    requiredReplicasPerObject?: number;
    wholeReplicaCount?: number;
    availableWholeReplicaCount?: number;
    missingWholeReplicaCount?: number;
    unavailableWholeNodeCount?: number;
    chunkReplicaCount?: number;
    availableChunkReplicaCount?: number;
    missingChunkReplicaCount?: number;
    unavailableChunkNodeCount?: number;
    chunksAtRisk?: number;
  };
  risks?: FileRiskFlag[];
  replicas?: FileReplicaDetail[];
}

export interface FileShareSummary {
  total: number;
  active: number;
  expired: number;
  revoked: number;
  passwordProtected: number;
  lastCreatedAt?: string | null;
  lastAccessAt?: string | null;
}

export interface FileAccessSummary {
  lastAccessAt?: string | null;
  lastActor?: string | null;
  recentDownloads?: number;
  recentShareDownloads?: number;
  recentFailures?: number;
}

export interface FileAccessLogItem {
  id: string;
  actorId?: string | null;
  shareLinkId?: string | null;
  nodeId?: string | null;
  action: string;
  result: string;
  createdAt: string;
}

export interface FileRiskFlag {
  type: "important_replica_shortage" | "node_offline" | "replica_verification_failed" | "storage_unavailable" | string;
  severity?: "info" | "warning" | "critical" | string;
  message: string;
  nodeId?: string | null;
  fileId?: string | null;
}

export interface FileDetail {
  file: FileItem;
  latestVersion?: FileVersionDetail | null;
  versions?: FileVersionDetail[];
  storageLayout?: StorageLayout | null;
  chunks?: FileChunkDetail[];
  shareSummary?: FileShareSummary | null;
  recentAccess?: FileAccessSummary | null;
  risks?: FileRiskFlag[];
}

export interface FileDetailResponse {
  file?: FileItem & { latestVersion?: FileVersionDetail | null };
  latestVersion?: FileVersionDetail | null;
  latestVersionId?: string | null;
  versions?: FileVersionDetail[];
  replicas?: FileReplicaDetail[];
  storageLayout?: StorageLayout | null;
  chunks?: FileChunkDetail[];
  shares?: ShareLink[];
  shareSummary?: FileShareSummary | null;
  recentAccess?: FileAccessSummary | FileAccessLogItem[] | null;
  accessSummary?: FileAccessSummary | null;
  risks?: FileRiskFlag[];
}

export interface FileUploadResponse {
  file: FileItem;
}

export interface FileVersionList {
  versions: FileVersionDetail[];
}

export interface TrashList {
  files?: FileItem[];
  items?: FileItem[];
}

export interface AccessLogList {
  logs?: AccessLog[];
  items?: AccessLog[];
  total?: number;
  page?: number;
  pageSize?: number;
  nextCursor?: string | null;
}

export interface UserList {
  users: SessionUser[];
}

export interface FileRiskItem {
  file: FileItem;
  latestVersionId?: string | null;
  risks: FileRiskFlag[];
}

export interface FileRiskList {
  risks: FileRiskItem[];
}

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function readErrorMessage(response: Response): Promise<string> {
  const fallback = response.statusText || `HTTP ${response.status}`;
  const text = await response.text();
  if (!text) return fallback;
  try {
    const body = JSON.parse(text) as { error?: string; message?: string; details?: string };
    return body.error ?? body.message ?? body.details ?? text;
  } catch {
    return text;
  }
}

export function absoluteAppUrl(pathOrUrl: string): string {
  try {
    return new URL(pathOrUrl, window.location.origin).toString();
  } catch {
    return pathOrUrl;
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const hasBody = init.body !== undefined && init.body !== null;
  const headers = new Headers(init.headers);
  if (hasBody && !(init.body instanceof FormData) && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    credentials: "include",
    headers
  });

  if (!response.ok) {
    throw new ApiError(response.status, await readErrorMessage(response));
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export async function download(path: string, filename: string, body?: unknown): Promise<void> {
  // POST downloads (e.g. share with password) must send a request body, so we
  // can't use a plain <a href>. Fall back to fetch + blob for those.
  if (body !== undefined && body !== null) {
    const response = await fetch(`${apiBase}${path}`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      throw new ApiError(response.status, await readErrorMessage(response));
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    triggerAnchorDownload(url, filename);
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    return;
  }

  // GET downloads: hand the URL to the browser so it streams the response
  // directly to disk with a native progress UI. Avoids buffering large files
  // in memory and gives the user instant visual feedback (download bar).
  // Same-origin (/api/ is proxied through the web nginx) so cookies are sent.
  triggerAnchorDownload(`${apiBase}${path}`, filename);
}

function triggerAnchorDownload(href: string, filename: string): void {
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}
