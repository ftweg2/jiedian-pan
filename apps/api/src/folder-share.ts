import archiver from "archiver";
import { FileStatus, type PrismaClient } from "@prisma/client";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { chunkedVersionHasPerChunkEncryption, readAuthenticatedEncryptedChunks } from "./replication.js";
import { decryptChunkBuffer, unwrapWrappedFileKey } from "./crypto.js";

/**
 * Returns true iff `targetFolderId` is `rootFolderId` itself or any descendant.
 */
export async function isFolderInShareTree(
  prisma: PrismaClient,
  targetFolderId: string,
  rootFolderId: string
): Promise<boolean> {
  if (targetFolderId === rootFolderId) return true;
  // Walk up from target to root by parentId. Cap depth at 64 to avoid loops.
  let cursor: string | null = targetFolderId;
  for (let depth = 0; depth < 64; depth += 1) {
    if (!cursor) return false;
    const node: { parentId: string | null } | null = await prisma.folder.findUnique({
      where: { id: cursor },
      select: { parentId: true }
    });
    if (!node) return false;
    if (node.parentId === rootFolderId) return true;
    cursor = node.parentId;
  }
  return false;
}

/**
 * Returns true iff a file's folderId is the share root or any descendant.
 * Files at the share root with folderId == rootFolderId qualify directly.
 */
export async function isFileInShareTree(
  prisma: PrismaClient,
  fileId: string,
  rootFolderId: string
): Promise<{ ok: boolean; folderId: string | null }> {
  const file = await prisma.file.findUnique({
    where: { id: fileId },
    select: { folderId: true, status: true }
  });
  if (!file || file.status !== FileStatus.ACTIVE) return { ok: false, folderId: null };
  if (!file.folderId) return { ok: false, folderId: null }; // root-of-account file never in any folder share
  if (file.folderId === rootFolderId) return { ok: true, folderId: file.folderId };
  return { ok: await isFolderInShareTree(prisma, file.folderId, rootFolderId), folderId: file.folderId };
}

export interface FolderShareChild {
  kind: "folder" | "file";
  id: string;
  name: string;
  // file-only
  sizeBytes?: string;
  mimeType?: string;
  effectivePolicy?: string;
  createdAt?: string;
  // folder-only
  childCount?: number;
}

export async function listShareFolderContents(
  prisma: PrismaClient,
  folderId: string
): Promise<{ folders: FolderShareChild[]; files: FolderShareChild[] }> {
  const [folders, files] = await Promise.all([
    prisma.folder.findMany({
      where: { parentId: folderId },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        _count: { select: { files: true, children: true } }
      }
    }),
    prisma.file.findMany({
      where: { folderId, status: FileStatus.ACTIVE },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        sizeBytes: true,
        mimeType: true,
        policyOverride: true,
        createdAt: true,
        folder: { select: { defaultPolicy: true } }
      }
    })
  ]);
  return {
    folders: folders.map((f) => ({
      kind: "folder" as const,
      id: f.id,
      name: f.name,
      childCount: f._count.files + f._count.children
    })),
    files: files.map((f) => ({
      kind: "file" as const,
      id: f.id,
      name: f.name,
      sizeBytes: f.sizeBytes.toString(),
      mimeType: f.mimeType,
      effectivePolicy: (f.policyOverride ?? f.folder?.defaultPolicy ?? "standard").toLowerCase(),
      createdAt: f.createdAt.toISOString()
    }))
  };
}

/**
 * Return the folder's name + crumbs from share root down to this folder.
 * `[ { id, name } ]` ordered root → current.
 */
export async function folderBreadcrumbsToRoot(
  prisma: PrismaClient,
  folderId: string,
  rootFolderId: string
): Promise<Array<{ id: string; name: string }>> {
  const chain: Array<{ id: string; name: string }> = [];
  let cursor: string | null = folderId;
  for (let depth = 0; depth < 64; depth += 1) {
    if (!cursor) break;
    const parent: { id: string; name: string; parentId: string | null } | null =
      await prisma.folder.findUnique({
        where: { id: cursor },
        select: { id: true, name: true, parentId: true }
      });
    if (!parent) break;
    chain.unshift({ id: parent.id, name: parent.name });
    if (parent.id === rootFolderId) break;
    cursor = parent.parentId;
  }
  return chain;
}

/**
 * Recursively walk the folder tree starting at rootFolderId, decrypting each
 * file and feeding it to the archiver. Returns the number of files written.
 *
 * The archiver is provided by caller (so caller can pipe to reply first, then
 * await this function, then call archive.finalize()).
 */
