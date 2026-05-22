import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { inflateRawSync } from "node:zlib";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import {
  FileStatus,
  FileVersionStorageLayout,
  ReplicaStatus,
  ShareStatus,
  StorageNodeStatus,
  UserRole,
  type Prisma,
  type PrismaClient
} from "@prisma/client";
import { assertTemporaryExpiry, isShareUsable, isTemporaryFileExpired, normalizePermission, normalizePolicy, requiredReplicaCount, resolveStoragePolicy, type StoragePolicy } from "@wangpan/shared";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import { clearSession, createPasswordHash, createSession, requireAdmin, requireUser, verifyPassword, type SessionUser } from "./auth.js";
import { randomBytes } from "node:crypto";
import { decryptBuffer, decryptChunkBuffer, decryptStringWithMaster, encryptChunkWithKey, encryptStreamToChunks, encryptStringWithMaster, hashToken, randomToken, safeEqualHash, sha256, unwrapWrappedFileKey, wrapFileKeyForMaster } from "./crypto.js";
import {
  DEFAULT_CHUNK_SIZE,
  MAX_CHUNK_SIZE,
  createSession as createUploadSession,
  getSession as getUploadSession,
  parseChunkedUploadCap,
  removeSession as removeUploadSession,
  startSessionPruner
} from "./upload-sessions.js";
import archiver from "archiver";
import {
  folderBreadcrumbsToRoot,
  isFileInShareTree,
  isFolderInShareTree,
  listShareFolderContents,
  streamFolderAsZip
} from "./folder-share.js";
import type { ApiEnv } from "./env.js";
import { toDbPermission, toDbPolicy, toSharedPolicy } from "./mappers.js";
import { canAccessFile, canAccessFolder } from "./permissions.js";
import { kickDrain } from "./cleanup.js";
import { declareNodeLost } from "./node-prober.js";
import { AgentStorageDriver } from "@wangpan/storage-driver";
import {
  CHUNK_SIZE_BYTES,
  chunkedVersionHasPerChunkEncryption,
  computeAggregateChunkHashes,
  createPlannedChunkStager,
  createStreamingChunkUploadStager,
  deleteReplicasForFile,
  persistStagedChunkMetadata,
  readAuthenticatedEncryptedChunks,
  readEncryptedObject,
  refreshNodeStatus,
  type ChunkUploadStager,
  type StreamingChunkUploadStager
} from "./replication.js";

const CHUNKED_UPLOAD_MAX_BYTES = parseChunkedUploadCap();

const policySchema = z.enum(["standard", "important", "temporary"]);
const permissionSchema = z.enum(["read", "write", "manage"]);

