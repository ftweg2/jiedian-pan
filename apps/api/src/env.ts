export interface ApiEnv {
  port: number;
  host: string;
  databaseUrl: string;
  cookieSecret: string;
  cookieSecure: boolean;
  masterKey: Buffer;
  sessionTtlDays: number;
  corsOrigin: string;
  publicBaseUrl: string;
  maxUploadBytes: number;
  bootstrapAdminEmail?: string;
  bootstrapAdminPassword?: string;
  bootstrapLocalNodeName?: string;
  bootstrapLocalNodeUrl?: string;
  bootstrapLocalNodeToken?: string;
}

export function loadEnv(): ApiEnv {
  const databaseUrl = required("DATABASE_URL");
  const cookieSecret = required("COOKIE_SECRET");
  const masterKey = parseMasterKey(required("APP_MASTER_KEY"));

  return {
    port: Number(process.env.PORT ?? 4000),
    host: process.env.HOST ?? "0.0.0.0",
    databaseUrl,
    cookieSecret,
    cookieSecure: parseBoolean(process.env.COOKIE_SECURE, process.env.NODE_ENV === "production"),
    masterKey,
    sessionTtlDays: Number(process.env.SESSION_TTL_DAYS ?? 14),
    corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:5173",
    publicBaseUrl: process.env.PUBLIC_BASE_URL ?? "http://localhost:5173",
    maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES ?? 512 * 1024 * 1024),
    bootstrapAdminEmail: process.env.BOOTSTRAP_ADMIN_EMAIL,
    bootstrapAdminPassword: process.env.BOOTSTRAP_ADMIN_PASSWORD,
    bootstrapLocalNodeName: process.env.BOOTSTRAP_LOCAL_NODE_NAME,
    bootstrapLocalNodeUrl: process.env.BOOTSTRAP_LOCAL_NODE_URL,
    bootstrapLocalNodeToken: process.env.BOOTSTRAP_LOCAL_NODE_TOKEN
  };
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value.length === 0) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function parseMasterKey(value: string): Buffer {
  const key = value.length === 64 && /^[a-f0-9]+$/i.test(value)
    ? Buffer.from(value, "hex")
    : Buffer.from(value, "base64");

  if (key.byteLength !== 32) {
    throw new Error("APP_MASTER_KEY must decode to exactly 32 bytes. Generate one with: openssl rand -base64 32");
  }

  return key;
}
