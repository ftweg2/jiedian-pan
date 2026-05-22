import { Download, Eye, Save, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { marked } from "marked";
import { api, apiBase } from "../api.js";

/**
 * In-browser editor for txt + md (Phase A) and docx (Phase B — for now docx
 * just shows a download-to-edit notice).
 *
 * For txt + md:
 *   - Full-screen dialog
 *   - Left pane: textarea
 *   - For .md: right pane shows live HTML preview (via `marked`)
 *   - Ctrl/Cmd+S saves; auto-save 3s after last keystroke
 *
 * Save flow: GET the existing content, then PUT /files/:id/content with
 * base64-encoded new content. Each save produces a new FileVersion server-side
 * so history works.
 */
export function TextFileEditor({
  fileId,
  fileName,
  mimeType,
  onClose,
  onSaved,
  toastError
}: {
  fileId: string;
  fileName: string;
  mimeType: string;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
  toastError: (m: string) => void;
}) {
  const isMd = mimeType === "text/markdown" || fileName.toLowerCase().endsWith(".md");
  const isText = mimeType.startsWith("text/") || isMd || fileName.toLowerCase().endsWith(".txt");
  const isDocx = mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    || fileName.toLowerCase().endsWith(".docx");

  const [content, setContent] = useState<string>("");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<"loading" | "saving" | null>("loading");
  const [dirty, setDirty] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const [previewVisible, setPreviewVisible] = useState(isMd);
  const dirtyRef = useRef(false);
  const contentRef = useRef("");

  // Initial load (text files only — docx download is handled differently).
  useEffect(() => {
    if (!isText) { setBusy(null); setLoaded(true); return; }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${apiBase}/files/${fileId}/download`, { credentials: "include" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        if (cancelled) return;
        setContent(text);
        contentRef.current = text;
        setLoaded(true);
      } catch (err) {
        if (!cancelled) toastError(err instanceof Error ? err.message : "加载文件失败");
      } finally {
        if (!cancelled) setBusy(null);
      }
    })();
    return () => { cancelled = true; };
  }, [fileId, isText, toastError]);

  // Auto-save 3s after last edit.
  useEffect(() => {
    if (!dirty || !isText) return;
    const t = setTimeout(() => { void save(); }, 3000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, content]);

  // Ctrl/Cmd+S to save.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        void save();
      }
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Warn before unload if there are unsaved changes.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current) { e.preventDefault(); e.returnValue = ""; }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  async function save() {
    if (!isText || busy === "saving") return;
    if (!dirtyRef.current) return;
    setBusy("saving");
    try {
      const bytes = new TextEncoder().encode(contentRef.current);
      const base64 = btoa(String.fromCharCode(...bytes));
      await api(`/files/${fileId}/content`, {
        method: "PUT",
        body: JSON.stringify({ contentBase64: base64 })
      });
      setDirty(false);
      dirtyRef.current = false;
      setLastSavedAt(new Date());
      await onSaved();
    } catch (err) {
      toastError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setBusy(null);
    }
  }

  const previewHtml = useMemo(() => {
    if (!isMd) return "";
    try {
      return marked.parse(content, { async: false }) as string;
    } catch {
      return "<p>预览渲染失败</p>";
    }
  }, [content, isMd]);

  return (
    <div className="text-editor-overlay" role="dialog">
      <div className="text-editor-window">
        <div className="text-editor-titlebar">
          <div className="row" style={{ gap: 10, minWidth: 0, flex: 1 }}>
            <strong style={{ fontSize: 14, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {fileName}
            </strong>
            <span className="muted" style={{ fontSize: 12 }}>
              {busy === "saving" ? "保存中…" : dirty ? "未保存" : lastSavedAt ? `已保存 ${lastSavedAt.toLocaleTimeString()}` : ""}
            </span>
          </div>
          <div className="row" style={{ gap: 6 }}>
            {isMd && (
              <button type="button" className={`btn btn-ghost btn-sm ${previewVisible ? "is-active" : ""}`} onClick={() => setPreviewVisible((v) => !v)}>
                <Eye size={12} /> 预览
              </button>
            )}
            {isText && (
              <button type="button" className="btn btn-primary btn-sm" onClick={save} disabled={busy === "saving" || !dirty}>
                <Save size={12} /> 保存
              </button>
            )}
            <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
              <X size={14} />
            </button>
          </div>
        </div>

        <div className="text-editor-body">
          {!loaded && <div className="muted" style={{ padding: 24 }}>加载中…</div>}

          {loaded && isText && (
            <div className={`text-editor-panes ${isMd && previewVisible ? "is-split" : ""}`}>
              <textarea
                className="text-editor-textarea"
                value={content}
                spellCheck={false}
                onChange={(e) => {
                  setContent(e.target.value);
                  contentRef.current = e.target.value;
                  setDirty(true);
                  dirtyRef.current = true;
                }}
                placeholder={isMd ? "# 标题\n\n用 Markdown 写笔记…" : "输入文本…"}
              />
              {isMd && previewVisible && (
                <div className="text-editor-preview" dangerouslySetInnerHTML={{ __html: previewHtml }} />
              )}
            </div>
          )}

          {loaded && isDocx && (
            <div className="stack-sm" style={{ padding: 32, textAlign: "center" }}>
              <p style={{ fontSize: 14 }}>
                Word 文档的在线编辑器(ONLYOFFICE)正在配置中。
              </p>
              <p className="muted" style={{ fontSize: 12 }}>
                目前可以下载到本地用 Word/WPS 编辑后,通过「上传」覆盖同名文件。
              </p>
              <div>
                <a
                  href={`${apiBase}/files/${fileId}/download`}
                  className="btn btn-primary"
                  style={{ display: "inline-flex", marginTop: 8 }}
                >
                  <Download size={14} /> 下载文件
                </a>
              </div>
            </div>
          )}

          {loaded && !isText && !isDocx && (
            <div className="muted" style={{ padding: 24 }}>该文件类型不支持在线编辑。</div>
          )}
        </div>
      </div>
    </div>
  );
}
