import assert from "node:assert/strict";
import test from "node:test";
import { canAccessFile, canAccessFolder, collectFolderGrants } from "./permissions.js";

type MockFolder = { id: string; parentId: string | null; ownerId: string };
type MockPermission = {
  userId: string;
  level: "READ" | "WRITE" | "MANAGE";
  folderId?: string | null;
  fileId?: string | null;
};

function mockUser(id: string, role: "admin" | "member" = "member") {
  return {
    id,
    email: `${id}@example.com`,
    name: id,
    role
  };
}

function createPermissionPrisma(folders: MockFolder[], permissions: MockPermission[]) {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));

  return {
    folder: {
      findUnique: async ({ where }: { where: { id: string } }) => byId.get(where.id) ?? null
    },
    permission: {
      findMany: async ({ where }: { where: { folderId?: { in: string[] }; fileId?: string } }) => {
        if (where.fileId) {
          return permissions.filter((permission) => permission.fileId === where.fileId);
        }

        const folderIds = where.folderId?.in ?? [];
        return permissions.filter(
          (permission) => permission.folderId && folderIds.includes(permission.folderId)
        );
      }
    }
  };
}

test("collectFolderGrants inherits permissions from ancestor folders", async () => {
  const prisma = createPermissionPrisma(
    [
      { id: "root", parentId: null, ownerId: "owner" },
      { id: "child", parentId: "root", ownerId: "owner" }
    ],
    [
      { userId: "reader", level: "READ", folderId: "root" },
      { userId: "writer", level: "WRITE", folderId: "child" }
    ]
  );

  const grants = await collectFolderGrants(prisma as never, "child");

  assert.deepEqual(
    grants.sort((left, right) => left.userId.localeCompare(right.userId)),
    [
      { userId: "reader", level: "read" },
      { userId: "writer", level: "write" }
    ]
  );
});

test("file access combines direct grants with inherited folder grants", async () => {
  const prisma = createPermissionPrisma(
    [
      { id: "root", parentId: null, ownerId: "owner" },
      { id: "child", parentId: "root", ownerId: "owner" }
    ],
    [
      { userId: "collaborator", level: "READ", fileId: "file-1" },
      { userId: "collaborator", level: "WRITE", folderId: "root" }
    ]
  );
  const file = {
    id: "file-1",
    ownerId: "owner",
    folderId: "child",
    folder: { id: "child", parentId: "root", ownerId: "owner" }
  };

  assert.equal(
    await canAccessFile(prisma as never, mockUser("collaborator"), file as never, "write"),
    true
  );
  assert.equal(
    await canAccessFile(prisma as never, mockUser("collaborator"), file as never, "manage"),
    false
  );
  assert.equal(
    await canAccessFile(prisma as never, mockUser("stranger"), file as never, "read"),
    false
  );
});

test("folder owners and admins can manage without explicit grants", async () => {
  const prisma = createPermissionPrisma([{ id: "root", parentId: null, ownerId: "owner" }], []);
  const folder = { id: "root", parentId: null, ownerId: "owner" };

  assert.equal(
    await canAccessFolder(prisma as never, mockUser("owner"), folder as never, "manage"),
    true
  );
  assert.equal(
    await canAccessFolder(prisma as never, mockUser("admin", "admin"), folder as never, "manage"),
    true
  );
});
