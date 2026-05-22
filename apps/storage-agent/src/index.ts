import { loadEnv } from "./env.js";
import { buildServer } from "./server.js";

const env = loadEnv();
const app = await buildServer(env);

await app.listen({ port: env.port, host: env.host });
