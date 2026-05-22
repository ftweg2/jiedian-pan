import {
  AlertCircle,
  Archive,
  ChevronRight,
  Clock,
  Download,
  File as FileIconBase,
  FileText,
  Folder as FolderIcon,
  HardDrive,
  Image as ImageIcon,
  Lock,
  Music,
  Video
} from "lucide-react";
import { useEffect, useState } from "react";
import { api, apiBase, type FolderShareListing, type FolderShareListingFile, type SharePublicMeta } from "../api.js";
import { formatDateTime } from "../lib/format.js";
import { publicShareErrorMessage } from "../lib/errors.js";
import { ShareErrorScreen } from "./ShareView.js";

const ROOT_FOLDER_SENTINEL = "__root__";

export function FolderShareView({
  token,
  meta
}: {
  token: string;
  meta: Extract<SharePublicMeta, { kind: "folder" }>;
}) {
  const [password, setPassword] = useState("");
  const [authorized, setAuthorized] = useState(!meta.share.needsPassword);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  if (!authorized) {
    return (
      <FolderSharePasswordGate
        meta={meta}
        password={password}
        onChangePassword={setPassword}
        busy={authBusy}
        error={authError}
        onSubmit={async () => {
          setAuthBusy(true);
          setAuthError(null);
          try {
            await api(`/shares/${token}/authorize`, {
              method: "POST",
              body: JSON.stringify({ password })
            });
            setAuthorized(true);
          } catch (err) {
            setAuthError(publicShareErrorMessage(err));
          } finally {
            setAuthBusy(false);
          }
        }}
      />
    );
  }

  return <FolderShareBrowser token={token} meta={meta} />;
}

function FolderSharePasswordGate({
  meta,
  password,
  onChangePassword,
  busy,
  error,
  onSubmit
}: {
  meta: Extract<SharePublicMeta, { kind: "folder" }>;
  password: string;
  onChangePassword: (value: string) => void;
  busy: boolean;
  error: string | null;
  onSubmit: () => Promise<void> | void;
}) {
  return (
    <main className="login-shell">
      <section className="login-form-pane">
        <form
          className="login-card"
          onSubmit={(event) => {
            event.preventDefault();
            if (password) void onSubmit();
          }}
        >
          <header className="row" style={{ alignItems: "flex-start", gap: 12 }}>
            <span className="file-glyph" style={{ width: 44, height: 44 }}>
              <FolderIcon size={22} />
            </span>
            <div className="stack-sm" style={{ flex: 1, minWidth: 0 }}>
              <h2 style={{ wordBreak: "break-all", fontSize: 16, fontWeight: 600 }}>{meta.folder.name}</h2>
              <span className="muted" style={{ fontSize: 12 }}>共享文件夹</span>
            </div>
          </header>
          <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
            <span className="share-pill is-on"><Lock size={11} />需要密码</span>
            <span className={`share-pill ${meta.share.expiresAt ? "is-warn" : ""}`}>
              <Clock size={11} />{meta.share.expiresAt ? `${formatDateTime(meta.share.expiresAt)} 到期` : "不过期"}
            </span>
          </div>
          <div className="field">
            <label className="field-label" htmlFor="folder-share-password">访问密码</label>
            <input
              id="folder-share-password"
              type="password"
              className="input"
              value={password}
              onChange={(event) => onChangePassword(event.target.value)}
              autoFocus
            />
          </div>
          {error && <div className="alert alert-danger"><AlertCircle size={14} />{error}</div>}
          <button type="submit" className="btn btn-primary btn-lg" disabled={busy || !password}>
            {busy ? <span className="spinner" /> : <Lock size={16} />}
            {busy ? "验证中" : "提取"}
          </button>
        </form>
      </section>
    </main>
  );
}

