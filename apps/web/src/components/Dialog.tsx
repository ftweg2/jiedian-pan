import { X } from "lucide-react";
import { useEffect, type MouseEvent, type ReactNode } from "react";

export type DialogSize = "sm" | "lg" | "xl";

export function Dialog({
  title,
  icon,
  size = "sm",
  onClose,
  children,
  footer,
  closeOnBackdrop = true
}: {
  title: ReactNode;
  icon?: ReactNode;
  size?: DialogSize;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  closeOnBackdrop?: boolean;
}) {
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  function handleBackdrop(event: MouseEvent<HTMLDivElement>) {
    if (!closeOnBackdrop) return;
    if (event.target === event.currentTarget) onClose();
  }

  const sizeClass = size === "lg" ? "dialog-lg" : size === "xl" ? "dialog-xl" : "";

  return (
    <div className="dialog-backdrop" onMouseDown={handleBackdrop} role="presentation">
      <div className={`dialog ${sizeClass}`} role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog-header">
          <h2>
            {icon}
            {title}
          </h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </div>
        <div className="dialog-body">{children}</div>
        {footer && <div className="dialog-footer">{footer}</div>}
      </div>
    </div>
  );
}
