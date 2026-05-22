import { PanelLeftClose, PanelLeftOpen, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";

export function Topbar({
  title,
  meta,
  collapsed,
  onToggleSidebar,
  onRefresh,
  refreshing,
  children
}: {
  title: string;
  meta?: ReactNode;
  collapsed: boolean;
  onToggleSidebar: () => void;
  onRefresh?: () => void;
  refreshing?: boolean;
  children?: ReactNode;
}) {
  return (
    <header className="topbar">
      <button type="button" className="icon-btn" onClick={onToggleSidebar} aria-label="折叠/展开侧栏" title="折叠/展开侧栏 (B)">
        {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
      </button>
      <h1>{title}</h1>
      {meta && <span className="topbar-meta">· {meta}</span>}
      <span className="topbar-spacer" />
      {children}
      {onRefresh && (
        <button type="button" className="icon-btn" onClick={onRefresh} disabled={refreshing} aria-label="刷新" title="刷新 (R)">
          <RefreshCw size={16} className={refreshing ? "spin" : ""} />
        </button>
      )}
    </header>
  );
}