function FolderShareBrowser({
  token,
  meta
}: {
  token: string;
  meta: Extract<SharePublicMeta, { kind: "folder" }>;
}) {
  const [currentFolderId, setCurrentFolderId] = useState<string>(ROOT_FOLDER_SENTINEL);
  const [listing, setListing] = useState<FolderShareListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const query = currentFolderId === ROOT_FOLDER_SENTINEL ? "" : `?folderId=${encodeURIComponent(currentFolderId)}`;
    api<FolderShareListing>(`/shares/${token}/listing${query}`)
      .then((data) => { if (!cancelled) setListing(data); })
      .catch((err) => { if (!cancelled) setError(publicShareErrorMessage(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [token, currentFolderId]);

  if (error && !listing) {
    return <ShareErrorScreen message={error} />;
  }

  const breadcrumb = listing?.breadcrumb ?? [{ id: meta.folder.id, name: meta.folder.name }];
  const remaining = meta.share.maxDownloads == null
    ? null
    : Math.max(meta.share.maxDownloads - (listing?.share.downloadCount ?? meta.share.downloadCount), 0);

  return (
    <main className="folder-share-shell">
      <header className="folder-share-header">
        <div className="folder-share-title">
          <span className="file-glyph folder" style={{ width: 36, height: 36 }}>
            <FolderIcon size={18} />
          </span>
          <div className="stack-sm" style={{ minWidth: 0 }}>
            <h1>{meta.folder.name}</h1>
            <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
              <span className={`share-pill ${meta.share.needsPassword ? "is-on" : ""}`}>
                <Lock size={11} />{meta.share.needsPassword ? "密码保护" : "公开"}
              </span>
              <span className={`share-pill ${meta.share.expiresAt ? "is-warn" : ""}`}>
                <Clock size={11} />{meta.share.expiresAt ? `${formatDateTime(meta.share.expiresAt)} 到期` : "永久有效"}
              </span>
              <span className={`share-pill ${remaining != null ? "is-warn" : ""}`}>
                <HardDrive size={11} />{remaining == null ? "下载不限次" : `剩余 ${remaining}/${meta.share.maxDownloads} 次`}
              </span>
            </div>
          </div>
        </div>
        <div className="folder-share-actions">
          <a
            className="btn btn-primary"
            href={`${apiBase}/shares/${token}/zip${currentFolderId === ROOT_FOLDER_SENTINEL ? "" : `?folderId=${encodeURIComponent(currentFolderId)}`}`}
            // 整包 ZIP 走原生流式下载;浏览器自带进度条
            download={`${breadcrumb[breadcrumb.length - 1]?.name ?? meta.folder.name}.zip`}
          >
            <Archive size={14} /> 下载整个文件夹 (ZIP)
          </a>
        </div>
      </header>

      <nav className="folder-share-breadcrumb">
        {breadcrumb.map((crumb, index) => (
          <span key={crumb.id} className="row" style={{ gap: 0 }}>
            {index > 0 && <span className="sep"><ChevronRight size={14} /></span>}
            <button
              type="button"
              className={`crumb ${index === breadcrumb.length - 1 ? "is-current" : ""}`}
              onClick={() => setCurrentFolderId(index === 0 ? ROOT_FOLDER_SENTINEL : crumb.id)}
            >
              {crumb.name}
            </button>
          </span>
        ))}
      </nav>

      {error && <div className="alert alert-danger" style={{ margin: "0 24px" }}><AlertCircle size={14} />{error}</div>}

      <section className="folder-share-body">
        {loading && !listing && (
          <div className="row muted" style={{ justifyContent: "center", padding: 36, gap: 8 }}>
            <span className="spinner" /> 加载中...
          </div>
        )}
        {listing && (listing.folders.length + listing.files.length === 0) && (
          <div className="empty-state" style={{ padding: 60 }}>
            <div className="empty-icon"><FolderIcon size={22} /></div>
            <strong>空文件夹</strong>
            <span>这个文件夹没有内容。</span>
          </div>
        )}
        {listing && (listing.folders.length > 0 || listing.files.length > 0) && (
          <div className="table-wrap" style={{ margin: "0 24px" }}>
            <table className="table">
              <thead>
                <tr>
                  <th>名称</th>
                  <th className="col-narrow">大小</th>
                  <th className="col-narrow">类型</th>
                  <th className="col-narrow">修改时间</th>
                  <th className="col-actions"></th>
                </tr>
              </thead>
              <tbody>
                {listing.folders.map((sub) => (
                  <tr key={`f-${sub.id}`} onDoubleClick={() => setCurrentFolderId(sub.id)} style={{ cursor: "pointer" }}>
                    <td>
                      <button
                        type="button"
                        className="file-cell"
                        style={{ background: "transparent", border: 0, padding: 0, cursor: "pointer", textAlign: "left" }}
                        onClick={() => setCurrentFolderId(sub.id)}
                      >
                        <span className="file-glyph folder"><FolderIcon size={16} /></span>
                        <div className="file-meta">
                          <span className="file-name">{sub.name}</span>
                          <span className="file-sub">{sub.childCount} 项</span>
                        </div>
                      </button>
                    </td>
                    <td className="muted" style={{ fontSize: 12 }}>—</td>
                    <td className="muted" style={{ fontSize: 12 }}>文件夹</td>
                    <td className="muted" style={{ fontSize: 12 }}>—</td>
                    <td className="col-actions">
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setCurrentFolderId(sub.id)}>
                        打开 <ChevronRight size={12} />
                      </button>
                    </td>
                  </tr>
                ))}
                {listing.files.map((file) => (
                  <tr key={`fl-${file.id}`}>
                    <td>
                      <div className="file-cell">
                        <span className="file-glyph"><FileTypeGlyph file={file} /></span>
                        <div className="file-meta">
                          <span className="file-name">{file.name}</span>
                          <span className="file-sub">{file.mimeType || "文件"}</span>
                        </div>
                      </div>
                    </td>
                    <td className="muted" style={{ fontSize: 12, fontVariantNumeric: "tabular-nums" }}>
                      {formatBytesShort(Number(file.sizeBytes))}
                    </td>
                    <td className="muted" style={{ fontSize: 12 }}>{policyTagFor(file)}</td>
                    <td className="muted" style={{ fontSize: 12 }}>{formatDateTime(file.createdAt)}</td>
                    <td className="col-actions">
                      <a
                        className="btn btn-ghost btn-sm"
                        href={`${apiBase}/shares/${token}/file/${file.id}`}
                        download={file.name}
                      >
                        <Download size={12} /> 下载
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}

function FileTypeGlyph({ file }: { file: FolderShareListingFile }) {
  const mime = (file.mimeType ?? "").toLowerCase();
  const name = file.name.toLowerCase();
  if (mime.startsWith("image/")) return <ImageIcon size={16} />;
  if (mime.startsWith("video/")) return <Video size={16} />;
  if (mime.startsWith("audio/")) return <Music size={16} />;
  if (mime.includes("pdf") || mime.startsWith("text/") || /\.(md|txt|csv|log|json|pdf|doc|docx|xls|xlsx|ppt|pptx)$/.test(name)) return <FileText size={16} />;
  return <FileIconBase size={16} />;
}

function formatBytesShort(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function policyTagFor(file: FolderShareListingFile): string {
  if (file.effectivePolicy === "important") return "重要";
  if (file.effectivePolicy === "temporary") return "临时";
  return "文件";
}

