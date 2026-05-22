import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ObjectStore } from "./object-store.js";

test("ObjectStore writes, verifies, streams, and deletes ciphertext objects", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wangpan-agent-test-"));
  const store = new ObjectStore(dir, "test-node");
  const body = Buffer.from("ciphertext");
  const hash = createHash("sha256").update(body).digest("hex");

  try {
    const result = await store.put("object-123456", body, hash);
    assert.equal(result.ciphertextSha256, hash);

    const verify = await store.verify("object-123456", hash);
    assert.equal(verify.exists, true);
    assert.equal(verify.matches, true);

    const chunks: Buffer[] = [];
    for await (const chunk of store.stream("object-123456")) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    assert.deepEqual(Buffer.concat(chunks), body);

    await store.delete("object-123456");
    const missing = await store.verify("object-123456", hash);
    assert.equal(missing.exists, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ObjectStore refuses to overwrite an existing object with different content", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wangpan-agent-test-"));
  const store = new ObjectStore(dir, "test-node");
  const body = Buffer.from("ciphertext");
  const hash = createHash("sha256").update(body).digest("hex");
  const otherBody = Buffer.from("different ciphertext");
  const otherHash = createHash("sha256").update(otherBody).digest("hex");

  try {
    await store.put("object-123456", body, hash, body.byteLength);
    await assert.rejects(
      () => store.put("object-123456", otherBody, otherHash, otherBody.byteLength),
      /different content/
    );

    const chunks: Buffer[] = [];
    for await (const chunk of store.stream("object-123456")) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    assert.deepEqual(Buffer.concat(chunks), body);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ObjectStore rejects object ids that could escape the data directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wangpan-agent-test-"));
  const store = new ObjectStore(dir, "test-node");
  const body = Buffer.from("ciphertext");
  const hash = createHash("sha256").update(body).digest("hex");

  try {
    await assert.rejects(() => store.put("........", body, hash), /invalid object id/);
    await assert.rejects(() => store.put(".hidden-object", body, hash), /invalid object id/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ObjectStore rejects unsafe object ids before touching the filesystem", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wangpan-agent-test-"));
  const store = new ObjectStore(dir, "test-node");

  try {
    assert.throws(() => store.objectPath("../secret-object"), /invalid object id/);
    await assert.rejects(
      () => store.put("short", Buffer.from("ciphertext"), "not-used"),
      /invalid object id/
    );
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ObjectStore refuses ciphertext with a mismatched hash", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wangpan-agent-test-"));
  const store = new ObjectStore(dir, "test-node");
  const body = Buffer.from("ciphertext");
  const wrongHash = createHash("sha256").update("different").digest("hex");

  try {
    await assert.rejects(() => store.put("object-abcdef", body, wrongHash), /ciphertext hash mismatch/);
    const verify = await store.verify("object-abcdef", wrongHash);
    assert.equal(verify.exists, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
