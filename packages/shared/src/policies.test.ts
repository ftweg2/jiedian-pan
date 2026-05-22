import assert from "node:assert/strict";
import test from "node:test";
import {
  assertTemporaryExpiry,
  canAccessResource,
  isShareUsable,
  isTemporaryFileExpired,
  normalizePermission,
  normalizePolicy,
  permissionAllows,
  requiredReplicaCount,
  resolveStoragePolicy
} from "./index.js";

test("important files require two replicas", () => {
  assert.equal(requiredReplicaCount("standard"), 1);
  assert.equal(requiredReplicaCount("temporary"), 1);
  assert.equal(requiredReplicaCount("important"), 2);
});

test("file policy override wins over folder default", () => {
  assert.equal(resolveStoragePolicy("important", null), "important");
  assert.equal(resolveStoragePolicy("standard", "temporary"), "temporary");
});

test("temporary files must have a valid future expiration", () => {
  const now = new Date("2026-05-20T00:00:00.000Z");

  assert.doesNotThrow(() => assertTemporaryExpiry("standard", null, now));
  assert.doesNotThrow(() =>
    assertTemporaryExpiry("temporary", "2026-05-20T00:01:00.000Z", now)
  );
  assert.throws(() => assertTemporaryExpiry("temporary", null, now), /expiration time/);
  assert.throws(() => assertTemporaryExpiry("temporary", "not-a-date", now), /valid/);
  assert.throws(() =>
    assertTemporaryExpiry("temporary", "2026-05-20T00:00:00.000Z", now),
    /future/
  );
});

test("temporary file expiry only applies to temporary policy", () => {
  const now = new Date("2026-05-20T00:00:00.000Z");

  assert.equal(
    isTemporaryFileExpired(
      { policy: "temporary", expiresAt: "2026-05-19T23:59:00.000Z" },
      now
    ),
    true
  );
  assert.equal(
    isTemporaryFileExpired(
      { policy: "temporary", expiresAt: "2026-05-20T00:01:00.000Z" },
      now
    ),
    false
  );
  assert.equal(
    isTemporaryFileExpired({ policy: "important", expiresAt: "2026-05-19T23:59:00.000Z" }, now),
    false
  );
  assert.equal(isTemporaryFileExpired({ policy: "temporary", expiresAt: "bad-date" }, now), false);
});

test("owner, admin, and grants can access resources", () => {
  assert.equal(
    canAccessResource({ id: "u1", role: "member" }, { ownerId: "u1" }, [], "manage"),
    true
  );
  assert.equal(
    canAccessResource({ id: "u2", role: "admin" }, { ownerId: "u1" }, [], "manage"),
    true
  );
  assert.equal(
    canAccessResource(
      { id: "u2", role: "member" },
      { ownerId: "u1" },
      [{ userId: "u2", level: "write" }],
      "read"
    ),
    true
  );
  assert.equal(
    canAccessResource(
      { id: "u2", role: "member" },
      { ownerId: "u1" },
      [{ userId: "u2", level: "read" }],
      "manage"
    ),
    false
  );
});

test("permission ranking is monotonic", () => {
  assert.equal(permissionAllows("read", "read"), true);
  assert.equal(permissionAllows("read", "write"), false);
  assert.equal(permissionAllows("write", "read"), true);
  assert.equal(permissionAllows("write", "manage"), false);
  assert.equal(permissionAllows("manage", "read"), true);
  assert.equal(permissionAllows("manage", "write"), true);
  assert.equal(permissionAllows("manage", "manage"), true);
});

test("normalizers fall back on untrusted policy and permission values", () => {
  assert.equal(normalizePolicy("important", "standard"), "important");
  assert.equal(normalizePolicy("IMPORTANT", "standard"), "standard");
  assert.equal(normalizePolicy("../temporary", "important"), "important");

  assert.equal(normalizePermission("manage", "read"), "manage");
  assert.equal(normalizePermission("ADMIN", "read"), "read");
  assert.equal(normalizePermission(null, "write"), "write");
});

test("share usability respects status, expiry, and max downloads", () => {
  const now = new Date("2026-05-20T00:00:00.000Z");
  assert.equal(isShareUsable({ status: "active", downloadCount: 0 }, now), true);
  assert.equal(
    isShareUsable(
      { status: "active", expiresAt: "2026-05-20T00:01:00.000Z", downloadCount: 0 },
      now
    ),
    true
  );
  assert.equal(
    isShareUsable(
      { status: "active", expiresAt: "2026-05-20T00:00:00.000Z", downloadCount: 0 },
      now
    ),
    false
  );
  assert.equal(
    isShareUsable(
      { status: "active", expiresAt: "2026-05-19T23:59:00.000Z", downloadCount: 0 },
      now
    ),
    false
  );
  assert.equal(
    isShareUsable({ status: "active", maxDownloads: 2, downloadCount: 1 }, now),
    true
  );
  assert.equal(
    isShareUsable({ status: "active", maxDownloads: 2, downloadCount: 2 }, now),
    false
  );
  assert.equal(
    isShareUsable({ status: "active", maxDownloads: 0, downloadCount: 0 }, now),
    false
  );
  assert.equal(
    isShareUsable({ status: "active", expiresAt: "bad-date", downloadCount: 0 }, now),
    false
  );
  assert.equal(isShareUsable({ status: "revoked", downloadCount: 0 }, now), false);
});
