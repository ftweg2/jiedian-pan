import { AlertCircle, Download, Link2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy, type RenderTask } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
import { marked } from "marked";
import { apiBase, type FileItem } from "../api.js";
import { filePreviewUrl, getFileCategory, isDocxPreview, isPdfPreview, isTextPreview } from "../lib/category.js";
import { formatBytes } from "../lib/format.js";
import { FileTypeIcon } from "../components/FileIcon.js";

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export function PreviewDialog({
  file,
  onClose,
  onDownload,
  onShare
}: {
  file: FileItem;
  onClose: () => void;
  onDownload: () => void;
  onShare: () => void;
}) {
  const isImage = getFileCategory(file) === "image";
  const isPdf = isPdfPreview(file);
  const isDocx = isDocxPreview(file);
  const isText = isTextPreview(file);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  return (
    <div className="preview-overlay" role="dialog" aria-modal="true" aria-label={file.name}>
      <header className="preview-header">
        <div className="stack-sm" style={{ minWidth: 0, flex: 1 }}>
          <strong style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{file.name}</strong>
          <span>{formatBytes(Number(file.sizeBytes))} · {file.mimeType || "未知类型"}</span>
        </div>
        <button type="button" className="btn btn-sm" onClick={onShare} disabled={file.status !== "active"}>
          <Link2 size={13} /> 分享
        </button>
        <button type="button" className="btn btn-sm" onClick={onDownload} disabled={file.status !== "active"}>
          <Download size={13} /> 下载
        </button>
        <button type="button" className="icon-btn" onClick={onClose} title="关闭 (Esc)">
          <X size={16} />
        </button>
      </header>
      <div className="preview-body">
        {isImage ? (
          <img src={filePreviewUrl(file)} alt={file.name} />
        ) : isPdf ? (
          <PdfPreview file={file} />
        ) : isDocx ? (
          <iframe src={filePreviewUrl(file)} title={file.name} />
        ) : isText ? (
          <InlineTextPreview file={file} />
        ) : (
          <div className="preview-empty">
            <span className="file-glyph"><FileTypeIcon file={file} size={28} /></span>
            <strong>{file.name}</strong>
            <span>暂不支持此类型在线预览,可以下载后查看。</span>
            <button type="button" className="btn btn-secondary" onClick={onDownload}><Download size={13} />下载文件</button>
          </div>
        )}
      </div>
    </div>
  );
}

function PdfPreview({ file }: { file: FileItem }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState("正在加载 PDF...");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const renderTasks: RenderTask[] = [];
    const loadingTask = getDocument({ url: filePreviewUrl(file), withCredentials: true });

    async function render() {
      setStatus("正在加载 PDF...");
      setError(null);
      const pdf = await loadingTask.promise;
      if (cancelled) return;
      setStatus(`正在渲染 1/${pdf.numPages} 页...`);
      await renderPages(pdf);
      if (!cancelled) setStatus("");
    }

    async function renderPages(pdf: PDFDocumentProxy) {
      const container = containerRef.current;
      if (!container) return;
      container.replaceChildren();
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        if (cancelled) return;
        const page = await pdf.getPage(pageNumber);
        const viewport = page.getViewport({ scale: 1.3 });
        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d");
        if (!context) continue;
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        canvas.className = "pdf-page-canvas";
        const shell = document.createElement("div");
        shell.className = "pdf-page-shell";
        shell.append(canvas);
        container.append(shell);
        setStatus(`正在渲染 ${pageNumber}/${pdf.numPages} 页...`);
        const task = page.render({ canvas, canvasContext: context, viewport });
        renderTasks.push(task);
        await task.promise;
      }
    }

    render().catch((err) => {
      if (!cancelled) {
        setError((err as Error).message || "PDF 预览失败");
        setStatus("");
      }
    });

    return () => {
      cancelled = true;
      for (const task of renderTasks) task.cancel();
      loadingTask.destroy();
    };
  }, [file.id]);

  return (
    <div style={{ width: "min(1000px, 100%)" }}>
      {status && <div className="preview-loading"><span className="spinner" /> {status}</div>}
      {error && <div className="preview-loading"><AlertCircle size={14} /> {error}</div>}
      <div className="pdf-pages" ref={containerRef} />
    </div>
  );
}

/**
 * Inline preview for text files (txt / md / json / csv / log / xml).
 *
 * Why not just <iframe src=filePreviewUrl>? Browsers handle inline text/plain
 * inconsistently — Chrome sometimes refuses to render UTF-8 BOM-less content,
 * sometimes triggers a download because of `content-disposition: inline`.
 * The result was a totally blank iframe even though the API returned 200
 * with the right bytes (user-reported regression).
 *
 * Inline rendering avoids the iframe entirely:
 *   - .md → marked-parsed HTML (read-only)
 *   - .json → pretty-printed
 *   - others → <pre> with monospace
 */
function InlineTextPreview({ file }: { file: FileItem }) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const name = file.name.toLowerCase();
  const isMd = file.mimeType === "text/markdown" || name.endsWith(".md");
  const isJson = file.mimeType === "application/json" || name.endsWith(".json");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${apiBase}/files/${file.id}/preview`, { credentials: "include" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        if (!cancelled) setContent(text);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "加载失败");
      }
    })();
    return () => { cancelled = true; };
  }, [file.id]);

  const html = useMemo(() => {
    if (!content) return null;
    if (isMd) {
      try {
        const result = marked.parse(content, { async: false });
        if (typeof result === "string") return result;
      } catch { /* fall through to pre */ }
    }
    if (isJson) {
      try {
        const pretty = JSON.stringify(JSON.parse(content), null, 2);
        return `<pre>${escapeHtml(pretty)}</pre>`;
      } catch { /* fall through to pre */ }
    }
    return `<pre>${escapeHtml(content)}</pre>`;
  }, [content, isMd, isJson]);

  if (error) {
    return (
      <div className="preview-empty">
        <AlertCircle size={20} />
        <strong>{file.name}</strong>
        <span>预览失败: {error}</span>
      </div>
    );
  }
  if (html == null) {
    return <div className="preview-loading">加载中…</div>;
  }
  return (
    <div className="inline-text-preview" dangerouslySetInnerHTML={{ __html: html }} />
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
