import { File as FileIconBase, FileText, Folder, Music, Video } from "lucide-react";
import type { FileItem } from "../api.js";
import { filePreviewUrl, getFileCategory } from "../lib/category.js";
import type { BrowserItem } from "../lib/types.js";

export function FileGlyph({ item, size = 18 }: { item: BrowserItem; size?: number }) {
  if (item.kind === "folder") return <Folder size={size} />;
  return <FileTypeIcon file={item.file} size={size} />;
}

export function FileTypeIcon({ file, size = 18 }: { file: FileItem; size?: number }) {
  const type = getFileCategory(file);
  if (type === "image") return <img src={filePreviewUrl(file)} alt="" loading="lazy" />;
  if (type === "document") return <FileText size={size} />;
  if (type === "video") return <Video size={size} />;
  if (type === "audio") return <Music size={size} />;
  return <FileIconBase size={size} />;
}