export async function buildServer(env: ApiEnv, prisma: PrismaClient) {
  const app = Fastify({
    logger: true,
    bodyLimit: env.maxUploadBytes + 1024 * 1024
  });

  await app.register(cookie, { secret: env.cookieSecret });
  await app.register(cors, {
    origin: env.corsOrigin === "*" ? true : env.corsOrigin,
    credentials: true
  });
  await app.register(multipart, {
    limits: { fileSize: env.maxUploadBytes, files: 1 }
  });

  // Raw byte chunks for the resumable upload protocol (PUT /uploads/:id/chunk/:index).
  // Default Fastify has no octet-stream parser; this stores body as a Buffer.
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer", bodyLimit: MAX_CHUNK_SIZE + 1024 * 1024 },
    (_request, body, done) => done(null, body)
  );

  startSessionPruner();

  app.setErrorHandler((error, request, reply) => {
    const message = error instanceof Error ? error.message : String(error);

    // Always log the original error — otherwise problems that happen AFTER a
    // route set content-type (e.g. a streamed download throwing mid-flight)
    // can be hidden by Fastify's "invalid payload type" follow-up error.
    request.log.error({ err: error }, "request failed in handler");

    // If the route already set content-type to something non-JSON (e.g.
    // application/octet-stream for a download that then threw), reply.send
    // of a JSON object would itself blow up with FST_ERR_REP_INVALID_PAYLOAD_TYPE.
    // Reset to JSON so the client gets a usable error response.
    if (!reply.sent) {
      reply.header("content-type", "application/json; charset=utf-8");
      reply.removeHeader("content-length");
      reply.removeHeader("content-disposition");
    }

    if (error instanceof z.ZodError) {
      return reply.code(400).send({ error: error.issues.map((issue) => issue.message).join("; ") });
    }

    const statusCode = httpStatusCode(error);
    if (statusCode) {
      return reply.code(statusCode).send({ error: message });
    }

    if (
      message.includes("MAX_UPLOAD_BYTES") ||
      message.includes("Temporary files") ||
      message.includes("expiresAt must") ||
      message.includes("interrupted upload") ||
      message.includes("multipart field 'file'") ||
      message.includes("chunk body must be") ||
      message.includes("upload session") ||
      message.includes("out-of-order chunk") ||
      message.includes("upload incomplete") ||
      message.includes("upload size mismatch") ||
      message.includes("invalid chunk index") ||
      message.includes("chunk") && message.includes("size mismatch")
    ) {
      return reply.code(400).send({ error: message });
    }
    if (message.includes("file too large")) {
      return reply.code(413).send({ error: message });
    }

    if (
      message.includes("not enough active storage nodes") ||
      message.includes("not enough storage capacity") ||
      message.includes("not enough capacity for important replicas") ||
      message.includes("chunk upload failure") ||
      message.includes("chunk read failure") ||
      message.includes("cleanup incomplete") ||
      message.includes("streaming upload failed") ||
      message.includes("no readable replica found") ||
      message.includes("no readable chunk replica found") ||
      message.includes("chunk metadata incomplete") ||
      message.includes("chunked version has no chunks") ||
      message.includes("ciphertext hash mismatch") ||
      message.includes("plaintext hash mismatch")
    ) {
      return reply.code(503).send({ error: message });
    }

    return reply.code(500).send({ error: message || "internal server error" });
  });

  app.get("/health", async () => ({ ok: true }));

  app.post("/auth/login", async (request, reply) => {
    const body = loginSchema.parse(request.body);
    const user = await prisma.user.findUnique({ where: { email: body.email.toLowerCase() } });
    if (!user || !(await verifyPassword(user.passwordHash, body.password))) {
      return reply.code(401).send({ error: "invalid email or password" });
    }
    if (user.disabledAt) {
      return reply.code(403).send({ error: "user disabled" });
    }

    await createSession(prisma, reply, env, user.id);
    return { user: serializeUserForResponse(user) };
  });

  app.post("/auth/logout", async (request, reply) => {
    await clearSession(prisma, request, reply);
    return { ok: true };
  });

  app.get("/auth/me", async (request, reply) => {
    const user = await requireUser(prisma, request, reply);
    return user ? { user } : undefined;
  });

  app.get("/users", async (request, reply) => {
    const user = await requireAdmin(prisma, request, reply);
    if (!user) return;
    const users = await prisma.user.findMany({ orderBy: { createdAt: "asc" } });
    return { users: users.map(serializeUserForResponse) };
  });

  app.post<{ Params: { id: string } }>("/users/:id/disable", async (request, reply) => {
    const admin = await requireAdmin(prisma, request, reply);
    if (!admin) return;

    const user = await prisma.user.findUnique({ where: { id: request.params.id } });
    if (!user) {
      return reply.code(404).send({ error: "user not found" });
    }

    const disabled = await prisma.user.update({
      where: { id: user.id },
      data: { disabledAt: user.disabledAt ?? new Date() }
    });
    await prisma.session.deleteMany({ where: { userId: user.id } });
    return { user: serializeUserForResponse(disabled) };
  });

  app.post<{ Params: { id: string } }>("/users/:id/enable", async (request, reply) => {
    const admin = await requireAdmin(prisma, request, reply);
    if (!admin) return;

    const user = await prisma.user.findUnique({ where: { id: request.params.id } });
    if (!user) {
      return reply.code(404).send({ error: "user not found" });
    }

    const enabled = await prisma.user.update({
      where: { id: user.id },
      data: { disabledAt: null }
    });
    return { user: serializeUserForResponse(enabled) };
  });

  app.post<{ Params: { id: string } }>("/users/:id/reset-password", async (request, reply) => {
    const admin = await requireAdmin(prisma, request, reply);
    if (!admin) return;

    const body = resetPasswordSchema.parse(request.body);
    const user = await prisma.user.findUnique({ where: { id: request.params.id } });
    if (!user) {
      return reply.code(404).send({ error: "user not found" });
    }

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await createPasswordHash(body.password) }
    });
    await prisma.session.deleteMany({ where: { userId: user.id } });
    return { user: serializeUserForResponse(updated) };
  });

  app.post("/users", async (request, reply) => {
    const admin = await requireAdmin(prisma, request, reply);
    if (!admin) return;

    const body = createUserSchema.parse(request.body);
    const user = await prisma.user.create({
      data: {
        email: body.email.toLowerCase(),
        name: body.name,
        role: body.role === "admin" ? UserRole.ADMIN : UserRole.MEMBER,
        passwordHash: await createPasswordHash(body.password)
      }
    });
    return reply.code(201).send({ user: serializeUserForResponse(user) });
  });

  app.get("/folders", async (request, reply) => {
    const user = await requireUser(prisma, request, reply);
    if (!user) return;

    const parentId = optionalQueryId(request, "parentId");
    const folders = await prisma.folder.findMany({
      where: { parentId },
      include: { permissions: true },
      orderBy: { name: "asc" }
    });

    const visible = [];
    for (const folder of folders) {
      if (await canAccessFolder(prisma, user, folder, "read")) {
        visible.push(serializeFolder(folder));
      }
    }

    return { folders: visible };
  });

  app.post("/folders", async (request, reply) => {
    const user = await requireUser(prisma, request, reply);
    if (!user) return;

    const body = createFolderSchema.parse(request.body);
    if (body.parentId) {
      const parent = await prisma.folder.findUnique({ where: { id: body.parentId } });
      if (!parent || !(await canAccessFolder(prisma, user, parent, "write"))) {
        return reply.code(403).send({ error: "no write access to parent folder" });
      }
    }

    const folder = await prisma.folder.create({
      data: {
        name: body.name,
        parentId: body.parentId ?? null,
        ownerId: user.id,
        defaultPolicy: toDbPolicy(body.defaultPolicy)
      }
    });
    return reply.code(201).send({ folder: serializeFolder(folder) });
  });

  app.patch<{ Params: { id: string } }>("/folders/:id", async (request, reply) => {
    const user = await requireUser(prisma, request, reply);
    if (!user) return;

    const folder = await prisma.folder.findUnique({ where: { id: request.params.id } });
    if (!folder || !(await canAccessFolder(prisma, user, folder, "manage"))) {
      return reply.code(404).send({ error: "folder not found" });
    }

    const body = updateFolderSchema.parse(request.body);

    // Validate move: parentId is null (move to root) or another folder you can write to.
    // Reject moving a folder into itself or any of its descendants (would create a cycle).
    if (body.parentId !== undefined) {
      if (body.parentId === folder.id) {
        return reply.code(400).send({ error: "cannot move a folder into itself" });
      }
      if (body.parentId !== null) {
        const destination = await prisma.folder.findUnique({ where: { id: body.parentId } });
        if (!destination || !(await canAccessFolder(prisma, user, destination, "write"))) {
          return reply.code(404).send({ error: "destination folder not found" });
        }
        if (await isDescendantOf(prisma, body.parentId, folder.id)) {
          return reply.code(400).send({ error: "cannot move a folder into its own subtree" });
        }
      }
    }

    const updated = await prisma.folder.update({
      where: { id: folder.id },
      data: {
        name: body.name ?? undefined,
        defaultPolicy: body.defaultPolicy ? toDbPolicy(body.defaultPolicy) : undefined,
        parentId: body.parentId === undefined ? undefined : body.parentId
      }
    });
    return { folder: serializeFolder(updated) };
  });

  app.delete<{ Params: { id: string } }>("/folders/:id", async (request, reply) => {
    const user = await requireUser(prisma, request, reply);
    if (!user) return;

    const folder = await prisma.folder.findUnique({ where: { id: request.params.id } });
    if (!folder || !(await canAccessFolder(prisma, user, folder, "manage"))) {
      return reply.code(404).send({ error: "folder not found" });
    }

    const folderIds = await collectFolderTreeIds(prisma, folder.id);
    const files = await prisma.file.findMany({
      where: { folderId: { in: folderIds }, status: { notIn: [FileStatus.DELETED, FileStatus.TRASHED] } },
      include: { folder: true }
    });

    for (const file of files) {
      if (!(await canAccessFile(prisma, user, file, "manage"))) {
        return reply.code(403).send({ error: "no manage access to every file in folder" });
      }
    }

    for (const file of files) {
      await prisma.file.update({
        where: { id: file.id },
        data: {
          status: FileStatus.TRASHED,
          policyOverride: toDbPolicy(effectivePolicyForFile(file))
        }
      });
    }
    await prisma.folder.deleteMany({ where: { id: { in: folderIds } } });
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>("/folders/:id/permissions", async (request, reply) => {
    const user = await requireUser(prisma, request, reply);
    if (!user) return;

    const folder = await prisma.folder.findUnique({ where: { id: request.params.id } });
    if (!folder || !(await canAccessFolder(prisma, user, folder, "manage"))) {
      return reply.code(404).send({ error: "folder not found" });
    }

    const body = permissionBodySchema.parse(request.body);
    if (!(await prisma.user.findUnique({ where: { id: body.userId }, select: { id: true } }))) {
      return reply.code(400).send({ error: "permission target user not found" });
    }

    const permission = await prisma.permission.upsert({
      where: { userId_folderId: { userId: body.userId, folderId: folder.id } },
      update: { level: toDbPermission(body.level) },
      create: { userId: body.userId, folderId: folder.id, level: toDbPermission(body.level) }
    });
    return { permission };
  });

  app.get("/files", async (request, reply) => {
    const user = await requireUser(prisma, request, reply);
    if (!user) return;

    const query = request.query as Record<string, string | undefined>;
    const folderId = optionalQueryId(request, "folderId");
    const q = (query.q ?? "").trim();
    const recursive = query.recursive === "1" || query.recursive === "true";

    // recursive=true: search across ALL folders the user can read (ignoring folderId).
    // Adds a case-insensitive name filter if `q` is given.
    const where = recursive
      ? {
          status: { notIn: [FileStatus.DELETED, FileStatus.TRASHED] },
          ...(q ? { name: { contains: q, mode: "insensitive" as const } } : {})
        }
      : {
          folderId,
          status: { notIn: [FileStatus.DELETED, FileStatus.TRASHED] },
          ...(q ? { name: { contains: q, mode: "insensitive" as const } } : {})
        };

    const files = await prisma.file.findMany({
      where,
      include: {
        folder: true,
        versions: {
          orderBy: { createdAt: "desc" },
          take: 1,
          include: { replicas: true }
        }
      },
      orderBy: { createdAt: "desc" },
      take: recursive ? 500 : undefined // cap recursive search to keep response bounded
    });

    const visible = [];
    for (const file of files) {
      if (await canAccessFile(prisma, user, file, "read")) {
        visible.push(serializeFile(file));
      }
    }
    return { files: visible };
  });

  app.get("/files/risks", async (request, reply) => {
    const user = await requireUser(prisma, request, reply);
    if (!user) return;

    const files = await prisma.file.findMany({
      where: { status: { notIn: [FileStatus.DELETED, FileStatus.TRASHED] } },
      include: {
        folder: true,
        versions: {
          orderBy: { createdAt: "desc" },
          take: 1,
          include: {
            replicas: { include: { node: true }, orderBy: { createdAt: "asc" } },
            chunks: {
              orderBy: { index: "asc" },
              include: { replicas: { include: { node: true }, orderBy: { createdAt: "asc" } } }
            }
          }
        }
      },
      orderBy: { updatedAt: "desc" }
    });

    const risks = [];
    for (const file of files) {
      if (!(await canAccessFile(prisma, user, file, "manage"))) {
        continue;
      }

      const fileRisks = buildFileRisks(file);
      if (fileRisks.length > 0) {
        risks.push({
          file: serializeFile(file),
          latestVersionId: file.versions[0]?.id ?? null,
          risks: fileRisks
        });
      }
    }

    return { risks };
  });

  app.get("/files/trash", async (request, reply) => {
    const user = await requireUser(prisma, request, reply);
    if (!user) return;

    const files = await prisma.file.findMany({
      where: { status: FileStatus.TRASHED },
      include: {
        folder: true,
        versions: {
          orderBy: { createdAt: "desc" },
          take: 1,
          include: { replicas: true, chunks: { include: { replicas: true } } }
        }
      },
      orderBy: { updatedAt: "desc" }
    });

    const visible = [];
    for (const file of files) {
      if (await canAccessFile(prisma, user, file, "manage")) {
        visible.push(serializeFile(file));
      }
    }
    return { files: visible };
  });

  app.get<{ Params: { id: string } }>("/files/:id/detail", async (request, reply) => {
    const user = await requireUser(prisma, request, reply);
    if (!user) return;

    const file = await prisma.file.findUnique({
      where: { id: request.params.id },
      include: {
        folder: true,
        versions: {
          orderBy: { createdAt: "desc" },
          take: 1,
          include: {
            replicas: { include: { node: true }, orderBy: { createdAt: "asc" } },
            chunks: {
              orderBy: { index: "asc" },
              include: { replicas: { include: { node: true }, orderBy: { createdAt: "asc" } } }
            }
          }
        },
        shares: {
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            status: true,
            expiresAt: true,
            maxDownloads: true,
            downloadCount: true,
            lastAccessAt: true,
            createdAt: true,
            passwordHash: true
          }
        },
        accessLogs: {
          orderBy: { createdAt: "desc" },
          take: 10,
          select: {
            id: true,
            actorId: true,
            shareLinkId: true,
            nodeId: true,
            action: true,
            result: true,
            createdAt: true
          }
        }
      }
    });

    if (!file || file.status === FileStatus.DELETED || !(await canAccessFile(prisma, user, file, "manage"))) {
      return reply.code(404).send({ error: "file not found" });
    }
    if (file.status === FileStatus.TRASHED) {
      return reply.code(409).send({ error: "file is in trash" });
    }

    const latestVersion = file.versions[0] ?? null;
    return {
      file: serializeFile(file),
      latestVersion: latestVersion ? serializeVersionDetail(latestVersion) : null,
      storageLayout: latestVersion ? serializeStorageLayout(latestVersion) : serializeMissingStorageLayout(),
      // F1: per-node distribution so the UI can answer "where is this file
      // stored, on how many VPSes, how big on each?" without recomputing it
      // from the raw replica list.
      storageDistribution: latestVersion ? serializeStorageDistribution(latestVersion) : { nodes: [], nodeCount: 0, isSingleNode: true },
      replicas: latestVersion?.replicas.map(serializeReplicaDetail) ?? [],
      chunks: latestVersion?.chunks.map(serializeChunkDetail) ?? [],
      shares: file.shares.map((s) => serializeShareMetadata(s, { publicBaseUrl: env.publicBaseUrl, masterKey: env.masterKey })),
      recentAccess: file.accessLogs.map(serializeAccessSummary),
      risks: buildFileRisks(file)
    };
  });

  app.post("/files/upload", async (request, reply) => {
    const user = await requireUser(prisma, request, reply);
    if (!user) return;

    const fields = new Map<string, string>();
    let streamedFile: {
      filename: string;
      mimeType: string;
      encrypted: Awaited<ReturnType<typeof encryptStreamToChunks>>;
    } | null = null;
    let file: { id: string } | null = null;
    let stager: StreamingChunkUploadStager | null = null;

    try {
      for await (const part of request.parts()) {
        if (part.type !== "file") {
          fields.set(part.fieldname, String(part.value));
          continue;
        }

        if (streamedFile) {
          throw new Error("multipart field 'file' must appear only once");
        }

        stager = await createStreamingChunkUploadStager(
          prisma,
          await resolveInitialUploadPolicy(prisma, user, fields),
          CHUNK_SIZE_BYTES
        );
        let encrypted: Awaited<ReturnType<typeof encryptStreamToChunks>>;
        try {
          encrypted = await encryptStreamToChunks(
            part.file,
            env.masterKey,
            CHUNK_SIZE_BYTES,
            stager.stageChunk,
            { maxPlaintextSizeBytes: env.maxUploadBytes }
          );
        } catch (error) {
          throw normalizeStreamingUploadError(error);
        }

        streamedFile = {
          filename: part.filename || "unnamed",
          mimeType: part.mimetype || "application/octet-stream",
          encrypted
        };
      }

      if (!streamedFile || !stager) {
        throw new Error("multipart field 'file' is required");
      }

      const upload = parseUploadFields(fields);
      const folder = await resolveWritableUploadFolder(prisma, user, upload.folderId);
      const folderDefault = folder ? toSharedPolicy(folder.defaultPolicy) : "standard";
      const policy = resolveStoragePolicy(folderDefault, upload.policyOverride);
      assertTemporaryExpiry(policy, upload.expiresAt);
      await stager.ensureReplicaPolicy(policy);
      const stagedUpload = stager.finish();

      file = await prisma.file.create({
        data: {
          name: streamedFile.filename,
          mimeType: streamedFile.mimeType,
          sizeBytes: BigInt(streamedFile.encrypted.plaintextSizeBytes),
          ownerId: user.id,
          folderId: folder?.id ?? null,
          policyOverride: upload.policyOverride ? toDbPolicy(upload.policyOverride) : null,
          expiresAt: policy === "temporary" ? upload.expiresAt : null,
          status: FileStatus.PENDING
        }
      });

      const version = await prisma.fileVersion.create({
        data: {
          fileId: file.id,
          objectKey: `${file.id}/v1`,
          plaintextSha256: streamedFile.encrypted.metadata.plaintextSha256,
          ciphertextSha256: streamedFile.encrypted.metadata.ciphertextSha256,
          encryptionNonce: streamedFile.encrypted.metadata.encryptionNonce,
          encryptionAuthTag: streamedFile.encrypted.metadata.encryptionAuthTag,
          wrappedKey: streamedFile.encrypted.metadata.wrappedKey,
          sizeBytes: BigInt(streamedFile.encrypted.ciphertextSizeBytes),
          storageLayout: FileVersionStorageLayout.CHUNKED,
          chunkSizeBytes: BigInt(streamedFile.encrypted.chunkSizeBytes),
          chunkCount: streamedFile.encrypted.chunkCount
        }
      });

      await persistStagedChunkMetadata(prisma, version.id, stagedUpload);
      const activeFile = await prisma.file.update({
        where: { id: file.id },
        data: { status: FileStatus.ACTIVE },
        include: {
          folder: true,
          versions: {
            orderBy: { createdAt: "desc" },
            take: 1,
            include: { replicas: true, chunks: { include: { replicas: true } } }
          }
        }
      });
      return reply.code(201).send({ file: serializeFile(activeFile) });
    } catch (error) {
      const cleanupErrors: string[] = [];
      if (file) {
        await deleteReplicasForFile(prisma, file.id).catch((cleanupError) => {
          cleanupErrors.push(errorMessage(cleanupError));
        });
        await prisma.file.update({ where: { id: file.id }, data: { status: FileStatus.FAILED } }).catch((cleanupError) => {
          cleanupErrors.push(errorMessage(cleanupError));
        });
      }
      if (stager) {
        await stager.cleanup().catch((cleanupError) => {
          cleanupErrors.push(errorMessage(cleanupError));
        });
      }
      if (cleanupErrors.length > 0) {
        throw new Error(`cleanup incomplete: ${errorMessage(error)}; ${cleanupErrors.join("; ")}`);
      }
      throw error;
    }
  });

  // ===== Resumable chunked upload =====
  //
  //   POST /uploads/init                        -> { uploadId, chunkSize, expectedChunks }
  //   PUT  /uploads/:id/chunk/:index            (raw octet-stream body)
  //   POST /uploads/:id/complete                -> { file }
  //   POST /uploads/:id/abort                   -> { aborted: true }
  //
  // Browser slices the File at chunkSize boundaries and uploads each piece
  // sequentially. Each piece is encrypted server-side (AES-256-GCM with the
  // session's per-file key + fresh nonce per chunk) and immediately written
  // to the storage agents. On /complete we persist File + FileVersion +
  // FileChunk rows and mark the file ACTIVE.

  app.post("/uploads/init", async (request, reply) => {
    const user = await requireUser(prisma, request, reply);
    if (!user) return;

    const body = initChunkedUploadSchema.parse(request.body);
    const chunkSize = clampChunkSize(body.chunkSize ?? DEFAULT_CHUNK_SIZE);

    if (body.sizeBytes > CHUNKED_UPLOAD_MAX_BYTES) {
      return reply.code(413).send({
        error: `file too large: ${body.sizeBytes} bytes exceeds CHUNKED_UPLOAD_MAX_BYTES (${CHUNKED_UPLOAD_MAX_BYTES})`
      });
    }

    const folder = await resolveWritableUploadFolder(prisma, user, body.folderId ?? null);
    const folderDefault = folder ? toSharedPolicy(folder.defaultPolicy) : "standard";
    const initialPolicy = resolveStoragePolicy(folderDefault, body.policyOverride ?? null);
    assertTemporaryExpiry(initialPolicy, body.expiresAt ?? null);

    const expectedChunks = Math.max(1, Math.ceil(body.sizeBytes / chunkSize));

    let stager: ChunkUploadStager;
    try {
      stager = await createPlannedChunkStager(prisma, initialPolicy, body.sizeBytes, chunkSize);
    } catch (err) {
      throw normalizeStreamingUploadError(err);
    }

    const session = createUploadSession({
      userId: user.id,
      filename: body.filename,
      mimeType: body.mimeType ?? "application/octet-stream",
      sizeBytes: body.sizeBytes,
      chunkSize,
      expectedChunks,
      folderId: body.folderId ?? null,
      policyOverride: body.policyOverride ?? null,
      expiresAtIso: body.expiresAt ? body.expiresAt.toISOString() : null,
      stager,
      initialPolicy
    });

    return {
      uploadId: session.uploadId,
      chunkSize,
      expectedChunks,
      recommendedConcurrency: 4,
      expiresInSeconds: 3600
    };
  });

  app.put<{ Params: { id: string; index: string } }>("/uploads/:id/chunk/:index", async (request, reply) => {
    const user = await requireUser(prisma, request, reply);
    if (!user) return;

    const session = getUploadSession(request.params.id);
    if (!session) return reply.code(410).send({ error: "upload session not found or expired" });
    if (session.userId !== user.id) return reply.code(403).send({ error: "upload session belongs to another user" });

    const index = Number.parseInt(request.params.index, 10);
    if (!Number.isInteger(index) || index < 0 || index >= session.expectedChunks) {
      return reply.code(400).send({ error: `invalid chunk index ${request.params.index}` });
    }
    if (session.receivedIndices.has(index)) {
      return reply.code(409).send({ error: `chunk ${index} already received` });
    }

    const buffer = request.body instanceof Buffer
      ? request.body
      : Buffer.isBuffer(request.body)
        ? (request.body as Buffer)
        : null;
    if (!buffer) return reply.code(400).send({ error: "chunk body must be application/octet-stream" });

    const isLastChunk = index === session.expectedChunks - 1;
    const expectedSize = isLastChunk
      ? session.sizeBytes - index * session.chunkSize
      : session.chunkSize;
    if (buffer.byteLength !== expectedSize) {
      return reply.code(400).send({
        error: `chunk ${index} size mismatch: expected ${expectedSize} bytes, got ${buffer.byteLength}`
      });
    }

    const encrypted = encryptChunkWithKey(buffer, session.fileKey, index);
    try {
      await session.stager.stageChunk(encrypted);
    } catch (err) {
      // best-effort: if a chunk failed mid-stage, the session's state is
      // probably still recoverable for retry. Don't blow up the whole session.
      throw normalizeStreamingUploadError(err);
    }

    session.receivedIndices.add(index);
    session.totalPlaintextBytes += buffer.byteLength;

    return {
      received: true,
      index,
      receivedCount: session.receivedIndices.size,
      expectedChunks: session.expectedChunks,
      uploadedBytes: session.totalPlaintextBytes,
      totalBytes: session.sizeBytes
    };
  });

  app.post<{ Params: { id: string } }>("/uploads/:id/complete", async (request, reply) => {
    const user = await requireUser(prisma, request, reply);
    if (!user) return;

    const session = getUploadSession(request.params.id);
    if (!session) return reply.code(410).send({ error: "upload session not found or expired" });
    if (session.userId !== user.id) return reply.code(403).send({ error: "upload session belongs to another user" });
    if (session.receivedIndices.size !== session.expectedChunks) {
      const missing: number[] = [];
      for (let i = 0; i < session.expectedChunks; i += 1) {
        if (!session.receivedIndices.has(i)) missing.push(i);
      }
      return reply.code(409).send({
        error: `upload incomplete: received ${session.receivedIndices.size}/${session.expectedChunks} chunks (missing: ${missing.slice(0, 10).join(",")}${missing.length > 10 ? ",..." : ""})`
      });
    }
    if (session.totalPlaintextBytes !== session.sizeBytes) {
      return reply.code(409).send({
        error: `upload size mismatch: declared ${session.sizeBytes}, received ${session.totalPlaintextBytes}`
      });
    }

    // Re-resolve folder + policy (in case folder was deleted between init and complete)
    const folder = await resolveWritableUploadFolder(prisma, user, session.folderId);
    const folderDefault = folder ? toSharedPolicy(folder.defaultPolicy) : "standard";
    const policy = resolveStoragePolicy(folderDefault, session.policyOverride);
    const expiresAt = session.expiresAtIso ? new Date(session.expiresAtIso) : null;
    assertTemporaryExpiry(policy, expiresAt);

    let file: { id: string } | null = null;
    try {
      const stagedUpload = session.stager.finish();
      // Aggregate plaintext + ciphertext hashes need chunks in order.
      // Read them back from storage now (parallel uploads can't keep a running hash).
      const aggregate = await computeAggregateChunkHashes(stagedUpload, session.fileKey);

      const totalCiphertextBytes = stagedUpload.chunks.reduce(
        (sum, chunk) => sum + chunk.ciphertextSizeBytes,
        0
      );

      file = await prisma.file.create({
        data: {
          name: session.filename,
          mimeType: session.mimeType,
          sizeBytes: BigInt(session.totalPlaintextBytes),
          ownerId: user.id,
          folderId: folder?.id ?? null,
          policyOverride: session.policyOverride ? toDbPolicy(session.policyOverride) : null,
          expiresAt: policy === "temporary" ? expiresAt : null,
          status: FileStatus.PENDING
        }
      });

      const version = await prisma.fileVersion.create({
        data: {
          fileId: file.id,
          objectKey: `${file.id}/v1`,
          plaintextSha256: aggregate.plaintextSha256,
          ciphertextSha256: aggregate.ciphertextSha256,
          encryptionNonce: randomBytes(12).toString("base64url"),
          encryptionAuthTag: randomBytes(16).toString("base64url"),
          wrappedKey: wrapFileKeyForMaster(session.fileKey, env.masterKey),
          sizeBytes: BigInt(totalCiphertextBytes),
          storageLayout: FileVersionStorageLayout.CHUNKED,
          chunkSizeBytes: BigInt(stagedUpload.chunkSizeBytes),
          chunkCount: stagedUpload.chunkCount
        }
      });

      await persistStagedChunkMetadata(prisma, version.id, stagedUpload);

      const activeFile = await prisma.file.update({
        where: { id: file.id },
        data: { status: FileStatus.ACTIVE },
        include: {
          folder: true,
          versions: {
            orderBy: { createdAt: "desc" },
            take: 1,
            include: { replicas: true, chunks: { include: { replicas: true } } }
          }
        }
      });

      await removeUploadSession(session.uploadId, { cleanup: false });
      return reply.code(201).send({ file: serializeFile(activeFile) });
    } catch (error) {
      const cleanupErrors: string[] = [];
      if (file) {
        await deleteReplicasForFile(prisma, file.id).catch((cleanupError) => {
          cleanupErrors.push(errorMessage(cleanupError));
        });
        await prisma.file.update({ where: { id: file.id }, data: { status: FileStatus.FAILED } }).catch((cleanupError) => {
          cleanupErrors.push(errorMessage(cleanupError));
        });
      }
      await removeUploadSession(session.uploadId, { cleanup: true }).catch((cleanupError) => {
        cleanupErrors.push(errorMessage(cleanupError));
      });
      if (cleanupErrors.length > 0) {
        throw new Error(`cleanup incomplete: ${errorMessage(error)}; ${cleanupErrors.join("; ")}`);
      }
      throw error;
    }
  });

  app.post<{ Params: { id: string } }>("/uploads/:id/abort", async (request, reply) => {
    const user = await requireUser(prisma, request, reply);
    if (!user) return;

    const session = getUploadSession(request.params.id);
    if (!session) return { aborted: true }; // already gone
    if (session.userId !== user.id) return reply.code(403).send({ error: "upload session belongs to another user" });

    await removeUploadSession(session.uploadId, { cleanup: true });
    return { aborted: true };
  });

  app.patch<{ Params: { id: string } }>("/files/:id", async (request, reply) => {
    const user = await requireUser(prisma, request, reply);
    if (!user) return;

    const file = await prisma.file.findUnique({ where: { id: request.params.id }, include: { folder: true } });
    if (!file || file.status === FileStatus.DELETED || !(await canAccessFile(prisma, user, file, "manage"))) {
      return reply.code(404).send({ error: "file not found" });
    }
    if (file.status === FileStatus.TRASHED) {
      return reply.code(409).send({ error: "file is in trash" });
    }

    const body = updateFileSchema.parse(request.body);

    // Validate move: user must have write access to the destination folder.
    let nextFolderPolicy: "standard" | "important" | "temporary" | null = null;
    if (body.folderId !== undefined) {
      if (body.folderId === null) {
        // move to root
        nextFolderPolicy = null;
      } else {
        const destination = await prisma.folder.findUnique({ where: { id: body.folderId } });
        if (!destination || !(await canAccessFolder(prisma, user, destination, "write"))) {
          return reply.code(404).send({ error: "destination folder not found" });
        }
        nextFolderPolicy = toSharedPolicy(destination.defaultPolicy);
      }
    }

    const folderPolicy = body.folderId !== undefined
      ? (nextFolderPolicy ?? "standard")
      : (file.folder ? toSharedPolicy(file.folder.defaultPolicy) : "standard");
    const nextOverride = body.policyOverride === undefined ? file.policyOverride && toSharedPolicy(file.policyOverride) : body.policyOverride;
    const effectivePolicy = resolveStoragePolicy(folderPolicy, nextOverride);
    const nextExpiresAt = effectivePolicy === "temporary"
      ? (body.expiresAt === undefined ? file.expiresAt : body.expiresAt)
      : null;
    assertTemporaryExpiry(effectivePolicy, nextExpiresAt);

    const updated = await prisma.file.update({
      where: { id: file.id },
      data: {
        name: body.name ?? undefined,
        policyOverride: body.policyOverride === undefined ? undefined : body.policyOverride ? toDbPolicy(body.policyOverride) : null,
        expiresAt: effectivePolicy === "temporary" ? (body.expiresAt === undefined ? undefined : body.expiresAt) : null,
        folderId: body.folderId === undefined ? undefined : body.folderId
      },
      include: {
        folder: true,
        versions: { orderBy: { createdAt: "desc" }, take: 1, include: { replicas: true } }
      }
    });
    return { file: serializeFile(updated) };
  });

  app.delete<{ Params: { id: string } }>("/files/:id", async (request, reply) => {
    const user = await requireUser(prisma, request, reply);
    if (!user) return;

    const file = await prisma.file.findUnique({ where: { id: request.params.id }, include: { folder: true } });
    if (!file || !(await canAccessFile(prisma, user, file, "manage"))) {
      return reply.code(404).send({ error: "file not found" });
    }
    if (file.status === FileStatus.DELETED) {
      return reply.code(404).send({ error: "file not found" });
    }
    if (file.status === FileStatus.TRASHED) {
      return reply.code(409).send({ error: "file is in trash" });
    }

    await prisma.file.update({ where: { id: file.id }, data: { status: FileStatus.TRASHED } });
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>("/files/:id/restore", async (request, reply) => {
    const user = await requireUser(prisma, request, reply);
    if (!user) return;

    const file = await prisma.file.findUnique({ where: { id: request.params.id }, include: { folder: true } });
    if (!file || file.status === FileStatus.DELETED || !(await canAccessFile(prisma, user, file, "manage"))) {
      return reply.code(404).send({ error: "file not found" });
    }
    if (file.status !== FileStatus.TRASHED) {
      return { file: serializeFile(file) };
    }

    if (isExpiredTemporaryFile(file)) {
      return reply.code(400).send({ error: "temporary file expired" });
    }

    const restored = await prisma.file.update({
      where: { id: file.id },
      data: { status: FileStatus.ACTIVE },
      include: {
        folder: true,
        versions: { orderBy: { createdAt: "desc" }, take: 1, include: { replicas: true } }
      }
    });
    return { file: serializeFile(restored) };
  });

  app.post<{ Params: { id: string } }>("/files/:id/purge", async (request, reply) => {
    const user = await requireUser(prisma, request, reply);
    if (!user) return;

    const file = await prisma.file.findUnique({ where: { id: request.params.id }, include: { folder: true } });
    if (!file || file.status === FileStatus.DELETED || !(await canAccessFile(prisma, user, file, "manage"))) {
      return reply.code(404).send({ error: "file not found" });
    }

    await deleteReplicasForFile(prisma, file.id);
    await prisma.file.update({ where: { id: file.id }, data: { status: FileStatus.DELETED } });
    return reply.code(204).send();
  });

  app.get<{ Params: { id: string } }>("/files/:id/versions", async (request, reply) => {
    const user = await requireUser(prisma, request, reply);
    if (!user) return;

    const file = await prisma.file.findUnique({
      where: { id: request.params.id },
      include: {
        folder: true,
        versions: {
          orderBy: { createdAt: "desc" },
          include: {
            replicas: { include: { node: true } },
            chunks: {
              orderBy: { index: "asc" },
              include: { replicas: { include: { node: true } } }
            }
          }
        }
      }
    });
    if (!file || file.status === FileStatus.DELETED || !(await canAccessFile(prisma, user, file, "read"))) {
      return reply.code(404).send({ error: "file not found" });
    }
    if (file.status === FileStatus.TRASHED) {
      return reply.code(409).send({ error: "file is in trash" });
    }

    const effectivePolicy = effectivePolicyForFile(file);
    return { versions: file.versions.map((version) => serializeVersionHistoryItem(version, effectivePolicy)) };
  });

  app.get<{ Params: { id: string; versionId: string } }>("/files/:id/versions/:versionId/download", async (request, reply) => {
    const user = await requireUser(prisma, request, reply);
    if (!user) return;

    const file = await prisma.file.findUnique({
      where: { id: request.params.id },
      include: { folder: true }
    });
    if (!file || file.status === FileStatus.DELETED || !(await canAccessFile(prisma, user, file, "read"))) {
      return reply.code(404).send({ error: "file not found" });
    }
    if (file.status === FileStatus.TRASHED) {
      return reply.code(409).send({ error: "file is in trash" });
    }

    const version = await prisma.fileVersion.findFirst({
      where: { id: request.params.versionId, fileId: file.id }
    });
    if (!version) {
      return reply.code(404).send({ error: "file version not found" });
    }

    try {
      const response = await sendLatestVersionDownload(prisma, env, reply, {
        name: file.name,
        mimeType: file.mimeType,
        sizeBytes: version.sizeBytes
      }, version);
      await logAccess(prisma, request, { actorId: user.id, fileId: file.id, action: "download_version", result: "ok" });
      return response;
    } catch (error) {
      await logAccess(prisma, request, { actorId: user.id, fileId: file.id, action: "download_version", result: "failed" }).catch(() => undefined);
      throw error;
    }
  });

  app.get<{ Params: { id: string } }>("/files/:id/download", async (request, reply) => {
    const user = await requireUser(prisma, request, reply);
    if (!user) return;

    const file = await prisma.file.findUnique({
      where: { id: request.params.id },
      include: { folder: true, versions: { orderBy: { createdAt: "desc" }, take: 1 } }
    });
    if (!file || file.status === FileStatus.DELETED || !(await canAccessFile(prisma, user, file, "read"))) {
      return reply.code(404).send({ error: "file not found" });
    }
    if (file.status === FileStatus.TRASHED) {
      return reply.code(409).send({ error: "file is in trash" });
    }
    if (file.status !== FileStatus.ACTIVE) {
      return reply.code(404).send({ error: "file not found" });
    }

    try {
      const version = file.versions[0];
      const response = await sendLatestVersionDownload(prisma, env, reply, {
        name: file.name,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes
      }, version);
      await logAccess(prisma, request, { actorId: user.id, fileId: file.id, action: "download", result: "ok" });
      return response;
    } catch (error) {
      await logAccess(prisma, request, { actorId: user.id, fileId: file.id, action: "download", result: "failed" }).catch(() => undefined);
      throw error;
    }
  });

  app.get<{ Params: { id: string } }>("/files/:id/preview", async (request, reply) => {
    const user = await requireUser(prisma, request, reply);
    if (!user) return;

    const file = await prisma.file.findUnique({
      where: { id: request.params.id },
      include: { folder: true, versions: { orderBy: { createdAt: "desc" }, take: 1 } }
    });
    if (!file || file.status === FileStatus.DELETED || !(await canAccessFile(prisma, user, file, "read"))) {
      return reply.code(404).send({ error: "file not found" });
    }
    if (file.status === FileStatus.TRASHED) {
      return reply.code(409).send({ error: "file is in trash" });
    }
    if (file.status !== FileStatus.ACTIVE) {
      return reply.code(404).send({ error: "file not found" });
    }

    const version = file.versions[0];
    const plaintext = await decryptLatestVersion(prisma, env, version);
    if (isDocxFile(file.name, file.mimeType)) {
      return sendInlineHtml(reply, `${file.name}.html`, renderDocxPreviewHtml(file.name, plaintext));
    }
    return sendInlineFile(reply, file.name, previewMimeType(file.name, file.mimeType), plaintext);
  });

  app.post<{ Params: { id: string } }>("/files/:id/permissions", async (request, reply) => {
    const user = await requireUser(prisma, request, reply);
    if (!user) return;

    const file = await prisma.file.findUnique({ where: { id: request.params.id }, include: { folder: true } });
    if (!file || file.status === FileStatus.DELETED || !(await canAccessFile(prisma, user, file, "manage"))) {
      return reply.code(404).send({ error: "file not found" });
    }
    if (file.status === FileStatus.TRASHED) {
      return reply.code(409).send({ error: "file is in trash" });
    }

    const body = permissionBodySchema.parse(request.body);
    if (!(await prisma.user.findUnique({ where: { id: body.userId }, select: { id: true } }))) {
      return reply.code(400).send({ error: "permission target user not found" });
    }

    const permission = await prisma.permission.upsert({
      where: { userId_fileId: { userId: body.userId, fileId: file.id } },
      update: { level: toDbPermission(body.level) },
      create: { userId: body.userId, fileId: file.id, level: toDbPermission(body.level) }
    });
    return { permission };
  });

  app.post<{ Params: { id: string } }>("/files/:id/shares", async (request, reply) => {
    const user = await requireUser(prisma, request, reply);
    if (!user) return;

    const file = await prisma.file.findUnique({ where: { id: request.params.id }, include: { folder: true } });
    if (!file || file.status === FileStatus.DELETED || !(await canAccessFile(prisma, user, file, "manage"))) {
      return reply.code(404).send({ error: "file not found" });
    }
    if (file.status === FileStatus.TRASHED) {
      return reply.code(409).send({ error: "file is in trash" });
    }
    if (file.status !== FileStatus.ACTIVE) {
      return reply.code(404).send({ error: "file not found" });
    }

    const body = createShareSchema.parse(request.body);
    const token = randomToken(24);
    const share = await prisma.shareLink.create({
      data: {
        tokenHash: hashToken(token),
        tokenEncrypted: encryptStringWithMaster(token, env.masterKey),
        fileId: file.id,
        createdById: user.id,
        passwordHash: body.password ? await createPasswordHash(body.password) : null,
        expiresAt: body.expiresAt,
        maxDownloads: body.maxDownloads ?? null
      }
    });

    return reply.code(201).send({
      share: serializeShare(share, `${env.publicBaseUrl.replace(/\/+$/, "")}/share/${token}`)
    });
  });

  app.get<{ Params: { id: string } }>("/files/:id/shares", async (request, reply) => {
    const user = await requireUser(prisma, request, reply);
    if (!user) return;

    const file = await prisma.file.findUnique({ where: { id: request.params.id }, include: { folder: true } });
    if (!file || file.status === FileStatus.DELETED || !(await canAccessFile(prisma, user, file, "manage"))) {
      return reply.code(404).send({ error: "file not found" });
    }
    if (file.status === FileStatus.TRASHED) {
      return reply.code(409).send({ error: "file is in trash" });
    }

    const shares = await prisma.shareLink.findMany({
      where: { fileId: file.id },
      orderBy: { createdAt: "desc" }
    });

    return { shares: shares.map((s) => serializeShareMetadata(s, { publicBaseUrl: env.publicBaseUrl, masterKey: env.masterKey })) };
  });

  // ===== Folder share endpoints =====

  app.post<{ Params: { id: string } }>("/folders/:id/shares", async (request, reply) => {
    const user = await requireUser(prisma, request, reply);
    if (!user) return;

    const folder = await prisma.folder.findUnique({ where: { id: request.params.id } });
    if (!folder || !(await canAccessFolder(prisma, user, folder, "manage"))) {
      return reply.code(404).send({ error: "folder not found" });
    }

    const body = createShareSchema.parse(request.body);
    const token = randomToken(24);
    const share = await prisma.shareLink.create({
      data: {
        tokenHash: hashToken(token),
        tokenEncrypted: encryptStringWithMaster(token, env.masterKey),
        folderId: folder.id,
        createdById: user.id,
        passwordHash: body.password ? await createPasswordHash(body.password) : null,
        expiresAt: body.expiresAt,
        maxDownloads: body.maxDownloads ?? null
      }
    });

    return reply.code(201).send({
      share: serializeShare(share, `${env.publicBaseUrl.replace(/\/+$/, "")}/share/${token}`)
    });
  });

  app.get<{ Params: { id: string } }>("/folders/:id/shares", async (request, reply) => {
    const user = await requireUser(prisma, request, reply);
    if (!user) return;

    const folder = await prisma.folder.findUnique({ where: { id: request.params.id } });
    if (!folder || !(await canAccessFolder(prisma, user, folder, "manage"))) {
      return reply.code(404).send({ error: "folder not found" });
    }

    const shares = await prisma.shareLink.findMany({
      where: { folderId: folder.id },
      orderBy: { createdAt: "desc" }
    });
    return { shares: shares.map((s) => serializeShareMetadata(s, { publicBaseUrl: env.publicBaseUrl, masterKey: env.masterKey })) };
  });

  app.post<{ Params: { id: string } }>("/shares/:id/revoke", async (request, reply) => {
    const user = await requireUser(prisma, request, reply);
    if (!user) return;

    const share = await findShareForManagement(prisma, request.params.id);
    if (!share) {
      return reply.code(404).send({ error: "share not found" });
    }

    if (!(await canManageShare(prisma, user, share))) {
      return reply.code(403).send({ error: "no manage access to share" });
    }

    const revoked = await prisma.shareLink.update({
      where: { id: share.id },
      data: { status: ShareStatus.REVOKED }
    });
    return { share: serializeShareMetadata(revoked, { publicBaseUrl: env.publicBaseUrl, masterKey: env.masterKey }) };
  });

  app.delete<{ Params: { id: string } }>("/shares/:id", async (request, reply) => {
    const user = await requireUser(prisma, request, reply);
    if (!user) return;

    const share = await findShareForManagement(prisma, request.params.id);
    if (!share) {
      return reply.code(404).send({ error: "share not found" });
    }

    if (!(await canManageShare(prisma, user, share))) {
      return reply.code(403).send({ error: "no manage access to share" });
    }

    const revoked = await prisma.shareLink.update({
      where: { id: share.id },
      data: { status: ShareStatus.REVOKED }
    });
    return { share: serializeShareMetadata(revoked, { publicBaseUrl: env.publicBaseUrl, masterKey: env.masterKey }) };
  });

  app.patch<{ Params: { id: string } }>("/shares/:id", async (request, reply) => {
    const user = await requireUser(prisma, request, reply);
    if (!user) return;

    const share = await findShareForManagement(prisma, request.params.id);
    if (!share) {
      return reply.code(404).send({ error: "share not found" });
    }

    if (!(await canManageShare(prisma, user, share))) {
      return reply.code(403).send({ error: "no manage access to share" });
    }

    const body = updateShareSchema.parse(request.body);
    const updated = await prisma.shareLink.update({
      where: { id: share.id },
      data: {
        expiresAt: body.expiresAt === undefined ? undefined : body.expiresAt,
        maxDownloads: body.maxDownloads === undefined ? undefined : body.maxDownloads,
        passwordHash: body.password === undefined
          ? undefined
          : body.password === null
            ? null
            : await createPasswordHash(body.password)
      }
    });
    return { share: serializeShareMetadata(updated, { publicBaseUrl: env.publicBaseUrl, masterKey: env.masterKey }) };
  });

  app.get<{ Params: { token: string } }>("/shares/:token", async (request, reply) => {
    const share = await findShare(prisma, request.params.token);
    if (!share || !shareUsable(share)) {
      return reply.code(404).send({ error: "share not found or expired" });
    }
    const shareMeta = {
      expiresAt: share.expiresAt,
      maxDownloads: share.maxDownloads,
      downloadCount: share.downloadCount,
      needsPassword: Boolean(share.passwordHash)
    };
    if (share.folder) {
      return {
        kind: "folder" as const,
        folder: { id: share.folder.id, name: share.folder.name },
        share: shareMeta
      };
    }
    if (share.file && share.file.status === FileStatus.ACTIVE) {
      return {
        kind: "file" as const,
        file: {
          name: share.file.name,
          mimeType: share.file.mimeType,
          sizeBytes: share.file.sizeBytes.toString()
        },
        share: shareMeta
      };
    }
    return reply.code(404).send({ error: "share not found or expired" });
  });

  // GET form is the same as POST but only works for password-less shares.
  // Lets the browser stream the download natively (no fetch+blob), which is
  // essential for large files (1 GB+) so we don't buffer everything in
  // browser memory.
  app.get<{ Params: { token: string } }>("/shares/:token/download", async (request, reply) => {
    const share = await findShare(prisma, request.params.token);
    if (!share || !shareUsable(share) || !share.fileId || !share.file || share.file.status !== FileStatus.ACTIVE) {
      return reply.code(404).send({ error: "share not found or expired" });
    }
    if (share.passwordHash) {
      return reply.code(403).send({ error: "this share requires a password; use POST" });
    }

    const downloadCount = share.downloadCount + 1;
    const reserved = await prisma.shareLink.updateMany({
      where: {
        id: share.id,
        status: ShareStatus.ACTIVE,
        downloadCount: share.maxDownloads == null
          ? share.downloadCount
          : { equals: share.downloadCount, lt: share.maxDownloads },
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }]
      },
      data: {
        downloadCount: { increment: 1 },
        lastAccessAt: new Date(),
        status: share.maxDownloads != null && downloadCount >= share.maxDownloads ? ShareStatus.EXPIRED : ShareStatus.ACTIVE
      }
    });
    if (reserved.count !== 1) {
      return reply.code(404).send({ error: "share not found or expired" });
    }

    try {
      const version = share.file.versions[0];
      const response = await sendLatestVersionDownload(prisma, env, reply, {
        name: share.file.name,
        mimeType: share.file.mimeType,
        sizeBytes: share.file.sizeBytes
      }, version);
      await logAccess(prisma, request, { shareLinkId: share.id, fileId: share.fileId, action: "share_download", result: "ok" });
      return response;
    } catch (error) {
      await prisma.shareLink.update({
        where: { id: share.id },
        data: {
          downloadCount: { decrement: 1 },
          status: ShareStatus.ACTIVE
        }
      }).catch(() => undefined);
      await logAccess(prisma, request, { shareLinkId: share.id, fileId: share.fileId, action: "share_download", result: "failed" }).catch(() => undefined);
      throw error;
    }
  });

  app.post<{ Params: { token: string } }>("/shares/:token/download", async (request, reply) => {
    const share = await findShare(prisma, request.params.token);
    if (!share || !shareUsable(share) || !share.fileId || !share.file || share.file.status !== FileStatus.ACTIVE) {
      return reply.code(404).send({ error: "share not found or expired" });
    }

    const body = shareDownloadSchema.parse(request.body ?? {});
    if (share.passwordHash && !(await verifyPassword(share.passwordHash, body.password ?? ""))) {
      await logAccess(prisma, request, { shareLinkId: share.id, fileId: share.fileId, action: "share_download", result: "bad_password" });
      return reply.code(403).send({ error: "invalid password" });
    }

    const downloadCount = share.downloadCount + 1;
    const reserved = await prisma.shareLink.updateMany({
      where: {
        id: share.id,
        status: ShareStatus.ACTIVE,
        downloadCount: share.maxDownloads == null
          ? share.downloadCount
          : { equals: share.downloadCount, lt: share.maxDownloads },
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }]
      },
      data: {
        downloadCount: { increment: 1 },
        lastAccessAt: new Date(),
        status: share.maxDownloads != null && downloadCount >= share.maxDownloads ? ShareStatus.EXPIRED : ShareStatus.ACTIVE
      }
    });
    if (reserved.count !== 1) {
      return reply.code(404).send({ error: "share not found or expired" });
    }

    try {
      const version = share.file.versions[0];
      const response = await sendLatestVersionDownload(prisma, env, reply, {
        name: share.file.name,
        mimeType: share.file.mimeType,
        sizeBytes: share.file.sizeBytes
      }, version);
      await logAccess(prisma, request, { shareLinkId: share.id, fileId: share.fileId, action: "share_download", result: "ok" });
      return response;
    } catch (error) {
      await prisma.shareLink.update({
        where: { id: share.id },
        data: {
          downloadCount: { decrement: 1 },
          status: ShareStatus.ACTIVE
        }
      }).catch(() => undefined);
      await logAccess(prisma, request, { shareLinkId: share.id, fileId: share.fileId, action: "share_download", result: "failed" }).catch(() => undefined);
      throw error;
    }
  });

  // ===== Public folder-share access =====
  //
  // Recipient flow:
  //   1. GET  /shares/:token             → meta { kind, file|folder, needsPassword }
  //   2. POST /shares/:token/authorize   → verify password, set short-lived cookie
  //   3. GET  /shares/:token/listing?folderId=…   → list children (defaults to share root)
  //   4. GET  /shares/:token/file/:fileId         → stream single file (cookie checked if pw)
  //   5. GET  /shares/:token/zip?folderId=…       → stream entire folder as ZIP
  //
  // Cookie name: wp_share_<shareId>, HMAC-signed by COOKIE_SECRET, 1h TTL.

  app.post<{ Params: { token: string } }>("/shares/:token/authorize", async (request, reply) => {
    const share = await findShare(prisma, request.params.token);
    if (!share || !shareUsable(share)) {
      return reply.code(404).send({ error: "share not found or expired" });
    }

    // Throttle password attempts per (ip, share) so attackers can't brute force.
    const limit = checkShareAuthRateLimit(request, share.id);
    if (!limit.allowed) {
      reply.header("retry-after", String(limit.retryAfterSec));
      return reply.code(429).send({
        error: `too many attempts; retry in ${limit.retryAfterSec}s`
      });
    }

    const body = shareDownloadSchema.parse(request.body ?? {});
    if (share.passwordHash) {
      if (!body.password || !(await verifyPassword(share.passwordHash, body.password))) {
        await logAccess(prisma, request, {
          shareLinkId: share.id,
          fileId: share.fileId ?? undefined,
          action: "share_authorize",
          result: "bad_password"
        });
        return reply.code(403).send({ error: "invalid password" });
      }
    }
    // Success → forgive previous bad attempts.
    resetShareAuthRateLimit(request, share.id);
    setShareAuthCookie(reply, share.id, request.params.token, env.cookieSecure);
    return { authorized: true };
  });

  app.get<{ Params: { token: string }; Querystring: { folderId?: string } }>("/shares/:token/listing", async (request, reply) => {
    const share = await findShare(prisma, request.params.token);
    if (!share || !shareUsable(share) || !share.folder || !share.folderId) {
      return reply.code(404).send({ error: "share not found or expired" });
    }
    if (!hasShareAuth(request, share.id, Boolean(share.passwordHash))) {
      return reply.code(403).send({ error: "share password required" });
    }
    const targetFolderId = request.query.folderId ?? share.folderId;
    if (targetFolderId !== share.folderId && !(await isFolderInShareTree(prisma, targetFolderId, share.folderId))) {
      return reply.code(404).send({ error: "folder not in share tree" });
    }
    const [contents, breadcrumb] = await Promise.all([
      listShareFolderContents(prisma, targetFolderId),
      folderBreadcrumbsToRoot(prisma, targetFolderId, share.folderId)
    ]);
    return {
      share: {
        rootFolder: { id: share.folder.id, name: share.folder.name },
        needsPassword: Boolean(share.passwordHash),
        expiresAt: share.expiresAt,
        maxDownloads: share.maxDownloads,
        downloadCount: share.downloadCount
      },
      breadcrumb,
      folders: contents.folders,
      files: contents.files
    };
  });

  app.get<{ Params: { token: string; fileId: string } }>("/shares/:token/file/:fileId", async (request, reply) => {
    const share = await findShare(prisma, request.params.token);
    if (!share || !shareUsable(share) || !share.folder || !share.folderId) {
      return reply.code(404).send({ error: "share not found or expired" });
    }
    if (!hasShareAuth(request, share.id, Boolean(share.passwordHash))) {
      return reply.code(403).send({ error: "share password required" });
    }
    const inTree = await isFileInShareTree(prisma, request.params.fileId, share.folderId);
    if (!inTree.ok) {
      return reply.code(404).send({ error: "file not in share tree" });
    }

    // Reserve a slot in the download counter (atomic).
    const downloadCount = share.downloadCount + 1;
    const reserved = await prisma.shareLink.updateMany({
      where: {
        id: share.id,
        status: ShareStatus.ACTIVE,
        downloadCount: share.maxDownloads == null
          ? share.downloadCount
          : { equals: share.downloadCount, lt: share.maxDownloads },
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }]
      },
      data: {
        downloadCount: { increment: 1 },
        lastAccessAt: new Date(),
        status: share.maxDownloads != null && downloadCount >= share.maxDownloads ? ShareStatus.EXPIRED : ShareStatus.ACTIVE
      }
    });
    if (reserved.count !== 1) {
      return reply.code(404).send({ error: "share not found or expired" });
    }

    try {
      const file = await prisma.file.findUnique({
        where: { id: request.params.fileId },
        include: { versions: { orderBy: { createdAt: "desc" }, take: 1 } }
      });
      if (!file || file.status !== FileStatus.ACTIVE) {
        throw new Error("file not active");
      }
      const response = await sendLatestVersionDownload(prisma, env, reply, {
        name: file.name,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes
      }, file.versions[0]);
      await logAccess(prisma, request, {
        shareLinkId: share.id,
        fileId: file.id,
        action: "share_download",
        result: "ok"
      });
      return response;
    } catch (error) {
      await prisma.shareLink.update({
        where: { id: share.id },
        data: { downloadCount: { decrement: 1 }, status: ShareStatus.ACTIVE }
      }).catch(() => undefined);
      await logAccess(prisma, request, {
        shareLinkId: share.id,
        fileId: request.params.fileId,
        action: "share_download",
        result: "failed"
      }).catch(() => undefined);
      throw error;
    }
  });

  app.get<{ Params: { token: string }; Querystring: { folderId?: string } }>("/shares/:token/zip", async (request, reply) => {
    const share = await findShare(prisma, request.params.token);
    if (!share || !shareUsable(share) || !share.folder || !share.folderId) {
      return reply.code(404).send({ error: "share not found or expired" });
    }
    if (!hasShareAuth(request, share.id, Boolean(share.passwordHash))) {
      return reply.code(403).send({ error: "share password required" });
    }
    const targetFolderId = request.query.folderId ?? share.folderId;
    if (targetFolderId !== share.folderId && !(await isFolderInShareTree(prisma, targetFolderId, share.folderId))) {
      return reply.code(404).send({ error: "folder not in share tree" });
    }
    const targetFolder = await prisma.folder.findUnique({ where: { id: targetFolderId } });
    if (!targetFolder) {
      return reply.code(404).send({ error: "folder not found" });
    }

    // ZIP counts as one share download — same accounting as a single-file share.
    const downloadCount = share.downloadCount + 1;
    const reserved = await prisma.shareLink.updateMany({
      where: {
        id: share.id,
        status: ShareStatus.ACTIVE,
        downloadCount: share.maxDownloads == null
          ? share.downloadCount
          : { equals: share.downloadCount, lt: share.maxDownloads },
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }]
      },
      data: {
        downloadCount: { increment: 1 },
        lastAccessAt: new Date(),
        status: share.maxDownloads != null && downloadCount >= share.maxDownloads ? ShareStatus.EXPIRED : ShareStatus.ACTIVE
      }
    });
    if (reserved.count !== 1) {
      return reply.code(404).send({ error: "share not found or expired" });
    }

    const zipName = `${sanitizeFilename(targetFolder.name) || "folder"}.zip`;
    reply.header("content-type", "application/zip");
    reply.header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(zipName)}`);

    const archive = archiver("zip", { store: true });
    archive.on("warning", (err) => {
      request.log.warn({ err }, "folder zip warning");
    });
    archive.on("error", (err) => {
      request.log.error({ err }, "folder zip error");
    });

    // Hand the archive stream to fastify; do not return reply.send(archive) because
    // we want to also drive archive.finalize() ourselves after walking the tree.
    reply.send(archive);
    try {
      await streamFolderAsZip(prisma, archive, env.masterKey, targetFolderId, targetFolder.name);
      await archive.finalize();
      await logAccess(prisma, request, {
        shareLinkId: share.id,
        action: "share_download_zip",
        result: "ok"
      });
    } catch (error) {
      try { archive.abort(); } catch { /* ignore */ }
      await prisma.shareLink.update({
        where: { id: share.id },
        data: { downloadCount: { decrement: 1 }, status: ShareStatus.ACTIVE }
      }).catch(() => undefined);
      await logAccess(prisma, request, {
        shareLinkId: share.id,
        action: "share_download_zip",
        result: "failed"
      }).catch(() => undefined);
      request.log.error({ err: error }, "folder zip failed");
    }
    return reply;
  });

  app.get("/nodes", async (request, reply) => {
    const user = await requireAdmin(prisma, request, reply);
    if (!user) return;

    const nodes = await prisma.storageNode.findMany({ orderBy: [{ priority: "asc" }, { createdAt: "asc" }] });
    const refreshed = [];
    for (const node of nodes) {
      if (node.status === StorageNodeStatus.DISABLED) {
        refreshed.push(serializeNode(node, {
          lastError: null,
          healthMessage: "storage node is disabled and was not checked"
        }));
        continue;
      }

      try {
        refreshed.push(serializeNode(await refreshNodeStatus(prisma, node), {
          lastError: null,
          healthMessage: "storage-agent is reachable"
        }));
      } catch (error) {
        const lastError = nodeHealthErrorMessage(error);
        const offline = await prisma.storageNode.update({
          where: { id: node.id },
          data: { status: StorageNodeStatus.OFFLINE }
        });
        refreshed.push(serializeNode(offline, {
          lastError,
          healthMessage: lastError
        }));
      }
    }

    return { nodes: refreshed };
  });

  app.post("/nodes", async (request, reply) => {
    const user = await requireAdmin(prisma, request, reply);
    if (!user) return;

    const body = createNodeSchema.parse(request.body);
    const node = await prisma.storageNode.create({
      data: {
        name: body.name,
        baseUrl: body.baseUrl.replace(/\/+$/, ""),
        agentToken: body.agentToken,
        priority: body.priority ?? 100,
        status: StorageNodeStatus.ACTIVE
      }
    });
    return reply.code(201).send({ node: serializeNode(node) });
  });

  // PATCH /nodes/:id — edit name / baseUrl / agentToken / priority on an
  // existing node. Use case: agent's AGENT_TOKEN got regenerated (e.g. .env
  // was overwritten) and the main VPS needs to learn the new value without
  // delete-and-readd (which would orphan the existing replica rows).
  app.patch<{ Params: { id: string } }>("/nodes/:id", async (request, reply) => {
    const user = await requireAdmin(prisma, request, reply);
    if (!user) return;

    const node = await prisma.storageNode.findUnique({ where: { id: request.params.id } });
    if (!node) return reply.code(404).send({ error: "node not found" });

    const body = updateNodeSchema.parse(request.body);
    const updated = await prisma.storageNode.update({
      where: { id: node.id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.baseUrl !== undefined ? { baseUrl: body.baseUrl.replace(/\/+$/, "") } : {}),
        ...(body.agentToken !== undefined ? { agentToken: body.agentToken } : {}),
        ...(body.priority !== undefined ? { priority: body.priority } : {}),
        // Touching connectivity-affecting fields (baseUrl/agentToken) wipes the
        // probe-failure counter so a previously-LOST or OFFLINE node gets a
        // fresh chance — the next probe round will reflect the new config.
        ...(body.baseUrl !== undefined || body.agentToken !== undefined
          ? { consecutiveProbeFailures: 0 }
          : {})
      }
    });
    return { node: serializeNode(updated) };
  });

  // Node monitoring: returns 60 aggregated buckets covering the requested
  // window + summary stats (current ping, 24h avg, uptime %, etc.).
  app.get<{ Params: { id: string }; Querystring: { range?: string } }>("/nodes/:id/probes", async (request, reply) => {
    const user = await requireAdmin(prisma, request, reply);
    if (!user) return;

    const node = await prisma.storageNode.findUnique({ where: { id: request.params.id } });
    if (!node) return reply.code(404).send({ error: "node not found" });

    const range = (request.query.range ?? "1h").toLowerCase();
    const rangeMs = parseRangeMs(range);
    if (rangeMs == null) {
      return reply.code(400).send({ error: "invalid range; use 1h|6h|24h|7d|30d" });
    }

    const now = Date.now();
    const from = new Date(now - rangeMs);
    const probes = await prisma.nodeProbe.findMany({
      where: { nodeId: node.id, observedAt: { gte: from } },
      orderBy: { observedAt: "asc" },
      select: { observedAt: true, ok: true, latencyMs: true }
    });

    // Always 60 buckets so the UI's bar chart is consistent across ranges.
    const BUCKET_COUNT = 60;
    const bucketMs = rangeMs / BUCKET_COUNT;
    const buckets: Array<{ at: string; latencyMs: number | null; uptimePct: number; sampleCount: number }> = [];
    for (let i = 0; i < BUCKET_COUNT; i += 1) {
      const bucketStart = now - rangeMs + i * bucketMs;
      const bucketEnd = bucketStart + bucketMs;
      const slice = probes.filter((p) => p.observedAt.getTime() >= bucketStart && p.observedAt.getTime() < bucketEnd);
      const okCount = slice.filter((p) => p.ok).length;
      const avgLatency = okCount > 0
        ? Math.round(slice.filter((p) => p.ok).reduce((sum, p) => sum + p.latencyMs, 0) / okCount)
        : null;
      buckets.push({
        at: new Date(bucketStart + bucketMs / 2).toISOString(),
        latencyMs: avgLatency,
        uptimePct: slice.length > 0 ? Math.round((okCount / slice.length) * 100) : -1,
        sampleCount: slice.length
      });
    }

    // Summary stats. Compute fresh queries scoped to wider windows.
    const [last24h, last30d, all] = await Promise.all([
      prisma.nodeProbe.findMany({
        where: { nodeId: node.id, observedAt: { gte: new Date(now - 24 * 60 * 60 * 1000) } },
        select: { ok: true, latencyMs: true }
      }),
      prisma.nodeProbe.findMany({
        where: { nodeId: node.id, observedAt: { gte: new Date(now - 30 * 24 * 60 * 60 * 1000) } },
        select: { ok: true }
      }),
      prisma.nodeProbe.findMany({
        where: { nodeId: node.id },
        select: { ok: true }
      })
    ]);
    const currentProbe = probes[probes.length - 1] ?? null;
    const ok24 = last24h.filter((p) => p.ok);
    const summary = {
      currentLatencyMs: currentProbe?.ok ? currentProbe.latencyMs : null,
      currentOk: currentProbe?.ok ?? null,
      avgLatency24hMs: ok24.length > 0
        ? Math.round(ok24.reduce((sum, p) => sum + p.latencyMs, 0) / ok24.length)
        : null,
      uptime24hPct: last24h.length > 0 ? +(ok24.length / last24h.length * 100).toFixed(2) : null,
      uptime30dPct: last30d.length > 0
        ? +(last30d.filter((p) => p.ok).length / last30d.length * 100).toFixed(2)
        : null,
      uptimeAllPct: all.length > 0
        ? +(all.filter((p) => p.ok).length / all.length * 100).toFixed(2)
        : null,
      totalProbeCount: all.length
    };

    return {
      node: { id: node.id, name: node.name },
      range,
      probeIntervalSec: 30,
      buckets,
      summary
    };
  });

  // ===== Node decommissioning (graceful migration off) =====
  //
  //   POST /nodes/:id/decommission         → start drain
  //   GET  /nodes/:id/migration            → progress { total, migrated, remaining, ... }
  //   POST /nodes/:id/cancel-decommission  → restore ACTIVE
  //
  // While DECOMMISSIONING: no new writes hit this node; the background
  // migrator (in cleanup.ts) copies chunk replicas elsewhere and removes
  // them from this node. When clean, status auto-flips to DISABLED.

  app.post<{ Params: { id: string } }>("/nodes/:id/decommission", async (request, reply) => {
    const user = await requireAdmin(prisma, request, reply);
    if (!user) return;

    const node = await prisma.storageNode.findUnique({ where: { id: request.params.id } });
    if (!node) return reply.code(404).send({ error: "node not found" });
    if (node.status === StorageNodeStatus.DECOMMISSIONING) {
      return { node: serializeNode(node), already: true };
    }
    if (node.status === StorageNodeStatus.DISABLED) {
      return reply.code(409).send({ error: "node already disabled" });
    }

    // Safety check 1: there must be at least one OTHER non-disabled, non-decommissioning
    // node to migrate to.
    const remainingActive = await prisma.storageNode.count({
      where: {
        id: { not: node.id },
        status: { in: [StorageNodeStatus.ACTIVE, StorageNodeStatus.DEGRADED] }
      }
    });
    if (remainingActive === 0) {
      return reply.code(409).send({
        error: "cannot decommission the only active node — add another node first"
      });
    }

    // Safety check 2: combined free space of remaining active nodes ≥ this node's used bytes
    const others = await prisma.storageNode.findMany({
      where: {
        id: { not: node.id },
        status: { in: [StorageNodeStatus.ACTIVE, StorageNodeStatus.DEGRADED] }
      },
      select: { freeBytes: true }
    });
    const remainingFree = others.reduce((sum, n) => sum + (n.freeBytes ?? 0n), 0n);
    const thisUsed = (node.totalBytes ?? 0n) - (node.freeBytes ?? 0n);
    if (remainingFree < thisUsed) {
      return reply.code(409).send({
        error: `not enough free space on other nodes to absorb this one (need ${thisUsed}B, have ${remainingFree}B)`
      });
    }

    const updated = await prisma.storageNode.update({
      where: { id: node.id },
      data: { status: StorageNodeStatus.DECOMMISSIONING }
    });
    // Don't wait 60s for the next maintenance tick — start draining now so
    // small datasets are migrated within seconds of the admin clicking the
    // button. Runs in the background; the GET /migration poller surfaces progress.
    kickDrain(prisma);
    return { node: serializeNode(updated), already: false };
  });

  app.get<{ Params: { id: string } }>("/nodes/:id/migration", async (request, reply) => {
    const user = await requireAdmin(prisma, request, reply);
    if (!user) return;

    const node = await prisma.storageNode.findUnique({ where: { id: request.params.id } });
    if (!node) return reply.code(404).send({ error: "node not found" });

    const [chunkReplicasOnNode, objectReplicasOnNode] = await Promise.all([
      prisma.chunkReplica.count({
        where: { nodeId: node.id, status: { not: ReplicaStatus.DELETED } }
      }),
      prisma.objectReplica.count({
        where: { nodeId: node.id, status: { not: ReplicaStatus.DELETED } }
      })
    ]);
    const remaining = chunkReplicasOnNode + objectReplicasOnNode;

    return {
      node: { id: node.id, name: node.name, status: node.status.toLowerCase() },
      remaining,
      isDecommissioning: node.status === StorageNodeStatus.DECOMMISSIONING,
      isDrained: node.status === StorageNodeStatus.DECOMMISSIONING && remaining === 0
    };
  });

  app.post<{ Params: { id: string } }>("/nodes/:id/cancel-decommission", async (request, reply) => {
    const user = await requireAdmin(prisma, request, reply);
    if (!user) return;

    const node = await prisma.storageNode.findUnique({ where: { id: request.params.id } });
    if (!node) return reply.code(404).send({ error: "node not found" });
    if (node.status !== StorageNodeStatus.DECOMMISSIONING) {
      return reply.code(409).send({ error: "node is not in DECOMMISSIONING state" });
    }

    const restored = await prisma.storageNode.update({
      where: { id: node.id },
      data: { status: StorageNodeStatus.ACTIVE }
    });
    return { node: serializeNode(restored) };
  });

  // ===== Node-lost detection (Plan B) =====
  //
  //   GET  /nodes/:id/impact       → which files lost replicas + how many are unrecoverable
  //   POST /nodes/:id/declare-lost → admin manually flips node to LOST without waiting for probes
  //   POST /nodes/:id/restore      → admin says "the VPS is back, treat MISSING replicas as ok"
  //
  // Automatic LOST is triggered by node-prober.ts after N consecutive failures.

  app.get<{ Params: { id: string } }>("/nodes/:id/impact", async (request, reply) => {
    const user = await requireAdmin(prisma, request, reply);
    if (!user) return;
    const node = await prisma.storageNode.findUnique({ where: { id: request.params.id } });
    if (!node) return reply.code(404).send({ error: "node not found" });
    return { impact: await computeNodeImpact(prisma, node.id) };
  });

  app.post<{ Params: { id: string } }>("/nodes/:id/declare-lost", async (request, reply) => {
    const user = await requireAdmin(prisma, request, reply);
    if (!user) return;
    const node = await prisma.storageNode.findUnique({ where: { id: request.params.id } });
    if (!node) return reply.code(404).send({ error: "node not found" });
    if (node.status === StorageNodeStatus.DISABLED) {
      return reply.code(409).send({ error: "node is disabled" });
    }
    const result = await declareNodeLost(prisma, node.id, `manual: admin ${user.id}`);
    const updated = await prisma.storageNode.findUnique({ where: { id: node.id } });
    return {
      node: serializeNode(updated!),
      ...result,
      impact: await computeNodeImpact(prisma, node.id)
    };
  });

  // POST /nodes/:id/reverify — for each MISSING replica on this node, ask the
  // agent if it still has the object (with matching ciphertext SHA). If yes,
  // flip the replica back to AVAILABLE. Use case: a node was incorrectly
  // declared LOST (network blip, token mismatch, agent restart), got its
  // replicas auto-marked MISSING by the self-heal, but the data on disk is
  // actually fine and just needs re-acceptance.
  app.post<{ Params: { id: string } }>("/nodes/:id/reverify", async (request, reply) => {
    const user = await requireAdmin(prisma, request, reply);
    if (!user) return;

    const node = await prisma.storageNode.findUnique({ where: { id: request.params.id } });
    if (!node) return reply.code(404).send({ error: "node not found" });
    if (node.status === StorageNodeStatus.DISABLED) {
      return reply.code(409).send({ error: "node is disabled" });
    }

    const driver = new AgentStorageDriver({ baseUrl: node.baseUrl, token: node.agentToken });

    const chunkMissing = await prisma.chunkReplica.findMany({
      where: { nodeId: node.id, status: ReplicaStatus.MISSING },
      select: { id: true, objectId: true, ciphertextSha256: true }
    });
    const objectMissing = await prisma.objectReplica.findMany({
      where: { nodeId: node.id, status: ReplicaStatus.MISSING },
      select: { id: true, objectId: true, ciphertextSha256: true }
    });

    let chunkRecovered = 0;
    let chunkStillMissing = 0;
    let objectRecovered = 0;
    let objectStillMissing = 0;

    // Verify with bounded concurrency so we don't slam the agent with 500
    // parallel requests on big nodes. Pool of 6 is a sane default.
    async function pool<T>(items: T[], width: number, fn: (item: T) => Promise<void>): Promise<void> {
      let i = 0;
      const workers = Array.from({ length: Math.min(width, items.length) }, async () => {
        while (i < items.length) {
          const idx = i++;
          await fn(items[idx]).catch(() => undefined);
        }
      });
      await Promise.all(workers);
    }

    await pool(chunkMissing, 6, async (r) => {
      try {
        const v = await driver.verifyObject(r.objectId, r.ciphertextSha256);
        if (v.exists && v.matches) {
          await prisma.chunkReplica.update({
            where: { id: r.id },
            data: { status: ReplicaStatus.AVAILABLE, verifiedAt: new Date() }
          });
          chunkRecovered += 1;
        } else {
          chunkStillMissing += 1;
        }
      } catch {
        chunkStillMissing += 1;
      }
    });

    await pool(objectMissing, 6, async (r) => {
      try {
        const v = await driver.verifyObject(r.objectId, r.ciphertextSha256);
        if (v.exists && v.matches) {
          await prisma.objectReplica.update({
            where: { id: r.id },
            data: { status: ReplicaStatus.AVAILABLE, verifiedAt: new Date() }
          });
          objectRecovered += 1;
        } else {
          objectStillMissing += 1;
        }
      } catch {
        objectStillMissing += 1;
      }
    });

    return {
      node: { id: node.id, name: node.name },
      checked: chunkMissing.length + objectMissing.length,
      chunkRecovered,
      chunkStillMissing,
      objectRecovered,
      objectStillMissing
    };
  });

  app.post<{ Params: { id: string } }>("/nodes/:id/restore", async (request, reply) => {
    const user = await requireAdmin(prisma, request, reply);
    if (!user) return;
    const node = await prisma.storageNode.findUnique({ where: { id: request.params.id } });
    if (!node) return reply.code(404).send({ error: "node not found" });
    if (node.status !== StorageNodeStatus.LOST) {
      return reply.code(409).send({ error: "node is not in LOST state" });
    }

    // Restore semantics:
    //  - Flip node status back to OFFLINE (next successful probe promotes to ACTIVE).
    //  - Reset the consecutive-failure counter.
    //  - For replicas the API marked MISSING when we declared LOST: we don't
    //    automatically flip them back to AVAILABLE — the periodic verifier
    //    re-checks them on next read or on next maintenance pass. Admin can
    //    manually verify via the file-detail health check.
    //  - However we DO clear lostDeclaredAt so the UI banner goes away.
    const restored = await prisma.storageNode.update({
      where: { id: node.id },
      data: {
        status: StorageNodeStatus.OFFLINE,
        consecutiveProbeFailures: 0,
        lostDeclaredAt: null
      }
    });
    return { node: serializeNode(restored) };
  });

  app.get("/access-logs", async (request, reply) => {
    const user = await requireAdmin(prisma, request, reply);
    if (!user) return;

    const page = parsePositiveQueryInt(request, "page", 1, 1, 10_000);
    const pageSize = parsePositiveQueryInt(request, "pageSize", 100, 1, 200);
    const from = parseOptionalQueryDate(request, "from");
    const to = parseOptionalQueryDate(request, "to");
    const where: Prisma.AccessLogWhereInput = {};
    if (from || to) {
      where.createdAt = {
        ...(from ? { gte: from } : {}),
        ...(to ? { lte: to } : {})
      };
    }
    applyAccessLogStringFilter(where, "action", optionalQueryString(request, "action"));
    applyAccessLogStringFilter(where, "result", optionalQueryString(request, "result"));
    applyAccessLogStringFilter(where, "fileId", optionalQueryString(request, "fileId"));
    applyAccessLogStringFilter(where, "shareLinkId", optionalQueryString(request, "shareLinkId"));
    applyAccessLogStringFilter(where, "actorId", optionalQueryString(request, "actorId"));

    const [total, logs] = await Promise.all([
      prisma.accessLog.count({ where }),
      prisma.accessLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { actor: true, file: true, shareLink: true, node: true }
      })
    ]);
    const items = logs.map((log) => ({
      id: log.id,
      actorId: log.actorId,
      actor: log.actor?.email ?? null,
      fileId: log.fileId,
      file: log.file?.name ?? null,
      shareLinkId: log.shareLinkId,
      nodeId: log.nodeId,
      action: log.action,
      result: log.result,
      ip: log.ip,
      userAgent: log.userAgent,
      createdAt: log.createdAt
    }));

    return {
      items,
      logs: items,
      page,
      pageSize,
      total
    };
  });

  return app;
}

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1)
});

const createUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  password: z.string().min(10),
  role: z.enum(["admin", "member"]).default("member")
});

const resetPasswordSchema = z.object({
  password: z.string().min(10)
});

const createFolderSchema = z.object({
  name: z.string().min(1),
  parentId: z.string().optional().nullable(),
  defaultPolicy: policySchema.default("standard")
});

const updateFolderSchema = z.object({
  name: z.string().min(1).optional(),
  defaultPolicy: policySchema.optional(),
  parentId: z.string().min(1).nullable().optional()
});

const updateFileSchema = z.object({
  name: z.string().min(1).optional(),
  policyOverride: policySchema.nullable().optional(),
  expiresAt: z.coerce.date().nullable().optional(),
  folderId: z.string().min(1).nullable().optional()
});

const permissionBodySchema = z.object({
  userId: z.string().min(1),
  level: permissionSchema.transform((value) => normalizePermission(value, "read"))
});

const createShareSchema = z.object({
  password: z.string().min(4).optional().nullable(),
  expiresAt: z.coerce.date().optional().nullable(),
  maxDownloads: z.number().int().positive().optional().nullable()
});

const updateShareSchema = z.object({
  password: z.string().min(4).optional().nullable(),
  expiresAt: z.coerce.date().optional().nullable(),
  maxDownloads: z.number().int().positive().optional().nullable()
}).strict();

const initChunkedUploadSchema = z.object({
  filename: z.string().min(1).max(512),
  mimeType: z.string().max(256).optional(),
  sizeBytes: z.number().int().nonnegative(),
  folderId: z.string().min(1).nullable().optional(),
  policyOverride: policySchema.nullable().optional(),
  expiresAt: z.coerce.date().nullable().optional(),
  chunkSize: z.number().int().positive().optional()
});

const shareDownloadSchema = z.object({
  password: z.string().optional()
});

const createNodeSchema = z.object({
  name: z.string().min(1),
  baseUrl: z.string().url(),
  agentToken: z.string().min(24),
  priority: z.number().int().min(1).max(1000).optional()
});

// PATCH /nodes/:id — every field is optional; omit a field to leave it alone.
// agentToken is unset by sending an empty string would be silly, so we keep
// the min(24) constraint only when present.
const updateNodeSchema = z.object({
  name: z.string().min(1).optional(),
  baseUrl: z.string().url().optional(),
  agentToken: z.string().min(24).optional(),
  priority: z.number().int().min(1).max(1000).optional()
}).refine((body) => Object.keys(body).length > 0, { message: "at least one field is required" });

function clampChunkSize(requested: number): number {
  if (!Number.isFinite(requested) || requested <= 0) return DEFAULT_CHUNK_SIZE;
  if (requested < 64 * 1024) return 64 * 1024;          // 64 KiB minimum
  if (requested > MAX_CHUNK_SIZE) return MAX_CHUNK_SIZE;
  return Math.floor(requested);
}

function parseUploadFields(fields: Map<string, string>) {
  const policyOverrideRaw = fields.get("policyOverride");
  const expiresAtRaw = fields.get("expiresAt");
  return {
    folderId: emptyToNull(fields.get("folderId")),
    policyOverride: policyOverrideRaw ? normalizePolicy(policyOverrideRaw, "standard") : null,
    expiresAt: parseOptionalDate(expiresAtRaw, "expiresAt")
  };
}

async function resolveInitialUploadPolicy(
  prisma: PrismaClient,
  user: SessionUser,
  fields: Map<string, string>
): Promise<StoragePolicy> {
  const policyOverrideRaw = fields.get("policyOverride");
  const policyOverride = policyOverrideRaw ? normalizePolicy(policyOverrideRaw, "standard") : null;
  const folder = await resolveWritableUploadFolder(prisma, user, emptyToNull(fields.get("folderId")));
  const folderDefault = folder ? toSharedPolicy(folder.defaultPolicy) : "standard";
  return resolveStoragePolicy(folderDefault, policyOverride);
}

async function resolveWritableUploadFolder(
  prisma: PrismaClient,
  user: SessionUser,
  folderId: string | null
) {
  if (!folderId) {
    return null;
  }

  const folder = await prisma.folder.findUnique({ where: { id: folderId } });
  if (!folder || !(await canAccessFolder(prisma, user, folder, "write"))) {
    throw httpError(403, "no write access to folder");
  }
  return folder;
}

function normalizeStreamingUploadError(error: unknown): Error {
  const message = errorMessage(error);
  if (
    message.includes("MAX_UPLOAD_BYTES") ||
    message.includes("not enough active storage nodes") ||
    message.includes("not enough storage capacity") ||
    message.includes("not enough capacity for important replicas") ||
    message.includes("chunk upload failure") ||
    message.includes("cleanup incomplete")
  ) {
    return error instanceof Error ? error : new Error(message);
  }

  if (
    message.toLowerCase().includes("abort") ||
    message.toLowerCase().includes("premature") ||
    message.toLowerCase().includes("closed") ||
    message.toLowerCase().includes("stream")
  ) {
    return new Error(`interrupted upload: ${message}`);
  }

  return new Error(`streaming upload failed: ${message}`);
}

async function decryptLatestVersion(
  prisma: PrismaClient,
  env: ApiEnv,
  version: {
    id: string;
    plaintextSha256: string;
    ciphertextSha256: string;
    encryptionNonce: string;
    encryptionAuthTag: string;
    wrappedKey: string;
  } | undefined
): Promise<Buffer> {
  if (!version) {
    throw new Error("file has no version");
  }

  const chunkedStream = await createChunkedPlaintextStream(prisma, env, version);
  if (chunkedStream) {
    return streamToBuffer(chunkedStream);
  }

  const ciphertext = await readEncryptedObject(prisma, version.id);
  if (!safeEqualHash(sha256(ciphertext), version.ciphertextSha256)) {
    throw new Error("ciphertext hash mismatch after download");
  }
  const plaintext = decryptBuffer(ciphertext, version, env.masterKey);
  if (!safeEqualHash(sha256(plaintext), version.plaintextSha256)) {
    throw new Error("plaintext hash mismatch after decrypt");
  }
  return plaintext;
}

async function sendLatestVersionDownload(
  prisma: PrismaClient,
  env: ApiEnv,
  reply: FastifyReply,
  file: { name: string; mimeType: string; sizeBytes: bigint },
  version: VersionForDecrypt | undefined
) {
  if (!version) {
    throw new Error("file has no version");
  }

  const chunkedStream = await createChunkedPlaintextStream(prisma, env, version);
  if (chunkedStream) {
    return sendFileStream(reply, file.name, file.mimeType, chunkedStream, file.sizeBytes);
  }

  const plaintext = await decryptLatestVersion(prisma, env, version);
  return sendFile(reply, file.name, file.mimeType, plaintext);
}

type VersionForDecrypt = {
  id: string;
  plaintextSha256: string;
  ciphertextSha256: string;
  encryptionNonce: string;
  encryptionAuthTag: string;
  wrappedKey: string;
};

async function createChunkedPlaintextStream(
  prisma: PrismaClient,
  env: ApiEnv,
  version: VersionForDecrypt
): Promise<NodeJS.ReadableStream | null> {
  if (!(await chunkedVersionHasPerChunkEncryption(prisma, version.id))) {
    return null;
  }

  const fileKey = unwrapWrappedFileKey(version.wrappedKey, env.masterKey);
  const plaintextHash = createHash("sha256");
  async function* plaintextChunks() {
    for await (const chunk of readAuthenticatedEncryptedChunks(prisma, version.id)) {
      // Ciphertext integrity is enforced per-chunk by AES-GCM's auth tag
      // (decryptChunkBuffer throws on mismatch). We don't run a separate
      // ciphertext SHA-256 anymore — that doubled CPU cost per chunk for
      // redundant safety.
      const plaintext = decryptChunkBuffer(chunk.ciphertext, chunk, fileKey);
      if (plaintext.byteLength !== chunk.plaintextSizeBytes) {
        throw new Error(`chunk read failure: chunk ${chunk.index} plaintext size mismatch after decrypt`);
      }
      plaintextHash.update(plaintext);
      yield plaintext;
    }

    const actualPlaintextHash = plaintextHash.digest("hex");
    if (!safeEqualHash(actualPlaintextHash, version.plaintextSha256)) {
      throw new Error("plaintext hash mismatch after streamed decrypt");
    }
  }

  return Readable.from(plaintextChunks());
}

async function findShare(prisma: PrismaClient, token: string) {
  return prisma.shareLink.findUnique({
    where: { tokenHash: hashToken(token) },
    include: {
      file: {
        include: {
          versions: { orderBy: { createdAt: "desc" }, take: 1 }
        }
      },
      folder: true
    }
  });
}

async function findShareForManagement(prisma: PrismaClient, id: string) {
  return prisma.shareLink.findUnique({
    where: { id },
    include: {
      file: { include: { folder: true } },
      folder: true
    }
  });
}

async function canManageShare(
  prisma: PrismaClient,
  user: SessionUser,
  share: NonNullable<Awaited<ReturnType<typeof findShareForManagement>>>
): Promise<boolean> {
  if (user.role === "admin" || share.createdById === user.id) {
    return true;
  }
  if (share.file) return canAccessFile(prisma, user, share.file, "manage");
  if (share.folder) return canAccessFolder(prisma, user, share.folder, "manage");
  return false;
}

function shareUsable(share: { status: ShareStatus; expiresAt: Date | null; maxDownloads: number | null; downloadCount: number }) {
  return isShareUsable({
    status: share.status.toLowerCase() as "active" | "expired" | "revoked",
    expiresAt: share.expiresAt,
    maxDownloads: share.maxDownloads,
    downloadCount: share.downloadCount
  });
}

function shareAuthCookieName(shareId: string): string {
  return `wp_share_${shareId}`;
}

function setShareAuthCookie(reply: FastifyReply, shareId: string, token: string, secure: boolean): void {
  reply.setCookie(shareAuthCookieName(shareId), "ok", {
    signed: true,
    httpOnly: true,
    sameSite: "lax",
    secure,
    maxAge: 60 * 60,
    // Scope the cookie to /api/shares/<token>/ so the browser only sends it
    // for routes that actually belong to this share. Defends against the
    // cookie leaking to unrelated paths if multiple shares are accessed.
    path: `/api/shares/${token}/`
  });
}

function hasShareAuth(request: FastifyRequest, shareId: string, needsAuth: boolean): boolean {
  if (!needsAuth) return true;
  const raw = (request.cookies as Record<string, string | undefined>)[shareAuthCookieName(shareId)];
  if (!raw) return false;
  const result = request.unsignCookie(raw);
  return result.valid && result.value === "ok";
}

// ---- Simple in-memory rate limiter for share password attempts ----
// Sliding window: max 5 attempts per (ip, shareId) per 60 seconds.
// Successful authorizations reset the counter.
const SHARE_AUTH_WINDOW_MS = 60 * 1000;
const SHARE_AUTH_MAX_ATTEMPTS = 5;
const shareAuthAttempts = new Map<string, { attempts: number[]; }>();

function shareAuthRateLimitKey(request: FastifyRequest, shareId: string): string {
  const ip = (request.headers["x-forwarded-for"] ?? request.ip).toString().split(",")[0].trim();
  return `${ip}:${shareId}`;
}

function checkShareAuthRateLimit(request: FastifyRequest, shareId: string): { allowed: boolean; retryAfterSec: number } {
  const key = shareAuthRateLimitKey(request, shareId);
  const now = Date.now();
  const record = shareAuthAttempts.get(key) ?? { attempts: [] };
  // Drop attempts older than window
  record.attempts = record.attempts.filter((t) => now - t < SHARE_AUTH_WINDOW_MS);
  if (record.attempts.length >= SHARE_AUTH_MAX_ATTEMPTS) {
    const oldest = record.attempts[0];
    return { allowed: false, retryAfterSec: Math.ceil((SHARE_AUTH_WINDOW_MS - (now - oldest)) / 1000) };
  }
  record.attempts.push(now);
  shareAuthAttempts.set(key, record);
  return { allowed: true, retryAfterSec: 0 };
}

function resetShareAuthRateLimit(request: FastifyRequest, shareId: string): void {
  shareAuthAttempts.delete(shareAuthRateLimitKey(request, shareId));
}

// Periodic prune of the rate-limiter map so it doesn't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [key, record] of shareAuthAttempts) {
    record.attempts = record.attempts.filter((t) => now - t < SHARE_AUTH_WINDOW_MS);
    if (record.attempts.length === 0) shareAuthAttempts.delete(key);
  }
}, 5 * 60 * 1000).unref?.();

function parseRangeMs(range: string): number | null {
  const map: Record<string, number> = {
    "1h": 60 * 60 * 1000,
    "6h": 6 * 60 * 60 * 1000,
    "24h": 24 * 60 * 60 * 1000,
    "7d": 7 * 24 * 60 * 60 * 1000,
    "30d": 30 * 24 * 60 * 60 * 1000
  };
  return map[range] ?? null;
}

function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/^\.+/, "_").slice(0, 200);
}

/**
 * Returns true iff `candidateId` is folderId itself or any of its descendants.
 * Used to prevent cycles when moving a folder.
 *   isDescendantOf(prisma, candidateNewParent, beingMoved) === true → reject.
 */
async function isDescendantOf(
  prisma: PrismaClient,
  candidateId: string,
  ancestorId: string
): Promise<boolean> {
  if (candidateId === ancestorId) return true;
  let cursor: string | null = candidateId;
  for (let depth = 0; depth < 64; depth += 1) {
    if (!cursor) return false;
    const row: { parentId: string | null } | null = await prisma.folder.findUnique({
      where: { id: cursor },
      select: { parentId: true }
    });
    if (!row) return false;
    if (row.parentId === ancestorId) return true;
    cursor = row.parentId;
  }
  return false;
}

function sendFile(reply: FastifyReply, filename: string, mimeType: string, body: Buffer) {
  return reply
    .header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`)
    .type(mimeType || "application/octet-stream")
    .send(body);
}

