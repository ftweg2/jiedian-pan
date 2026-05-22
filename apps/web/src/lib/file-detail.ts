import {
  ApiError,
  api,
  type FileAccessLogItem,
  type FileAccessSummary,
  type FileChunkDetail,
  type FileDetail,
  type FileDetailResponse,
  type FileItem,
  type FileReplicaDetail,
  type FileShareSummary,
  type FileVersionDetail,
  type FileVersionList,
  type ShareLink,
  type StorageLayout
} from "../api.js";
import { isReplicaFailure } from "./format.js";
import { requiredReplicaCount } from "./category.js";

export async function fetchFileDetail(file: FileItem): Promise<FileDetail> {
  let lastError: unknown = null;
  for (const path of [`/files/${file.id}/detail`, `/files/${file.id}`]) {
    try {
      const response = await api<FileDetailResponse>(path);
      const detail = normalizeFileDetail(response, file);
      const versions = await fetchFileVersions(file.id);
      return versions ? { ...detail, versions } : detail;
    } catch (err) {
      lastError = err;
      if (!(err instanceof ApiError) || (err.status !== 404 && err.status !== 405)) throw err;
    }
  }
  throw lastError;
}

async function fetchFileVersions(fileId: string): Promise<FileVersionDetail[] | null> {
  try {
    const response = await api<FileVersionList>(`/files/${fileId}/versions`);
    return normalizeVersionList(response.versions, null);
  } catch {
    return null;
  }
}

export function fallbackFileDetail(file: FileItem): FileDetail {
  return {
    file,
    latestVersion: file.latestVersionId ? { id: file.latestVersionId, replicas: [] } : null,
    storageLayout: storageLayoutFromFile(file),
    chunks: [],
    risks: inferFileRisks(file, [])
  };
}

function normalizeFileDetail(response: FileDetailResponse, fallback: FileItem): FileDetail {
  const responseFile = (response.file ?? fallback) as FileItem & { latestVersion?: FileVersionDetail | null };
  const latestVersion = response.latestVersion ?? responseFile.latestVersion ?? response.versions?.[0] ?? null;
  const topLevelReplicas = response.replicas?.map(normalizeReplicaDetail);
  const normalizedNested = latestVersion ? normalizeLatestVersion(latestVersion) : null;
  const normalizedVersion = latestVersion
    ? { ...normalizedNested!, replicas: topLevelReplicas ?? normalizedNested!.replicas }
    : topLevelReplicas
      ? { id: response.latestVersionId ?? responseFile.latestVersionId ?? "latest", replicas: topLevelReplicas }
      : null;
  return {
    file: { ...fallback, ...responseFile },
    latestVersion: normalizedVersion,
    versions: normalizeVersionList(response.versions, normalizedVersion),
    storageLayout: normalizeStorageLayout(response.storageLayout ?? responseFile.storageLayout ?? null, responseFile),
    storageDistribution: response.storageDistribution ?? null,
    chunks: response.chunks?.map(normalizeChunkDetail) ?? [],
    shareSummary: response.shareSummary ?? (response.shares ? summarizeShareLinks(response.shares) : null),
    recentAccess: normalizeAccessSummary(response.recentAccess ?? response.accessSummary ?? null),
    risks: response.risks ?? []
  };
}

function normalizeLatestVersion(version: FileVersionDetail): FileVersionDetail {
  return { ...version, replicas: version.replicas?.map(normalizeReplicaDetail) ?? [] };
}

