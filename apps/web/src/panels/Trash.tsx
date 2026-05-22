import { AlertCircle, Info, RefreshCw, Trash2, Undo2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

type TrashSortMode = "time-desc" | "time-asc" | "name-asc" | "size-desc" | "size-asc";
import { ApiError, api, type FileItem, type TrashList } from "../api.js";
import { PolicyBadge, StatusBadge } from "../components/Badges.js";
import { EmptyState, TableState } from "../components/Empty.js";
import { FileTypeIcon } from "../components/FileIcon.js";
import { ConfirmDialog } from "../dialogs/Confirm.js";
import { stage8ErrorMessage } from "../lib/errors.js";
import { formatBytes, formatDateTime } from "../lib/format.js";

export function TrashPanel({
  toastSuccess,
  toastError,
  onOpenFile
}: {
  toastSuccess: (message: string) => void;
  toastError: (message: string) => void;
  onOpenFile: (file: FileItem) => void;
}) {
  const [files, setFiles] = useState<FileItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [backendAvailable, setBackendAvailable] = useState(true);
  const [purgeTarget, setPurgeTarget] = useState<FileItem | null>(null);
  const [sortMode, setSortMode] = useState<TrashSortMode>("time-desc");

  const sortedFiles = useMemo(() => {
    const arr = [...files];
    switch (sortMode) {
      case "time-asc": return arr.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      case "name-asc": return arr.sort((a, b) => a.name.localeCompare(b.name));
      case "size-desc": return arr.sort((a, b) => Number(b.sizeBytes) - Number(a.sizeBytes));
      case "size-asc": return arr.sort((a, b) => Number(a.sizeBytes) - Number(b.sizeBytes));
      case "time-desc":
      default: return arr.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    }
  }, [files, sortMode]);

  async function loadTrash() {
    setLoading(true);
    try {
      const response = await api<TrashList>("/files/trash");
      setFiles(response.files ?? response.items ?? []);
      setBackendAvailable(true);
    } catch (err) {
      setFiles([]);
      setBackendAvailable(false);
      if (!(err instanceof ApiError && (err.status === 404 || err.status === 405))) {
        toastError(stage8ErrorMessage(err, "读取回收站"));
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void loadTrash(); /* eslint-disable-next-line */ }, []);

  async function restore(file: FileItem) {
    setBusyId(file.id);
    try {
      await api(`/files/${file.id}/restore`, { method: "POST", body: "{}" });
      await loadTrash();
      toastSuccess(`${file.name} 已恢复`);
    } catch (err) {
      toastError(stage8ErrorMessage(err, "恢复文件"));
    } finally {
      setBusyId(null);
    }
  }

  async function purge() {
    if (!purgeTarget) return;
    const file = purgeTarget;
    setBusyId(file.id);
    try {
      await api(`/files/${file.id}/purge`, { method: "POST", body: "{}" });
      await loadTrash();
      setPurgeTarget(null);
      toastSuccess(`${file.name} 已永久删除`);
    } catch (err) {
      toastError(stage8ErrorMessage(err, "永久删除"));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="stack">
      <div className="row-between">
        <div className="stack-sm">
          <h2 style={{ fontSize: 18, fontWeight: 600 }}>回收站</h2>
          <p className="muted" style={{ fontSize: 13 }}>移入回收站的文件可以恢复;永久删除不可撤销。</p>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <select
            className="select"
            style={{ height: 32, width: "auto" }}
            value={sortMode}
            onChange={(event) => setSortMode(event.target.value as TrashSortMode)}
            aria-label="排序"
          >
            <option value="time-desc">删除时间(新→旧)</option>
            <option value="time-asc">删除时间(旧→新)</option>
            <option value="name-asc">名称(A→Z)</option>
            <option value="size-desc">大小(大→小)</option>
            <option value="size-asc">大小(小→大)</option>
          </select>
          <button type="button" className="btn btn-ghost" onClick={() => loadTrash()} disabled={loading}>
            <RefreshCw size={13} className={loading ? "spin" : ""} /> 刷新
          </button>
        </div>
      </div>

      {!backendAvailable && (
        <div className="alert alert-warn">
          <AlertCircle size={14} />
          <div>
            <strong>回收站接口暂不可用</strong>
            <span>后端尚未启用此接口,无法读取或操作。</span>
          </div>
        </div>
      )}

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>文件</th>
              <th>策略</th>
              <th>大小</th>
              <th>状态</th>
              <th>创建时间</th>
              <th className="col-actions"></th>
            </tr>
          </thead>
          <tbody>
            {loading && <TableState colSpan={6}><span className="spinner" /> 加载中...</TableState>}
            {!loading && backendAvailable && files.length === 0 && (
              <tr><td colSpan={6}><EmptyState icon={<Trash2 size={20} />} title="回收站为空" hint="移入回收站的文件会暂存在这里" /></td></tr>
            )}
            {sortedFiles.map((file) => (
              <tr key={file.id}>
                <td>
                  <div className="file-cell">
                    <span className="file-glyph"><FileTypeIcon file={file} size={16} /></span>
                    <div className="file-meta">
                      <span className="file-name">{file.name}</span>
                      <span className="file-sub">{file.mimeType || "文件"}</span>
                    </div>
                  </div>
                </td>
                <td><PolicyBadge policy={file.effectivePolicy} /></td>
                <td className="muted" style={{ fontSize: 12, fontVariantNumeric: "tabular-nums" }}>{formatBytes(Number(file.sizeBytes))}</td>
                <td><StatusBadge status={file.status} /></td>
                <td className="muted" style={{ fontSize: 12 }}>{formatDateTime(file.createdAt)}</td>
                <td className="col-actions">
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => onOpenFile(file)} title="详情">
                    <Info size={12} /> 详情
                  </button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => restore(file)} disabled={busyId === file.id}>
                    <Undo2 size={12} /> 恢复
                  </button>
                  <button type="button" className="btn btn-danger-ghost btn-sm" onClick={() => setPurgeTarget(file)} disabled={busyId === file.id}>
                    <Trash2 size={12} /> 永久删除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {purgeTarget && (
        <ConfirmDialog
          title="永久删除"
          message={`确定永久删除「${purgeTarget.name}」吗?所有版本和副本都将被清理,此操作不可恢复。`}
          confirmLabel="永久删除"
          danger
          busy={busyId === purgeTarget.id}
          onCancel={() => setPurgeTarget(null)}
          onConfirm={purge}
        />
      )}

    </div>
  );
}
