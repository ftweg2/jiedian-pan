import { Activity, AlertTriangle, ArrowLeft, ChevronDown, RefreshCw, RotateCcw, Skull } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, type NodeImpact, type NodeItem } from "../api.js";
import { Dialog } from "../components/Dialog.js";
import { formatBytes, formatDateTime, nodeStatusLabel } from "../lib/format.js";

type Range = "1h" | "6h" | "24h" | "7d" | "30d";

const RANGE_LABELS: Record<Range, string> = {
  "1h": "1小时",
  "6h": "6小时",
  "24h": "24小时",
  "7d": "7天",
  "30d": "30天"
};

interface ProbeBucket {
  at: string;
  latencyMs: number | null;
  uptimePct: number;     // -1 means no samples in this bucket
  sampleCount: number;
}

interface ProbesResponse {
  node: { id: string; name: string };
  range: Range;
  probeIntervalSec: number;
  buckets: ProbeBucket[];
  summary: {
    currentLatencyMs: number | null;
    currentOk: boolean | null;
    avgLatency24hMs: number | null;
    uptime24hPct: number | null;
    uptime30dPct: number | null;
    uptimeAllPct: number | null;
    totalProbeCount: number;
  };
}

export function NodeMonitorView({
  node,
  onBack,
  toastError
}: {
  node: NodeItem;
  onBack: () => void;
  toastError: (m: string) => void;
}) {
  const [range, setRange] = useState<Range>("1h");
  const [data, setData] = useState<ProbesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [autoRefreshAt, setAutoRefreshAt] = useState<number>(0);

  const load = useMemo(() => async (r: Range) => {
    setLoading(true);
    try {
      const res = await api<ProbesResponse>(`/nodes/${node.id}/probes?range=${r}`);
      setData(res);
    } catch (err) {
      toastError(err instanceof Error ? err.message : "加载监控数据失败");
    } finally {
      setLoading(false);
    }
  }, [node.id, toastError]);

  // Initial + range change
  useEffect(() => { void load(range); }, [load, range, autoRefreshAt]);

  // Auto-refresh every 7 seconds (matches probe pacing visually)
  useEffect(() => {
    const t = setInterval(() => setAutoRefreshAt(Date.now()), 7000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="stack-lg">
      <div className="row-between">
        <div className="row" style={{ gap: 12 }}>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onBack}>
            <ArrowLeft size={13} /> 返回
          </button>
          <div className="stack-sm">
            <h2 style={{ fontSize: 18, fontWeight: 600 }}>{node.name}</h2>
            <span className="muted" style={{ fontSize: 12 }}>
              {node.baseUrl} · {nodeStatusLabel(node.status)}
              {node.lastSeenAt && ` · 最近心跳 ${formatDateTime(node.lastSeenAt)}`}
            </span>
          </div>
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => load(range)} disabled={loading}>
          <RefreshCw size={13} className={loading ? "spin" : ""} /> 刷新
        </button>
      </div>

      {/* Real-time 60-bucket status strip */}
      <section className="card card-pad stack-sm">
        <div className="row-between">
          <div className="stack-sm">
            <h3 style={{ fontSize: 14, fontWeight: 600 }}>实时监控</h3>
            <span className="muted" style={{ fontSize: 12 }}>{RANGE_LABELS[range]}在线状态(60 个时段)</span>
          </div>
          <div className="row" style={{ gap: 6 }}>
            <span className="badge badge-good badge-dot">监控中</span>
            <span className="muted" style={{ fontSize: 11 }}>{data?.probeIntervalSec ?? 30}s 间隔</span>
          </div>
        </div>
        <StatusStrip buckets={data?.buckets ?? []} />
        <div className="row-between muted" style={{ fontSize: 11 }}>
          <span>{RANGE_LABELS[range]}前</span>
          <span>现在</span>
        </div>
      </section>

      {/* Stat tiles */}
      <div className="stat-grid">
        <StatTile label="当前 Ping" value={fmtPing(data?.summary.currentLatencyMs)} hint={data?.summary.currentOk === false ? "离线中" : undefined} bad={data?.summary.currentOk === false} />
        <StatTile label="24h 平均" value={fmtPing(data?.summary.avgLatency24hMs)} />
        <StatTile label="24h 在线率" value={fmtPct(data?.summary.uptime24hPct)} good={(data?.summary.uptime24hPct ?? 0) >= 99} />
        <StatTile label="30天 在线率" value={fmtPct(data?.summary.uptime30dPct)} good={(data?.summary.uptime30dPct ?? 0) >= 99} />
        <StatTile label="累计 在线率" value={fmtPct(data?.summary.uptimeAllPct)} hint={`${(data?.summary.totalProbeCount ?? 0).toLocaleString()} 次探测`} />
      </div>

      {/* History latency chart */}
      <section className="card card-pad stack">
        <div className="row-between">
          <div className="stack-sm">
            <h3 style={{ fontSize: 14, fontWeight: 600 }}>历史数据</h3>
            <span className="muted" style={{ fontSize: 12 }}>延迟趋势 · 60 个数据点</span>
          </div>
          <div className="view-toggle" role="tablist">
            {(["1h", "6h", "24h", "7d", "30d"] as Range[]).map((r) => (
              <button
                key={r}
                type="button"
                className={range === r ? "is-active" : ""}
                onClick={() => setRange(r)}
                style={{ minWidth: 50 }}
              >
                {RANGE_LABELS[r]}
              </button>
            ))}
          </div>
        </div>
        <LatencyChart buckets={data?.buckets ?? []} loading={loading} />
      </section>

      {/* Capacity reminder */}
      <section className="card card-pad row" style={{ gap: 12, alignItems: "center" }}>
        <Activity size={16} className="muted" />
        <div style={{ flex: 1 }}>
          <strong style={{ fontSize: 13 }}>磁盘容量</strong>
          <p className="muted" style={{ fontSize: 12, marginTop: 2 }}>
            {formatBytes(Number(node.freeBytes ?? 0))} 可用 / {formatBytes(Number(node.totalBytes ?? 0))} 总量
          </p>
        </div>
        <ChevronDown size={14} className="muted" style={{ transform: "rotate(-90deg)" }} />
      </section>

      {/* Lost / decommission section */}
      {node.status === "lost"
        ? <LostSection node={node} toastError={toastError} onChanged={() => load(range)} />
        : <DecommissionSection node={node} toastError={toastError} onChanged={() => load(range)} />}

      {/* "Declare lost" appears whenever the node isn't already lost/disabled — manual override
          for the case where the admin knows the VPS is gone for good. */}
      {node.status !== "lost" && node.status !== "disabled" && node.status !== "decommissioning" && (
        <DeclareLostSection node={node} toastError={toastError} onChanged={() => load(range)} />
      )}

      {/* Manual re-verify: walk MISSING replicas and ask the agent if the
          data is still there. Useful any time admin suspects a false alarm. */}
      {node.status !== "disabled" && (
        <ReverifySection node={node} toastError={toastError} onChanged={() => load(range)} />
      )}
    </div>
  );
}

