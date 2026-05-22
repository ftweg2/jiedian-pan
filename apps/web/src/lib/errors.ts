import { ApiError, type SessionUser } from "../api.js";
import { compactErrorMessage } from "./format.js";
import type { StoragePolicy } from "../api.js";

export function loginErrorMessage(error: unknown): string {
  const message = compactErrorMessage(error instanceof Error ? error.message : String(error ?? ""));
  const normalized = message.toLowerCase();
  if (normalized.includes("user disabled")) return "账号已停用,请联系管理员。";
  if (error instanceof ApiError && error.status === 401) return "邮箱或密码不正确。";
  return message || "登录失败,请稍后重试。";
}

export function stage8ErrorMessage(error: unknown, action: string): string {
  const message = compactErrorMessage(error instanceof Error ? error.message : String(error ?? ""));
  const normalized = message.toLowerCase();
  if (error instanceof ApiError && error.status === 401) return `无法${action}:登录已失效,请重新登录。`;
  if (normalized.includes("temporary file expired")) return `无法${action}:临时文件已过期,不能恢复。`;
  if (normalized.includes("version")) return `无法${action}:版本文件不可用或已被清理。`;
  if (normalized.includes("trash") || normalized.includes("restore") || normalized.includes("purge")) {
    return `无法${action}:回收站状态不可用,请刷新后重试。`;
  }
  if (normalized.includes("user disabled")) return `无法${action}:该用户已停用。`;
  if (normalized.includes("password") && (normalized.includes("fewer") || normalized.includes("min") || normalized.includes("too small"))) {
    return `无法${action}:新密码至少需要 10 个字符。`;
  }
  if (normalized.includes("user not found")) return `无法${action}:用户不存在或已被删除。`;
  if (normalized.includes("admin")) return `无法${action}:需要管理员权限。`;
  if (error instanceof ApiError) {
    if (error.status === 403) return `无法${action}:当前账号没有管理员或管理权限。`;
    if (error.status === 404 || error.status === 405) return `无法${action}:后端暂未启用该接口。`;
    if (error.status === 409) return `无法${action}:对象状态已变化,请刷新后重试。`;
  }
  return `无法${action}:${message || "请稍后重试。"}`;
}

export function isUserDisabled(user: SessionUser): boolean {
  return user.enabled === false || Boolean(user.disabled) || Boolean(user.disabledAt) || String(user.status ?? "").toLowerCase() === "disabled";
}

export function shareCreateErrorMessage(error: unknown): string {
  if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
    return "无法生成分享链接:当前账号可能没有该文件的管理权限,或文件已删除/不可用。";
  }
  return compactErrorMessage(error instanceof Error ? error.message : String(error ?? ""));
}

export function shareManageErrorMessage(error: unknown, action: string): string {
  if (error instanceof ApiError) {
    if (error.status === 403 || error.status === 404) return `无法${action}分享链接:当前账号没有该文件的管理权限,或链接已不存在。`;
    if (error.status === 409) return `无法${action}分享链接:链接状态已变化,请刷新后重试。`;
  }
  return `无法${action}分享链接:${compactErrorMessage(error instanceof Error ? error.message : String(error ?? ""))}`;
}

export function publicShareErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 404) return "分享链接不存在、已过期,或下载次数已经用完。";
    if (error.status === 403) return "访问密码不正确,或你没有打开此分享的权限。";
  }
  return transferErrorMessage(error);
}

export function transferErrorMessage(error: unknown): string {
  const message = compactErrorMessage(error instanceof Error ? error.message : String(error ?? ""));
  const normalized = message.toLowerCase();
  if (normalized.includes("streaming download failed")) return "流式下载失败:请检查节点连通性后再试。";
  if (normalized.includes("no readable") && normalized.includes("chunk")) return "没有可读分片副本:请检查分片所在节点是否在线。";
  return message || "操作失败,请稍后重试。";
}

export function uploadErrorMessage(error: unknown, policy: StoragePolicy): string {
  const rawMessage = error instanceof Error ? error.message : String(error ?? "");
  const message = compactErrorMessage(rawMessage);
  const normalized = message.toLowerCase();
  const status = error instanceof ApiError ? error.status : undefined;

  if (normalized.includes("interrupted upload")) return "上传已中断:可以重试整个文件上传。";
  if (normalized.includes("chunk cleanup incomplete")) return "分片清理未完成:服务端可能仍在清理临时分片,请稍后重试。";
  if (normalized.includes("streaming upload failed")) return "流式上传失败:网络或节点写入中断,请重试整个文件。";
  if (normalized.includes("hash mismatch") || normalized.includes("checksum mismatch")) return "分片校验失败:hash 不一致,可能是传输中断或节点写入异常。";

  const hasChunk = normalized.includes("chunk") || normalized.includes("分片");
  if (hasChunk && (normalized.includes("capacity") || normalized.includes("enospc") || normalized.includes("no space"))) {
    return "分片容量不足:存储节点剩余空间不够。";
  }
  if (hasChunk && normalized.includes("no readable") && normalized.includes("replica")) {
    return "没有可读分片副本:请检查分片所在节点是否在线。";
  }
  if (hasChunk && (normalized.includes("missing") || normalized.includes("not found"))) {
    return "分片缺失:后端未找到完整分片,请重试上传或检查节点状态。";
  }
  if (hasChunk && (normalized.includes("replica") || normalized.includes("insufficient"))) {
    return "分片副本不足:可用节点不足,无法为分片建立所需副本。";
  }
  if (status === 507 || normalized.includes("enospc") || normalized.includes("no space left") || normalized.includes("capacity") || normalized.includes("quota") || normalized.includes("disk full")) {
    return "容量不足:存储节点剩余空间不够,请清理空间或更换节点后重试。";
  }
  if (normalized.includes("not enough active storage nodes") || normalized.includes("not enough storage nodes") || normalized.includes("no readable replica found")) {
    const match = message.match(/required\s+(\d+),\s*found\s+(\d+)/i);
    const requirement = match ? `(需要 ${match[1]} 个,当前可用 ${match[2]} 个)` : "";
    if (policy === "important" || (match && Number(match[1]) >= 2)) {
      return `重要文件需要两个可用节点${requirement}。`;
    }
    return `节点不足${requirement}。`;
  }

  return message || "上传失败,请稍后重试。";
}

export function fileDetailErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return "当前账号没有读取此文件详情的权限。";
    if (error.status === 409) return "文件当前在回收站或状态已变化,部分详情只能按列表信息显示。";
    if (error.status === 404 || error.status === 405) return "后端详情接口暂不可用,已使用列表字段显示。";
  }
  return `文件详情加载失败:${compactErrorMessage(error instanceof Error ? error.message : String(error ?? ""))}`;
}

export function nodeRefreshErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 503) {
    return "刷新节点状态失败:主服务无法连通部分节点,请检查 baseUrl、网络、防火墙和 Agent Token。";
  }
  const message = compactErrorMessage(error instanceof Error ? error.message : String(error ?? ""));
  return message ? `刷新节点状态失败:${message}` : "刷新节点状态失败,请检查节点服务和网络连通性。";
}