function sendFileStream(
  reply: FastifyReply,
  filename: string,
  mimeType: string,
  body: NodeJS.ReadableStream,
  sizeBytes?: bigint
) {
  if (sizeBytes != null) {
    reply.header("content-length", sizeBytes.toString());
  }
  return reply
    .header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`)
    .type(mimeType || "application/octet-stream")
    .send(body);
}

function sendInlineFile(reply: FastifyReply, filename: string, mimeType: string, body: Buffer) {
  return reply
    .header("content-disposition", `inline; filename*=UTF-8''${encodeURIComponent(filename)}`)
    .type(mimeType || "application/octet-stream")
    .send(body);
}

function sendInlineHtml(reply: FastifyReply, filename: string, body: string) {
  return reply
    .header("content-disposition", `inline; filename*=UTF-8''${encodeURIComponent(filename)}`)
    .type("text/html; charset=utf-8")
    .send(body);
}

function isDocxFile(filename: string, mimeType: string) {
  const lowerName = filename.toLowerCase();
  const lowerMime = mimeType.toLowerCase();
  return lowerName.endsWith(".docx") || lowerMime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
}

function previewMimeType(filename: string, mimeType: string) {
  const lowerName = filename.toLowerCase();
  const lowerMime = mimeType.toLowerCase();
  if (lowerName.endsWith(".pdf") || lowerMime.includes("pdf")) return "application/pdf";
  if (lowerName.endsWith(".md")) return "text/plain; charset=utf-8";
  if (lowerName.endsWith(".txt") || lowerName.endsWith(".log")) return "text/plain; charset=utf-8";
  if (lowerName.endsWith(".csv")) return "text/csv; charset=utf-8";
  if (lowerName.endsWith(".json")) return "application/json; charset=utf-8";
  return mimeType || "application/octet-stream";
}

function renderDocxPreviewHtml(filename: string, body: Buffer) {
  const xml = readZipEntry(body, "word/document.xml");
  const paragraphs = xml ? extractDocxParagraphs(xml) : [];
  const content = paragraphs.length > 0
    ? paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join("\n")
    : `<div class="empty">无法解析这个 DOCX 的文本内容，可以下载后查看原文件。</div>`;

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(filename)}</title>
  <style>
    body { margin: 0; background: #f3f5f8; color: #1f2329; font-family: ui-serif, Georgia, "Times New Roman", "Noto Serif CJK SC", serif; }
    main { width: min(820px, calc(100vw - 32px)); min-height: calc(100vh - 48px); margin: 24px auto; padding: 54px 64px; background: #fff; box-shadow: 0 8px 30px rgb(31 35 41 / 10%); }
    h1 { margin: 0 0 28px; font: 700 22px ui-sans-serif, system-ui, sans-serif; }
    p { margin: 0 0 14px; line-height: 1.78; white-space: pre-wrap; overflow-wrap: anywhere; }
    .empty { color: #646a73; font-family: ui-sans-serif, system-ui, sans-serif; }
    @media (max-width: 720px) { main { width: auto; min-height: 100vh; margin: 0; padding: 28px 22px; } }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(filename)}</h1>
    ${content}
  </main>
</body>
</html>`;
}

