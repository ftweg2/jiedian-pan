import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import type { Toast } from "../lib/types.js";

export function ToastRegion({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: string) => void }) {
  if (toasts.length === 0) return null;
  return (
    <div className="toast-region" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast-${toast.tone}`}>
          {toast.tone === "success" && <CheckCircle2 size={16} />}
          {toast.tone === "error" && <AlertCircle size={16} />}
          {toast.tone === "info" && <Info size={16} />}
          <span className="toast-message">{toast.message}</span>
          <button type="button" className="toast-close" onClick={() => onDismiss(toast.id)} aria-label="关闭通知">
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
