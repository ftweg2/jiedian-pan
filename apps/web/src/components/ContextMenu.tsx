import { useEffect, useRef, type ReactNode } from "react";

export interface ContextMenuItem {
  key: string;
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
  danger?: boolean;
  onClick: () => void;
  divider?: false;
}

export interface ContextMenuDivider {
  key: string;
  divider: true;
}

export type ContextMenuEntry = ContextMenuItem | ContextMenuDivider;

export function ContextMenu({
  x,
  y,
  items,
  onClose
}: {
  x: number;
  y: number;
  items: ContextMenuEntry[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function handle(event: MouseEvent) {
      if (!ref.current?.contains(event.target as Node)) onClose();
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("click", handle);
    window.addEventListener("contextmenu", handle);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", handle);
      window.removeEventListener("contextmenu", handle);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // boundary clamping
  const maxX = typeof window !== "undefined" ? window.innerWidth - 200 : x;
  const maxY = typeof window !== "undefined" ? window.innerHeight - 240 : y;
  const left = Math.min(x, Math.max(8, maxX));
  const top = Math.min(y, Math.max(8, maxY));

  return (
    <div ref={ref} className="context-menu" style={{ left, top }} role="menu">
      {items.map((item) => {
        if ("divider" in item && item.divider) {
          return <div key={item.key} className="menu-divider" role="separator" />;
        }
        const action = item as ContextMenuItem;
        return (
          <button
            key={action.key}
            type="button"
            disabled={action.disabled}
            className={action.danger ? "is-danger" : ""}
            onClick={() => {
              action.onClick();
              onClose();
            }}
            role="menuitem"
          >
            {action.icon}
            {action.label}
          </button>
        );
      })}
    </div>
  );
}
