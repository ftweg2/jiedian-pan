import { Activity as ActivityIcon, AlertCircle, ChevronRight, HardDrive, Star } from "lucide-react";
import { useEffect, useState } from "react";
import { ApiError, api, type FileItem, type FileRiskList, type FolderItem, type NodeItem } from "../api.js";
import { PolicyBadge, ReplicaBadge, StatusBadge } from "../components/Badges.js";
import { EmptyState, TableState } from "../components/Empty.js";
import { FileTypeIcon } from "../components/FileIcon.js";
import { riskDisplayMessage } from "../lib/file-detail.js";
import { compactErrorMessage, formatDateTime, relativeTime } from "../lib/format.js";

export function ActivityPanel({
  files,
  folders,
  nodes,
  loading,
  canOpenNodes,
  onOpenFile,
  onOpenNodes
}: {
  files: FileItem[];
  folders: FolderItem[];
  nodes: NodeItem[];
  loading: boolean;
  canOpenNodes: boolean;
  onOpenFile: (file: FileItem) => void;
  onOpenNodes: () => void;
}) {
  const [backendRisks, setBackendRisks] = useState<FileRiskList["risks"]>([]);
  const [backendRisksError, setBackendRisksError] = useState<string | null>(null);

  const recent = [...files].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 8);
  const risky = files.filter((file) => file.effectivePolicy === "important" && file.status !== "deleted" && file.replicaCount < 2);
  const failed = files.filter((file) => file.status === "failed");
  const temporary = files.filter((file) => file.effectivePolicy === "temporary" && file.expiresAt);
  const active = files.filter((file) => file.status === "active");
  const offline = nodes.filter((node) => node.status === "offline");
  const degraded = nodes.filter((node) => node.status === "degraded");

  useEffect(() => {
    let cancelled = false;
    api<FileRiskList>("/files/risks")
      .then((response) => { if (!cancelled) setBackendRisks(response.risks); })
      .catch((err) => {
        if (cancelled) return;
        if (!(err instanceof ApiError && (err.status === 404 || err.status === 405))) {
          setBackendRisksError(`后端风险接口:${compactErrorMessage(err instanceof Error ? err.message : String(err))}`);
        }
      });
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="stack-lg">
      <div className="stack-sm">
        <h2 style={{ fontSize: 18, fontWeight: 600 }}>动态</h2>
        <p className="muted" style={{ fontSize: 13 }}>基于当前目录显示最近文件、临时文件和副本风险。</p>
      </div>

      <div className="stat-grid">
        <div className="stat-card"><span className="stat-label">可用文件</span><span className="stat-value">{active.length}</span></div>
        <div className="stat-card"><span className="stat-label">文件夹</span><span className="stat-value">{folders.length}</span></div>
        <div className="stat-card"><span className="stat-label">临时文件</span><span className="stat-value">{temporary.length}</span><span className="stat-hint">设有过期时间</span></div>
        <div className="stat-card">
          <span className="stat-label">副本风险</span>
          <span className="stat-value" style={{ color: risky.length > 0 ? "var(--warn)" : undefined }}>{risky.length}</span>
          <span className="stat-hint">{risky.length > 0 ? "重要文件副本不足" : "全部满足策略"}</span>
        </div>
      </div>

      {backendRisksError && <div className="alert alert-warn"><AlertCircle size={14} />{backendRisksError}</div>}

      {(risky.length > 0 || failed.length > 0 || offline.length > 0 || degraded.length > 0 || backendRisks.length > 0) && (
        <section className="stack-sm">
          <h3 className="section-title">需要关注</h3>
          <div className="stack-sm">
            {backendRisks.slice(0, 5).map((item) => (
              <div className="alert alert-warn" key={item.file.id}>
                <AlertCircle size={14} />
                <div className="stack-sm" style={{ flex: 1 }}>
                  <strong>{item.file.name}</strong>
                  <span>{item.risks.map((risk) => riskDisplayMessage(risk)).join(" · ")}</span>
                </div>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => onOpenFile(item.file)}>详情</button>
              </div>
            ))}
            {risky.length > 0 && (
              <div className="alert alert-warn">
                <Star size={14} />
                <div className="stack-sm" style={{ flex: 1 }}>
                  <strong>{risky.length} 个重要文件副本不足</strong>
                  <span>打开详情查看副本状态;如节点离线,先检查节点健康。</span>
                </div>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => onOpenFile(risky[0])}>查看</button>
              </div>
            )}
            {(offline.length > 0 || degraded.length > 0) && (
              <div className="alert alert-warn">
                <HardDrive size={14} />
                <div className="stack-sm" style={{ flex: 1 }}>
                  <strong>{offline.length + degraded.length} 个节点状态异常</strong>
                  <span>节点离线会导致重要文件无法达到双副本目标。</span>
                </div>
                {canOpenNodes && <button type="button" className="btn btn-ghost btn-sm" onClick={onOpenNodes}>查看节点</button>}
              </div>
            )}
            {failed.length > 0 && (
              <div className="alert alert-danger">
                <AlertCircle size={14} />
                <div className="stack-sm" style={{ flex: 1 }}>
                  <strong>{failed.length} 个文件上传或校验失败</strong>
                  <span>打开详情确认最新版本和副本状态,必要时重新上传。</span>
                </div>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => onOpenFile(failed[0])}>查看</button>
              </div>
            )}
          </div>
        </section>
      )}

      <section className="stack-sm">
        <h3 className="section-title"><ActivityIcon size={12} /> 最近文件</h3>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>文件</th><th>策略</th><th>状态</th><th>副本</th><th>创建时间</th><th className="col-actions"></th></tr></thead>
            <tbody>
              {loading && <TableState colSpan={6}><span className="spinner" /> 加载中...</TableState>}
              {!loading && recent.length === 0 && (
                <tr><td colSpan={6}><EmptyState icon={<ActivityIcon size={20} />} title="当前目录暂无文件" /></td></tr>
              )}
              {recent.map((file) => (
                <tr key={file.id}>
                  <td>
                    <div className="file-cell">
                      <span className="file-glyph"><FileTypeIcon file={file} size={16} /></span>
                      <div className="file-meta">
                        <span className="file-name">{file.name}</span>
                        <span className="file-sub">{relativeTime(file.createdAt)}</span>
                      </div>
                    </div>
                  </td>
                  <td><PolicyBadge policy={file.effectivePolicy} /></td>
                  <td><StatusBadge status={file.status} /></td>
                  <td><ReplicaBadge file={file} /></td>
                  <td className="muted" style={{ fontSize: 12 }}>{formatDateTime(file.createdAt)}</td>
                  <td className="col-actions">
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => onOpenFile(file)}>
                      详情 <ChevronRight size={12} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
