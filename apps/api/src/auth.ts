import type { FastifyReply, FastifyRequest } from "fastify";
import argon2 from "argon2";
import type { PrismaClient, User } from "@prisma/client";
import { hashToken, randomToken } from "./crypto.js";
import type { ApiEnv } from "./env.js";
import { toSharedRole } from "./mappers.js";

export const sessionCookieName = "wp_session";

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: "admin" | "member";
}

export function serializeUser(user: Pick<User, "id" | "email" | "name" | "role">): SessionUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: toSharedRole(user.role)
  };
}

export async function createPasswordHash(password: string): Promise<string> {
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1
  });
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

export async function createSession(
  prisma: PrismaClient,
  reply: FastifyReply,
  env: ApiEnv,
  userId: string
): Promise<string> {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + env.sessionTtlDays * 24 * 60 * 60 * 1000);
  await prisma.session.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      expiresAt
    }
  });

  reply.setCookie(sessionCookieName, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.cookieSecure,
    path: "/",
    expires: expiresAt
  });
  return token;
}

export async function clearSession(prisma: PrismaClient, request: FastifyRequest, reply: FastifyReply) {
  const token = request.cookies[sessionCookieName];
  if (token) {
    await prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } });
  }
  reply.clearCookie(sessionCookieName, { path: "/" });
}

export async function getSessionUser(
  prisma: PrismaClient,
  request: FastifyRequest
): Promise<SessionUser | null> {
  const token = request.cookies[sessionCookieName];
  if (!token) {
    return null;
  }

  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true }
  });

  if (!session || session.expiresAt <= new Date()) {
    if (session) {
      await prisma.session.delete({ where: { id: session.id } });
    }
    return null;
  }

  if (session.user.disabledAt) {
    await prisma.session.deleteMany({ where: { userId: session.userId } });
    return null;
  }

  return serializeUser(session.user);
}

export async function requireUser(
  prisma: PrismaClient,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<SessionUser | null> {
  const user = await getSessionUser(prisma, request);
  if (!user) {
    await reply.code(401).send({ error: "authentication required" });
    return null;
  }
  return user;
}

export async function requireAdmin(
  prisma: PrismaClient,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<SessionUser | null> {
  const user = await requireUser(prisma, request, reply);
  if (!user) {
    return null;
  }

  if (user.role !== "admin") {
    await reply.code(403).send({ error: "admin only" });
    return null;
  }

  return user;
}
