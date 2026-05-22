import assert from "node:assert/strict";
import test from "node:test";
import { createPasswordHash, verifyPassword } from "./auth.js";

test("password hashes verify only the original password", async () => {
  const hash = await createPasswordHash("correct horse battery staple");

  assert.equal(await verifyPassword(hash, "correct horse battery staple"), true);
  assert.equal(await verifyPassword(hash, "wrong password"), false);
});

test("malformed password hashes fail closed", async () => {
  assert.equal(await verifyPassword("not-an-argon2-hash", "password"), false);
});
