import type { ReactNode } from "react";

export function EmptyState({ icon, title, hint }: { icon: ReactNode; title: string; hint?: ReactNode }) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon}</div>
      <strong>{title}</strong>
      {hint && <span>{hint}</span>}
    </div>
  );
}

export function TableState({ children, colSpan = 8 }: { children: ReactNode; colSpan?: number }) {
  return (
    <tr>
      <td className="table-state" colSpan={colSpan}>
        <div className="row" style={{ justifyContent: "center", gap: 8 }}>{children}</div>
      </td>
    </tr>
  );
}
