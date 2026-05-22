import { Activity, AlertTriangle, Copy, HardDrive, KeyRound, Plus, RefreshCw } from "lucide-react";
import { useState, type FormEvent } from "react";
import { api, type NodeItem } from "../api.js";
import { Dialog } from "../components/Dialog.js";
import { EmptyState } from "../components/Empty.js";
import { nodeRefreshErrorMessage } from "../lib/errors.js";
import { formatBytes, formatDateTime, nodeStatusLabel } from "../lib/format.js";
import { NodeMonitorView } from "./NodeMonitor.js";

export function NodesPanel({
  nodes,
  loading,
  reload,
  toastSuccess,
  toastError
}: {
  nodes: NodeItem[];
  loading: boolean;
  reload: () => Promise<void>;
  toastSuccess: (message: string) => void;
  toastError: (message: string) => void;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const [monitorNodeId, setMonitorNodeId] = useState<string | null>(null);
  const monitorNode = monitorNodeId ? nodes.find((n) => n.id === monitorNodeId) ?? null : null;

  if (monitorNode) {
    return (
      <NodeMonitorView
        node={monitorNode}
        onBack={() => setMonitorNodeId(null)}
        toastError={toastError}
      />
    );
  }

  const health = nodes.reduce(
    (acc, node) => {
      acc[node.status] = (acc[node.status] ?? 0) + 1;
      acc.free += Number(node.freeBytes ?? 0);
      acc.total += Number(node.totalBytes ?? 0);
      return acc;
    },
    { active: 0, degraded: 0, offline: 0, lost: 0, disabled: 0, free: 0, total: 0 } as Record<string, number>
  );

  const lostNodes = nodes.filter((n) => n.status === "lost");

  async function copyAddress(node: NodeItem) {
    try {
      await navigator.clipboard.writeText(node.baseUrl);
      toastSuccess(`${node.name} 地址已复制`);
    } catch {
      toastError("复制失败,请手动选中地址复制。");
    }
  }

  async function refreshOne(node: NodeItem) {
    setRefreshingId(node.id);
    try {
      await reload();
      toastSuccess(`${node.name} 状态已刷新`);
    } catch (err) {
      toastError(nodeRefreshErrorMessage(err));
    } finally {
      setRefreshingId(null);
    }
  }

  return (
    <div className="stack-lg">
      <div className="row-between">
        <div className="stack-sm">
          <h2 style={{ fontSize: 18, fontWeight: 600 }}>存储节点</h2>
          <p className="muted" style={{ fontSize: 13 }}>节点是实际保存文件副本的机器,重要文件副本不足时优先检查这里。</p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setCreateOpen(true)}>
          <Plus size={14} /> 添加节点
        </button>
      </div>

      {lostNodes.length > 0 && (
        <div className="alert alert-danger" style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
          <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 2 }} />
          <div className="stack-sm" style={{ flex: 1 }}>
            <strong style={{ fontSize: 13 }}>
              {lostNodes.length === 1
                ? `节点 ${lostNodes[0].name} 已失联`
                : `${lostNodes.length} 个节点已失联`}
            </strong>
            <p className="muted" style={{ fontSize: 12, margin: 0 }}>
              系统已自动把这些节点上的副本标记为缺失,并尝试在其他节点上补副本。
              点击节点的「监控」按钮查看影响范围,确认 VPS 是否真的失联。
            </p>
          </div>
        </div>
      )}

      <div className="stat-grid">
        <div className="stat-card"><span className="stat-label">正常</span><span className="stat-value" style={{ color: "var(--good)" }}>{health.active}</span></div>
        <div className="stat-card"><span className="stat-label">降级</span><span className="stat-value" style={{ color: health.degraded > 0 ? "var(--warn)" : undefined }}>{health.degraded}</span></div>
        <div className="stat-card"><span className="stat-label">离线</span><span className="stat-value" style={{ color: health.offline > 0 ? "var(--danger)" : undefined }}>{health.offline}</span></div>
        <div className="stat-card"><span className="stat-label">失联</span><span className="stat-value" style={{ color: health.lost > 0 ? "var(--danger)" : undefined }}>{health.lost}</span></div>
        <div className="stat-card"><span className="stat-label">停用</span><span className="stat-value">{health.disabled}</span></div>
        <div className="stat-card"><span className="stat-label">可用容量</span><span className="stat-value">{formatBytes(health.free)}</span><span className="stat-hint">总 {formatBytes(health.total)}</span></div>
      </div>

      {loading && <p className="row muted" style={{ gap: 6, fontSize: 13 }}><span className="spinner" /> 加载节点...</p>}
      {!loading && nodes.length === 0 && <EmptyState icon={<HardDrive size={20} />} title="还没有节点" hint="添加第一个节点后,文件才能稳定落盘和复制。" />}

      <div className="stat-grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
        {nodes.map((node) => {
          const total = Number(node.totalBytes ?? 0);
          const free = Number(node.freeBytes ?? 0);
          const used = Math.max(total - free, 0);
          const usagePct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
          const barTone = usagePct >= 90 ? "is-danger" : usagePct >= 70 ? "is-warn" : "";
          const tone = node.status === "active" ? "good"
            : node.status === "lost" ? "danger"
            : node.status === "offline" ? "danger"
            : node.status === "degraded" ? "warn"
            : node.status === "decommissioning" ? "warn"
            : "neutral";
          return (
            <div key={node.id} className="card card-pad stack-sm">
              <div className="row-between">
                <div className="stack-sm" style={{ minWidth: 0 }}>
                  <strong style={{ fontSize: 14 }}>{node.name}</strong>
                  <span className="muted mono" style={{ fontSize: 11 }}>{node.baseUrl}</span>
                </div>
                <span className={`badge badge-${tone} badge-dot`}>{nodeStatusLabel(node.status)}</span>
              </div>

              <div className="stack-sm">
                <div className={`capacity-bar ${barTone}`}><span style={{ width: `${usagePct}%` }} /></div>
                <div className="row-between muted" style={{ fontSize: 12 }}>
                  <span>{formatBytes(free)} 可用</span>
                  <span>{formatBytes(total)} 总量</span>
                </div>
              </div>

              <p className="muted" style={{ fontSize: 12 }}>
                {node.lastSeenAt ? `最近心跳 ${formatDateTime(node.lastSeenAt)}` : "暂无心跳"}
              </p>

              {(node.healthMessage || node.lastError) && (
                <p className="muted" style={{ fontSize: 12, color: "var(--warn)" }}>
                  {node.lastError ?? node.healthMessage}
                </p>
              )}

              <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setMonitorNodeId(node.id)}>
                  <Activity size={12} /> 监控
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => copyAddress(node)}>
                  <Copy size={12} /> 复制地址
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => refreshOne(node)} disabled={refreshingId === node.id}>
                  <RefreshCw size={12} className={refreshingId === node.id ? "spin" : ""} /> 刷新
                </button>
                <button type="button" className="btn btn-ghost btn-sm" disabled title="Token 不会回显">
                  <KeyRound size={12} /> Token
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {createOpen && (
        <CreateNodeDialog
          onCreated={async () => { await reload(); toastSuccess("节点已添加"); }}
          onError={toastError}
          onClose={() => setCreateOpen(false)}
        />
      )}
    </div>
  );
}