function readZipEntry(zip: Buffer, entryName: string): string | null {
  const eocdOffset = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocdOffset < 0 || eocdOffset + 22 > zip.length) return null;

  const entryCount = zip.readUInt16LE(eocdOffset + 10);
  const centralDirectoryOffset = zip.readUInt32LE(eocdOffset + 16);
  let offset = centralDirectoryOffset;

  for (let index = 0; index < entryCount && offset + 46 <= zip.length; index += 1) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) return null;
    const compressionMethod = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const filenameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const localHeaderOffset = zip.readUInt32LE(offset + 42);
    const name = zip.subarray(offset + 46, offset + 46 + filenameLength).toString("utf8");

    if (name === entryName) {
      if (localHeaderOffset + 30 > zip.length || zip.readUInt32LE(localHeaderOffset) !== 0x04034b50) return null;
      const localFilenameLength = zip.readUInt16LE(localHeaderOffset + 26);
      const localExtraLength = zip.readUInt16LE(localHeaderOffset + 28);
      const dataOffset = localHeaderOffset + 30 + localFilenameLength + localExtraLength;
      const compressed = zip.subarray(dataOffset, dataOffset + compressedSize);
      if (compressionMethod === 0) return compressed.toString("utf8");
      if (compressionMethod === 8) return inflateRawSync(compressed).toString("utf8");
      return null;
    }

    offset += 46 + filenameLength + extraLength + commentLength;
  }

  return null;
}

