import type { FileItem, StoragePolicy } from "../api.js";
import { requiredReplicaCount } from "../lib/category.js";
import {
  fileStatusLabel,
  fileStatusTone,
  policyLabel,
  replicaStatusLabel,
  replicaStatusTone
} from "../lib/format.js";

const policyTone: Record<StoragePolicy, "brand" | "warn" | "neutral"> = {
  important: "warn",
  temporary: "brand",
  standard: "neutral"
};

export function PolicyBadge({ policy }: { policy: StoragePolicy }) {
  return <span className={`badge badge-${policyTone[policy]}`}>{policyLabel(policy)}</span>;
}

export function ReplicaBadge({ file }: { file: FileItem }) {
  const required = requiredReplicaCount(file.effectivePolicy);
  const ok = file.replicaCount >= required;
  const title = ok ? `已有 ${file.replicaCount} 份副本` : `副本不足 (${file.replicaCount}/${required})`;
  return (
    <span className={`badge ${ok ? "badge-good" : "badge-warn"}`} title={title}>
      {file.replicaCount}/{required}
    </span>
  );
}

export function StatusBadge({ status }: { status: FileItem["status"] }) {
  return <span className={`badge badge-${fileStatusTone(status)} badge-dot`}>{fileStatusLabel(status)}</span>;
}

export function ReplicaStatusBadge({ status }: { status: string }) {
  return <span className={`badge badge-${replicaStatusTone(status)}`}>{replicaStatusLabel(status)}</span>;
}
