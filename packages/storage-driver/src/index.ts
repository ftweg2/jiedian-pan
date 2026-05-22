import { Readable } from "node:stream";
import type { NodeStatusReport } from "@wangpan/shared";

export interface PutObjectInput {
  objectId: string;
  body: Buffer | Uint8Array | Readable;
  ciphertextSha256: string;
  sizeBytes?: number;
}

export interface PutObjectResult {
  objectId: string;
  sizeBytes: number;
  ciphertextSha256: string;
}

export interface VerifyObjectResult {
  objectId: string;
  exists: boolean;
  sizeBytes?: number;
  ciphertextSha256?: string;
  matches: boolean;
}

export interface StorageDriver {
  putObject(input: PutObjectInput): Promise<PutObjectResult>;
  getObject(objectId: string): Promise<Readable>;
  deleteObject(objectId: string): Promise<void>;
  verifyObject(objectId: string, ciphertextSha256: string): Promise<VerifyObjectResult>;
  getStatus(): Promise<NodeStatusReport>;
}

export interface AgentStorageDriverOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}

export class AgentStorageDriver implements StorageDriver {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AgentStorageDriverOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async putObject(input: PutObjectInput): Promise<PutObjectResult> {
    const response = await this.fetchImpl(`${this.baseUrl}/objects/${encodeURIComponent(input.objectId)}`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/octet-stream",
        "x-ciphertext-sha256": input.ciphertextSha256,
        ...(input.sizeBytes == null ? {} : { "x-size-bytes": String(input.sizeBytes) })
      },
      body: input.body as BodyInit,
      duplex: "half"
    } as RequestInit);

    if (!response.ok) {
      throw new Error(`storage-agent putObject failed: ${response.status} ${await response.text()}`);
    }

    const result = (await response.json()) as PutObjectResult;
    if (result.ciphertextSha256 !== input.ciphertextSha256) {
      throw new Error("storage-agent putObject returned mismatched ciphertext hash");
    }
    if (input.sizeBytes != null && result.sizeBytes !== input.sizeBytes) {
      throw new Error("storage-agent putObject returned mismatched object size");
    }

    return result;
  }

  async getObject(objectId: string): Promise<Readable> {
    const response = await this.fetchImpl(`${this.baseUrl}/objects/${encodeURIComponent(objectId)}`, {
      headers: { authorization: `Bearer ${this.token}` }
    });

    if (!response.ok || !response.body) {
      throw new Error(`storage-agent getObject failed: ${response.status} ${await response.text()}`);
    }

    return Readable.fromWeb(response.body as unknown as import("node:stream/web").ReadableStream);
  }

  async deleteObject(objectId: string): Promise<void> {
    const response = await this.fetchImpl(`${this.baseUrl}/objects/${encodeURIComponent(objectId)}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${this.token}` }
    });

    if (!response.ok && response.status !== 404) {
      throw new Error(`storage-agent deleteObject failed: ${response.status} ${await response.text()}`);
    }
  }

  async verifyObject(objectId: string, ciphertextSha256: string): Promise<VerifyObjectResult> {
    const response = await this.fetchImpl(`${this.baseUrl}/objects/${encodeURIComponent(objectId)}/verify`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ ciphertextSha256 })
    });

    if (!response.ok) {
      throw new Error(`storage-agent verifyObject failed: ${response.status} ${await response.text()}`);
    }

    return (await response.json()) as VerifyObjectResult;
  }

  async getStatus(): Promise<NodeStatusReport> {
    const response = await this.fetchImpl(`${this.baseUrl}/status`, {
      headers: { authorization: `Bearer ${this.token}` }
    });

    if (!response.ok) {
      throw new Error(`storage-agent getStatus failed: ${response.status} ${await response.text()}`);
    }

    return (await response.json()) as NodeStatusReport;
  }

  async listObjects(options: { prefix?: string; olderThanSeconds?: number; limit?: number } = {}): Promise<Array<{ objectId: string; sizeBytes: number; ageSeconds: number }>> {
    const params = new URLSearchParams();
    if (options.prefix) params.set("prefix", options.prefix);
    if (options.olderThanSeconds != null) params.set("olderThanSeconds", String(options.olderThanSeconds));
    if (options.limit != null) params.set("limit", String(options.limit));
    const response = await this.fetchImpl(`${this.baseUrl}/objects?${params.toString()}`, {
      headers: { authorization: `Bearer ${this.token}` }
    });
    if (!response.ok) {
      throw new Error(`storage-agent listObjects failed: ${response.status} ${await response.text()}`);
    }
    const body = (await response.json()) as { objects: Array<{ objectId: string; sizeBytes: number; ageSeconds: number }> };
    return body.objects;
  }
}

export class S3StorageDriver implements StorageDriver {
  constructor() {
    throw new Error("S3StorageDriver is reserved for future Garage/S3 integration and is not enabled in v1.");
  }

  async putObject(): Promise<PutObjectResult> {
    throw new Error("S3StorageDriver is not implemented.");
  }

  async getObject(): Promise<Readable> {
    throw new Error("S3StorageDriver is not implemented.");
  }

  async deleteObject(): Promise<void> {
    throw new Error("S3StorageDriver is not implemented.");
  }

  async verifyObject(): Promise<VerifyObjectResult> {
    throw new Error("S3StorageDriver is not implemented.");
  }

  async getStatus(): Promise<NodeStatusReport> {
    throw new Error("S3StorageDriver is not implemented.");
  }
}