function extractDocxParagraphs(documentXml: string) {
  const paragraphs: string[] = [];
  const paragraphMatches = documentXml.matchAll(/<w:p\b[\s\S]*?<\/w:p>/g);
  for (const match of paragraphMatches) {
    const paragraphXml = match[0]
      .replace(/<w:tab\b[^>]*\/>/g, "\t")
      .replace(/<w:br\b[^>]*\/>/g, "\n");
    const text = Array.from(paragraphXml.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g))
      .map((textMatch) => decodeXmlEntities(textMatch[1]))
      .join("");
    if (text.trim()) {
      paragraphs.push(text);
    }
  }
  return paragraphs;
}

function decodeXmlEntities(value: string) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function collectFolderTreeIds(prisma: PrismaClient, rootFolderId: string): Promise<string[]> {
  const ids: string[] = [];
  const queue = [rootFolderId];

  while (queue.length > 0) {
    const folderId = queue.shift();
    if (!folderId || ids.includes(folderId)) continue;
    ids.push(folderId);
    const children = await prisma.folder.findMany({
      where: { parentId: folderId },
      select: { id: true }
    });
    queue.push(...children.map((child) => child.id));
  }

  return ids;
}

async function logAccess(
  prisma: PrismaClient,
  request: FastifyRequest,
  input: {
    actorId?: string;
    fileId?: string;
    shareLinkId?: string;
    nodeId?: string;
    action: string;
    result: string;
  }
) {
  await prisma.accessLog.create({
    data: {
      ...input,
      ip: request.ip,
      userAgent: typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : null
    }
  });
}

