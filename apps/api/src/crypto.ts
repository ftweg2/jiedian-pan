import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual, type Hash } from "node:crypto";

export interface EncryptionMetadata {
  plaintextSha256: string;
  ciphertextSha256: string;
  encryptionNonce: string;
  encryptionAuthTag: string;
  wrappedKey: string;
}

export interface EncryptionResult {
  ciphertext: Buffer;
  metadata: EncryptionMetadata;
}

export interface EncryptedStreamChunk {
  index: number;
  plaintextSizeBytes: number;
  ciphertextSizeBytes: number;
  plaintextSha256: string;
  ciphertextSha256: string;
  encryptionNonce: string;
  encryptionAuthTag: string;
  ciphertext: Buffer;
}

export interface StreamEncryptionResult {
  metadata: EncryptionMetadata;
  plaintextSizeBytes: number;
  ciphertextSizeBytes: number;
  chunkCount: number;
  chunkSizeBytes: number;
}

export interface StreamEncryptionOptions {
  maxPlaintextSizeBytes?: number;
}

export function sha256(buffer: Buffer | string): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function hashToken(token: string): string {
  return sha256(token);
}

export function encryptBuffer(plaintext: Buffer, masterKey: Buffer): EncryptionResult {
  const fileKey = randomBytes(32);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", fileKey, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    ciphertext,
    metadata: {
      plaintextSha256: sha256(plaintext),
      ciphertextSha256: sha256(ciphertext),
      encryptionNonce: nonce.toString("base64url"),
      encryptionAuthTag: authTag.toString("base64url"),
      wrappedKey: wrapFileKey(fileKey, masterKey)
    }
  };
}

export async function encryptStreamToChunks(
  input: AsyncIterable<Buffer | Uint8Array | string>,
  masterKey: Buffer,
  chunkSizeBytes: number,
  onChunk: (chunk: EncryptedStreamChunk) => Promise<void>,
  options: StreamEncryptionOptions = {}
): Promise<StreamEncryptionResult> {
  if (!Number.isSafeInteger(chunkSizeBytes) || chunkSizeBytes <= 0) {
    throw new Error("chunk upload failure: invalid chunk size");
  }

  const fileKey = randomBytes(32);
  const plaintextHash = createHash("sha256");
  const ciphertextHash = createHash("sha256");
  let pending = Buffer.alloc(0);
  let index = 0;
  let plaintextSizeBytes = 0;
  let ciphertextSizeBytes = 0;
  let observedPlaintextBytes = 0;

  const emitChunk = async (plaintextChunk: Buffer) => {
    const chunkNonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", fileKey, chunkNonce);
    const ciphertext = Buffer.concat([cipher.update(plaintextChunk), cipher.final()]);
    const chunkAuthTag = cipher.getAuthTag();
    plaintextHash.update(plaintextChunk);
    ciphertextHash.update(ciphertext);
    plaintextSizeBytes += plaintextChunk.byteLength;
    ciphertextSizeBytes += ciphertext.byteLength;
    await onChunk({
      index,
      plaintextSizeBytes: plaintextChunk.byteLength,
      ciphertextSizeBytes: ciphertext.byteLength,
      plaintextSha256: sha256(plaintextChunk),
      ciphertextSha256: sha256(ciphertext),
      encryptionNonce: chunkNonce.toString("base64url"),
      encryptionAuthTag: chunkAuthTag.toString("base64url"),
      ciphertext
    });
    index += 1;
  };

  for await (const rawChunk of input) {
    const chunk = Buffer.from(rawChunk);
    if (chunk.byteLength === 0) {
      continue;
    }

    observedPlaintextBytes += chunk.byteLength;
    if (
      options.maxPlaintextSizeBytes != null &&
      observedPlaintextBytes > options.maxPlaintextSizeBytes
    ) {
      throw new Error("file exceeds MAX_UPLOAD_BYTES");
    }

    pending = pending.byteLength === 0 ? chunk : Buffer.concat([pending, chunk]);
    while (pending.byteLength >= chunkSizeBytes) {
      const plaintextChunk = pending.subarray(0, chunkSizeBytes);
      await emitChunk(plaintextChunk);
      pending = pending.subarray(chunkSizeBytes);
    }
  }

  if (pending.byteLength > 0 || index === 0) {
    await emitChunk(pending);
  }

  return {
    metadata: {
      plaintextSha256: plaintextHash.digest("hex"),
      ciphertextSha256: ciphertextHash.digest("hex"),
      encryptionNonce: randomBytes(12).toString("base64url"),
      encryptionAuthTag: randomBytes(16).toString("base64url"),
      wrappedKey: wrapFileKey(fileKey, masterKey)
    },
    plaintextSizeBytes,
    ciphertextSizeBytes,
    chunkCount: index,
    chunkSizeBytes
  };
}

