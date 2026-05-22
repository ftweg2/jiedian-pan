import { Activity, ArrowLeft, ChevronDown, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, type NodeItem } from "../api.js";
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
    </div>
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
