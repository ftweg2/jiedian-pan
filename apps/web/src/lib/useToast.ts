import { useCallback, useEffect, useRef, useState } from "react";
import type { Toast, ToastTone } from "./types.js";

const TOAST_TTL_MS = 3200;

export function useToast() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timeoutsRef = useRef<Map<string, number>>(new Map());

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
    const timeout = timeoutsRef.current.get(id);
    if (timeout) {
      window.clearTimeout(timeout);
      timeoutsRef.current.delete(id);
    }
  }, []);

  const push = useCallback(
    (message: string, tone: ToastTone = "info") => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      setToasts((current) => [...current, { id, message, tone }]);
      const timeout = window.setTimeout(() => dismiss(id), TOAST_TTL_MS);
      timeoutsRef.current.set(id, timeout);
      return id;
    },
    [dismiss]
  );

  useEffect(() => {
    const timeouts = timeoutsRef.current;
    return () => {
      for (const t of timeouts.values()) window.clearTimeout(t);
      timeouts.clear();
    };
  }, []);

  const success = useCallback((message: string) => push(message, "success"), [push]);
  const error = useCallback((message: string) => push(message, "error"), [push]);
  const info = useCallback((message: string) => push(message, "info"), [push]);

  return { toasts, push, success, error, info, dismiss };
}

export type ToastApi = ReturnType<typeof useToast>;
