import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { link, mkdir, readdir, rm, stat, statfs } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { NodeStatusReport } from "@wangpan/shared";

const objectIdPattern = /^(?!\.)(?!.*\.\.)[a-zA-Z0-9._:-]{8,160}$/;

export interface StoredObjectInfo {
  objectId: string;
  sizeBytes: number;
  ciphertextSha256: string;
}

export class ObjectStore {
  constructor(
    private readonly dataDir: string,
    private readonly nodeId?: string
  ) {}

  async ensureReady(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
  }

  objectPath(objectId: string): string {
    this.assertSafeObjectId(objectId);
    const prefix = objectId.slice(0, 2);
    return join(this.dataDir, prefix, objectId);
  }

  async put(objectId: string, body: Buffer, expectedHash: string, expectedSizeBytes?: number): Promise<StoredObjectInfo> {
    this.assertSafeObjectId(objectId);
    assertSha256(expectedHash);
    if (expectedSizeBytes != null && body.byteLength !== expectedSizeBytes) {
      throw new Error(`object size mismatch: expected ${expectedSizeBytes}, got ${body.byteLength}`);
    }

    const actualHash = sha256(body);
    if (actualHash !== expectedHash) {
      throw new Error(`ciphertext hash mismatch: expected ${expectedHash}, got ${actualHash}`);
    }

    const targetPath = this.objectPath(objectId);
    const existing = await this.verify(objectId, expectedHash);
    if (existing.exists) {
      if (!existing.matches || existing.sizeBytes !== body.byteLength) {
        throw new Error("object already exists with different content");
      }
      return {
        objectId,
        sizeBytes: existing.sizeBytes,
        ciphertextSha256: existing.ciphertextSha256
      };
    }

    await mkdir(dirname(targetPath), { recursive: true });
    const tempPath = `${targetPath}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`;
    try {
      await pipeline(Readable.from(body), createWriteStream(tempPath, { flags: "wx" }));
      await link(tempPath, targetPath);
      await rm(tempPath, { force: true });
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        const existingAfterRace = await this.verify(objectId, expectedHash);
        if (existingAfterRace.exists && existingAfterRace.matches && existingAfterRace.sizeBytes === body.byteLength) {
          return {
            objectId,
            sizeBytes: existingAfterRace.sizeBytes,
            ciphertextSha256: existingAfterRace.ciphertextSha256
          };
        }
        throw new Error("object already exists with different content");
      }
      throw error;
    }

    return {
      objectId,
      sizeBytes: body.byteLength,
      ciphertextSha256: actualHash
    };
  }

  stream(objectId: string): NodeJS.ReadableStream {
    return createReadStream(this.objectPath(objectId));
  }

  async exists(objectId: string): Promise<boolean> {
    try {
      await stat(this.objectPath(objectId));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      throw error;
    }
  }

  async delete(objectId: string): Promise<void> {
    await rm(this.objectPath(objectId), { force: true });
  }

  async verify(objectId: string, expectedHash: string): Promise<StoredObjectInfo & { exists: boolean; matches: boolean }> {
    this.assertSafeObjectId(objectId);
    assertSha256(expectedHash);
    try {
      const targetPath = this.objectPath(objectId);
      const fileStat = await stat(targetPath);
      const actualHash = await hashFile(targetPath);
      return {
        objectId,
        exists: true,
        sizeBytes: fileStat.size,
        ciphertextSha256: actualHash,
        matches: actualHash === expectedHash
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          objectId,
          exists: false,
          sizeBytes: 0,
          ciphertextSha256: "",
          matches: false
        };
      }
      throw error;
    }
  }

  async list(options: { prefix?: string; olderThanSeconds?: number; limit?: number }): Promise<Array<{ objectId: string; sizeBytes: number; ageSeconds: number }>> {
    const prefix = options.prefix ?? "";
    const minAge = Math.max(0, options.olderThanSeconds ?? 0);
    const limit = Math.max(1, Math.min(options.limit ?? 1000, 5000));
    const out: Array<{ objectId: string; sizeBytes: number; ageSeconds: number }> = [];
    const now = Date.now();
    const entries = await readdir(this.dataDir, { withFileTypes: true });
    for (const shard of entries) {
      if (!shard.isDirectory()) continue;
      // Only walk shards that could contain our prefix
      if (prefix && !shard.name.startsWith(prefix.slice(0, Math.min(prefix.length, shard.name.length)))) continue;
      const shardPath = join(this.dataDir, shard.name);
      let shardChildren;
      try {
        shardChildren = await readdir(shardPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const child of shardChildren) {
        if (!child.isFile()) continue;
        if (child.name.includes(".tmp-")) continue;
        if (prefix && !child.name.startsWith(prefix)) continue;
        try {
          const st = await stat(join(shardPath, child.name));
          const ageSeconds = (now - st.mtimeMs) / 1000;
          if (ageSeconds < minAge) continue;
          out.push({ objectId: child.name, sizeBytes: st.size, ageSeconds });
          if (out.length >= limit) return out;
        } catch {
          // ignore individual stat errors
        }
      }
    }
    return out;
  }

  async status(): Promise<NodeStatusReport> {
    await this.ensureReady();
    const fsStats = await statfs(this.dataDir);
    const totalBytes = Number(fsStats.blocks) * Number(fsStats.bsize);
    const freeBytes = Number(fsStats.bavail) * Number(fsStats.bsize);
    return {
      nodeId: this.nodeId,
      totalBytes,
      freeBytes,
      usedBytes: totalBytes - freeBytes,
      objectCount: await countObjects(this.dataDir),
      checkedAt: new Date().toISOString()
    };
  }

  private assertSafeObjectId(objectId: string): void {
    if (!objectIdPattern.test(objectId)) {
      throw new Error("invalid object id");
    }
  }
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function assertSha256(value: string): void {
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error("invalid ciphertext sha256");
  }
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

async function countObjects(dir: string): Promise<number> {
  let count = 0;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      count += await countObjects(entryPath);
    } else if (!entry.name.includes(".tmp-")) {
      count += 1;
    }
  }
  return count;
}