export function encryptChunkWithKey(
  plaintext: Buffer,
  fileKey: Buffer,
  index: number
): EncryptedStreamChunk {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", fileKey, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    index,
    plaintextSizeBytes: plaintext.byteLength,
    ciphertextSizeBytes: ciphertext.byteLength,
    plaintextSha256: sha256(plaintext),
    ciphertextSha256: sha256(ciphertext),
    encryptionNonce: nonce.toString("base64url"),
    encryptionAuthTag: authTag.toString("base64url"),
    ciphertext
  };
}

export function buildAggregateMetadata(
  plaintextHash: Hash,
  ciphertextHash: Hash,
  fileKey: Buffer,
  masterKey: Buffer
): EncryptionMetadata {
  return {
    plaintextSha256: plaintextHash.copy().digest("hex"),
    ciphertextSha256: ciphertextHash.copy().digest("hex"),
    encryptionNonce: randomBytes(12).toString("base64url"),
    encryptionAuthTag: randomBytes(16).toString("base64url"),
    wrappedKey: wrapFileKey(fileKey, masterKey)
  };
}

export function decryptBuffer(
  ciphertext: Buffer,
  metadata: Pick<EncryptionMetadata, "encryptionNonce" | "encryptionAuthTag" | "wrappedKey">,
  masterKey: Buffer
): Buffer {
  const fileKey = unwrapFileKey(metadata.wrappedKey, masterKey);
  const decipher = createDecipheriv(
    "aes-256-gcm",
    fileKey,
    Buffer.from(metadata.encryptionNonce, "base64url")
  );
  decipher.setAuthTag(Buffer.from(metadata.encryptionAuthTag, "base64url"));
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function unwrapWrappedFileKey(wrappedKey: string, masterKey: Buffer): Buffer {
  return unwrapFileKey(wrappedKey, masterKey);
}

export function decryptChunkBuffer(
  ciphertext: Buffer,
  metadata: Pick<EncryptedStreamChunk, "encryptionNonce" | "encryptionAuthTag">,
  fileKey: Buffer
): Buffer {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    fileKey,
    Buffer.from(metadata.encryptionNonce, "base64url")
  );
  decipher.setAuthTag(Buffer.from(metadata.encryptionAuthTag, "base64url"));
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function safeEqualHash(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function wrapFileKeyForMaster(fileKey: Buffer, masterKey: Buffer): string {
  return wrapFileKey(fileKey, masterKey);
}

/**
 * Envelope-encrypt an arbitrary string under the master key.
 * Used for storing share tokens at rest so the owner can recover the URL later.
 */
export function encryptStringWithMaster(plaintext: string, masterKey: Buffer): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey, nonce);
  const encrypted = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [nonce, tag, encrypted].map((part) => part.toString("base64url")).join(".");
}

export function decryptStringWithMaster(envelope: string, masterKey: Buffer): string {
  const parts = envelope.split(".").map((part) => Buffer.from(part, "base64url"));
  const [nonce, tag, encrypted] = parts;
  if (!nonce || !tag || !encrypted) throw new Error("invalid envelope format");
  const decipher = createDecipheriv("aes-256-gcm", masterKey, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

function wrapFileKey(fileKey: Buffer, masterKey: Buffer): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey, nonce);
  const encrypted = Buffer.concat([cipher.update(fileKey), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [nonce, tag, encrypted].map((part) => part.toString("base64url")).join(".");
}

function unwrapFileKey(wrappedKey: string, masterKey: Buffer): Buffer {
  const [nonce, tag, encrypted] = wrappedKey.split(".").map((part) => Buffer.from(part, "base64url"));
  if (!nonce || !tag || !encrypted) {
    throw new Error("invalid wrapped key format");
  }

  const decipher = createDecipheriv("aes-256-gcm", masterKey, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}