function normalizeVersionList(versions: FileVersionDetail[] | undefined, latestVersion: FileVersionDetail | null): FileVersionDetail[] {
  const normalized = versions?.map(normalizeLatestVersion) ?? [];
  if (normalized.length > 0) {
    return normalized.sort((a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime());
  }
  return latestVersion ? [latestVersion] : [];
}

function normalizeReplicaDetail(
  replica: FileReplicaDetail & { node?: { id?: string; name?: string; status?: string }; lastVerifiedAt?: string | null }
): FileReplicaDetail {
  return {
    id: replica.id,
    nodeId: replica.nodeId ?? replica.node?.id ?? null,
    nodeName: replica.nodeName ?? replica.node?.name ?? null,
    nodeStatus: replica.nodeStatus ?? replica.node?.status ?? null,
    status: String(replica.status ?? "unknown").toLowerCase(),
    verifiedAt: replica.verifiedAt ?? replica.lastVerifiedAt ?? null,
    lastError: replica.lastError ?? null
  };
}

function normalizeChunkDetail(chunk: FileChunkDetail): FileChunkDetail {
  return { ...chunk, replicas: chunk.replicas?.map(normalizeReplicaDetail) ?? [] };
}

export function storageLayoutFromFile(file: FileItem): StorageLayout | null {
  return normalizeStorageLayout(file.storageLayout ?? null, file);
}

export function normalizeStorageLayout(
  value: FileItem["storageLayout"] | StorageLayout | null,
  file?: { chunkCount?: number | null; replicaCount?: number | null; isChunked?: boolean }
): StorageLayout | null {
  if (value && typeof value === "object") {
    return { ...value, isChunked: value.isChunked ?? value.layout === "chunked", chunkCount: value.chunkCount ?? file?.chunkCount ?? null };
  }
  if (value === "chunked" || file?.isChunked) {
    return { layout: "chunked", isChunked: true, chunkCount: file?.chunkCount ?? null, chunkedUploadDownloadSupported: false };
  }
  if (value === "whole" || file?.isChunked === false) {
    return { layout: "whole", isChunked: false, chunkCount: file?.chunkCount ?? null, wholeReplicaCount: file?.replicaCount ?? null };
  }
  return null;
}

export function storageLayoutLabel(layout: StorageLayout): string {
  return layout.isChunked || layout.layout === "chunked" ? "分片存储" : "整文件";
}

export function fileStorageLayoutBadge(file: FileItem): string | null {
  const layout = storageLayoutFromFile(file);
  return layout ? storageLayoutLabel(layout) : null;
}

export function summarizeShareLinks(shares: ShareLink[]): FileShareSummary {
  const summary: FileShareSummary = {
    total: shares.length,
    active: 0,
    expired: 0,
    revoked: 0,
    passwordProtected: 0,
    lastCreatedAt: null,
    lastAccessAt: null
  };
  for (const share of shares) {
    if (share.status === "active") summary.active += 1;
    else if (share.status === "expired") summary.expired += 1;
    else if (share.status === "revoked") summary.revoked += 1;
    if (shareHasPassword(share)) summary.passwordProtected += 1;
    summary.lastCreatedAt = laterDate(summary.lastCreatedAt, share.createdAt ?? null);
    summary.lastAccessAt = laterDate(summary.lastAccessAt, share.lastAccessAt ?? null);
  }
  return summary;
}

export function shareHasPassword(share: ShareLink): boolean {
  return Boolean(share.hasPassword ?? share.needsPassword);
}

export function shareDownloadLabel(share: ShareLink): string {
  if (share.maxDownloads == null) return `下载 ${share.downloadCount} 次 / 不限`;
  return `下载 ${share.downloadCount} / ${share.maxDownloads} 次`;
}

function normalizeAccessSummary(value: FileAccessSummary | FileAccessLogItem[] | null): FileAccessSummary | null {
  if (!value) return null;
  if (!Array.isArray(value)) return value;
  const summary: FileAccessSummary = { lastAccessAt: null, recentDownloads: 0, recentShareDownloads: 0, recentFailures: 0 };
  for (const log of value) {
    summary.lastAccessAt = laterDate(summary.lastAccessAt, log.createdAt);
    const action = log.action.toLowerCase();
    const result = log.result.toLowerCase();
    if (action.includes("share_download") || log.shareLinkId) summary.recentShareDownloads = (summary.recentShareDownloads ?? 0) + 1;
    else if (action.includes("download")) summary.recentDownloads = (summary.recentDownloads ?? 0) + 1;
    if (result !== "ok" && result !== "success") summary.recentFailures = (summary.recentFailures ?? 0) + 1;
  }
  return summary;
}

function laterDate(current: string | null | undefined, next: string | null | undefined): string | null {
  if (!next) return current ?? null;
  if (!current) return next;
  return new Date(next).getTime() > new Date(current).getTime() ? next : current;
}

export function inferFileRisks(file: FileItem, replicas: FileReplicaDetail[]): Array<{ type: string; message: string; severity: string }> {
  const risks: Array<{ type: string; message: string; severity: string }> = [];
  const required = requiredReplicaCount(file.effectivePolicy);
  if (file.status === "failed") {
    risks.push({ type: "storage_unavailable", severity: "critical", message: "文件当前处于失败状态,请检查节点容量、网络或重新上传。" });
  }
  if (file.replicaCount < required) {
    risks.push({
      type: "important_replica_shortage",
      severity: file.effectivePolicy === "important" ? "critical" : "warning",
      message: file.effectivePolicy === "important"
        ? `重要文件需要 ${required} 个可用副本,当前只有 ${file.replicaCount} 个。`
        : `文件副本不足,当前 ${file.replicaCount}/${required}。`
    });
  }
  if (replicas.some((replica) => isReplicaFailure(replica.status))) {
    risks.push({ type: "replica_verification_failed", severity: "critical", message: "最新版本存在校验失败或不可用副本。" });
  }
  if (replicas.some((replica) => String(replica.nodeStatus ?? "").toLowerCase() === "offline")) {
    risks.push({ type: "node_offline", severity: "warning", message: "有副本所在节点离线,下载或双副本目标可能受影响。" });
  }
  return risks;
}

export function riskDisplayMessage(risk: { type: string; message: string }): string {
  if (risk.type === "important_replica_shortage") return "重要文件健康副本不足";
  if (risk.type === "replica_unavailable") return "副本不可用或校验失败";
  if (risk.type === "replica_node_unavailable" || risk.type === "node_offline") return "副本所在节点不可用";
  if (risk.type === "file_has_no_version") return "文件缺少最新版本";
  return risk.message || risk.type;
}

export function versionDownloadName(file: FileItem, version: FileVersionDetail): string {
  const suffix = version.createdAt ? new Date(version.createdAt).toISOString().replace(/[:\.]/g, "-").slice(0, 19) : version.id.slice(0, 8);
  return `${file.name}.version-${suffix}`;
}

export function versionSizeLabel(version: FileVersionDetail): string {
  const size = version.sizeBytes ?? version.size;
  if (size == null) return "-";
  return formatVersionBytes(Number(size));
}

function formatVersionBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}
