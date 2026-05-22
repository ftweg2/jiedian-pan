import { AlertCircle, CheckCircle2, FilePlus2, RefreshCw, Settings2, UploadCloud, X } from "lucide-react";
import { useRef, useState, type DragEvent, type FormEvent } from "react";
import { type StoragePolicy } from "../api.js";
import { Dialog } from "../components/Dialog.js";
import { formatBytes, policyLabel } from "../lib/format.js";
import {
  CHUNK_SIZE_PRESETS,
  CONCURRENCY_PRESETS
} from "../lib/chunked-upload.js";
import { isInFlight, type UploadController, type UploadItem, type UploadStatus } from "../lib/useUploadController.js";

export function UploadDialog({ controller }: { controller: UploadController }) {
  if (!controller.isOpen) return null;
  return <UploadDialogBody controller={controller} />;
}

function UploadDialogBody({ controller }: { controller: UploadController }) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [expiresAtLocal, setExpiresAtLocal] = useState(() => isoToLocal(controller.expiresAtIso));
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const folderPolicy = controller.activeFolderPolicy;
  const effectivePolicy: StoragePolicy = (controller.policyOverride || folderPolicy) as StoragePolicy;
  const needsExpiry = effectivePolicy === "temporary" && !controller.expiresAtIso;
  const queue = controller.queue;
  const waiting = queue.filter((i) => i.status === "waiting").length;
  const failed = queue.filter((i) => i.status === "failed").length;
  const cancelled = queue.filter((i) => i.status === "cancelled").length;
  const success = queue.filter((i) => i.status === "success").length;
  const uploadable = waiting + failed + cancelled;
  const busy = controller.busy;

  function handleExpiresChange(value: string) {
    setExpiresAtLocal(value);
    controller.setExpiresAtIso(value ? new Date(value).toISOString() : null);
  }

  function handleDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setDragging(false);
    if (event.dataTransfer.files) controller.addFiles(event.dataTransfer.files);
  }

  function handleDragOver(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setDragging(true);
  }

  function submitForm(event: FormEvent) {
    event.preventDefault();
    if (needsExpiry) return;
    void controller.startUploads();
  }

  return (
    <Dialog
      title="上传文件"
      icon={<UploadCloud size={16} style={{ color: "var(--brand)", marginRight: 8 }} />}
      size="lg"
      onClose={busy ? () => undefined : controller.closeDialog}
      footer={
        <>
          <div style={{ marginRight: "auto", fontSize: 12 }} className="muted">
            {queue.length > 0 && `队列 ${queue.length} 项 · ${success} 完成 · ${failed} 失败`}
            {queue.length === 0 && <span>关闭对话框后,正在上传的文件会在后台继续</span>}
          </div>
          {success > 0 && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={controller.clearSuccessful} disabled={busy}>
              清空已完成
            </button>
          )}
          <button type="button" className="btn btn-ghost" onClick={controller.closeDialog} disabled={busy}>关闭</button>
          <button
            type="submit"
            form="upload-form"
            className="btn btn-primary"
            disabled={uploadable === 0 || busy || needsExpiry}
          >
            {busy && <span className="spinner" />}
            <FilePlus2 size={14} />
            {busy ? "上传中" : uploadable > 0 ? `上传 ${uploadable} 项` : "上传"}
          </button>
        </>
      }
    >
      <form id="upload-form" className="stack" onSubmit={submitForm}>
        <label
          className={`upload-drop ${dragging ? "is-active" : ""}`}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={() => setDragging(false)}
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            style={{ display: "none" }}
            onChange={(event) => {
              controller.addFiles(event.target.files ?? []);
              if (event.target) event.target.value = "";
            }}
          />
          <div className="stack-sm" style={{ pointerEvents: "none" }}>
            <UploadCloud size={28} style={{ margin: "0 auto", color: "var(--brand)" }} />
            <strong>{dragging ? "松开以加入队列" : "点击选择文件,或拖到此处"}</strong>
            <span className="muted">分片上传 · 并发 {controller.concurrency} · 单片 {formatBytes(controller.chunkSize)} · 切面板时上传不中断</span>
          </div>
        </label>

        <div className="split-grid">
          <div className="field">
            <label className="field-label">存储策略</label>
            <select
              className="select"
              value={controller.policyOverride}
              onChange={(event) => controller.setPolicyOverride(event.target.value as StoragePolicy | "")}
            >
              <option value="">继承目录 ({policyLabel(folderPolicy)})</option>
              <option value="standard">普通</option>
              <option value="important">重要 (双副本)</option>
              <option value="temporary">临时</option>
            </select>
          </div>
          <div className="field">
            <label className="field-label">
              过期时间 {effectivePolicy === "temporary" && <span style={{ color: "var(--danger)" }}>*</span>}
            </label>
            <input
              type="datetime-local"
              className="input"
              value={expiresAtLocal}
              onChange={(event) => handleExpiresChange(event.target.value)}
              disabled={effectivePolicy !== "temporary"}
            />
            <p className={`field-hint ${needsExpiry ? "warn" : ""}`}>
              {effectivePolicy === "temporary" ? "临时文件必须设置过期时间。" :
                effectivePolicy === "important" ? "重要文件按双副本目标维护。" : "普通文件按单副本保存。"}
            </p>
          </div>
        </div>

        <div>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setSettingsOpen((s) => !s)}
            aria-expanded={settingsOpen}
          >
            <Settings2 size={12} /> 上传性能{settingsOpen ? "" : "..."}
          </button>
          {settingsOpen && (
            <div className="split-grid" style={{ marginTop: 8 }}>
              <div className="field">
                <label className="field-label">单片大小</label>
                <select
                  className="select"
                  value={controller.chunkSize}
                  onChange={(event) => controller.setChunkSize(Number(event.target.value))}
                  disabled={busy}
                >
                  {CHUNK_SIZE_PRESETS.map((preset) => (
                    <option key={preset.value} value={preset.value}>{preset.label}</option>
                  ))}
                </select>
                <p className="field-hint">越大网络利用率越高,但失败重传成本也越高。8 MB 通常最稳。</p>
              </div>
              <div className="field">
                <label className="field-label">并发数</label>
                <select
                  className="select"
                  value={controller.concurrency}
                  onChange={(event) => controller.setConcurrency(Number(event.target.value))}
                  disabled={busy}
                >
                  {CONCURRENCY_PRESETS.map((value) => (
                    <option key={value} value={value}>{value} 个并发</option>
                  ))}
                </select>
                <p className="field-hint">浏览器同时上传的分片数。带宽充裕时 4-6 个较快。</p>
              </div>
            </div>
          )}
        </div>

        {queue.length > 0 && (
          <div className="upload-queue">
            {queue.map((item) => (
              <UploadRow key={item.id} item={item} busy={busy} needsExpiry={needsExpiry} controller={controller} />
            ))}
          </div>
        )}
      </form>
    </Dialog>
  );
}