function optionalQueryId(request: FastifyRequest, key: string): string | null {
  const value = (request.query as Record<string, unknown> | undefined)?.[key];
  if (typeof value !== "string" || value.length === 0 || value === "null") {
    return null;
  }
  return value;
}

function optionalQueryString(request: FastifyRequest, key: string): string | null {
  const value = (request.query as Record<string, unknown> | undefined)?.[key];
  const stringValue = Array.isArray(value) ? value[0] : value;
  if (typeof stringValue !== "string" || stringValue.length === 0 || stringValue === "null") {
    return null;
  }
  return stringValue;
}

function parsePositiveQueryInt(request: FastifyRequest, key: string, fallback: number, min: number, max: number): number {
  const raw = optionalQueryString(request, key);
  if (!raw) {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw httpError(400, `${key} must be an integer between ${min} and ${max}`);
  }

  return value;
}

function parseOptionalQueryDate(request: FastifyRequest, key: string): Date | null {
  const raw = optionalQueryString(request, key);
  if (!raw) {
    return null;
  }

  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw httpError(400, `${key} must be a valid date`);
  }

  return date;
}

function applyAccessLogStringFilter(
  where: Prisma.AccessLogWhereInput,
  key: "action" | "result" | "fileId" | "shareLinkId" | "actorId",
  value: string | null
) {
  if (!value) {
    return;
  }

  switch (key) {
    case "action":
      where.action = value;
      break;
    case "result":
      where.result = value;
      break;
    case "fileId":
      where.fileId = value;
      break;
    case "shareLinkId":
      where.shareLinkId = value;
      break;
    case "actorId":
      where.actorId = value;
      break;
  }
}

