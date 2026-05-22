import { Check } from "lucide-react";
import type { MouseEvent } from "react";

export function Checkbox({
  checked,
  indeterminate = false,
  onChange,
  label,
  onClick
}: {
  checked: boolean;
  indeterminate?: boolean;
  onChange?: () => void;
  label?: string;
  onClick?: (event: MouseEvent) => void;
}) {
  function handle(event: MouseEvent) {
    event.stopPropagation();
    onClick?.(event);
    onChange?.();
  }
  const className = `checkbox ${checked ? "is-checked" : ""} ${indeterminate ? "is-indeterminate" : ""}`;
  return (
    <button type="button" className={className} onClick={handle} role="checkbox" aria-checked={indeterminate ? "mixed" : checked} aria-label={label}>
      {checked && !indeterminate && <Check size={12} strokeWidth={3} />}
    </button>
  );
}
