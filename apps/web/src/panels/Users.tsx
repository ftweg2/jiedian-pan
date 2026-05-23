import { KeyRound, Plus, Trash2, UserCheck, UserX } from "lucide-react";
import { useState, type FormEvent } from "react";
import { api, type SessionUser } from "../api.js";
import { Dialog } from "../components/Dialog.js";
import { EmptyState, TableState } from "../components/Empty.js";
import { isUserDisabled, stage8ErrorMessage } from "../lib/errors.js";

export function UsersPanel({
  currentUserId,
  users,
  loading,
  reload,
  toastSuccess,
  toastError
}: {
  currentUserId: string;
  users: SessionUser[];
  loading: boolean;
  reload: () => Promise<void>;
  toastSuccess: (message: string) => void;
  toastError: (message: string) => void;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const [resetTarget, setResetTarget] = useState<SessionUser | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SessionUser | null>(null);
  const [actionId, setActionId] = useState<string | null>(null);

  async function setEnabled(user: SessionUser, enabled: boolean) {
    setActionId(user.id);
    try {
      await api(`/users/${user.id}/${enabled ? "enable" : "disable"}`, { method: "POST", body: "{}" });
      await reload();
      toastSuccess(enabled ? `${user.email} 已启用` : `${user.email} 已停用`);
    } catch (err) {
      toastError(stage8ErrorMessage(err, enabled ? "启用用户" : "停用用户"));
    } finally {
      setActionId(null);
    }
  }

  async function confirmDelete(user: SessionUser) {
    setActionId(user.id);
    try {
      const res = await api<{ deleted: boolean; transferredFiles: number; transferredFolders: number }>(
        `/users/${user.id}`,
        { method: "DELETE" }
      );
      await reload();
      const xfer = res.transferredFiles + res.transferredFolders;
      toastSuccess(xfer > 0
        ? `已删除 ${user.email},接管了 ${res.transferredFiles} 个文件 + ${res.transferredFolders} 个文件夹`
        : `已删除 ${user.email}`);
      setDeleteTarget(null);
    } catch (err) {
      toastError(stage8ErrorMessage(err, "删除用户"));
    } finally {
      setActionId(null);
    }
  }

  return (
    <div className="stack-lg">
      <div className="row-between">
        <div className="stack-sm">
          <h2 style={{ fontSize: 18, fontWeight: 600 }}>用户</h2>
          <p className="muted" style={{ fontSize: 13 }}>家人或同学可以创建独立账号,用密码登录。临时分享请用分享链接。</p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setCreateOpen(true)}>
          <Plus size={14} /> 新建用户
        </button>
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>邮箱</th><th>名称</th><th>角色</th><th>状态</th><th className="col-actions"></th></tr></thead>
          <tbody>
            {loading && <TableState colSpan={5}><span className="spinner" /> 加载用户...</TableState>}
            {!loading && users.length === 0 && (
              <tr><td colSpan={5}><EmptyState icon={<UserCheck size={20} />} title="还没有用户" /></td></tr>
            )}
            {users.map((user) => {
              const disabled = isUserDisabled(user);
              return (
                <tr key={user.id}>
                  <td className="mono" style={{ fontSize: 13 }}>{user.email}</td>
                  <td>{user.name}</td>
                  <td><span className={`badge badge-${user.role === "admin" ? "brand" : "neutral"}`}>{user.role === "admin" ? "管理员" : "成员"}</span></td>
                  <td><span className={`badge badge-${disabled ? "danger" : "good"} badge-dot`}>{disabled ? "已停用" : "可登录"}</span></td>
                  <td className="col-actions">
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setResetTarget(user)}>
                      <KeyRound size={12} /> 重置密码
                    </button>
                    {disabled ? (
                      <>
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEnabled(user, true)} disabled={actionId === user.id}>
                          <UserCheck size={12} /> 启用
                        </button>
                        {user.id !== currentUserId && (
                          <button type="button" className="btn btn-danger-ghost btn-sm" onClick={() => setDeleteTarget(user)} disabled={actionId === user.id}>
                            <Trash2 size={12} /> 删除
                          </button>
                        )}
                      </>
                    ) : (
                      <button type="button" className="btn btn-danger-ghost btn-sm" onClick={() => setEnabled(user, false)} disabled={actionId === user.id}>
                        <UserX size={12} /> 停用
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {createOpen && (
        <CreateUserDialog
          onCreated={async () => { await reload(); toastSuccess("用户已创建"); }}
          onError={toastError}
          onClose={() => setCreateOpen(false)}
        />
      )}
      {resetTarget && (
        <ResetPasswordDialog
          user={resetTarget}
          onClose={() => setResetTarget(null)}
          onSuccess={() => toastSuccess(`${resetTarget.email} 密码已重置`)}
          onError={toastError}
        />
      )}
      {deleteTarget && (
        <Dialog
          title={`删除用户 — ${deleteTarget.email}`}
          onClose={() => actionId !== deleteTarget.id && setDeleteTarget(null)}
          footer={
            <>
              <button type="button" className="btn btn-ghost" onClick={() => setDeleteTarget(null)} disabled={actionId === deleteTarget.id}>取消</button>
              <button type="button" className="btn btn-danger" onClick={() => confirmDelete(deleteTarget)} disabled={actionId === deleteTarget.id}>
                {actionId === deleteTarget.id && <span className="spinner" />} 确认删除
              </button>
            </>
          }
        >
          <div className="stack-sm">
            <p>这个操作 <strong>不可撤销</strong>:</p>
            <ul style={{ paddingLeft: 18, fontSize: 13, lineHeight: 1.7, margin: 0 }}>
              <li>用户账号 <strong>{deleteTarget.email}</strong> 会被永久删除</li>
              <li>该用户所有 <strong>文件</strong> 和 <strong>文件夹</strong> 会转移给你(当前管理员)</li>
              <li>会话、权限授予会一并删除</li>
              <li>访问日志保留,但归属者会变成"已删除用户"</li>
            </ul>
            <p className="muted" style={{ fontSize: 12 }}>
              如果只是临时不允许登录,用「停用」就够了 — 不必删。
            </p>
          </div>
        </Dialog>
      )}
    </div>
  );
}

function CreateUserDialog({
  onCreated,
  onError,
  onClose
}: {
  onCreated: () => Promise<void> | void;
  onError: (message: string) => void;
  onClose: () => void;
}) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"admin" | "member">("member");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!email.trim() || !name.trim() || !password) return;
    setBusy(true);
    try {
      await api("/users", { method: "POST", body: JSON.stringify({ email: email.trim(), name: name.trim(), password, role }) });
      await onCreated();
      onClose();
    } catch (err) {
      onError(stage8ErrorMessage(err, "创建用户"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      title="新建用户"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>取消</button>
          <button type="submit" form="create-user-form" className="btn btn-primary" disabled={busy || !email.trim() || !name.trim() || !password}>
            {busy && <span className="spinner" />}创建
          </button>
        </>
      }
    >
      <form id="create-user-form" className="stack" onSubmit={submit}>
        <div className="field">
          <label className="field-label">邮箱</label>
          <input className="input" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
        </div>
        <div className="field">
          <label className="field-label">名称</label>
          <input className="input" value={name} onChange={(event) => setName(event.target.value)} required />
        </div>
        <div className="field">
          <label className="field-label">初始密码</label>
          <input className="input" type="password" value={password} onChange={(event) => setPassword(event.target.value)} required />
          <p className="field-hint">建议至少 10 个字符,用户可在登录后通过管理员重置。</p>
        </div>
        <div className="field">
          <label className="field-label">角色</label>
          <select className="select" value={role} onChange={(event) => setRole(event.target.value as "admin" | "member")}>
            <option value="member">成员</option>
            <option value="admin">管理员</option>
          </select>
        </div>
      </form>
    </Dialog>
  );
}

function ResetPasswordDialog({
  user,
  onClose,
  onSuccess,
  onError
}: {
  user: SessionUser;
  onClose: () => void;
  onSuccess: () => void;
  onError: (message: string) => void;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!password) return;
    setBusy(true);
    try {
      await api(`/users/${user.id}/reset-password`, { method: "POST", body: JSON.stringify({ password }) });
      onSuccess();
      onClose();
    } catch (err) {
      onError(stage8ErrorMessage(err, "重置密码"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={`重置密码 — ${user.email}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>取消</button>
          <button type="submit" form="reset-password-form" className="btn btn-primary" disabled={busy || !password}>
            {busy && <span className="spinner" />}保存
          </button>
        </>
      }
    >
      <form id="reset-password-form" className="stack" onSubmit={submit}>
        <div className="field">
          <label className="field-label">新密码</label>
          <input className="input" type="password" value={password} onChange={(event) => setPassword(event.target.value)} required autoFocus />
          <p className="field-hint">保存后该用户的所有现有会话会立即失效。</p>
        </div>
      </form>
    </Dialog>
  );
}
