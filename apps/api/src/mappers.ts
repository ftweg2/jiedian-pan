import type {
  PermissionLevel as DbPermissionLevel,
  StoragePolicy as DbStoragePolicy,
  UserRole as DbUserRole
} from "@prisma/client";
import type { PermissionLevel, StoragePolicy, UserRole } from "@wangpan/shared";

export function toSharedRole(role: DbUserRole): UserRole {
  return role.toLowerCase() as UserRole;
}

export function toSharedPolicy(policy: DbStoragePolicy): StoragePolicy {
  return policy.toLowerCase() as StoragePolicy;
}

export function toDbPolicy(policy: StoragePolicy): DbStoragePolicy {
  return policy.toUpperCase() as DbStoragePolicy;
}

export function toSharedPermission(level: DbPermissionLevel): PermissionLevel {
  return level.toLowerCase() as PermissionLevel;
}

export function toDbPermission(level: PermissionLevel): DbPermissionLevel {
  return level.toUpperCase() as DbPermissionLevel;
}
