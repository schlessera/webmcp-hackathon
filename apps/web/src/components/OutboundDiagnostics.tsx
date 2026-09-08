import { useEffect, useState } from "react";
import { currentToken } from "../session.ts";
import { formatBytes, formatMs } from "../wire-timeline.ts";

interface Row {
  host: string; route: string; attempts: number; successes: number; bytesDown: number;
  latencyMs: { p50: number; p95: number; max: number };
  proxyFailures: Record<string, number>; targetFailures: Record<string, number>;
  targetStatus: Record<string, number>; lastAt: string;
}
export function OutboundDiagnostics() {
  const [version, setVersion] = useState(0);
  const [state, setState] = useState<{ loading?: boolean; message?: string; at?: string; rows?: Row[] }>({ loading: true });
  useEffect(() => {
    const token = currentToken();
    if (!token) { setState({ message: "Sign in to inspect outbound diagnostics." }); return; }
    const controller = new AbortController();
    setState((old) => ({ ...old, loading: true, message: undefined }));
    void fetch("/api/diag/outbound", { headers: { authorization: `Bearer ${token}` }, signal: controller.signal })
      .then(async (response) => {
        if (response.status === 404) return { message: "Global outbound logs are available in development only. Request-specific server spans remain available in Wire." };
        if (!response.ok) throw new Error("unavailable");
        const body = await response.json();
        return { at: body.generatedAt as string, rows: (body.rows ?? []).slice(0, 100) as Row[] };
      }).then((next) => { if (!controller.signal.aborted) setState(next); })
      .catch(() => { if (!controller.signal.aborted) setState({ message: "Could not load outbound diagnostics. Refresh to try again." }); });
    return () => controller.abort();
  }, [version]);
  const rows = [...(state.rows ?? [])].sort((a, b) => (b.attempts - b.successes) - (a.attempts - a.successes) || b.latencyMs.p95 - a.latencyMs.p95);
  return <div className="wire-outbound" data-testid="diag-outbound">
    <div className="wire-toolbar"><span>{state.at ? `Snapshot ${new Date(state.at).toLocaleTimeString()}` : "Outbound providers"}</span>
      <button className="wire-control" disabled={state.loading} onClick={() => setVersion((v) => v + 1)}>{state.loading ? "Loading…" : "Refresh"}</button></div>
    <p className="wire-help">Development process totals across rooms, grouped by host and route. Open a row for failure details. Latency is time to response headers.</p>
    {state.message && <p role="status">{state.message}</p>}
    {!state.loading && !state.message && !rows.length && <p>No outbound attempts recorded in this process.</p>}
    {rows.map((row) => <details key={`${row.host}-${row.route}`}><summary><strong>{row.host}</strong><span>{row.route} · {row.successes}/{row.attempts} succeeded · p95 {formatMs(row.latencyMs.p95)}</span></summary>
      <dl className="wire-properties"><div><dt>Body bytes</dt><dd>{formatBytes(row.bytesDown)}</dd></div>
        <div><dt>p50 / p95 / max</dt><dd>{[row.latencyMs.p50, row.latencyMs.p95, row.latencyMs.max].map(formatMs).join(" / ")}</dd></div>
        <div><dt>Proxy failures</dt><dd>{Object.entries(row.proxyFailures).filter(([, n]) => n).map(([k, n]) => `${k}: ${n}`).join(", ") || "none"}</dd></div>
        <div><dt>Target failures</dt><dd>{Object.entries(row.targetFailures).filter(([, n]) => n).map(([k, n]) => `${k}: ${n}`).join(", ") || "none"}</dd></div>
        <div><dt>Status counts</dt><dd>{Object.entries(row.targetStatus).map(([k, n]) => `${k}: ${n}`).join(", ") || "none reported"}</dd></div>
      </dl></details>)}
  </div>;
}
