import { KeyRound, Plus, UserCheck, UserX } from "lucide-react";
import { useState, type FormEvent } from "react";
import { api, type SessionUser } from "../api.js";
import { Dialog } from "../components/Dialog.js";
import { EmptyState, TableState } from "../components/Empty.js";
import { isUserDisabled, stage8ErrorMessage } from "../lib/errors.js";

export function UsersPanel({
  users,
  loading,
  reload,
  toastSuccess,
  toastError
}: {
  users: SessionUser[];
  loading: boolean;
  reload: () => Promise<void>;
  toastSuccess: (message: string) => void;
  toastError: (message: string) => void;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const [resetTarget, setResetTarget] = useState<SessionUser | null>(null);
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
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEnabled(user, true)} disabled={actionId === user.id}>
                        <UserCheck size={12} /> 启用
                      </button>
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
