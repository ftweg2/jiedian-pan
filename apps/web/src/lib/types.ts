import type { FileItem, FolderItem } from "../api.js";

export type View = "files" | "trash" | "activity" | "nodes" | "users" | "logs";

export type BrowserItem =
  | { kind: "folder"; id: string; folder: FolderItem }
  | { kind: "file"; id: string; file: FileItem };

export function itemKey(item: BrowserItem): string {
  return `${item.kind}:${item.id}`;
}

export function itemName(item: BrowserItem): string {
  return item.kind === "folder" ? item.folder.name : item.file.name;
}

export type ToastTone = "success" | "error" | "info";
export interface Toast {
  id: string;
  message: string;
  tone: ToastTone;
}
