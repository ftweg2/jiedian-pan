import { Activity, FolderTree, HardDrive, LogOut, ScrollText, Trash2, Users } from "lucide-react";
import type { SessionUser } from "../api.js";
import type { View } from "../lib/types.js";

export function Sidebar({
  view,
  user,
  collapsed,
  onChange,
  onLogout
}: {
  view: View;
  user: SessionUser;
  collapsed: boolean;
  onChange: (view: View) => void;
  onLogout: () => void;
}) {
  const initials = (user.name || user.email || "?").slice(0, 1).toUpperCase();

  return (
    <aside className="sidebar" aria-label="主导航">
      <div className="sidebar-brand">
        <span className="brand-mark"><HardDrive size={16} /></span>
        <span className="sidebar-brand-name">Wangpan</span>
      </div>

      <span className="sidebar-section-title">空间</span>
      <NavBtn icon={<FolderTree size={16} />} label="我的文件" active={view === "files"} onClick={() => onChange("files")} />
      <NavBtn icon={<Activity size={16} />} label="动态" active={view === "activity"} onClick={() => onChange("activity")} />
      <NavBtn icon={<Trash2 size={16} />} label="回收站" active={view === "trash"} onClick={() => onChange("trash")} />

      {user.role === "admin" && (
        <>
          <span className="sidebar-section-title">管理</span>
          <NavBtn icon={<HardDrive size={16} />} label="存储节点" active={view === "nodes"} onClick={() => onChange("nodes")} />
          <NavBtn icon={<Users size={16} />} label="用户" active={view === "users"} onClick={() => onChange("users")} />
          <NavBtn icon={<ScrollText size={16} />} label="访问记录" active={view === "logs"} onClick={() => onChange("logs")} />
        </>
      )}

      <div className="sidebar-foot">
        <div className="sidebar-user" title={user.email}>
          <div className="avatar">{initials}</div>
          <div className="sidebar-user-meta">
            <strong>{user.name}</strong>
            <span>{user.role === "admin" ? "管理员" : "成员"}</span>
          </div>
        </div>
        <NavBtn icon={<LogOut size={16} />} label="退出登录" onClick={onLogout} />
      </div>

      {/* swallow `collapsed` prop — visual state is driven by app-shell class */}
      <span hidden aria-hidden="true">{collapsed ? "" : ""}</span>
    </aside>
  );
}

function NavBtn({
  icon,
  label,
  active = false,
  onClick
}: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" className={`nav-item ${active ? "is-active" : ""}`} onClick={onClick} title={label}>
      {icon}
      <span className="nav-item-label">{label}</span>
    </button>
  );
}
