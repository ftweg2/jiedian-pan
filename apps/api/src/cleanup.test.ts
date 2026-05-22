import assert from "node:assert/strict";
import test from "node:test";
import { FileStatus, ShareStatus, StoragePolicy } from "@prisma/client";
import { runMaintenance } from "./cleanup.js";

test("runMaintenance expires stale shares and deletes expired files", async () => {
  const updatedFiles: Array<{ id: string; data: unknown }> = [];
  const fileFindManyCalls: unknown[] = [];

  const prisma = {
    shareLink: {
      updateMany: async (input: unknown) => {
        assert.deepEqual((input as { where: { status: ShareStatus } }).where.status, ShareStatus.ACTIVE);
        assert.deepEqual((input as { data: { status: ShareStatus } }).data.status, ShareStatus.EXPIRED);
        return { count: 1 };
      }
    },
    file: {
      findMany: async (input: unknown) => {
        fileFindManyCalls.push(input);
        if (fileFindManyCalls.length === 1) {
          assert.deepEqual(
            (input as { where: { status: FileStatus; expiresAt: unknown } }).where.status,
            FileStatus.ACTIVE
          );
          assert.ok((input as { where: { expiresAt: unknown } }).where.expiresAt);
          assert.deepEqual(
            (input as { where: { OR: unknown } }).where.OR,
            [
              { policyOverride: StoragePolicy.TEMPORARY },
              { policyOverride: null, folder: { defaultPolicy: StoragePolicy.TEMPORARY } }
            ]
          );
          return [{ id: "expired-temp-file" }];
        }
        return [];
      },
      update: async ({ where, data }: { where: { id: string }; data: { status: FileStatus } }) => {
        updatedFiles.push({ id: where.id, data });
        return { id: where.id, ...data };
      }
    },
    fileVersion: {
      findMany: async ({ where }: { where: { fileId: string } }) => {
        assert.equal(where.fileId, "expired-temp-file");
        return [];
      }
    },
    storageNode: {
      findMany: async () => [],
      update: async () => {
        throw new Error("storage nodes should not be updated when none exist");
      }
    }
  };

  await runMaintenance(prisma as never);

  assert.deepEqual(updatedFiles, [
    { id: "expired-temp-file", data: { status: FileStatus.DELETED } }
  ]);
  assert.equal(fileFindManyCalls.length, 2);
});
