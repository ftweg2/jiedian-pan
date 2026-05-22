import { timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

export function verifyBearerToken(request: FastifyRequest, expectedToken: string): boolean {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return false;
  }

  const actualToken = header.slice("Bearer ".length);
  const actual = Buffer.from(actualToken);
  const expected = Buffer.from(expectedToken);

  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function rejectUnauthorized(reply: FastifyReply): Promise<void> {
  await reply.code(401).send({ error: "unauthorized" });
}
