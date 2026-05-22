import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { decryptBuffer, encryptBuffer, sha256 } from "./crypto.js";

test("encryptBuffer encrypts, decrypts, and records hashes", () => {
  const key = randomBytes(32);
  const plaintext = Buffer.from("important school document");
  const encrypted = encryptBuffer(plaintext, key);

  assert.notDeepEqual(encrypted.ciphertext, plaintext);
  assert.equal(encrypted.metadata.plaintextSha256, sha256(plaintext));
  assert.equal(encrypted.metadata.ciphertextSha256, sha256(encrypted.ciphertext));
  assert.deepEqual(decryptBuffer(encrypted.ciphertext, encrypted.metadata, key), plaintext);
});

test("decryptBuffer rejects a wrong master key", () => {
  const encrypted = encryptBuffer(Buffer.from("private"), randomBytes(32));
  assert.throws(() => decryptBuffer(encrypted.ciphertext, encrypted.metadata, randomBytes(32)));
});
