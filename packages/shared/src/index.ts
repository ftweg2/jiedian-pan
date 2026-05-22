export const storagePolicies = ["standard", "important", "temporary"] as const;
export type StoragePolicy = (typeof storagePolicies)[number];

export const userRoles = ["admin", "member"] as const;
export type UserRole = (typeof userRoles)[number];

export const permissionLevels = ["read", "write", "manage"] as const;
export type PermissionLevel = (typeof permissionLevels)[number];

export type ReplicaStatus = "pending" | "available" | "missing" | "deleted";
export type StorageNodeStatus = "active" | "degraded" | "offline" | "disabled";
export type FileStatus = "pending" | "active" | "failed" | "trashed" | "deleted";
export type ShareStatus = "active" | "expired" | "revoked";

export interface Actor {
  id: string;
  role: UserRole;
}

export interface OwnedResource {
  ownerId: string;
}

export interface PermissionGrant {
  userId: string;
  level: PermissionLevel;
}

export interface ShareLimitState {
  status: ShareStatus;
  expiresAt?: Date | string | null;
  maxDownloads?: number | null;
  downloadCount: number;
}

export interface TemporaryFileState {
  policy: StoragePolicy;
  expiresAt?: Date | string | null;
}

export interface NodeStatusReport {
  nodeId?: string;
  freeBytes: number;
  totalBytes: number;
  usedBytes: number;
  objectCount: number;
  checkedAt: string;
}

export function requiredReplicaCount(policy: StoragePolicy): number {
  return policy === "important" ? 2 : 1;
}

export function resolveStoragePolicy(
  folderDefault: StoragePolicy,
  fileOverride?: StoragePolicy | null
): StoragePolicy {
  return fileOverride ?? folderDefault;
}

export function assertTemporaryExpiry(policy: StoragePolicy, expiresAt?: Date | string | null, now = new Date()): void {
  if (policy === "temporary" && !expiresAt) {
    throw new Error("Temporary files must have an expiration time.");
  }

  if (policy !== "temporary") {
    return;
  }

  const expiresAtMs = toTime(expiresAt);
  if (expiresAtMs == null) {
    throw new Error("Temporary files must have a valid expiration time.");
  }

  if (expiresAtMs <= now.getTime()) {
    throw new Error("Temporary files must expire in the future.");
  }
}

const permissionRank: Record<PermissionLevel, number> = {
  read: 1,
  write: 2,
  manage: 3
};

export function permissionAllows(grant: PermissionLevel, required: PermissionLevel): boolean {
  return permissionRank[grant] >= permissionRank[required];
}

export function canAccessResource(
  actor: Actor,
  resource: OwnedResource,
  grants: PermissionGrant[],
  required: PermissionLevel
): boolean {
  if (actor.role === "admin" || actor.id === resource.ownerId) {
    return true;
  }

  return grants.some(
    (grant) => grant.userId === actor.id && permissionAllows(grant.level, required)
  );
}

export function isShareUsable(share: ShareLimitState, now = new Date()): boolean {
  if (share.status !== "active") {
    return false;
  }

  if (share.expiresAt) {
    const expiresAtMs = toTime(share.expiresAt);
    if (expiresAtMs == null || expiresAtMs <= now.getTime()) {
      return false;
    }
  }

  if (share.maxDownloads != null && share.downloadCount >= share.maxDownloads) {
    return false;
  }

  return true;
}

export function isTemporaryFileExpired(file: TemporaryFileState, now = new Date()): boolean {
  if (file.policy !== "temporary") {
    return false;
  }

  const expiresAtMs = toTime(file.expiresAt);
  return expiresAtMs != null && expiresAtMs <= now.getTime();
}

export function normalizePolicy(value: unknown, fallback: StoragePolicy): StoragePolicy {
  return storagePolicies.includes(value as StoragePolicy) ? (value as StoragePolicy) : fallback;
}

export function normalizePermission(value: unknown, fallback: PermissionLevel): PermissionLevel {
  return permissionLevels.includes(value as PermissionLevel) ? (value as PermissionLevel) : fallback;
}

function toTime(value: Date | string | null | undefined): number | null {
  if (!value) {
    return null;
  }

  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}
