import { AlertCircle, CheckCircle2, Clock, Copy, FolderOpen, Link2, Lock, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import {
  absoluteAppUrl,
  api,
  type FileItem,
  type FolderItem,
  type ShareCreateResponse,
  type ShareLink,
  type ShareList
} from "../api.js";
import { Dialog } from "../components/Dialog.js";
import { shareCreateErrorMessage, shareManageErrorMessage } from "../lib/errors.js";
import { shareDownloadLabel, shareHasPassword } from "../lib/file-detail.js";
import { formatDateTime, shareStatusLabel, toDateTimeLocal } from "../lib/format.js";

export type ShareTarget =
  | { kind: "file"; file: FileItem }
  | { kind: "folder"; folder: FolderItem };

export function ShareDialog({ file, onClose }: { file: FileItem; onClose: () => void }) {
  return <ShareDialogBody target={{ kind: "file", file }} onClose={onClose} />;
}

export function FolderShareDialog({ folder, onClose }: { folder: FolderItem; onClose: () => void }) {
  return <ShareDialogBody target={{ kind: "folder", folder }} onClose={onClose} />;
}

function ShareDialogBody({ target, onClose }: { target: ShareTarget; onClose: () => void }) {
  const targetId = target.kind === "file" ? target.file.id : target.folder.id;
  const targetName = target.kind === "file" ? target.file.name : target.folder.name;
  const apiPrefix = target.kind === "file" ? `/files/${targetId}/shares` : `/folders/${targetId}/shares`;
  const dialogTitle = target.kind === "file" ? `分享 — ${targetName}` : `分享文件夹 — ${targetName}`;
  const dialogIcon = target.kind === "file"
    ? <Link2 size={16} style={{ color: "var(--brand)", marginRight: 8 }} />
    : <FolderOpen size={16} style={{ color: "var(--brand)", marginRight: 8 }} />;
  const subtitle = target.kind === "file"
    ? "分享链接适合发给没有账号的人;用户权限适合长期共享。"
    : "分享整个文件夹后,接收方可以浏览所有子文件夹、下载单个文件或一次性打包 ZIP 下载。次数计算:每下载一个文件计 1 次,ZIP 整包也计 1 次。";

  /* eslint-disable react-hooks/exhaustive-deps */
  const [password, setPassword] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [maxDownloads, setMaxDownloads] = useState("");
  const [url, setUrl] = useState<string | null>(null);
  const [shares, setShares] = useState<ShareLink[]>([]);
  const [loadingShares, setLoadingShares] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [manageError, setManageError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionId, setActionId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editExpiresAt, setEditExpiresAt] = useState("");
  const [editMax, setEditMax] = useState("");
  const [editPwd, setEditPwd] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => { void loadShares(); }, [targetId]);

  async function loadShares() {
    setLoadingShares(true);
    setManageError(null);
    try {
      const response = await api<ShareList>(apiPrefix);
      setShares(response.shares);
    } catch (err) {
      setShares([]);
      setManageError(shareManageErrorMessage(err, "读取"));
    } finally {
      setLoadingShares(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setCreateError(null);
    try {
      const response = await api<ShareCreateResponse>(apiPrefix, {
        method: "POST",
        body: JSON.stringify({
          password: password || null,
          expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
          maxDownloads: maxDownloads ? Number(maxDownloads) : null
        })
      });
      setUrl(absoluteAppUrl(response.share.url));
      setCopied(false);
      await loadShares();
    } catch (err) {
      setCreateError(shareCreateErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function beginEdit(share: ShareLink) {
    setEditingId(share.id);
    setEditExpiresAt(toDateTimeLocal(share.expiresAt));
    setEditMax(share.maxDownloads == null ? "" : String(share.maxDownloads));
    setEditPwd("");
    setManageError(null);
  }

  async function saveEdit(share: ShareLink) {
    setActionId(`update:${share.id}`);
    setManageError(null);
    try {
      await api(`/shares/${share.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          expiresAt: editExpiresAt ? new Date(editExpiresAt).toISOString() : null,
          maxDownloads: editMax ? Number(editMax) : null,
          ...(editPwd ? { password: editPwd } : {})
        })
      });
      setEditingId(null);
      await loadShares();
    } catch (err) {
      setManageError(shareManageErrorMessage(err, "更新"));
    } finally {
      setActionId(null);
    }
  }

  async function revoke(share: ShareLink) {
    setActionId(`revoke:${share.id}`);
    setManageError(null);
    try {
      await api(`/shares/${share.id}/revoke`, { method: "POST", body: "{}" });
      await loadShares();
    } catch (err) {
      setManageError(shareManageErrorMessage(err, "撤销"));
    } finally {
      setActionId(null);
    }
  }

  async function copyUrl() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setCreateError("复制失败,请手动选中链接复制。");
    }
  }

  return (
    <Dialog
      title={dialogTitle}
      icon={dialogIcon}
      size="lg"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>关闭</button>
          <button type="submit" form="share-form" className="btn btn-primary" disabled={busy}>
            {busy && <span className="spinner" />}
            <Link2 size={14} /> {busy ? "生成中" : "生成新链接"}
          </button>
        </>
      }
    >
      <form id="share-form" className="stack" onSubmit={submit}>
        <p className="muted" style={{ fontSize: 13 }}>{subtitle}</p>

        <div className="split-grid">
          <div className="field">
            <label className="field-label">访问密码</label>
            <input className="input" type="text" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="留空表示无密码" />
          </div>
          <div className="field">
            <label className="field-label">过期时间</label>
            <input className="input" type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} />
          </div>
        </div>

        <div className="field">
          <label className="field-label">最多下载次数</label>
          <input className="input" type="number" min={1} value={maxDownloads} onChange={(event) => setMaxDownloads(event.target.value)} placeholder="留空表示不限" />
        </div>

        <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
          <span className={`share-pill ${password ? "is-on" : ""}`}><Lock size={11} />{password ? "已设密码" : "无密码"}</span>
          <span className={`share-pill ${expiresAt ? "is-on" : ""}`}><Clock size={11} />{expiresAt ? "已设过期" : "不过期"}</span>
          <span className={`share-pill ${maxDownloads ? "is-on" : ""}`}>{maxDownloads ? `${maxDownloads} 次` : "次数不限"}</span>
        </div>

        {createError && <div className="alert alert-danger"><AlertCircle size={14} />{createError}</div>}

        {url && (
          <div className="card card-pad stack-sm" style={{ background: "var(--brand-soft)", borderColor: "var(--brand)" }}>
            <div className="row" style={{ gap: 6 }}>
              <CheckCircle2 size={14} color="var(--brand)" />
              <strong style={{ fontSize: 13, color: "var(--brand-soft-fg)" }}>分享链接已生成</strong>
            </div>
            <div className="copy-row">
              <input className="input" readOnly value={url} onFocus={(event) => event.currentTarget.select()} />
              <button type="button" className="btn btn-secondary" onClick={copyUrl}>
                <Copy size={14} /> {copied ? "已复制" : "复制"}
              </button>
            </div>
          </div>
        )}
      </form>

      <section className="stack-sm">
        <h3 className="section-title"><Link2 size={12} /> 已有的分享链接</h3>
        {loadingShares && <p className="muted row" style={{ gap: 6, fontSize: 13 }}><span className="spinner" /> 加载中...</p>}
        {manageError && <div className="alert alert-danger"><AlertCircle size={14} />{manageError}</div>}
        {!loadingShares && shares.length === 0 && <p className="muted" style={{ fontSize: 13 }}>暂无已创建的分享。</p>}
        {shares.map((share) => {
          const editing = editingId === share.id;
          const actionBusy = actionId === `update:${share.id}` || actionId === `revoke:${share.id}`;
          return (
            <div key={share.id} className="card card-pad stack-sm">
              <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                <span className={`share-pill ${share.status === "active" ? "is-on" : share.status === "revoked" ? "is-danger" : "is-warn"}`}>
                  {shareStatusLabel(share.status)}
                </span>
                <span className={`share-pill ${share.expiresAt ? "is-on" : ""}`}>
                  <Clock size={11} />{share.expiresAt ? `${formatDateTime(share.expiresAt)} 到期` : "不过期"}
                </span>
                <span className={`share-pill ${share.maxDownloads ? "is-on" : ""}`}>{shareDownloadLabel(share)}</span>
                <span className={`share-pill ${shareHasPassword(share) ? "is-on" : ""}`}>
                  <Lock size={11} />{shareHasPassword(share) ? "有密码" : "无密码"}
                </span>
                <span className="share-pill">{share.lastAccessAt ? `访问 ${formatDateTime(share.lastAccessAt)}` : "未访问"}</span>
              </div>

              {share.url && share.status === "active" && (
                <div className="copy-row">
                  <input className="input" readOnly value={share.url} onFocus={(event) => event.currentTarget.select()} />
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={async () => {
                      try { await navigator.clipboard.writeText(share.url!); } catch { /* ignore */ }
                    }}
                    title="复制链接"
                  >
                    <Copy size={12} /> 复制
                  </button>
                </div>
              )}

              {editing ? (
                <div className="stack-sm">
                  <div className="split-grid">
                    <input className="input" type="datetime-local" value={editExpiresAt} onChange={(event) => setEditExpiresAt(event.target.value)} />
                    <input className="input" type="number" min={1} value={editMax} onChange={(event) => setEditMax(event.target.value)} placeholder="次数,留空不限" />
                  </div>
                  <input className="input" type="password" value={editPwd} onChange={(event) => setEditPwd(event.target.value)} placeholder="新密码,留空不修改" />
                  <div className="row" style={{ justifyContent: "flex-end", gap: 6 }}>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditingId(null)} disabled={actionBusy}>取消</button>
                    <button type="button" className="btn btn-primary btn-sm" onClick={() => saveEdit(share)} disabled={actionBusy}>
                      {actionId === `update:${share.id}` && <span className="spinner" />}
                      保存
                    </button>
                  </div>
                </div>
              ) : (
                <div className="row" style={{ justifyContent: "flex-end", gap: 6 }}>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => beginEdit(share)} disabled={actionBusy || share.status === "revoked"}>
                    <RefreshCw size={12} /> 修改
                  </button>
                  <button type="button" className="btn btn-danger-ghost btn-sm" onClick={() => revoke(share)} disabled={actionBusy || share.status === "revoked"}>
                    <Trash2 size={12} /> {actionId === `revoke:${share.id}` ? "撤销中" : "撤销"}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </section>
    </Dialog>
  );
}
