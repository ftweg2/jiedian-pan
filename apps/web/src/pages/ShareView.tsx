import { AlertCircle, Clock, Download, FileText, HardDrive, Lock } from "lucide-react";
import { useEffect, useState } from "react";
import { api, download, type SharePublicMeta } from "../api.js";
import { formatDateTime } from "../lib/format.js";
import { publicShareErrorMessage } from "../lib/errors.js";
import { FolderShareView } from "./FolderShareView.js";

export function ShareView({ token }: { token: string }) {
  const [meta, setMeta] = useState<SharePublicMeta | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    api<SharePublicMeta>(`/shares/${token}`)
      .then(setMeta)
      .catch((err) => setLoadError(publicShareErrorMessage(err)));
  }, [token]);

  if (loadError) {
    return <ShareErrorScreen message={loadError} />;
  }
  if (!meta) return <div className="boot">Wangpan</div>;

  if (meta.kind === "folder") {
    return <FolderShareView token={token} meta={meta} />;
  }
  return <FileShareView token={token} meta={meta} />;
}

function FileShareView({
  token,
  meta
}: {
  token: string;
  meta: Extract<SharePublicMeta, { kind: "file" }>;
}) {
  const [password, setPassword] = useState("");
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function downloadFile() {
    if (meta.share.needsPassword && !password) return;
    setBusy(true);
    setDownloadError(null);
    try {
      if (meta.share.needsPassword) {
        await download(`/shares/${token}/download`, meta.file.name, { password });
      } else {
        await download(`/shares/${token}/download`, meta.file.name);
      }
    } catch (err) {
      setDownloadError(publicShareErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const remaining = meta.share.maxDownloads == null
    ? null
    : Math.max(meta.share.maxDownloads - meta.share.downloadCount, 0);
  const sizeMb = Number(meta.file.sizeBytes) / 1024 / 1024;

  return (
    <main className="login-shell">
      <section className="login-form-pane">
        <div className="login-card">
          <header className="row" style={{ alignItems: "flex-start", gap: 12 }}>
            <span className="file-glyph" style={{ width: 44, height: 44 }}>
              <FileText size={22} />
            </span>
            <div className="stack-sm" style={{ flex: 1, minWidth: 0 }}>
              <h2 style={{ wordBreak: "break-all", fontSize: 16, fontWeight: 600 }}>{meta.file.name}</h2>
              <span className="muted" style={{ fontSize: 12 }}>
                {sizeMb >= 1 ? `${sizeMb.toFixed(1)} MB` : `${(Number(meta.file.sizeBytes) / 1024).toFixed(0)} KB`}
                {meta.file.mimeType ? ` · ${meta.file.mimeType}` : ""}
              </span>
            </div>
          </header>

          <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
            <span className={`share-pill ${meta.share.needsPassword ? "is-on" : ""}`}>
              <Lock size={11} />{meta.share.needsPassword ? "需要密码" : "无密码"}
            </span>
            <span className={`share-pill ${meta.share.expiresAt ? "is-warn" : ""}`}>
              <Clock size={11} />{meta.share.expiresAt ? `${formatDateTime(meta.share.expiresAt)} 到期` : "不过期"}
            </span>
            <span className={`share-pill ${remaining != null ? "is-warn" : ""}`}>
              <HardDrive size={11} />{remaining == null ? "下载不限次" : `剩余 ${remaining}/${meta.share.maxDownloads} 次`}
            </span>
          </div>

          {meta.share.needsPassword && (
            <div className="field">
              <label className="field-label" htmlFor="share-password">访问密码</label>
              <input
                id="share-password"
                type="password"
                className="input"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoFocus
              />
            </div>
          )}

          {downloadError && <div className="alert alert-danger">{downloadError}</div>}

          <button
            className="btn btn-primary btn-lg"
            onClick={downloadFile}
            disabled={busy || (meta.share.needsPassword && !password)}
            type="button"
          >
            {busy ? <span className="spinner" /> : <Download size={16} />}
            {busy ? "下载中" : "下载文件"}
          </button>
        </div>
      </section>
    </main>
  );
}

export function ShareErrorScreen({ message }: { message: string }) {
  return (
    <main className="login-shell">
      <section className="login-form-pane">
        <div className="login-card">
          <div className="row" style={{ alignItems: "center", gap: 10 }}>
            <span className="file-glyph"><AlertCircle size={20} /></span>
            <h2>分享不可用</h2>
          </div>
          <div className="alert alert-danger">{message}</div>
        </div>
      </section>
    </main>
  );
}
