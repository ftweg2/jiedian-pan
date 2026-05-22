import { prisma } from "./db.js";
import { loadEnv } from "./env.js";
import { bootstrapAdmin, bootstrapLocalNode } from "./bootstrap.js";
import { startBackgroundJobs } from "./cleanup.js";
import { startNodeProber } from "./node-prober.js";
import { buildServer } from "./server.js";

const env = loadEnv();
await bootstrapAdmin(prisma, env);
await bootstrapLocalNode(prisma, env);
startBackgroundJobs(prisma);
startNodeProber(prisma);

const app = await buildServer(env, prisma);
await app.listen({ port: env.port, host: env.host });

const shutdown = async () => {
  await app.close();
  await prisma.$disconnect();
};

process.on("SIGINT", () => {
  shutdown().then(() => process.exit(0));
});

process.on("SIGTERM", () => {
  shutdown().then(() => process.exit(0));
});