function ReverifySection({
  node,
  toastError,
  onChanged
}: {
  node: NodeItem;
  toastError: (m: string) => void;
  onChanged: () => Promise<void> | void;
}) {
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<{ checked: number; recovered: number } | null>(null);

  async function run() {
    setBusy(true);
    try {
      const res = await api<{ checked: number; chunkRecovered: number; objectRecovered: number }>(
        `/nodes/${node.id}/reverify`,
        { method: "POST", body: "{}" }
      );
      const recovered = res.chunkRecovered + res.objectRecovered;
      setLast({ checked: res.checked, recovered });
      await onChanged();
      if (res.checked === 0) {
        toastError("没有可校验的 MISSING 副本(这是好事)");
      } else {
        toastError(`已校验 ${res.checked} 个副本,恢复 ${recovered} 个`);
      }
    } catch (err) {
      toastError(err instanceof Error ? err.message : "重新校验失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card card-pad stack-sm">
      <div className="row" style={{ gap: 8 }}>
        <RotateCcw size={16} className="muted" />
        <strong style={{ fontSize: 13 }}>重新校验副本</strong>
      </div>
      <p className="muted" style={{ fontSize: 12, lineHeight: 1.6 }}>
        如果节点之前被误判失联,或者 token 短暂不一致导致副本被标 MISSING,
        点这里会逐个去 agent 那边核对:还在 → 翻回正常;真没了 → 保持 MISSING。
      </p>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={run}
        disabled={busy}
        style={{ alignSelf: "flex-start" }}
      >
        <RotateCcw size={12} className={busy ? "spin" : ""} /> {busy ? "校验中…" : "立即重新校验"}
      </button>
      {last && (
        <p className="muted" style={{ fontSize: 12, margin: 0 }}>
          上次结果:校验 {last.checked} 个,恢复 {last.recovered} 个
        </p>
      )}
    </section>
  );
}

// ---- declare-lost (manual) UI ----

function DeclareLostSection({
  node,
  toastError,
  onChanged
}: {
  node: NodeItem;
  toastError: (m: string) => void;
  onChanged: () => Promise<void> | void;
}) {
  const [impact, setImpact] = useState<NodeImpact | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  // Lazy-load impact when the section first mounts so the danger zone shows
  // "if this node disappears, you lose X files" upfront.
  useEffect(() => {
    let cancelled = false;
    api<{ impact: NodeImpact }>(`/nodes/${node.id}/impact`)
      .then((res) => { if (!cancelled) setImpact(res.impact); })
      .catch(() => { /* ignore */ });
    return () => { cancelled = true; };
  }, [node.id]);

  async function declareLost() {
    setBusy(true);
    try {
      await api(`/nodes/${node.id}/declare-lost`, { method: "POST", body: "{}" });
      setConfirmOpen(false);
      await onChanged();
    } catch (err) {
      toastError(err instanceof Error ? err.message : "标记失联失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card card-pad stack-sm" style={{ borderColor: "var(--border)" }}>
      <div className="row" style={{ gap: 8 }}>
        <Skull size={16} className="muted" />
        <strong style={{ fontSize: 13 }}>已知 VPS 跑路 / 永久下线?</strong>
      </div>
      <p className="muted" style={{ fontSize: 12, lineHeight: 1.6 }}>
        如果你确定这台 VPS 不会回来(欠费、被回收、跑路),可以直接标记为「失联」。
        系统会立刻把这台节点上的副本标记为缺失,并尝试从其他节点补副本。
        正常情况下,系统会在连续 10 次探测失败后自动这么做(约 5 分钟)。
      </p>
      {impact && (
        <p style={{ fontSize: 12, lineHeight: 1.6, margin: 0 }}>
          <strong>影响:</strong>本节点上有 <strong>{impact.replicasOnNode}</strong> 个副本,
          涉及 <strong>{impact.affectedFiles}</strong> 个文件。
          其中 <strong style={{ color: impact.unrecoverableFileCount > 0 ? "var(--danger)" : "var(--good)" }}>
            {impact.unrecoverableFileCount}
          </strong> 个文件没有其他备份(失联后无法恢复)。
        </p>
      )}
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={() => setConfirmOpen(true)}
        disabled={busy}
        style={{ alignSelf: "flex-start", color: "var(--danger)" }}
      >
        <Skull size={12} /> 立即标记失联
      </button>
      {confirmOpen && (
        <Dialog
          title="确认标记节点失联"
          icon={<Skull size={16} style={{ color: "var(--danger)", marginRight: 8 }} />}
          onClose={() => !busy && setConfirmOpen(false)}
          footer={
            <>
              <button type="button" className="btn btn-ghost" onClick={() => setConfirmOpen(false)} disabled={busy}>取消</button>
              <button type="button" className="btn btn-danger" onClick={declareLost} disabled={busy}>
                {busy && <span className="spinner" />} 确认,标记失联
              </button>
            </>
          }
        >
          <div className="stack-sm">
            <p>即将把节点 <strong>{node.name}</strong> 标记为「失联」。</p>
            {impact && impact.unrecoverableFileCount > 0 && (
              <div className="alert alert-danger" style={{ fontSize: 12 }}>
                ⚠ <strong>{impact.unrecoverableFileCount}</strong> 个文件失去全部副本,将无法恢复。
                {impact.unrecoverableFiles.length > 0 && (
                  <ul style={{ margin: "6px 0 0 18px", padding: 0, fontSize: 11 }}>
                    {impact.unrecoverableFiles.slice(0, 10).map((f) => (
                      <li key={f.fileId}>{f.name}</li>
                    ))}
                    {impact.unrecoverableFiles.length > 10 && <li>… 还有 {impact.unrecoverableFiles.length - 10} 个</li>}
                  </ul>
                )}
              </div>
            )}
            <ul style={{ paddingLeft: 18, fontSize: 13, lineHeight: 1.8 }}>
              <li>立即把这台节点的副本全部标记 MISSING</li>
              <li>触发自愈:其他节点尚有副本的文件,会自动补副本到健康节点</li>
              <li>如果是误判,可以在节点列表点击「恢复」</li>
            </ul>
          </div>
        </Dialog>
      )}
    </section>
  );
}

// ---- LOST status section: shown when node is already LOST ----

function LostSection({
  node,
  toastError,
  onChanged
}: {
  node: NodeItem;
  toastError: (m: string) => void;
  onChanged: () => Promise<void> | void;
}) {
  const [impact, setImpact] = useState<NodeImpact | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api<{ impact: NodeImpact }>(`/nodes/${node.id}/impact`)
      .then((res) => { if (!cancelled) setImpact(res.impact); })
      .catch(() => { /* ignore */ });
    return () => { cancelled = true; };
  }, [node.id]);

  async function restore() {
    setBusy(true);
    try {
      // 1) Flip status back to OFFLINE. Next probe will promote ACTIVE.
      await api(`/nodes/${node.id}/restore`, { method: "POST", body: "{}" });
      // 2) Walk MISSING replicas and verify on the (presumably-back) agent.
      //    Anything that still has the bytes flips back to AVAILABLE so
      //    files become readable again. This is the part that "un-loses"
      //    files when the LOST declaration turned out to be a false alarm.
      const result = await api<{ checked: number; chunkRecovered: number; objectRecovered: number }>(
        `/nodes/${node.id}/reverify`,
        { method: "POST", body: "{}" }
      );
      await onChanged();
      const recovered = result.chunkRecovered + result.objectRecovered;
      if (recovered > 0) {
        // We don't have a toastSuccess prop here, but the err toast is fine for info.
        toastError(`已恢复 ${recovered}/${result.checked} 个副本`);
      }
    } catch (err) {
      toastError(err instanceof Error ? err.message : "恢复节点失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card card-pad stack-sm" style={{ borderColor: "var(--danger)", background: "color-mix(in srgb, var(--danger-soft) 40%, transparent)" }}>
      <div className="row" style={{ gap: 8 }}>
        <Skull size={16} color="var(--danger)" />
        <strong style={{ fontSize: 13, color: "var(--danger)" }}>节点已失联</strong>
      </div>
      <p className="muted" style={{ fontSize: 12, lineHeight: 1.6 }}>
        {node.lostDeclaredAt
          ? `失联时间:${new Date(node.lostDeclaredAt).toLocaleString()}`
          : "失联时间未知"}
        。系统已自动尝试从其他节点重建副本。
      </p>
      {impact && (
        <div className="stack-sm" style={{ fontSize: 12 }}>
          <p style={{ margin: 0 }}>
            <strong>影响:</strong>{impact.replicasOnNode} 个副本(涉及 {impact.affectedFiles} 个文件),
            其中 <strong style={{ color: impact.unrecoverableFileCount > 0 ? "var(--danger)" : "var(--good)" }}>
              {impact.unrecoverableFileCount}
            </strong> 个文件失去全部副本,无法恢复。
          </p>
          {impact.unrecoverableFiles.length > 0 && (
            <details>
              <summary style={{ cursor: "pointer", fontSize: 12 }}>查看受影响文件清单</summary>
              <ul style={{ margin: "6px 0 0 18px", padding: 0, fontSize: 11, lineHeight: 1.8 }}>
                {impact.unrecoverableFiles.map((f) => (
                  <li key={f.fileId}>{f.name}{f.unrecoverableChunks > 1 && ` (缺 ${f.unrecoverableChunks} 块)`}</li>
                ))}
                {impact.truncated && <li className="muted">… 列表已截断,共 {impact.unrecoverableFileCount} 个</li>}
              </ul>
            </details>
          )}
        </div>
      )}
      <div className="row" style={{ gap: 6 }}>
        <button type="button" className="btn btn-ghost btn-sm" onClick={restore} disabled={busy}>
          <RotateCcw size={12} /> {busy ? "恢复中…" : "节点回来了,恢复"}
        </button>
      </div>
    </section>
  );
}

// ---- decommission UI ----

function DecommissionSection({
  node,
  toastError,
  onChanged
}: {
  node: NodeItem;
  toastError: (m: string) => void;
  onChanged: () => Promise<void> | void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [migration, setMigration] = useState<{ remaining: number; isDecommissioning: boolean; isDrained: boolean } | null>(null);

  // Poll migration progress every 5s when this node is DECOMMISSIONING or DISABLED.
  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const res = await api<{ remaining: number; isDecommissioning: boolean; isDrained: boolean }>(`/nodes/${node.id}/migration`);
        if (!cancelled) setMigration(res);
      } catch {
        // ignore
      }
    }
    void poll();
    const t = setInterval(poll, 5000);
    return () => { cancelled = true; clearInterval(t); };
  }, [node.id]);

  async function startDecommission() {
    setBusy(true);
    try {
      await api(`/nodes/${node.id}/decommission`, { method: "POST", body: "{}" });
      setConfirmOpen(false);
      await onChanged();
    } catch (err) {
      toastError(err instanceof Error ? err.message : "下线失败");
    } finally {
      setBusy(false);
    }
  }
  async function cancel() {
    setBusy(true);
    try {
      await api(`/nodes/${node.id}/cancel-decommission`, { method: "POST", body: "{}" });
      await onChanged();
    } catch (err) {
      toastError(err instanceof Error ? err.message : "取消下线失败");
    } finally {
      setBusy(false);
    }
  }

  const used = Number((node.totalBytes ?? 0)) - Number((node.freeBytes ?? 0));

  if (node.status === "decommissioning") {
    return (
      <section className="card card-pad stack-sm" style={{ borderColor: "var(--warn)" }}>
        <div className="row" style={{ gap: 8 }}>
          <Activity size={16} color="var(--warn)" />
          <strong style={{ fontSize: 13 }}>正在下线 — 后台搬运中</strong>
        </div>
        <p className="muted" style={{ fontSize: 12 }}>
          {migration
            ? migration.isDrained
              ? "全部数据已迁出,节点已停用,可在节点列表里删除该节点。"
              : `还剩 ${migration.remaining} 个副本待搬运到其他节点。每 60s 后台搬一批。`
            : "加载进度中..."}
        </p>
        <div className="row" style={{ gap: 6 }}>
          <button type="button" className="btn btn-ghost btn-sm" onClick={cancel} disabled={busy || migration?.isDrained}>
            取消下线(恢复为 active)
          </button>
        </div>
      </section>
    );
  }

  if (node.status === "disabled") {
    return (
      <section className="card card-pad stack-sm">
        <p className="muted" style={{ fontSize: 12 }}>节点已停用,不再参与读写。</p>
      </section>
    );
  }

  return (
    <section className="card card-pad stack-sm" style={{ borderColor: "var(--danger)", background: "color-mix(in srgb, var(--danger-soft) 30%, transparent)" }}>
      <div className="row" style={{ gap: 8 }}>
        <AlertTriangle size={16} color="var(--danger)" />
        <strong style={{ fontSize: 13, color: "var(--danger)" }}>危险区域</strong>
      </div>
      <p className="muted" style={{ fontSize: 12, lineHeight: 1.6 }}>
        <strong>下线节点</strong>会停止新写入,后台把节点上 {formatBytes(used)} 数据搬到其他节点。
        每 60 秒搬一批(由 <code>DECOMMISSION_CHUNKS_PER_TICK</code> 控制,默认 50)。
        全部搬完后节点自动转为停用,你可以放心删除节点 / 不续费 VPS。
      </p>
      <button
        type="button"
        className="btn btn-danger btn-sm"
        onClick={() => setConfirmOpen(true)}
        disabled={busy}
        style={{ alignSelf: "flex-start" }}
      >
        <AlertTriangle size={12} /> 下线节点
      </button>
      {confirmOpen && (
        <Dialog
          title="确认下线节点"
          icon={<AlertTriangle size={16} style={{ color: "var(--danger)", marginRight: 8 }} />}
          onClose={() => !busy && setConfirmOpen(false)}
          footer={
            <>
              <button type="button" className="btn btn-ghost" onClick={() => setConfirmOpen(false)} disabled={busy}>取消</button>
              <button type="button" className="btn btn-danger" onClick={startDecommission} disabled={busy}>
                {busy && <span className="spinner" />} 我确认,开始下线
              </button>
            </>
          }
        >
          <div className="stack-sm">
            <p>即将下线节点 <strong>{node.name}</strong>。</p>
            <ul style={{ paddingLeft: 18, fontSize: 13, lineHeight: 1.8 }}>
              <li>立即停止新写入到此节点</li>
              <li>后台开始把 <strong>{formatBytes(used)}</strong> 数据迁移到其他节点</li>
              <li>整个迁移过程是<strong>异步</strong>的,你可以随时关闭此页面</li>
              <li>取消下线可恢复(只要还没全部迁完)</li>
              <li>所有数据安全到位之后,节点状态会自动变成「已停用」</li>
            </ul>
            <div className="alert alert-warn" style={{ marginTop: 8 }}>
              确认其他节点剩余容量 ≥ {formatBytes(used)},否则迁移会卡住。
            </div>
          </div>
        </Dialog>
      )}
    </section>
  );
}

// ---- subcomponents ----

function StatusStrip({ buckets }: { buckets: ProbeBucket[] }) {
  // 60 evenly-spaced pills color-coded by uptime%.
  // Empty bucket (no samples) is rendered as a hollow placeholder so the user
  // can tell missing-data apart from down-time.
  return (
    <div className="status-strip" role="img" aria-label="60-bucket uptime strip">
      {(buckets.length > 0 ? buckets : Array.from({ length: 60 }, () => null)).map((b, i) => {
        const cls = !b
          ? "is-empty"
          : b.uptimePct < 0
            ? "is-empty"
            : b.uptimePct === 100
              ? "is-ok"
              : b.uptimePct === 0
                ? "is-down"
                : "is-degraded";
        const title = !b || b.sampleCount === 0
          ? `${new Date().toLocaleString()} · 无数据`
          : `${new Date(b.at).toLocaleString()} · ${b.uptimePct}% 在线 · ${b.latencyMs != null ? `${b.latencyMs}ms` : "-"} · ${b.sampleCount} 次探测`;
        return <span key={i} className={`status-pill ${cls}`} title={title} />;
      })}
    </div>
  );
}

function StatTile({ label, value, hint, good, bad }: { label: string; value: string; hint?: string; good?: boolean; bad?: boolean }) {
  return (
    <div className="stat-card">
      <span className="stat-label">{label}</span>
      <span
        className="stat-value"
        style={{ color: bad ? "var(--danger)" : good ? "var(--good)" : undefined }}
      >
        {value}
      </span>
      {hint && <span className="stat-hint">{hint}</span>}
    </div>
  );
}

function LatencyChart({ buckets, loading }: { buckets: ProbeBucket[]; loading: boolean }) {
  const width = 1000;
  const height = 220;
  const padding = { top: 12, right: 12, bottom: 24, left: 44 };
  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;
  const points = buckets.map((b, i) => ({ i, l: b.latencyMs }));

  const ys = points.map((p) => p.l).filter((v): v is number => v != null);
  const max = ys.length > 0 ? Math.max(...ys, 1) : 1;
  const min = ys.length > 0 ? Math.min(...ys) : 0;
  const yMax = Math.ceil((max + (max - min) * 0.15) || 10);
  const yMin = Math.max(0, Math.floor(min - (max - min) * 0.05));

  const x = (i: number) => padding.left + (i / Math.max(1, buckets.length - 1)) * innerW;
  const y = (v: number) => padding.top + innerH - ((v - yMin) / Math.max(1, yMax - yMin)) * innerH;

  // Build path with breaks for null values
  const segments: string[] = [];
  let cur = "";
  for (const p of points) {
    if (p.l == null) {
      if (cur) { segments.push(cur); cur = ""; }
    } else {
      cur += cur ? ` L${x(p.i)},${y(p.l)}` : `M${x(p.i)},${y(p.l)}`;
    }
  }
  if (cur) segments.push(cur);

  const gridYValues = 4;
  const gridLines: number[] = [];
  for (let i = 0; i <= gridYValues; i += 1) {
    gridLines.push(yMin + ((yMax - yMin) * i) / gridYValues);
  }

  if (buckets.length === 0 && !loading) {
    return (
      <div className="empty-state" style={{ padding: 36 }}>
        <Activity size={20} />
        <strong>暂无数据</strong>
        <span>探测启动后约 30 秒会出现首个数据点</span>
      </div>
    );
  }

  return (
    <div className="latency-chart-wrap">
      <svg viewBox={`0 0 ${width} ${height}`} className="latency-chart" preserveAspectRatio="none">
        {/* Y grid + labels */}
        {gridLines.map((v, i) => {
          const yy = y(v);
          return (
            <g key={i}>
              <line x1={padding.left} y1={yy} x2={padding.left + innerW} y2={yy} stroke="var(--border)" strokeWidth={1} />
              <text x={padding.left - 6} y={yy + 4} textAnchor="end" fontSize={10} fill="var(--fg-subtle)">
                {Math.round(v)}ms
              </text>
            </g>
          );
        })}
        {/* Path */}
        {segments.map((seg, i) => (
          <path key={i} d={seg} fill="none" stroke="var(--brand)" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
        ))}
        {/* X-axis bottom rule */}
        <line x1={padding.left} y1={padding.top + innerH} x2={padding.left + innerW} y2={padding.top + innerH} stroke="var(--border-strong)" />
      </svg>
      {loading && <div className="muted" style={{ fontSize: 11, position: "absolute", top: 8, right: 12 }}>更新中…</div>}
    </div>
  );
}

function fmtPing(ms: number | null | undefined): string {
  if (ms == null) return "—";
  return `${ms.toFixed(2)} ms`;
}

function fmtPct(pct: number | null | undefined): string {
  if (pct == null) return "—";
  return `${pct.toFixed(2)}%`;
}
