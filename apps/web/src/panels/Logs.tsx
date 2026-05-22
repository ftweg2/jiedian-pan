import { AlertCircle, ChevronLeft, ChevronRight, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, type AccessLog, type AccessLogList } from "../api.js";
import { EmptyState, TableState } from "../components/Empty.js";
import { stage8ErrorMessage } from "../lib/errors.js";
import { formatFullDateTime } from "../lib/format.js";

const PAGE_SIZE = 25;

export function LogsPanel({ initialLogs, loading }: { initialLogs: AccessLog[]; loading: boolean }) {
  const [logs, setLogs] = useState<AccessLog[]>(initialLogs);
  const [query, setQuery] = useState("");
  const [actionFilter, setActionFilter] = useState("all");
  const [resultFilter, setResultFilter] = useState("all");
  const [fromTime, setFromTime] = useState("");
  const [toTime, setToTime] = useState("");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState<number | null>(null);
  const [logLoading, setLogLoading] = useState(false);
  const [logError, setLogError] = useState<string | null>(null);

  const normalizedQuery = query.trim().toLowerCase();
  const actionOptions = useMemo(() => Array.from(new Set(logs.map((log) => log.action))).slice(0, 8), [logs]);
  const resultOptions = useMemo(() => Array.from(new Set(logs.map((log) => log.result))).slice(0, 8), [logs]);

  const visibleLogs = logs.filter((log) => {
    if (actionFilter !== "all" && log.action !== actionFilter) return false;
    if (resultFilter !== "all" && log.result !== resultFilter) return false;
    if (!normalizedQuery) return true;
    return [log.actor, log.file, log.action, log.result, log.ip].filter(Boolean).some((value) => value!.toLowerCase().includes(normalizedQuery));
  });
  const pageCount = total == null ? null : Math.max(1, Math.ceil(total / PAGE_SIZE));
  const canGoNext = pageCount == null ? logs.length >= PAGE_SIZE : page < pageCount;

  useEffect(() => { setLogs(initialLogs); }, [initialLogs]);

  useEffect(() => {
    let cancelled = false;
    setLogLoading(true);
    setLogError(null);
    const params = new URLSearchParams({ pageSize: String(PAGE_SIZE), page: String(page) });
    if (actionFilter !== "all") params.set("action", actionFilter);
    if (resultFilter !== "all") params.set("result", resultFilter);
    if (fromTime) params.set("from", new Date(fromTime).toISOString());
    if (toTime) params.set("to", new Date(toTime).toISOString());
    api<AccessLogList>(`/access-logs?${params.toString()}`)
      .then((response) => {
        if (cancelled) return;
        setLogs(response.logs ?? response.items ?? []);
        setTotal(response.total ?? null);
      })
      .catch((err) => { if (!cancelled) setLogError(stage8ErrorMessage(err, "读取访问记录")); })
      .finally(() => { if (!cancelled) setLogLoading(false); });
    return () => { cancelled = true; };
  }, [actionFilter, resultFilter, fromTime, toTime, page]);

  function reset(setter: (next: string) => void) {
    return (next: string) => { setter(next); setPage(1); };
  }

  return (
    <div className="stack">
      <div className="stack-sm">
        <h2 style={{ fontSize: 18, fontWeight: 600 }}>访问记录</h2>
        <p className="muted" style={{ fontSize: 13 }}>用于追踪登录、下载、分享访问和失败请求,排查外链泄露或节点异常时先看这里。</p>
      </div>

      <div className="card card-pad stack-sm">
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <div className="input-search" style={{ flex: 1, minWidth: 220 }}>
            <Search size={14} />
            <input className="input" placeholder="搜索动作、文件、用户或 IP" value={query} onChange={(event) => setQuery(event.target.value)} />
          </div>
          <select className="select" style={{ width: "auto" }} value={actionFilter} onChange={(event) => reset(setActionFilter)(event.target.value)}>
            <option value="all">全部动作</option>
            {actionOptions.map((action) => <option key={action} value={action}>{action}</option>)}
          </select>
          <select className="select" style={{ width: "auto" }} value={resultFilter} onChange={(event) => reset(setResultFilter)(event.target.value)}>
            <option value="all">全部结果</option>
            {resultOptions.map((result) => <option key={result} value={result}>{result}</option>)}
          </select>
        </div>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <div className="field" style={{ flex: 1 }}>
            <label className="field-label">开始时间</label>
            <input className="input" type="datetime-local" value={fromTime} onChange={(event) => reset(setFromTime)(event.target.value)} />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label className="field-label">结束时间</label>
            <input className="input" type="datetime-local" value={toTime} onChange={(event) => reset(setToTime)(event.target.value)} />
          </div>
        </div>
      </div>

      {logError && <div className="alert alert-danger"><AlertCircle size={14} />{logError}</div>}

      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>时间</th><th>动作</th><th>结果</th><th>文件</th><th>用户</th><th>IP</th></tr></thead>
          <tbody>
            {(loading || logLoading) && <TableState colSpan={6}><span className="spinner" /> 加载中...</TableState>}
            {!loading && !logLoading && visibleLogs.length === 0 && (
              <tr><td colSpan={6}><EmptyState icon={<Search size={20} />} title={logs.length === 0 ? "暂无访问记录" : "没有匹配的记录"} /></td></tr>
            )}
            {visibleLogs.map((log) => {
              const success = log.result.toLowerCase() === "ok" || log.result.toLowerCase() === "success";
              const failure = !success && /fail|error|denied|bad/.test(log.result.toLowerCase());
              return (
                <tr key={log.id}>
                  <td className="muted mono" style={{ fontSize: 12 }}>{formatFullDateTime(log.createdAt)}</td>
                  <td><span className="mono" style={{ fontSize: 12 }}>{log.action}</span></td>
                  <td><span className={`badge badge-${success ? "good" : failure ? "danger" : "warn"}`}>{log.result}</span></td>
                  <td className="muted" style={{ fontSize: 12 }}>{log.file ?? "—"}</td>
                  <td className="muted" style={{ fontSize: 12 }}>{log.actor ?? "—"}</td>
                  <td className="muted mono" style={{ fontSize: 12 }}>{log.ip ?? "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="row" style={{ justifyContent: "center", gap: 8 }}>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1 || logLoading}>
          <ChevronLeft size={12} /> 上一页
        </button>
        <span className="muted" style={{ fontSize: 12 }}>第 {page} 页{pageCount ? ` / ${pageCount}` : ""}</span>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPage((p) => p + 1)} disabled={logLoading || !canGoNext}>
          下一页 <ChevronRight size={12} />
        </button>
      </div>
    </div>
  );
}