function UploadRow({
  item,
  busy,
  needsExpiry,
  controller
}: {
  item: UploadItem;
  busy: boolean;
  needsExpiry: boolean;
  controller: UploadController;
}) {
  const percent = item.file.size > 0
    ? Math.min(100, Math.max(0, Math.round((item.uploadedBytes / item.file.size) * 100)))
    : item.status === "success" ? 100 : 0;
  return (
    <div className={`upload-item ${queueClass(item.status)}`}>
      <span className="file-glyph" style={{ width: 28, height: 28 }}>
        {item.status === "success" ? <CheckCircle2 size={16} color="var(--good)" /> :
          item.status === "failed" ? <AlertCircle size={16} color="var(--danger)" /> :
          isInFlight(item.status) ? <span className="spinner" /> :
          <FilePlus2 size={16} />}
      </span>
      <div className="upload-meta">
        <span className="upload-name">{item.file.name}</span>
        <span className="upload-sub">{item.error ?? subLine(item, percent)}</span>
        <div className="upload-bar"><span style={{ width: `${percent}%` }} /></div>
      </div>
      {(item.status === "failed" || item.status === "cancelled") && (
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => controller.retryItem(item.id)} disabled={busy || needsExpiry}>
          <RefreshCw size={12} /> 重试
        </button>
      )}
      <button type="button" className="icon-btn" onClick={() => controller.cancelItem(item.id)} title="移除/取消">
        <X size={14} />
      </button>
    </div>
  );
}

function queueClass(status: UploadStatus): string {
  if (status === "success") return "is-success";
  if (status === "failed") return "is-failed";
  if (status === "cancelled") return "is-failed";
  if (isInFlight(status)) return "is-progress";
  return "";
}

function subLine(item: UploadItem, percent: number): string {
  if (item.status === "success") return `${formatBytes(item.file.size)} · 完成`;
  if (item.status === "cancelled") return "已取消";
  if (item.status === "completing") return "服务端校验中...";
  if (item.status === "uploading") {
    const chunkLabel = item.totalChunks > 0
      ? ` · ${item.completedChunks}/${item.totalChunks} 分片${item.inFlight > 0 ? ` (${item.inFlight} 进行中)` : ""}`
      : "";
    return `${formatBytes(item.uploadedBytes)} / ${formatBytes(item.file.size)} (${percent}%)${chunkLabel}`;
  }
  return `${formatBytes(item.file.size)} · 等待上传`;
}

function isoToLocal(iso: string | null): string {
  if (!iso) return "";
  try {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    const offset = date.getTimezoneOffset() * 60_000;
    return new Date(date.getTime() - offset).toISOString().slice(0, 16);
  } catch {
    return "";
  }
}
