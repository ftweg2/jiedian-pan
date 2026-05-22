import { apiBase, type FileItem, type StoragePolicy } from "../api.js";

export type FileCategory = "all" | "image" | "document" | "video" | "audio" | "important" | "temporary" | "other";
export type SortMode = "name" | "time" | "size";
export type FileViewMode = "list" | "grid";

export function getFileCategory(file: FileItem): Exclude<FileCategory, "all" | "important" | "temporary"> {
  const mime = file.mimeType.toLowerCase();
  const name = file.name.toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (
    mime.startsWith("text/") ||
    mime.includes("pdf") ||
    mime.includes("document") ||
    mime.includes("spreadsheet") ||
    mime.includes("presentation") ||
    /\.(md|doc|docx|xls|xlsx|ppt|pptx|pdf)$/.test(name)
  ) {
    return "document";
  }
  return "other";
}

export function fileMatchesCategory(file: FileItem, category: FileCategory): boolean {
  if (category === "all") return true;
  if (category === "important") return file.effectivePolicy === "important";
  if (category === "temporary") return file.effectivePolicy === "temporary";
  return getFileCategory(file) === category;
}

export function countCategory(files: FileItem[], category: FileCategory): number {
  return files.filter((file) => fileMatchesCategory(file, category)).length;
}

export function compareFiles(a: FileItem, b: FileItem, sortMode: SortMode): number {
  if (sortMode === "name") return a.name.localeCompare(b.name);
  if (sortMode === "size") return Number(b.sizeBytes) - Number(a.sizeBytes);
  return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
}

export function getFileTypeLabel(file: FileItem): string {
  return { image: "图片", document: "文档", video: "视频", audio: "音频", other: "文件" }[getFileCategory(file)];
}

export function requiredReplicaCount(policy: StoragePolicy): number {
  return policy === "important" ? 2 : 1;
}

export function isPdfPreview(file: FileItem): boolean {
  return file.mimeType.toLowerCase().includes("pdf") || file.name.toLowerCase().endsWith(".pdf");
}

export function isDocxPreview(file: FileItem): boolean {
  const mime = file.mimeType.toLowerCase();
  const name = file.name.toLowerCase();
  return name.endsWith(".docx") || mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
}

export function isTextPreview(file: FileItem): boolean {
  const mime = file.mimeType.toLowerCase();
  const name = file.name.toLowerCase();
  if (mime.includes("openxmlformats") || mime.includes("msword") || /\.(docx?|xlsx?|pptx?)$/.test(name)) return false;
  return (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/xml" ||
    mime.endsWith("+xml") ||
    /\.(md|txt|csv|log|json)$/.test(name)
  );
}

export function filePreviewUrl(file: FileItem): string {
  return `${apiBase}/files/${encodeURIComponent(file.id)}/preview`;
}
