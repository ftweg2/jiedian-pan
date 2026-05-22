import type { File, Folder, Permission, PrismaClient } from "@prisma/client";
import type { PermissionLevel } from "@wangpan/shared";
import { canAccessResource } from "@wangpan/shared";
import type { SessionUser } from "./auth.js";
import { toSharedPermission } from "./mappers.js";

export async function canAccessFolder(
  prisma: PrismaClient,
  user: SessionUser,
  folder: Folder,
  required: PermissionLevel
): Promise<boolean> {
  const grants = await collectFolderGrants(prisma, folder.id);
  return canAccessResource(
    { id: user.id, role: user.role },
    { ownerId: folder.ownerId },
    grants,
    required
  );
}

export async function canAccessFile(
  prisma: PrismaClient,
  user: SessionUser,
  file: File & { folder?: Folder | null },
  required: PermissionLevel
): Promise<boolean> {
  const fileGrants = await prisma.permission.findMany({ where: { fileId: file.id } });
  const inheritedFolderGrants = file.folderId ? await collectFolderGrants(prisma, file.folderId) : [];
  return canAccessResource(
    { id: user.id, role: user.role },
    { ownerId: file.ownerId },
    [...toSharedGrants(fileGrants), ...inheritedFolderGrants],
    required
  );
}

export async function collectFolderGrants(prisma: PrismaClient, folderId: string) {
  const folders: string[] = [];
  let currentId: string | null = folderId;

  while (currentId) {
    const folder: { id: string; parentId: string | null } | null = await prisma.folder.findUnique({
      where: { id: currentId },
      select: { id: true, parentId: true }
    });
    if (!folder) {
      break;
    }
    folders.push(folder.id);
    currentId = folder.parentId;
  }

  const grants = await prisma.permission.findMany({
    where: { folderId: { in: folders } }
  });

  return toSharedGrants(grants);
}

function toSharedGrants(grants: Permission[]) {
  return grants.map((grant) => ({
    userId: grant.userId,
    level: toSharedPermission(grant.level)
  }));
}
