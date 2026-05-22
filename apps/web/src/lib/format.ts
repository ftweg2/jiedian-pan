import type { FileItem, NodeItem, StoragePolicy } from "../api.js";

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

export function formatDateTime(value: string): string {
  return new Date(value).toLocaleString([], { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function formatFullDateTime(value: string): string {
  return new Date(value).toLocaleString();
}

export function relativeTime(value: string): string {
  const diff = Date.now() - new Date(value).getTime();
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "刚刚";
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`;
  return formatDateTime(value);
}

export function policyLabel(policy: StoragePolicy): string {
  return { standard: "普通", important: "重要", temporary: "临时" }[policy];
}

export function policyDescription(policy: StoragePolicy): string {
  return { standard: "单副本日常资料", important: "至少双副本", temporary: "到期后自动清理" }[policy];
}

export function nodeStatusLabel(status: NodeItem["status"]): string {
  const map: Record<string, string> = {
    active: "正常",
    degraded: "降级",
    offline: "离线",
    decommissioning: "下线中",
    lost: "失联",
    disabled: "停用"
  };
  return map[status] ?? status;
}

export function fileStatusLabel(status: FileItem["status"]): string {
  return { active: "可用", pending: "处理中", failed: "失败", deleted: "已删除", trashed: "回收站" }[status];
}

export function fileStatusTone(status: FileItem["status"]): "good" | "warn" | "danger" | "neutral" {
  if (status === "active") return "good";
  if (status === "pending") return "warn";
  if (status === "trashed") return "neutral";
  return "danger";
}

export function shareStatusLabel(status: string): string {
  const normalized = status.toLowerCase();
  if (normalized === "active") return "可访问";
  if (normalized === "expired") return "已过期";
  if (normalized === "revoked") return "已撤销";
  if (normalized === "disabled") return "已停用";
  return status;
}

export function replicaStatusLabel(status: string): string {
  const normalized = status.toLowerCase();
  if (normalized === "available") return "可用";
  if (normalized === "pending") return "等待校验";
  if (normalized === "failed") return "失败";
  if (normalized === "missing") return "缺失";
  return status;
}

export function replicaStatusTone(status: string): "good" | "warn" | "danger" | "neutral" {
  const normalized = status.toLowerCase();
  if (normalized === "available") return "good";
  if (normalized === "pending") return "warn";
  if (normalized.includes("fail") || normalized.includes("missing") || normalized.includes("corrupt") || normalized.includes("mismatch")) return "danger";
  return "neutral";
}

export function isReplicaFailure(status: string): boolean {
  const normalized = status.toLowerCase();
  return normalized.includes("fail") || normalized.includes("missing") || normalized.includes("corrupt") || normalized.includes("mismatch");
}

export function toDateTimeLocal(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return localDate.toISOString().slice(0, 16);
}

export function compactErrorMessage(message: string): string {
  const jsonError = message.match(/"error"\s*:\s*"([^"]+)"/);
  const firstLine = (jsonError?.[1] ?? message).split(/\r?\n/)[0].replace(/^Error:\s*/i, "").trim();
  if (firstLine.length <= 120) return firstLine;
  return `${firstLine.slice(0, 117)}...`;
}
