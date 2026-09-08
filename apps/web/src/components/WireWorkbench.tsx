import { memo, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { wire, WIRE_RING, type WireEvent, type WireState } from "../wire-store.ts";
import { LANES, formatBytes, formatMs } from "../wire-timeline.ts";
import { attention, connectedIds, elapsed, eventMatches, summarizeWire, wireExport, wireRelations, type WireRelation } from "../wire-insights.ts";
import "./wire.css";
import { WireFlow } from "./WireFlow.tsx";

const ROW_H = 44;
const subscribe = (cb: () => void) => wire.subscribe(cb);
const snapshot = () => wire.state;
const noopSubscribe = () => () => {};
const names = { page: "Page", http: "HTTP", ws: "Socket", tool: "Tool", agent: "Agent" };
const clock = (at: number) => `${new Date(at).toLocaleTimeString([], { hour12: false })}.${String(new Date(at).getMilliseconds()).padStart(3, "0")}`;

function Mark({ event }: { event: Pick<WireEvent, "lane" | "outcome" | "endAt" | "dir"> }) {
  return <svg className="wire-symbol" viewBox="0 0 20 20" aria-hidden="true" data-outcome={event.outcome}>
    {event.lane === "page" && <rect x="7" y="7" width="6" height="6" />}
    {event.lane === "http" && <circle cx="10" cy="10" r="4" />}
    {event.lane === "ws" && <path d="M10 4 16 10 10 16 4 10Z" className={event.dir === "out" ? "is-hollow" : ""} />}
    {event.lane === "tool" && <path d="M6 4 2 10 6 16 M14 4 18 10 14 16" className="is-stroke" />}
    {event.lane === "agent" && <><circle cx="10" cy="10" r="6" className="is-hollow" /><circle cx="10" cy="10" r="2" /></>}
    {(event.outcome === "error" || event.outcome === "blocked") && <path d="M3 17 17 3" className="is-stroke" />}
    {event.endAt === undefined && <circle cx="10" cy="10" r="8" className="is-running" />}
  </svg>;
}

function download(value: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const link = document.createElement("a"); link.href = url; link.download = `spokes-wire-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const EventRow = memo(function EventRow({ event, selected, related, now, start, range, timing, onSelect }: {
  event: WireEvent; selected: boolean; related: boolean; now?: number; start: number; range: number;
  timing: boolean; onSelect(id: string): void;
}) {
  const ms = elapsed(event, now);
  const status = event.endAt === undefined ? "running" : event.outcome ?? "received";
  return <button type="button" className="wire-event" data-wire-id={event.id} data-selected={selected || undefined}
    data-related={related || undefined} data-outcome={event.outcome} aria-pressed={selected}
    aria-label={`${names[event.lane]} ${event.label}, ${event.note ?? status}, ${formatMs(ms)}`}
    onClick={() => onSelect(event.id)}>
    <Mark event={event} />
    <span className="wire-event-copy"><span className="wire-event-title">{event.label}</span>
      <span className="wire-event-note">{clock(event.at)} · {event.note ?? status}{event.status ? ` · HTTP ${event.status}` : ""}</span></span>
    {timing && <span className="wire-waterfall-track" aria-hidden="true"><i style={{ left: `${Math.max(0, (event.at - start) / range * 100)}%`, width: `${Math.min(100, Math.max(.5, ms / range * 100))}%` }} data-open={event.endAt === undefined || undefined} /></span>}
      <span className="wire-event-end"><span>{event.endAt === event.at && event.durationMs === undefined ? names[event.lane] : formatMs(ms)}</span>
      <span>{attention(event) ? "check" : event.replayed ? "replayed" : event.bytes !== undefined ? formatBytes(event.bytes) : status}</span></span>
  </button>;
});

function Timing({ event, now }: { event: WireEvent; now: number }) {
  const total = elapsed(event, now);
  const measures = [
    ["Server before headers", event.serverMs],
    ["Outside server measurement", event.headersMs !== undefined && event.serverMs !== undefined ? Math.max(0, event.headersMs - event.serverMs) : undefined],
    ["Read response body", event.bodyMs], ["Parse JSON", event.parseMs],
  ] as const;
  if (!measures.some(([, ms]) => ms !== undefined)) return null;
  return <section className="wire-inspector-section"><h4>Where the time went</h4>
    <div className="wire-timing-stack" aria-hidden="true">{measures.map(([label, ms], i) => ms === undefined ? null :
      <i key={label} data-part={i} style={{ flexBasis: `${Math.min(100, ms / Math.max(1, total) * 100)}%` }} />)}</div>
    <dl className="wire-properties">{measures.map(([label, ms]) => <div key={label}><dt>{label}</dt><dd>{ms === undefined ? "not measured" : formatMs(ms)}</dd></div>)}</dl>
    <p className="wire-help">The remainder includes transit and browser scheduling. It is not a pure network measurement. Server spans below can overlap.</p>
  </section>;
}

function Inspector({ event, events, relations, now, onSelect, onFocus, onClose }: {
  event: WireEvent; events: WireEvent[]; relations: WireRelation[]; now: number;
  onSelect(id: string): void; onFocus(): void; onClose(): void;
}) {
  const neighbors = relations.filter((r) => r.source === event.id || r.target === event.id);
  const byId = new Map(events.map((e) => [e.id, e]));
  const server = event.serverTrace;
  const metadata = { event: event.id, lane: event.lane, outcome: event.outcome ?? (event.endAt === undefined ? "running" : "instant"),
    started: new Date(event.at).toISOString(), duration: formatMs(elapsed(event, now)), status: event.status,
    correlation: event.correlationId, parent: event.parentId, idempotency: event.idempotencyKey,
    revision: event.revision, fromRevision: event.fromRevision, bodyBytes: event.bytes, budgetCharacters: event.budget,
    compacted: event.truncated, replayed: event.replayed, failure: event.failureKind, ...event.detail };
  return <aside className="wire-inspector" aria-label="Event details" data-testid="wire-inspector">
    <div className="wire-inspector-head"><Mark event={event} /><div><h3>{event.label}</h3><p>{event.note ?? event.outcome ?? (event.endAt === undefined ? "in progress" : "recorded")}</p></div>
      <button className="wire-control" onClick={onClose} aria-label="Close event details">Close</button></div>
    <div className="wire-inspector-actions"><button className="wire-control" onClick={onFocus}>Focus related events</button>
      <button className="wire-control" onClick={() => download(wireExport({ events: [event], seq: 0 }))}>Export event</button></div>
    {event.failureKind === "decode" && <p className="wire-notice">A response arrived, but its body was not valid JSON. The HTTP status is preserved above.</p>}
    {event.parentId && !byId.has(event.parentId) && <p className="wire-notice">The parent is outside the retained recording.</p>}
    <Timing event={event} now={now} />
    <section className="wire-inspector-section"><h4>Connections <span>{neighbors.length}</span></h4>
      {neighbors.length ? neighbors.map((r) => {
        const incoming = r.target === event.id, other = byId.get(incoming ? r.source : r.target)!;
        const label = r.kind === "parent" ? (incoming ? "Called by" : "Started") : r.kind === "correlation" ? "Same request ID" : r.kind === "retry" ? "Same operation / another attempt" : "Same revision / inferred";
        return <button className="wire-connection" key={`${r.kind}-${other.id}`} onClick={() => onSelect(other.id)}>
          <span className="wire-edge" data-inferred={r.kind === "revision" || undefined} aria-hidden="true" />
          <span><small>{label}</small><strong>{other.label}</strong></span><span>{incoming ? "←" : "→"}</span></button>;
      }) : <p className="wire-help">No recorded causal connection. Nearby timestamps alone do not establish one.</p>}
    </section>
    <section className="wire-inspector-section"><h4>Inside the server</h4>
      {server ? <><div className="wire-scale"><span>0</span><span>{formatMs(server.durationMs)} from trace start</span></div>
        <ol className="wire-server-spans">{server.spans.map((span, i) => <li key={i} data-outcome={span.outcome}>
          <div><strong>{span.label}</strong><span>{span.durationMs === undefined ? "still running at response" : formatMs(span.durationMs)}</span></div>
          <div className="wire-waterfall-track" aria-hidden="true"><i data-open={span.outcome === "running" || undefined}
            style={{ left: `${Math.min(99, span.offsetMs / Math.max(1, server.durationMs) * 100)}%`, width: `${Math.max(.5, Math.min(100, (span.durationMs ?? server.durationMs - span.offsetMs) / Math.max(1, server.durationMs) * 100))}%` }} /></div>
          <small>{span.kind} · {span.outcome}{span.status ? ` · HTTP ${span.status}` : ""}{span.bytes !== undefined ? ` · ${formatBytes(span.bytes)}` : ""}
            {span.inputTokens !== undefined ? ` · ${span.inputTokens} in / ${span.outputTokens ?? 0} out tokens` : ""}{span.costUsd !== undefined ? ` · $${span.costUsd.toFixed(4)}` : ""}</small>
        </li>)}</ol>
        {!server.spans.length && <p className="wire-help">No instrumented model, outbound or metadata-cache work in this request.</p>}
        {server.omitted > 0 && <p className="wire-notice">{server.omitted} additional spans omitted by the recording limit.</p>}
        <p className="wire-help">Snapshot at response headers. Later background progress arrives in socket pipeline and facts events.</p></>
        : <p className="wire-help">No server trace was attached to this event. Earlier builds and passive reads may provide only total server time.</p>}
    </section>
    {event.steps?.length ? <section className="wire-inspector-section"><h4>Reported stages</h4><ol className="wire-stage-list">{event.steps.map((step, i) =>
      <li key={i}><span>{step.label}{step.ok === false ? " · failed" : ""}</span><span>{step.ms === undefined ? "not timed" : formatMs(step.ms)}</span></li>)}</ol>
      <p className="wire-help">Reported durations; stage offsets were not recorded.</p></section> : null}
    <details className="wire-inspector-section"><summary>All recorded metadata</summary><dl className="wire-properties">{Object.entries(metadata).filter(([, v]) => v !== undefined && v !== null).map(([key, value]) =>
      <div key={key}><dt>{key}</dt><dd>{String(value)}</dd></div>)}</dl></details>
  </aside>;
}

interface Props { live: boolean; hidden: string[]; onHiddenChange(next: string[]): void }

export function WireWorkbench({ live, hidden, onHiddenChange }: Props) {
  const [paused, setPaused] = useState<WireState | null>(null);
  const frozenSnapshot = useCallback(() => paused!, [paused]);
  const state = useSyncExternalStore(paused ? noopSubscribe : subscribe, paused ? frozenSnapshot : snapshot);
  const [now, setNow] = useState(Date.now);
  const anyOpen = !paused && state.events.some((e) => e.endAt === undefined);
  useEffect(() => {
    if (!anyOpen) return;
    const timer = window.setInterval(() => { if (!document.hidden) setNow(Date.now()); }, 1000);
    return () => window.clearInterval(timer);
  }, [anyOpen]);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [filter, setFilter] = useState("all");
  const [view, setView] = useState("activity");
  const timing = view === "timing";
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [following, setFollowing] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 440 });
  const measureScroll = useCallback(() => {
    const el = scrollRef.current;
    if (el?.clientHeight) setViewport({ top: el.scrollTop, height: el.clientHeight });
  }, []);
  const events = state.events;
  const relations = useMemo(() => wireRelations(events), [events]);
  const related = useMemo(() => selectedId ? connectedIds(relations, selectedId) : new Set<string>(), [relations, selectedId]);
  const focused = useMemo(() => focusedId ? connectedIds(relations, focusedId) : null, [relations, focusedId]);
  const summary = useMemo(() => summarizeWire(events, now), [events, now]);
  const shown = useMemo(() => events.filter((e) => !hidden.includes(e.lane) && !(hidden.includes("ping") && e.label === "ping" && e.lane === "ws") &&
    (!focused || focused.has(e.id)) && eventMatches(e, deferredQuery) &&
    (filter === "all" || (filter === "attention" && attention(e)) || (filter === "running" && e.endAt === undefined) || (filter === "slow" && e.lane === "http" && elapsed(e, now) >= 2000)))
    .sort((a, b) => a.at - b.at), [events, hidden, focused, deferredQuery, filter, now]);
  const selected = events.find((e) => e.id === selectedId);
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (selectedId && root && root.clientWidth < 720) {
      root.querySelector<HTMLElement>(".wire-inspector")?.scrollIntoView({ block: "nearest" });
      root.querySelector<HTMLElement>('[aria-label="Close event details"]')?.focus({ preventScroll: true });
    }
  }, [selectedId]);
  const start = shown[0]?.at ?? now;
  const range = Math.max(1, ...shown.map((e) => e.at + elapsed(e, now) - start));
  const first = Math.max(0, Math.floor(viewport.top / ROW_H) - 5);
  const last = Math.min(shown.length, first + Math.ceil(viewport.height / ROW_H) + 12);
  useEffect(() => {
    const el = scrollRef.current; if (!el) return;
    const observer = new ResizeObserver(measureScroll); observer.observe(el); measureScroll();
    return () => observer.disconnect();
  }, [measureScroll]);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && following) { el.scrollTop = el.scrollHeight; measureScroll(); }
  }, [shown.at(-1)?.id, shown.length, following, measureScroll]);
  useLayoutEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    measureScroll();
  }, [filter, deferredQuery, focusedId, measureScroll]);
  const select = useCallback((id: string) => { setSelectedId(id); setFollowing(false); }, []);
  const goTo = (id: string) => {
    select(id);
    const index = shown.findIndex((e) => e.id === id);
    if (index >= 0 && scrollRef.current) { scrollRef.current.scrollTop = index * ROW_H; measureScroll(); }
  };
  const chooseFilter = (value: string) => { setFilter(value); setFollowing(false); };
  const reset = () => { setQuery(""); setFilter("all"); setFocusedId(null); onHiddenChange(["ping"]); };
  return <div className="wire-workbench" data-testid="diag-wire" data-inspecting={!!selected || undefined} ref={rootRef}>
    <div className="wire-toolbar"><div className="wire-recording"><i data-live={!paused && live || undefined} />{paused ? "View paused" : "Recording this page"}<small>{live ? "socket connected" : "socket disconnected"}</small></div>
      <div className="wire-actions"><button className="wire-control" aria-pressed={!!paused} onClick={() => { setNow(Date.now()); setPaused(paused ? null : wire.state); }}>{paused ? "Resume" : "Pause view"}</button>
        <button className="wire-control" onClick={() => download(wireExport(state, shown))}>Export {shown.length}</button>
        <button className="wire-control" onClick={() => { wire.clear(); setPaused(null); setSelectedId(null); setFocusedId(null); }}>Clear</button></div></div>
    <div className="wire-metrics" aria-label="Recording summary">
      <button onClick={() => chooseFilter("all")} aria-pressed={filter === "all"}><strong>{summary.total}</strong><span>events retained</span></button>
      <button onClick={() => chooseFilter("attention")} aria-pressed={filter === "attention"}><strong>{summary.attention}</strong><span>need attention</span></button>
      <button onClick={() => chooseFilter("running")} aria-pressed={filter === "running"}><strong>{summary.running}</strong><span>in flight</span></button>
      <button onClick={() => chooseFilter("slow")} aria-pressed={filter === "slow"}><strong>{summary.p95 === null ? "—" : formatMs(summary.p95)}</strong><span>HTTP p95 · {summary.slow} ≥2s</span></button>
      <div><strong>{formatBytes(summary.httpBytes)}</strong><span>HTTP bodies</span></div>
    </div>
    <div className="wire-filters"><input type="search" aria-label="Search wire events" placeholder="Search route, result, request ID…" value={query} onChange={(e) => { setQuery(e.target.value); setFollowing(false); }} />
      <div className="wire-view-switch" role="group" aria-label="Visualization">{["activity", "timing", "flow"].map((mode) => <button key={mode} className="wire-control" aria-pressed={view === mode} onClick={() => setView(mode)}>{mode[0].toUpperCase() + mode.slice(1)}</button>)}</div></div>
    <div className="wire-lane-filters" role="group" aria-label="Lanes shown">{[...LANES, "ping"].map((lane) => <button key={lane} aria-pressed={!hidden.includes(lane)}
      onClick={() => { onHiddenChange(hidden.includes(lane) ? hidden.filter((h) => h !== lane) : [...hidden, lane]); setFollowing(false); }}>
      {lane !== "ping" && <Mark event={{ lane: lane as WireEvent["lane"], endAt: 0 }} />}{lane === "ping" ? "Keepalives" : names[lane as WireEvent["lane"]]}</button>)}</div>
    <div className="wire-result-line"><span>{shown.length} shown{focusedId ? " · related events" : ""}{filter !== "all" ? ` · ${filter}` : ""}</span>
      {(focusedId || filter !== "all" || query || hidden.join() !== "ping") && <button className="wire-control" onClick={reset}>Reset filters</button>}
      {summary.modelCalls > 0 && <span>{summary.modelCalls} model attempts · {summary.usageCalls ? `${summary.tokens} reported tokens` : "usage not reported"}{summary.usageCalls > 0 && summary.usageCalls < summary.modelCalls ? ` (${summary.usageCalls} of ${summary.modelCalls} attempts)` : ""}{summary.costUsd ? ` · $${summary.costUsd.toFixed(4)}` : ""}</span>}</div>
    <div className="wire-workspace" data-inspecting={!!selected || undefined}>
      <div className="wire-stream-pane">
        {view === "flow" && <WireFlow events={shown} relations={relations} selectedId={selectedId} onSelect={select} />}
        <div hidden={view === "flow"}>
        {timing && <div className="wire-scale"><span>{clock(start)}</span><span>{formatMs(range)} window · linear time</span></div>}
        <div className="wire-stream" ref={scrollRef} tabIndex={0} role="region" aria-label="Wire events" data-testid="wire-stream"
          onScroll={() => { measureScroll(); const el = scrollRef.current; if (el) setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight < 20); }}
          onKeyDown={(e) => { if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
            e.preventDefault(); setFollowing(false);
            const at = shown.findIndex((row) => row.id === selectedId);
            const index = e.key === "Home" ? 0 : e.key === "End" ? shown.length - 1 : Math.max(0, Math.min(shown.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)));
            if (shown[index]) goTo(shown[index].id);
          }}>
          {shown.length ? <div style={{ height: shown.length * ROW_H, position: "relative" }}><div style={{ position: "absolute", top: first * ROW_H, left: 0, right: 0 }}>
            {shown.slice(first, last).map((event) => <EventRow key={event.id} event={event} selected={event.id === selectedId} related={related.has(event.id)}
              now={event.endAt === undefined ? now : undefined} start={timing ? start : 0} range={timing ? range : 1} timing={timing} onSelect={select} />)}
          </div></div> : <div className="wire-empty-state"><strong>{events.length ? "No events match" : "Waiting for activity"}</strong><p>{events.length ? "Change the search or reset filters to see the recording." : "Requests, socket frames, tools and agent turns appear here as you use Spokes."}</p></div>}
        </div>
        <div className="wire-stream-footer"><span>{following ? "Following latest" : "Reading history"}{paused ? " · capture continues" : ""}</span><button className="wire-control" onClick={() => { setFollowing(true); const el = scrollRef.current; if (el) { el.scrollTop = el.scrollHeight; measureScroll(); } }}>Latest</button></div>
        </div>
      </div>
      {selected ? <Inspector event={selected} events={events} relations={relations} now={now} onSelect={goTo}
        onFocus={() => { setFocusedId(selected.id); setFilter("all"); setQuery(""); onHiddenChange([]); setFollowing(false); }} onClose={() => setSelectedId(null)} />
        : <div className="wire-inspector-placeholder"><h3>Follow a request through the system</h3><p>Select an event for timings, connected calls, server work and recorded metadata.</p>
          <div className="wire-language"><span className="wire-edge" /> explicit parent or request ID <span className="wire-edge" data-inferred /> inferred revision match</div>
          <p>Timing uses a common linear scale. Activity preserves event order; neither assumes neighboring events caused each other.</p></div>}
    </div>
    <details className="wire-recording-notes"><summary>Recording scope and limits</summary><p>This browser page retains up to {WIRE_RING} events; keepalives have a separate cap. {state.dropped ?? 0} older events and {state.omittedPings ?? 0} excess keepalives have been evicted. Clear resets this page’s recording. Pause freezes this view while capture continues.</p>
      <p>Response sizes are decoded body bytes, not compressed transfer size. Tool budgets are characters. Server spans are opt-in, bounded snapshots; no prompts, credentials or response bodies are collected. Exports omit free-form detail fields.</p></details>
  </div>;
}
