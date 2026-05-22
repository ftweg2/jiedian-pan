import { StorageNodeStatus, UserRole, type PrismaClient } from "@prisma/client";
import type { ApiEnv } from "./env.js";
import { createPasswordHash } from "./auth.js";

export async function bootstrapAdmin(prisma: PrismaClient, env: ApiEnv): Promise<void> {
  if (!env.bootstrapAdminEmail || !env.bootstrapAdminPassword) {
    return;
  }

  const existingUsers = await prisma.user.count();
  if (existingUsers > 0) {
    return;
  }

  await prisma.user.create({
    data: {
      email: env.bootstrapAdminEmail,
      name: "Admin",
      role: UserRole.ADMIN,
      passwordHash: await createPasswordHash(env.bootstrapAdminPassword)
    }
  });
}

export async function bootstrapLocalNode(prisma: PrismaClient, env: ApiEnv): Promise<void> {
  if (!env.bootstrapLocalNodeUrl || !env.bootstrapLocalNodeToken) {
    return;
  }

  const existing = await prisma.storageNode.findFirst({
    where: { baseUrl: env.bootstrapLocalNodeUrl.replace(/\/+$/, "") }
  });
  if (existing) {
    return;
  }

  await prisma.storageNode.create({
    data: {
      name: env.bootstrapLocalNodeName ?? "main-local",
      baseUrl: env.bootstrapLocalNodeUrl.replace(/\/+$/, ""),
      agentToken: env.bootstrapLocalNodeToken,
      status: StorageNodeStatus.ACTIVE,
      priority: 10
    }
  });
}