// Bound a folder-share ZIP so a single recipient can't request a multi-TB
// archive and tie up the API + a node forever. Configurable via env.
const MAX_FOLDER_ZIP_FILES = Math.max(1, Number(process.env.MAX_FOLDER_ZIP_FILES ?? 5000));
const MAX_FOLDER_ZIP_DEPTH = Math.max(1, Number(process.env.MAX_FOLDER_ZIP_DEPTH ?? 32));
const MAX_FOLDER_ZIP_BYTES = Math.max(
  1024 * 1024,
  Number(process.env.MAX_FOLDER_ZIP_BYTES ?? 10 * 1024 * 1024 * 1024) // 10 GiB default
);

export async function streamFolderAsZip(
  prisma: PrismaClient,
  archive: archiver.Archiver,
  masterKey: Buffer,
  rootFolderId: string,
  rootZipName: string
): Promise<number> {
  let totalFiles = 0;
  await walk(prisma, archive, masterKey, rootFolderId, rootZipName, (count) => {
    totalFiles = count;
  });
  return totalFiles;
}

async function walk(
  prisma: PrismaClient,
  archive: archiver.Archiver,
  masterKey: Buffer,
  folderId: string,
  prefix: string,
  setCount: (count: number) => void
): Promise<void> {
  let count = 0;
  let totalBytes = 0n;
  async function visit(currentFolderId: string, currentPrefix: string, depth: number): Promise<void> {
    if (depth > MAX_FOLDER_ZIP_DEPTH) {
      throw new Error(`folder share zip: depth limit ${MAX_FOLDER_ZIP_DEPTH} exceeded`);
    }
    const subfolders = await prisma.folder.findMany({
      where: { parentId: currentFolderId },
      orderBy: { name: "asc" },
      select: { id: true, name: true }
    });
    const files = await prisma.file.findMany({
      where: { folderId: currentFolderId, status: FileStatus.ACTIVE },
      orderBy: { name: "asc" },
      include: { versions: { orderBy: { createdAt: "desc" }, take: 1 } }
    });

    for (const file of files) {
      const version = file.versions[0];
      if (!version) continue;
      if (count >= MAX_FOLDER_ZIP_FILES) {
        throw new Error(`folder share zip: file count limit ${MAX_FOLDER_ZIP_FILES} exceeded`);
      }
      const fileSize = file.sizeBytes ?? 0n;
      if (totalBytes + fileSize > BigInt(MAX_FOLDER_ZIP_BYTES)) {
        throw new Error(`folder share zip: ${MAX_FOLDER_ZIP_BYTES} byte budget exceeded`);
      }
      totalBytes += fileSize;
      const zipPath = `${currentPrefix}/${file.name}`;
      // Empty folders are skipped naturally; archiver auto-creates intermediate
      // directory entries when files are added with slash-separated paths.
      const plaintextStream = await createPlaintextStream(prisma, version, masterKey);
      // Use STORE method (no compression) — files are encrypted so already
      // high-entropy; deflate adds CPU for ~0% savings.
      archive.append(plaintextStream, { name: zipPath, store: true });
      count += 1;
      setCount(count);
    }

    for (const sub of subfolders) {
      await visit(sub.id, `${currentPrefix}/${sub.name}`, depth + 1);
    }
  }
  await visit(folderId, prefix, 0);
  setCount(count);
}

async function createPlaintextStream(
  prisma: PrismaClient,
  version: {
    id: string;
    plaintextSha256: string;
    wrappedKey: string;
  },
  masterKey: Buffer
): Promise<Readable> {
  if (!(await chunkedVersionHasPerChunkEncryption(prisma, version.id))) {
    throw new Error(`folder zip: version ${version.id} is not per-chunk encrypted (legacy whole-file not supported)`);
  }

  const fileKey = unwrapWrappedFileKey(version.wrappedKey, masterKey);
  const plaintextHash = createHash("sha256");

  async function* generate() {
    for await (const chunk of readAuthenticatedEncryptedChunks(prisma, version.id)) {
      const plaintext = decryptChunkBuffer(chunk.ciphertext, chunk, fileKey);
      if (plaintext.byteLength !== chunk.plaintextSizeBytes) {
        throw new Error(`folder zip: chunk ${chunk.index} size mismatch after decrypt`);
      }
      plaintextHash.update(plaintext);
      yield plaintext;
    }
    if (sha256Hex(plaintextHash) !== version.plaintextSha256) {
      throw new Error(`folder zip: aggregate plaintext hash mismatch`);
    }
  }

  return Readable.from(generate());
}

function sha256Hex(hash: ReturnType<typeof createHash>): string {
  return hash.digest("hex");
}
