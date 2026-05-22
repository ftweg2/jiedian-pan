import { useEffect } from "react";

export interface Shortcut {
  key: string;
  meta?: boolean;
  shift?: boolean;
  alt?: boolean;
  handler: (event: KeyboardEvent) => void;
  when?: () => boolean;
}

export function useShortcuts(shortcuts: Shortcut[]): void {
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (isInputFocused(event.target) && !["Escape"].includes(event.key)) return;
      for (const shortcut of shortcuts) {
        if (shortcut.when && !shortcut.when()) continue;
        if (event.key !== shortcut.key && event.key.toLowerCase() !== shortcut.key.toLowerCase()) continue;
        const metaWanted = shortcut.meta ?? false;
        const metaPressed = event.metaKey || event.ctrlKey;
        if (metaWanted !== metaPressed) continue;
        if ((shortcut.shift ?? false) !== event.shiftKey) continue;
        if ((shortcut.alt ?? false) !== event.altKey) continue;
        shortcut.handler(event);
        return;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shortcuts]);
}

function isInputFocused(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}
