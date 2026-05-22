import cors from "@fastify/cors";
import Fastify from "fastify";
import { rejectUnauthorized, verifyBearerToken } from "./auth.js";
import type { AgentEnv } from "./env.js";
import { ObjectStore } from "./object-store.js";

export async function buildServer(env: AgentEnv) {
  const app = Fastify({
    logger: true,
    bodyLimit: Number(process.env.AGENT_MAX_OBJECT_BYTES ?? 1024 * 1024 * 1024),
    // objectId path params can be 8-160 chars (see object-store.objectIdPattern);
    // default Fastify limit is 100 and silently turns into a route-not-found 404.
    maxParamLength: 256
  });
  const store = new ObjectStore(env.dataDir, env.nodeId);
  await store.ensureReady();

  app.setErrorHandler((error, _request, reply) => {
    const message = error instanceof Error ? error.message : String(error);
    if (
      message.includes("invalid object id") ||
      message.includes("invalid ciphertext sha256") ||
      message.includes("hash mismatch") ||
      message.includes("size mismatch")
    ) {
      return reply.code(400).send({ error: message });
    }

    if (message.includes("already exists with different content")) {
      return reply.code(409).send({ error: message });
    }

    return reply.code(500).send({ error: message || "internal server error" });
  });

  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_request, body, done) => {
    done(null, body);
  });

  await app.register(cors, { origin: false });

  app.addHook("preHandler", async (request, reply) => {
    if (request.routeOptions.url === "/health") {
      return;
    }

    if (!verifyBearerToken(request, env.agentToken)) {
      return rejectUnauthorized(reply);
    }
  });

  app.get("/health", async () => ({ ok: true }));

  app.get("/status", async () => store.status());

  // List objects (for orphan sweep). prefix limits which shard subset to scan;
  // olderThanSeconds excludes files mid-upload; limit caps response size.
  app.get<{ Querystring: { prefix?: string; olderThanSeconds?: string; limit?: string } }>("/objects", async (request) => {
    const prefix = request.query.prefix ?? "";
    const olderThanSeconds = Number(request.query.olderThanSeconds ?? 0);
    const limit = Number(request.query.limit ?? 1000);
    const objects = await store.list({ prefix, olderThanSeconds, limit });
    return { objects };
  });

  app.put<{ Params: { objectId: string }; Body: Buffer }>("/objects/:objectId", async (request, reply) => {
    const expectedHash = request.headers["x-ciphertext-sha256"];
    if (typeof expectedHash !== "string") {
      return reply.code(400).send({ error: "x-ciphertext-sha256 header is required" });
    }

    const expectedSize = parseSizeHeader(request.headers["x-size-bytes"]);
    if (expectedSize === false) {
      return reply.code(400).send({ error: "x-size-bytes must be a non-negative safe integer" });
    }

    const result = await store.put(request.params.objectId, request.body, expectedHash, expectedSize ?? undefined);
    return reply.code(201).send(result);
  });

  app.get<{ Params: { objectId: string } }>("/objects/:objectId", async (request, reply) => {
    if (!(await store.exists(request.params.objectId))) {
      return reply.code(404).send({ error: "object not found" });
    }

    return reply.type("application/octet-stream").send(store.stream(request.params.objectId));
  });

  app.delete<{ Params: { objectId: string } }>("/objects/:objectId", async (request, reply) => {
    await store.delete(request.params.objectId);
    return reply.code(204).send();
  });

  app.post<{ Params: { objectId: string }; Body: { ciphertextSha256?: string } }>(
    "/objects/:objectId/verify",
    async (request, reply) => {
      const expectedHash = request.body?.ciphertextSha256;
      if (!expectedHash) {
        return reply.code(400).send({ error: "ciphertextSha256 is required" });
      }

      const result = await store.verify(request.params.objectId, expectedHash);
      return {
        objectId: request.params.objectId,
        exists: result.exists,
        sizeBytes: result.sizeBytes,
        ciphertextSha256: result.ciphertextSha256 || undefined,
        matches: result.matches
      };
    }
  );

  return app;
}

function parseSizeHeader(value: string | string[] | undefined): number | null | false {
  if (value == null) {
    return null;
  }

  if (Array.isArray(value) || !/^\d+$/.test(value)) {
    return false;
  }

  const size = Number(value);
  return Number.isSafeInteger(size) ? size : false;
}
