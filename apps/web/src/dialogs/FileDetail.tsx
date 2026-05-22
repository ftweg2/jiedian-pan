import { AlertCircle, Download, Eye, Link2, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api, download, type FileDetail, type FileItem, type FileVersionDetail, type ShareList } from "../api.js";
import { FileTypeIcon } from "../components/FileIcon.js";
import { PolicyBadge, ReplicaBadge, ReplicaStatusBadge, StatusBadge } from "../components/Badges.js";
import { fileDetailErrorMessage, stage8ErrorMessage } from "../lib/errors.js";
import {
  fallbackFileDetail,
  fetchFileDetail,
  inferFileRisks,
  storageLayoutFromFile,
  storageLayoutLabel,
  summarizeShareLinks,
  versionDownloadName,
  versionSizeLabel
} from "../lib/file-detail.js";
import { formatBytes, formatDateTime, policyLabel } from "../lib/format.js";

type Tab = "overview" | "versions" | "storage" | "shares" | "access";

export function FileDetailDrawer({
  file,
  onClose,
  onPreview,
  onDownload,
  onShare,
  onDelete,
  busyAction
}: {
  file: FileItem;
  onClose: () => void;
  onPreview: () => void;
  onDownload: () => void;
  onShare: () => void;
  onDelete: () => void;
  busyAction: string | null;
}) {
  const [detail, setDetail] = useState<FileDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [versionAction, setVersionAction] = useState<string | null>(null);
  const [versionError, setVersionError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDetailLoading(true);
    setDetailError(null);
    setTab("overview");
    (async () => {
      try {
        const loaded = await fetchFileDetail(file);
        if (!cancelled) setDetail(loaded);
      } catch (err) {
        if (!cancelled) {
          setDetail(fallbackFileDetail(file));
          setDetailError(fileDetailErrorMessage(err));
        }
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [file]);

  // share summary fallback if detail doesn't include
  const [shareSummary, setShareSummary] = useState<ReturnType<typeof summarizeShareLinks> | null>(null);
  useEffect(() => {
    if (detail?.shareSummary) { setShareSummary(detail.shareSummary); return; }
    let cancelled = false;
    api<ShareList>(`/files/${file.id}/shares`)
      .then((response) => { if (!cancelled) setShareSummary(summarizeShareLinks(response.shares)); })
      .catch(() => { if (!cancelled) setShareSummary(null); });
    return () => { cancelled = true; };
  }, [detail, file.id]);

  const currentFile = detail?.file ?? file;
  const latest = detail?.latestVersion ?? null;
  const versions = detail?.versions?.length ? detail.versions : latest ? [latest] : [];
  const replicas = latest?.replicas ?? [];
  const storageLayout = detail?.storageLayout ?? storageLayoutFromFile(currentFile);
  const chunks = detail?.chunks ?? [];
  const risks = detail?.risks?.length ? detail.risks : inferFileRisks(currentFile, replicas);
  const active = currentFile.status === "active";
  const downloading = busyAction === `download:${currentFile.id}`;
  const access = detail?.recentAccess ?? null;

  async function downloadVersion(version: FileVersionDetail) {
    setVersionAction(version.id);
    setVersionError(null);
    try {
      await download(`/files/${currentFile.id}/versions/${version.id}/download`, versionDownloadName(currentFile, version));
    } catch (err) {
      setVersionError(stage8ErrorMessage(err, "下载版本"));
    } finally {
      setVersionAction(null);
    }
  }

  return (
    <div className="drawer-overlay" onClick={onClose} role="presentation">
      <aside className="drawer" onClick={(event) => event.stopPropagation()} aria-label="文件详情">
        <header className="drawer-header">
          <span className="file-glyph"><FileTypeIcon file={currentFile} size={22} /></span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="drawer-title">{currentFile.name}</div>
            <div className="drawer-sub">{formatBytes(Number(currentFile.sizeBytes))} · {policyLabel(currentFile.effectivePolicy)} · 创建于 {formatDateTime(currentFile.createdAt)}</div>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭"><X size={16} /></button>
        </header>

        <nav className="drawer-tabs" role="tablist">
          <TabBtn id="overview" current={tab} onClick={setTab}>概览</TabBtn>
          <TabBtn id="versions" current={tab} onClick={setTab}>版本 {versions.length > 0 && `(${versions.length})`}</TabBtn>
          <TabBtn id="storage" current={tab} onClick={setTab}>存储</TabBtn>
          <TabBtn id="shares" current={tab} onClick={setTab}>分享</TabBtn>
          <TabBtn id="access" current={tab} onClick={setTab}>访问</TabBtn>
        </nav>

        <div className="drawer-content">
          {detailLoading && <div className="row muted" style={{ gap: 6, fontSize: 13 }}><span className="spinner" /> 加载详情...</div>}
          {detailError && <div className="alert alert-warn"><AlertCircle size={14} />{detailError}</div>}

          {risks.length > 0 && (
            <div className="alert alert-warn">
              <AlertCircle size={14} />
              <div className="stack-sm" style={{ flex: 1 }}>
                <strong>{risks.length} 项风险</strong>
                {risks.map((risk, i) => <div key={i}>{risk.message}</div>)}
              </div>
            </div>
          )}

          {tab === "overview" && (
            <dl className="detail-list">
              <dt>策略</dt><dd><PolicyBadge policy={currentFile.effectivePolicy} /> {currentFile.policyOverride ? <span className="muted" style={{ fontSize: 12 }}>(手动)</span> : <span className="muted" style={{ fontSize: 12 }}>(继承目录)</span>}</dd>
              <dt>副本</dt><dd><ReplicaBadge file={currentFile} /></dd>
              <dt>状态</dt><dd><StatusBadge status={currentFile.status} /></dd>
              <dt>大小</dt><dd>{formatBytes(Number(currentFile.sizeBytes))}</dd>
              <dt>类型</dt><dd>{currentFile.mimeType || "—"}</dd>
              <dt>过期</dt><dd>{currentFile.expiresAt ? formatDateTime(currentFile.expiresAt) : "不过期"}</dd>
              <dt>创建</dt><dd>{formatDateTime(currentFile.createdAt)}</dd>
              <dt>最新版本</dt><dd className="mono">{latest?.id ?? currentFile.latestVersionId ?? "—"}</dd>
              <dt>存储布局</dt><dd>{storageLayout ? storageLayoutLabel(storageLayout) : "—"}</dd>
            </dl>
          )}

          {tab === "versions" && (
            <div className="stack-sm">
              {versionError && <div className="alert alert-danger"><AlertCircle size={14} />{versionError}</div>}
              {versions.length === 0 ? (
                <p className="muted" style={{ fontSize: 13 }}>暂无版本信息。</p>
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <thead><tr><th>版本</th><th>大小</th><th>创建</th><th className="col-actions"></th></tr></thead>
                    <tbody>
                      {versions.map((version) => (
                        <tr key={version.id}>
                          <td className="mono" style={{ maxWidth: 130, overflow: "hidden", textOverflow: "ellipsis" }}>{version.id}</td>
                          <td>{versionSizeLabel(version)}</td>
                          <td>{version.createdAt ? formatDateTime(version.createdAt) : "—"}</td>
                          <td className="col-actions">
                            <button type="button" className="btn btn-ghost btn-sm" onClick={() => downloadVersion(version)} disabled={versionAction === version.id}>
                              <Download size={12} /> {versionAction === version.id ? "下载中" : "下载"}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {tab === "storage" && (
            <div className="stack">
              <div>
                <h3 className="section-title">布局</h3>
                {storageLayout ? (
                  <p className="muted" style={{ fontSize: 13, lineHeight: 1.6 }}>
                    {storageLayoutLabel(storageLayout)} · 分片数 {storageLayout.chunkCount ?? "未知"} · 分片大小 {storageLayout.chunkSizeBytes == null ? "未知" : formatBytes(Number(storageLayout.chunkSizeBytes))} · 整文件副本 {storageLayout.wholeReplicaCount ?? currentFile.replicaCount} · 分片副本 {storageLayout.chunkReplicaCount ?? "未知"}
                  </p>
                ) : <p className="muted" style={{ fontSize: 13 }}>后端尚未返回存储布局。</p>}
              </div>

              <div>
                <h3 className="section-title">副本状态</h3>
                {replicas.length === 0 ? (
                  <p className="muted" style={{ fontSize: 13 }}>后端未返回副本明细。</p>
                ) : (
                  <div className="table-wrap">
                    <table className="table">
                      <thead><tr><th>节点</th><th>状态</th><th>校验时间</th></tr></thead>
                      <tbody>
                        {replicas.map((replica, i) => (
                          <tr key={replica.id ?? i}>
                            <td>{replica.nodeName ?? replica.nodeId ?? "—"}</td>
                            <td><ReplicaStatusBadge status={replica.status} /></td>
                            <td>{replica.verifiedAt ? formatDateTime(replica.verifiedAt) : "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {chunks.length > 0 && (
                <div>
                  <h3 className="section-title">分片明细 (前 5)</h3>
                  <div className="table-wrap">
                    <table className="table">
                      <thead><tr><th>#</th><th>大小</th><th>Hash</th><th>副本</th></tr></thead>
                      <tbody>
                        {chunks.slice(0, 5).map((chunk) => {
                          const available = (chunk.replicas ?? []).filter((r) => r.status === "available").length;
                          return (
                            <tr key={chunk.index}>
                              <td className="mono">#{chunk.index}</td>
                              <td>{(chunk.sizeBytes ?? chunk.size) == null ? "—" : formatBytes(Number(chunk.sizeBytes ?? chunk.size))}</td>
                              <td className="mono">{(chunk.hash ?? chunk.sha256)?.slice(0, 10) ?? "—"}…</td>
                              <td>{available}/{(chunk.replicas ?? []).length}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  {chunks.length > 5 && <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>共 {chunks.length} 个分片</p>}
                </div>
              )}
            </div>
          )}

          {tab === "shares" && (
            <div className="stack-sm">
              {shareSummary ? (
                <>
                  <div className="stat-grid">
                    <div className="stat-card"><span className="stat-label">活跃</span><span className="stat-value">{shareSummary.active}</span></div>
                    <div className="stat-card"><span className="stat-label">已过期</span><span className="stat-value">{shareSummary.expired}</span></div>
                    <div className="stat-card"><span className="stat-label">已撤销</span><span className="stat-value">{shareSummary.revoked}</span></div>
                    <div className="stat-card"><span className="stat-label">有密码</span><span className="stat-value">{shareSummary.passwordProtected}</span></div>
                  </div>
                  <p className="muted" style={{ fontSize: 12 }}>
                    {shareSummary.lastAccessAt ? `最近访问 ${formatDateTime(shareSummary.lastAccessAt)}` : "暂无访问记录"}
                  </p>
                </>
              ) : <p className="muted" style={{ fontSize: 13 }}>暂无分享数据。</p>}
              <button type="button" className="btn btn-secondary" onClick={onShare} disabled={!active}>
                <Link2 size={13} /> 创建或管理分享
              </button>
            </div>
          )}

          {tab === "access" && (
            access ? (
              <dl className="detail-list">
                <dt>最近访问</dt><dd>{access.lastAccessAt ? formatDateTime(access.lastAccessAt) : "—"}</dd>
                <dt>下载次数</dt><dd>{access.recentDownloads ?? 0}</dd>
                <dt>分享下载</dt><dd>{access.recentShareDownloads ?? 0}</dd>
                <dt>失败次数</dt><dd>{access.recentFailures ?? 0}</dd>
              </dl>
            ) : <p className="muted" style={{ fontSize: 13 }}>暂无访问统计;管理员可在「访问记录」查看完整日志。</p>
          )}
        </div>

        <div className="drawer-actions">
          <button type="button" className="btn btn-secondary" onClick={onPreview} disabled={!active}>
            <Eye size={13} /> 预览
          </button>
          <button type="button" className="btn btn-secondary" onClick={onDownload} disabled={!active || downloading}>
            <Download size={13} /> {downloading ? "下载中" : "下载"}
          </button>
          <button type="button" className="btn btn-secondary" onClick={onShare} disabled={!active}>
            <Link2 size={13} /> 分享
          </button>
          <button type="button" className="btn btn-danger-ghost" onClick={onDelete} style={{ marginLeft: "auto" }}>
            <Trash2 size={13} /> 移入回收站
          </button>
        </div>
      </aside>
    </div>
  );
}

function TabBtn({ id, current, onClick, children }: { id: Tab; current: Tab; onClick: (id: Tab) => void; children: React.ReactNode }) {
  return (
    <button type="button" className={current === id ? "is-active" : ""} onClick={() => onClick(id)} role="tab" aria-selected={current === id}>
      {children}
    </button>
  );
}
