import { Activity, HardDrive, Lock, Share2, ShieldCheck } from "lucide-react";
import { useState, type FormEvent } from "react";
import { api, type SessionUser } from "../api.js";
import { loginErrorMessage } from "../lib/errors.js";

export function Login({ onLogin }: { onLogin: (user: SessionUser) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!email.trim() || !password) return;
    setBusy(true);
    setError(null);
    try {
      const response = await api<{ user: SessionUser }>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password })
      });
      onLogin(response.user);
    } catch (err) {
      setError(loginErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-shell">
      <aside className="login-brand-pane" aria-hidden="true">
        <div>
          <span className="brand-mark-lg"><HardDrive size={20} /></span>
          <h1>Wangpan</h1>
          <p>个人文件中转和重要资料长期存储。端到端加密、可跨 VPS 多副本,登录后管理目录、节点和访问记录。</p>
        </div>
        <ul className="feature-list">
          <li><Lock size={16} /><span>应用层 AES-256-GCM 加密,密文落盘</span></li>
          <li><ShieldCheck size={16} /><span>多节点副本,重要文件至少双副本</span></li>
          <li><Share2 size={16} /><span>分享链接支持密码、过期时间和下载次数</span></li>
          <li><Activity size={16} /><span>完整访问记录和后台清理</span></li>
        </ul>
      </aside>

      <section className="login-form-pane">
        <form className="login-card" onSubmit={submit}>
          <header className="stack-sm">
            <h2>登录</h2>
            <p className="muted">使用管理员或成员账号登录,继续访问你的网盘。</p>
          </header>

          <div className="field">
            <label className="field-label" htmlFor="login-email">邮箱</label>
            <input
              id="login-email"
              className="input"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoFocus
            />
          </div>

          <div className="field">
            <label className="field-label" htmlFor="login-password">密码</label>
            <input
              id="login-password"
              className="input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>

          {error && (
            <div className="alert alert-danger" role="alert">
              <span>{error}</span>
            </div>
          )}

          <button type="submit" className="btn btn-primary btn-lg" disabled={busy || !email.trim() || !password}>
            {busy && <span className="spinner" />}
            {busy ? "登录中" : "登录"}
          </button>
        </form>
      </section>
    </main>
  );
}