function CreateNodeDialog({
  onCreated,
  onError,
  onClose
}: {
  onCreated: () => Promise<void> | void;
  onError: (message: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [agentToken, setAgentToken] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || !baseUrl.trim() || !agentToken.trim()) return;
    setBusy(true);
    try {
      await api("/nodes", { method: "POST", body: JSON.stringify({ name: name.trim(), baseUrl: baseUrl.trim(), agentToken: agentToken.trim() }) });
      await onCreated();
      onClose();
    } catch (err) {
      onError(err instanceof Error ? err.message : "添加节点失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      title="添加节点"
      icon={<HardDrive size={16} style={{ color: "var(--brand)", marginRight: 8 }} />}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>取消</button>
          <button type="submit" form="create-node-form" className="btn btn-primary" disabled={busy || !name.trim() || !baseUrl.trim() || !agentToken.trim()}>
            {busy && <span className="spinner" />}保存
          </button>
        </>
      }
    >
      <form id="create-node-form" className="stack" onSubmit={submit}>
        <div className="field">
          <label className="field-label">名称</label>
          <input className="input" value={name} onChange={(event) => setName(event.target.value)} placeholder="例如:remote-vps-1" />
          <p className="field-hint">建议与 agent 的 NODE_ID 保持一致。</p>
        </div>
        <div className="field">
          <label className="field-label">Base URL</label>
          <input className="input" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="http://10.0.0.2:4010" />
          <p className="field-hint">主 VPS 能直接访问的地址 (私网 IP 或 WireGuard IP 优先)。</p>
        </div>
        <div className="field">
          <label className="field-label">Agent Token</label>
          <input className="input" type="password" value={agentToken} onChange={(event) => setAgentToken(event.target.value)} placeholder="agent 配置中的 AGENT_TOKEN" />
          <p className="field-hint">保存后不再回显,请确保和 agent 端配置一致。</p>
        </div>
      </form>
    </Dialog>
  );
}
