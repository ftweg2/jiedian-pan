import { FilePlus, FileText, ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, type FileItem } from "../api.js";

/**
 * "新建文件" button + dropdown. Picks one of three formats and creates
 * an empty file (with a minimal valid template for docx). On success
 * calls onCreated with the new FileItem so the parent can open the editor.
 */
export function NewFileMenu({
  folderId,
  onCreated,
  toastError
}: {
  folderId: string | null;
  onCreated: (file: FileItem) => void | Promise<void>;
  toastError: (m: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click / escape.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function create(kind: "txt" | "md") {
    const presets = {
      txt: { name: defaultName("新文档", "txt"), mimeType: "text/plain" },
      md: { name: defaultName("新笔记", "md"), mimeType: "text/markdown" }
    } as const;
    const { name, mimeType } = presets[kind];
    setBusy(kind);
    setOpen(false);
    try {
      const res = await api<{ file: FileItem }>("/files/new", {
        method: "POST",
        body: JSON.stringify({ name, mimeType, folderId })
      });
      await onCreated(res.file);
    } catch (err) {
      toastError(err instanceof Error ? err.message : "新建文件失败");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        className="btn btn-secondary"
        onClick={() => setOpen((v) => !v)}
        disabled={busy != null}
      >
        <FilePlus size={14} /> 新建文件 <ChevronDown size={12} />
      </button>
      {open && (
        <div role="menu" className="new-file-menu">
          <MenuItem icon={<FileText size={14} />} label="文本文件 (.txt)" hint="纯文本笔记" onClick={() => create("txt")} />
          <MenuItem icon={<FileText size={14} />} label="Markdown (.md)" hint="带格式 + 实时预览" onClick={() => create("md")} />
        </div>
      )}
    </div>
  );
}

function MenuItem({ icon, label, hint, onClick }: { icon: React.ReactNode; label: string; hint?: string; onClick: () => void }) {
  return (
    <button type="button" role="menuitem" className="new-file-menu-item" onClick={onClick}>
      <span className="new-file-menu-icon">{icon}</span>
      <span style={{ flex: 1 }}>
        <div>{label}</div>
        {hint && <div className="muted" style={{ fontSize: 11 }}>{hint}</div>}
      </span>
    </button>
  );
}

function defaultName(base: string, ext: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
  return `${base}-${stamp}.${ext}`;
}