function emptyToNull(value?: string): string | null {
  return value && value !== "null" ? value : null;
}

function parseOptionalDate(value: string | undefined, fieldName: string): Date | null {
  if (!value || value === "null") {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${fieldName} must be a valid date`);
  }

  return date;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function httpError(statusCode: number, message: string): Error {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = statusCode;
  return error;
}

function httpStatusCode(error: unknown): number | null {
  const statusCode = (error as { statusCode?: unknown } | null)?.statusCode;
  return typeof statusCode === "number" && statusCode >= 400 && statusCode < 500 ? statusCode : null;
}

function serializeUserForResponse(user: {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  disabledAt?: Date | null;
  createdAt: Date;
  updatedAt?: Date;
}) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role.toLowerCase(),
    disabledAt: user.disabledAt ?? null,
    enabled: !user.disabledAt,
    createdAt: user.createdAt
  };
}

function serializeFolder(folder: { id: string; name: string; parentId: string | null; ownerId: string; defaultPolicy: unknown; createdAt: Date; updatedAt: Date }) {
  return {
    id: folder.id,
    name: folder.name,
    parentId: folder.parentId,
    ownerId: folder.ownerId,
    defaultPolicy: String(folder.defaultPolicy).toLowerCase(),
    createdAt: folder.createdAt,
    updatedAt: folder.updatedAt
  };
}

function serializeFile(file: {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: bigint;
  ownerId: string;
  folderId: string | null;
  policyOverride: unknown;
  expiresAt: Date | null;
  status: FileStatus;
  createdAt: Date;
  updatedAt: Date;
  folder?: { defaultPolicy: unknown } | null;
  versions?: Array<{ id: string; storageLayout?: unknown; chunkCount?: number | null; replicas?: Array<{ status: unknown }> }>;
}) {
  const latestVersion = file.versions?.[0];
  const availableReplicas = latestVersion?.replicas?.filter((replica) => String(replica.status) === "AVAILABLE").length ?? 0;
  const folderPolicy = file.folder ? String(file.folder.defaultPolicy).toLowerCase() : "standard";
  const policyOverride = file.policyOverride ? String(file.policyOverride).toLowerCase() : null;
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes.toString(),
    ownerId: file.ownerId,
    folderId: file.folderId,
    policyOverride,
    effectivePolicy: resolveStoragePolicy(folderPolicy as "standard" | "important" | "temporary", policyOverride as "standard" | "important" | "temporary" | null),
    expiresAt: file.expiresAt,
    status: file.status.toLowerCase(),
    latestVersionId: latestVersion?.id ?? null,
    storageLayout: latestVersion ? storageLayoutValue(latestVersion) : "whole",
    isChunked: latestVersion ? storageLayoutValue(latestVersion) === "chunked" : false,
    chunkCount: latestVersion?.chunkCount ?? null,
    replicaCount: availableReplicas,
    createdAt: file.createdAt,
    updatedAt: file.updatedAt
  };
}

function serializeVersionDetail(version: {
  id: string;
  objectKey: string;
  plaintextSha256: string;
  ciphertextSha256: string;
  sizeBytes: bigint;
  storageLayout?: unknown;
  chunkSizeBytes?: bigint | null;
  chunkCount?: number | null;
  createdAt: Date;
  replicas?: Array<{ status: unknown; node?: { status: unknown } | null }>;
  chunks?: Array<{
    encryptionNonce?: string | null;
    encryptionAuthTag?: string | null;
    replicas?: Array<{ status: unknown; node?: { status: unknown } | null }>;
  }>;
}) {
  const isChunked = storageLayoutValue(version) === "chunked";
  const hasPerChunkEncryption = isChunked &&
    (version.chunks?.length ?? 0) > 0 &&
    version.chunks?.every((chunk) => chunk.encryptionNonce && chunk.encryptionAuthTag) === true;
  return {
    id: version.id,
    objectKey: version.objectKey,
    plaintextSha256: version.plaintextSha256,
    ciphertextSha256: version.ciphertextSha256,
    sizeBytes: version.sizeBytes.toString(),
    storageLayout: storageLayoutValue(version),
    isChunked,
    streamingDownloadSupported: hasPerChunkEncryption,
    chunkSizeBytes: version.chunkSizeBytes?.toString() ?? null,
    declaredChunkCount: version.chunkCount ?? null,
    chunkCount: version.chunks?.length ?? 0,
    replicaCount: version.replicas?.length ?? 0,
    availableReplicaCount: version.replicas?.filter(isHealthyAvailableReplica).length ?? 0,
    chunkReplicaCount: version.chunks?.reduce((count, chunk) => count + (chunk.replicas?.length ?? 0), 0) ?? 0,
    availableChunkReplicaCount: version.chunks?.reduce(
      (count, chunk) => count + (chunk.replicas?.filter(isHealthyAvailableReplica).length ?? 0),
      0
    ) ?? 0,
    createdAt: version.createdAt
  };
}

function serializeVersionHistoryItem(version: {
  id: string;
  plaintextSha256: string;
  ciphertextSha256: string;
  sizeBytes: bigint;
  storageLayout?: unknown;
  chunkSizeBytes?: bigint | null;
  chunkCount?: number | null;
  createdAt: Date;
  replicas?: Array<{ status: unknown; node?: { status: unknown } | null }>;
  chunks?: Array<{
    index: number;
    encryptionNonce?: string | null;
    encryptionAuthTag?: string | null;
    replicas?: Array<{ status: unknown; node?: { status: unknown } | null }>;
  }>;
}, effectivePolicy: StoragePolicy) {
  const layout = storageLayoutValue(version);
  const chunks = version.chunks ?? [];
  const replicas = version.replicas ?? [];
  const chunkReplicas = chunks.flatMap((chunk) => chunk.replicas ?? []);
  const requiredReplicasPerObject = requiredReplicaCount(effectivePolicy);
  const chunksAtRisk = layout === "chunked"
    ? chunks.filter((chunk) => (chunk.replicas ?? []).filter(isHealthyAvailableReplica).length < requiredReplicasPerObject).length
    : 0;
  const streamingDownloadSupported = layout === "chunked" &&
    chunks.length > 0 &&
    chunks.every((chunk) => chunk.encryptionNonce && chunk.encryptionAuthTag);

  return {
    id: version.id,
    storageLayout: layout,
    isChunked: layout === "chunked",
    sizeBytes: version.sizeBytes.toString(),
    plaintextSha256: version.plaintextSha256,
    ciphertextSha256: version.ciphertextSha256,
    chunkSizeBytes: version.chunkSizeBytes?.toString() ?? null,
    declaredChunkCount: version.chunkCount ?? null,
    chunkCount: chunks.length,
    streamingDownloadSupported,
    createdAt: version.createdAt,
    replicaHealth: {
      requiredReplicasPerObject,
      wholeReplicaCount: replicas.length,
      availableWholeReplicaCount: replicas.filter(isHealthyAvailableReplica).length,
      missingWholeReplicaCount: replicas.filter((replica) => String(replica.status) === "MISSING").length,
      unavailableWholeNodeCount: replicas.filter(replicaNodeUnavailable).length,
      chunkReplicaCount: chunkReplicas.length,
      availableChunkReplicaCount: chunkReplicas.filter(isHealthyAvailableReplica).length,
      missingChunkReplicaCount: chunkReplicas.filter((replica) => String(replica.status) === "MISSING").length,
      unavailableChunkNodeCount: chunkReplicas.filter(replicaNodeUnavailable).length,
      chunksAtRisk
    }
  };
}

function serializeStorageLayout(version: {
  storageLayout?: unknown;
  chunkSizeBytes?: bigint | null;
  chunkCount?: number | null;
  replicas?: unknown[];
  chunks?: Array<{ replicas?: unknown[]; encryptionNonce?: string | null; encryptionAuthTag?: string | null }>;
}) {
  const layout = storageLayoutValue(version);
  const hasPerChunkEncryption = layout === "chunked" &&
    (version.chunks?.length ?? 0) > 0 &&
    version.chunks?.every((chunk) => chunk.encryptionNonce && chunk.encryptionAuthTag) === true;
  return {
    layout,
    isChunked: layout === "chunked",
    chunkedUploadDownloadSupported: true,
    streamingDownloadSupported: hasPerChunkEncryption,
    chunkSizeBytes: version.chunkSizeBytes?.toString() ?? null,
    declaredChunkCount: version.chunkCount ?? null,
    chunkCount: version.chunks?.length ?? 0,
    wholeReplicaCount: version.replicas?.length ?? 0,
    chunkReplicaCount: version.chunks?.reduce((count, chunk) => count + (chunk.replicas?.length ?? 0), 0) ?? 0
  };
}

/**
 * Per-node storage distribution for a single version. Aggregates whole-file
 * replica bytes + chunk-replica bytes for each node that holds any piece.
 *
 * Output is sorted by bytes desc so the UI can render the biggest holders
 * first. Each entry includes the node's current status so the UI can flag
 * "this VPS is currently lost/offline" inline.
 */
function serializeStorageDistribution(version: {
  sizeBytes?: bigint | null;
  replicas?: Array<{
    nodeId: string;
    status: unknown;
    node: { id: string; name: string; baseUrl: string; status: StorageNodeStatus };
  }>;
  chunks?: Array<{
    ciphertextSizeBytes?: bigint | null;
    replicas?: Array<{
      nodeId: string;
      status: unknown;
      node: { id: string; name: string; baseUrl: string; status: StorageNodeStatus };
    }>;
  }>;
}) {
  type Entry = {
    nodeId: string;
    nodeName: string;
    nodeBaseUrl: string;
    nodeStatus: string;
    bytes: bigint;
    wholeReplicaCount: number;
    chunkReplicaCount: number;
  };
  const byNode = new Map<string, Entry>();

  function ensure(node: { id: string; name: string; baseUrl: string; status: StorageNodeStatus }): Entry {
    let entry = byNode.get(node.id);
    if (!entry) {
      entry = {
        nodeId: node.id,
        nodeName: node.name,
        nodeBaseUrl: node.baseUrl,
        nodeStatus: String(node.status).toLowerCase(),
        bytes: 0n,
        wholeReplicaCount: 0,
        chunkReplicaCount: 0
      };
      byNode.set(node.id, entry);
    }
    return entry;
  }

  // Whole-file replicas: each occupies the version's full ciphertext size.
  const wholeBytes = version.sizeBytes ?? 0n;
  for (const replica of version.replicas ?? []) {
    if (String(replica.status).toLowerCase() === "deleted") continue;
    const entry = ensure(replica.node);
    entry.bytes += wholeBytes;
    entry.wholeReplicaCount += 1;
  }

  // Chunk replicas: each occupies the chunk's individual ciphertext size.
  for (const chunk of version.chunks ?? []) {
    const chunkBytes = chunk.ciphertextSizeBytes ?? 0n;
    for (const replica of chunk.replicas ?? []) {
      if (String(replica.status).toLowerCase() === "deleted") continue;
      const entry = ensure(replica.node);
      entry.bytes += chunkBytes;
      entry.chunkReplicaCount += 1;
    }
  }

  const nodes = Array.from(byNode.values())
    .map((e) => ({
      nodeId: e.nodeId,
      nodeName: e.nodeName,
      nodeBaseUrl: e.nodeBaseUrl,
      nodeStatus: e.nodeStatus,
      bytes: e.bytes.toString(),
      wholeReplicaCount: e.wholeReplicaCount,
      chunkReplicaCount: e.chunkReplicaCount
    }))
    .sort((a, b) => (BigInt(b.bytes) > BigInt(a.bytes) ? 1 : BigInt(b.bytes) < BigInt(a.bytes) ? -1 : 0));

  return {
    nodes,
    nodeCount: nodes.length,
    // Single-VPS = "all the data lives on one node" — useful for the UI to
    // flash a warning (no redundancy). Empty distribution counts as single
    // for display purposes (nothing to redundancy-warn about either way).
    isSingleNode: nodes.length <= 1
  };
}

function serializeMissingStorageLayout() {
  return {
    layout: "whole",
    isChunked: false,
    chunkedUploadDownloadSupported: true,
    streamingDownloadSupported: false,
    chunkSizeBytes: null,
    declaredChunkCount: null,
    chunkCount: 0,
    wholeReplicaCount: 0,
    chunkReplicaCount: 0
  };
}

function storageLayoutValue(version: { storageLayout?: unknown }) {
  return String(version.storageLayout ?? "WHOLE").toLowerCase();
}

function serializeReplicaDetail(replica: {
  id: string;
  versionId: string;
  nodeId: string;
  objectId: string;
  ciphertextSha256: string;
  status: unknown;
  verifiedAt: Date | null;
  createdAt: Date;
  node: {
    id: string;
    name: string;
    baseUrl: string;
    status: StorageNodeStatus;
    priority: number;
    lastSeenAt: Date | null;
    freeBytes: bigint | null;
    totalBytes: bigint | null;
    createdAt: Date;
  };
}) {
  return {
    id: replica.id,
    versionId: replica.versionId,
    nodeId: replica.nodeId,
    objectId: replica.objectId,
    status: String(replica.status).toLowerCase(),
    ciphertextSha256: replica.ciphertextSha256,
    verifiedAt: replica.verifiedAt,
    createdAt: replica.createdAt,
    node: serializeNode(replica.node)
  };
}

function serializeChunkDetail(chunk: {
  id: string;
  versionId: string;
  index: number;
  plaintextSizeBytes: bigint;
  ciphertextSizeBytes: bigint;
  plaintextSha256: string;
  ciphertextSha256: string;
  encryptionNonce?: string | null;
  encryptionAuthTag?: string | null;
  createdAt: Date;
  replicas: Array<{
    id: string;
    chunkId: string;
    nodeId: string;
    objectId: string;
    ciphertextSha256: string;
    status: unknown;
    verifiedAt: Date | null;
    createdAt: Date;
    node: {
      id: string;
      name: string;
      baseUrl: string;
      status: StorageNodeStatus;
      priority: number;
      lastSeenAt: Date | null;
      freeBytes: bigint | null;
      totalBytes: bigint | null;
      createdAt: Date;
    };
  }>;
}) {
  return {
    id: chunk.id,
    versionId: chunk.versionId,
    index: chunk.index,
    plaintextSizeBytes: chunk.plaintextSizeBytes.toString(),
    ciphertextSizeBytes: chunk.ciphertextSizeBytes.toString(),
    plaintextSha256: chunk.plaintextSha256,
    ciphertextSha256: chunk.ciphertextSha256,
    hasPerChunkEncryption: Boolean(chunk.encryptionNonce && chunk.encryptionAuthTag),
    replicaCount: chunk.replicas.length,
    availableReplicaCount: chunk.replicas.filter(isHealthyAvailableReplica).length,
    createdAt: chunk.createdAt,
    replicas: chunk.replicas.map((replica) => ({
      id: replica.id,
      chunkId: replica.chunkId,
      nodeId: replica.nodeId,
      objectId: replica.objectId,
      status: String(replica.status).toLowerCase(),
      ciphertextSha256: replica.ciphertextSha256,
      verifiedAt: replica.verifiedAt,
      createdAt: replica.createdAt,
      node: serializeNode(replica.node)
    }))
  };
}

function serializeAccessSummary(log: {
  id: string;
  actorId: string | null;
  shareLinkId: string | null;
  nodeId: string | null;
  action: string;
  result: string;
  createdAt: Date;
}) {
  return {
    id: log.id,
    actorId: log.actorId,
    shareLinkId: log.shareLinkId,
    nodeId: log.nodeId,
    action: log.action,
    result: log.result,
    createdAt: log.createdAt
  };
}

function buildFileRisks(file: {
  id: string;
  policyOverride: unknown;
  folder?: { defaultPolicy: unknown } | null;
  versions?: Array<{
    id: string;
    storageLayout?: unknown;
    chunkCount?: number | null;
    replicas?: Array<{
      id: string;
      versionId: string;
      nodeId: string;
      status: unknown;
      node?: { id: string; status: unknown } | null;
    }>;
    chunks?: Array<{
      id: string;
      versionId: string;
      index: number;
      replicas?: Array<{
        id: string;
        chunkId: string;
        nodeId: string;
        status: unknown;
        node?: { id: string; status: unknown } | null;
      }>;
    }>;
  }>;
}) {
  const latestVersion = file.versions?.[0];
  if (!latestVersion) {
    return [{
      type: "file_has_no_version",
      fileId: file.id,
      versionId: null,
      replicaId: null,
      nodeId: null,
      message: "file has no latest version"
    }];
  }

  const replicas = latestVersion.replicas ?? [];
  const chunks = latestVersion.chunks ?? [];
  const risks = [];
  const effectivePolicy = effectivePolicyForFile(file);
  const healthyAvailableCount = replicas.filter(isHealthyAvailableReplica).length;
  const isChunked = storageLayoutValue(latestVersion) === "chunked";

  if (!isChunked && effectivePolicy === "important" && healthyAvailableCount < requiredReplicaCount("important")) {
    risks.push({
      type: "important_replica_shortage",
      fileId: file.id,
      versionId: latestVersion.id,
      replicaId: null,
      nodeId: null,
      message: `important file has ${healthyAvailableCount} healthy available replicas`
    });
  }

  if (isChunked && latestVersion.chunkCount != null && chunks.length !== latestVersion.chunkCount) {
    risks.push({
      type: "chunk_metadata_incomplete",
      fileId: file.id,
      versionId: latestVersion.id,
      replicaId: null,
      nodeId: null,
      chunkId: null,
      chunkIndex: null,
      message: `chunked version declares ${latestVersion.chunkCount} chunks but has ${chunks.length} chunk records`
    });
  }

  for (const chunk of chunks) {
    const chunkReplicas = chunk.replicas ?? [];
    const healthyChunkReplicaCount = chunkReplicas.filter(isHealthyAvailableReplica).length;
    const requiredChunkReplicas = requiredReplicaCount(effectivePolicy);
    if (healthyChunkReplicaCount < requiredChunkReplicas) {
      risks.push({
        type: "chunk_replica_shortage",
        fileId: file.id,
        versionId: chunk.versionId,
        replicaId: null,
        nodeId: null,
        chunkId: chunk.id,
        chunkIndex: chunk.index,
        message: `chunk ${chunk.index} has ${healthyChunkReplicaCount} healthy available replicas`
      });
    }

    for (const replica of chunkReplicas) {
      const replicaStatus = String(replica.status);
      const nodeStatus = replica.node ? String(replica.node.status) : null;
      if (replicaStatus === "MISSING") {
        risks.push({
          type: "chunk_replica_unavailable",
          fileId: file.id,
          versionId: chunk.versionId,
          replicaId: replica.id,
          nodeId: replica.nodeId,
          chunkId: chunk.id,
          chunkIndex: chunk.index,
          message: `chunk ${chunk.index} replica is marked missing`
        });
      }

      if (nodeStatus === "OFFLINE" || nodeStatus === "DISABLED") {
        risks.push({
          type: "chunk_replica_node_unavailable",
          fileId: file.id,
          versionId: chunk.versionId,
          replicaId: replica.id,
          nodeId: replica.nodeId,
          chunkId: chunk.id,
          chunkIndex: chunk.index,
          message: `chunk ${chunk.index} replica node is ${nodeStatus.toLowerCase()}`
        });
      }
    }
  }

  for (const replica of replicas) {
    const replicaStatus = String(replica.status);
    const nodeStatus = replica.node ? String(replica.node.status) : null;
    if (replicaStatus === "MISSING") {
      risks.push({
        type: "replica_unavailable",
        fileId: file.id,
        versionId: replica.versionId,
        replicaId: replica.id,
        nodeId: replica.nodeId,
        message: "replica is marked missing after a failed read or verification"
      });
    }

    if (nodeStatus === "OFFLINE" || nodeStatus === "DISABLED") {
      risks.push({
        type: "replica_node_unavailable",
        fileId: file.id,
        versionId: replica.versionId,
        replicaId: replica.id,
        nodeId: replica.nodeId,
        message: `replica node is ${nodeStatus.toLowerCase()}`
      });
    }
  }

  return risks;
}

function effectivePolicyForFile(file: { policyOverride: unknown; folder?: { defaultPolicy: unknown } | null }) {
  const folderPolicy = file.folder ? String(file.folder.defaultPolicy).toLowerCase() : "standard";
  const policyOverride = file.policyOverride ? String(file.policyOverride).toLowerCase() : null;
  return resolveStoragePolicy(
    folderPolicy as "standard" | "important" | "temporary",
    policyOverride as "standard" | "important" | "temporary" | null
  );
}

function isExpiredTemporaryFile(file: {
  policyOverride: unknown;
  expiresAt: Date | null;
  folder?: { defaultPolicy: unknown } | null;
}) {
  return isTemporaryFileExpired({
    policy: effectivePolicyForFile(file),
    expiresAt: file.expiresAt
  });
}

function isHealthyAvailableReplica(replica: { status: unknown; node?: { status: unknown } | null }) {
  const nodeStatus = replica.node ? String(replica.node.status) : null;
  return String(replica.status) === "AVAILABLE" && (nodeStatus === "ACTIVE" || nodeStatus === "DEGRADED");
}

function replicaNodeUnavailable(replica: { node?: { status: unknown } | null }) {
  const nodeStatus = replica.node ? String(replica.node.status) : null;
  return nodeStatus === "OFFLINE" || nodeStatus === "DISABLED";
}

function serializeShare(share: { id: string; expiresAt: Date | null; maxDownloads: number | null; downloadCount: number; status: ShareStatus }, url: string) {
  return {
    id: share.id,
    url,
    expiresAt: share.expiresAt,
    maxDownloads: share.maxDownloads,
    downloadCount: share.downloadCount,
    status: share.status.toLowerCase()
  };
}

function serializeShareMetadata(
  share: {
    id: string;
    expiresAt: Date | null;
    maxDownloads: number | null;
    downloadCount: number;
    lastAccessAt: Date | null;
    createdAt: Date;
    passwordHash: string | null;
    status: ShareStatus;
    tokenEncrypted?: string | null;
  },
  options: { publicBaseUrl?: string; masterKey?: Buffer } = {}
) {
  let url: string | null = null;
  if (share.tokenEncrypted && options.publicBaseUrl && options.masterKey) {
    try {
      const token = decryptStringWithMaster(share.tokenEncrypted, options.masterKey);
      url = `${options.publicBaseUrl.replace(/\/+$/, "")}/share/${token}`;
    } catch {
      url = null; // ignore decryption errors; treat as legacy share
    }
  }
  return {
    id: share.id,
    status: share.status.toLowerCase(),
    expiresAt: share.expiresAt,
    maxDownloads: share.maxDownloads,
    downloadCount: share.downloadCount,
    lastAccessAt: share.lastAccessAt,
    createdAt: share.createdAt,
    needsPassword: Boolean(share.passwordHash),
    url
  };
}

function serializeNode(node: {
  id: string;
  name: string;
  baseUrl: string;
  status: StorageNodeStatus;
  priority: number;
  lastSeenAt: Date | null;
  freeBytes: bigint | null;
  totalBytes: bigint | null;
  createdAt: Date;
  consecutiveProbeFailures?: number;
  lostDeclaredAt?: Date | null;
}, health?: { lastError: string | null; healthMessage: string }) {
  return {
    id: node.id,
    name: node.name,
    baseUrl: node.baseUrl,
    status: node.status.toLowerCase(),
    priority: node.priority,
    lastSeenAt: node.lastSeenAt,
    freeBytes: node.freeBytes?.toString() ?? null,
    totalBytes: node.totalBytes?.toString() ?? null,
    lastError: health?.lastError ?? null,
    healthMessage: health?.healthMessage ?? defaultNodeHealthMessage(node.status),
    createdAt: node.createdAt,
    consecutiveProbeFailures: node.consecutiveProbeFailures ?? 0,
    lostDeclaredAt: node.lostDeclaredAt ?? null
  };
}

/**
 * Compute the data-loss impact of a single node going down. Surfaces:
 *  - affectedFiles: how many ACTIVE files have at least one replica on this node
 *  - replicasOnNode: total live replicas (chunk + whole) on this node
 *  - unrecoverableFiles: list of files where this node holds the ONLY live
 *    replica of at least one chunk/version (i.e. losing this node = data loss)
 *
 * Used by the UI to show "if this node is gone, here's what you lose" before
 * the admin clicks "declare lost" (and after, to summarize the damage).
 */
async function computeNodeImpact(prisma: PrismaClient, nodeId: string) {
  // Whole-file replicas on this node (live), with sibling counts.
  const wholeReplicasOnNode = await prisma.objectReplica.findMany({
    where: { nodeId, status: { not: ReplicaStatus.DELETED } },
    include: { version: { include: { file: true, replicas: { include: { node: true } } } } }
  });

  // Chunk replicas on this node (live), with sibling counts.
  const chunkReplicasOnNode = await prisma.chunkReplica.findMany({
    where: { nodeId, status: { not: ReplicaStatus.DELETED } },
    include: {
      chunk: {
        include: {
          version: { include: { file: true } },
          replicas: { include: { node: true } }
        }
      }
    }
  });

  // Per-file aggregation.
  type FileImpact = { fileId: string; name: string; unrecoverableChunks: number };
  const fileMap = new Map<string, FileImpact>();
  const touched = new Set<string>();

  function addUnrecoverable(file: { id: string; name: string }, chunks = 1) {
    touched.add(file.id);
    const cur = fileMap.get(file.id) ?? { fileId: file.id, name: file.name, unrecoverableChunks: 0 };
    cur.unrecoverableChunks += chunks;
    fileMap.set(file.id, cur);
  }

  // Helper: is a sibling replica (i.e. not on this node) considered "healthy"
  // and thus a viable backup if this node disappears? We accept ACTIVE,
  // DEGRADED, DECOMMISSIONING (data still readable). LOST/OFFLINE/DISABLED don't count.
  const isViableSibling = (r: { status: ReplicaStatus; node: { status: StorageNodeStatus } }) =>
    r.status === ReplicaStatus.AVAILABLE &&
    (r.node.status === StorageNodeStatus.ACTIVE ||
      r.node.status === StorageNodeStatus.DEGRADED ||
      r.node.status === StorageNodeStatus.DECOMMISSIONING);

  for (const replica of wholeReplicasOnNode) {
    const file = replica.version.file;
    if (file.status !== FileStatus.ACTIVE) continue;
    touched.add(file.id);
    const otherViable = replica.version.replicas.some((r) => r.nodeId !== nodeId && isViableSibling(r));
    if (!otherViable) {
      addUnrecoverable({ id: file.id, name: file.name });
    }
  }

  for (const replica of chunkReplicasOnNode) {
    const file = replica.chunk.version.file;
    if (file.status !== FileStatus.ACTIVE) continue;
    touched.add(file.id);
    const otherViable = replica.chunk.replicas.some((r) => r.nodeId !== nodeId && isViableSibling(r));
    if (!otherViable) {
      addUnrecoverable({ id: file.id, name: file.name });
    }
  }

  const unrecoverable = Array.from(fileMap.values()).sort((a, b) => b.unrecoverableChunks - a.unrecoverableChunks);

  return {
    nodeId,
    replicasOnNode: wholeReplicasOnNode.length + chunkReplicasOnNode.length,
    affectedFiles: touched.size,
    unrecoverableFileCount: unrecoverable.length,
    // Cap the per-file list at 50 so a catastrophic node-loss doesn't blow up
    // the payload. UI can show "and N more…" if truncated.
    unrecoverableFiles: unrecoverable.slice(0, 50),
    truncated: unrecoverable.length > 50
  };
}

function defaultNodeHealthMessage(status: StorageNodeStatus): string {
  if (status === StorageNodeStatus.DISABLED) {
    return "storage node is disabled and was not checked";
  }

  if (status === StorageNodeStatus.OFFLINE) {
    return "storage node has not been checked in this response";
  }

  return "storage node status is cached; refresh /nodes to diagnose";
}

function nodeHealthErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("401") || message.toLowerCase().includes("unauthorized")) {
    return "storage-agent authentication failed; check the agent token";
  }

  if (message.includes("storage node identity mismatch")) {
    return message;
  }

  if (message.toLowerCase().includes("fetch failed") || message.toLowerCase().includes("econnrefused")) {
    return "storage-agent is unreachable";
  }

  return message || "storage-agent health check failed";
}
