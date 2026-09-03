import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { wire, type WireEvent, type WireLane, type WireStep } from "../wire-store.ts";
import {
  LANES,
  buildTimeline,
  formatBytes,
  formatClock,
  formatMs,
  relatedIds,
  type Connector,
  type TimelineRow,
} from "../wire-timeline.ts";

/**
 * The wire, drawn: one row per request, frame, tool call, agent turn or page
 * moment, a lane column per kind, spans as lines, causes as connectors. A
 * timeline, not a log. Lives only inside the `{ }` drawer (CLAUDE.md §6).
 *
 * Lanes tell by column and by mark shape, outcomes by fill and a cross, so
 * the graph survives greyscale (§13). Motion is the busy ring only (§9).
 */

/** Row height. Paired with `--wire-row` in styles.css; change both. */
export const ROW_H = 16;
const LANE_W = 9;
const GRAPH_PAD = 2;
const GRAPH_W = GRAPH_PAD * 2 + LANE_W * LANES.length;
const FOLLOW_SLACK_PX = 24;

const laneX = (lane: number) => GRAPH_PAD + lane * LANE_W + LANE_W / 2;

/** Half-size of each lane's mark, so a connector stops at its edge. */
const MARK_R: Record<WireLane, number> = { page: 1.5, http: 2.5, ws: 3.5, tool: 2.5, agent: 4.5 };

/** Bar length for a duration: log scale, 40px at ten seconds. */
function barWidth(ms: number): number {
  return Math.min(44, 10 * Math.log10(Math.max(0, ms) + 1));
}

/** Parent and link connectors: down from the source's column at the row's
 * top edge, a quarter round, then across to the mark. */
function connectorPath(from: number, to: number, y: number, toLane: WireLane): string {
  const top = y - ROW_H / 2;
  if (from === to) return `M${from},${top} V${y - MARK_R[toLane] - 1}`;
  const dir = to > from ? 1 : -1;
  const r = 3;
  return `M${from},${top} V${y - r} Q${from},${y} ${from + dir * r},${y} H${to - dir * (MARK_R[toLane] + 1)}`;
}

function Mark({ event, x, y, open }: { event: WireEvent; x: number; y: number; open: boolean }) {
  const { lane, dir, outcome } = event;
  return (
    // Position on the wrapper, animate on the inner ring (§9 trap).
    <g className="wire-mark" data-lane={lane} data-outcome={outcome} transform={`translate(${x},${y})`}>
      {lane === "page" && <circle r={1.5} className="wire-fill" />}
      {lane === "http" && <circle r={2.5} className="wire-fill" />}
      {lane === "ws" && (
        <rect x={-2.5} y={-2.5} width={5} height={5} transform="rotate(45)" className={dir === "out" ? "wire-hollow" : "wire-fill"} />
      )}
      {lane === "tool" && <circle r={2.5} className="wire-hollow wire-thick" />}
      {lane === "agent" && (
        <>
          <circle r={4.5} className="wire-hollow" />
          <circle r={2.5} className="wire-hollow" />
        </>
      )}
      {outcome === "error" && <line x1={-3.5} y1={3.5} x2={3.5} y2={-3.5} className="wire-cross" />}
      {open && <circle r={6} className="wire-busy" />}
    </g>
  );
}

/* One row of the graph. Memoised: on the 1s clock nothing here changes (the
   busy ring is CSS-animated), so closed rows are skipped by identity. */
const GraphRow = memo(function GraphRow({
  event,
  connectors,
  x,
  y,
  endY,
  open,
  related,
}: {
  event: WireEvent;
  connectors: Connector[];
  x: number;
  y: number;
  endY: number | null;
  open: boolean;
  related: boolean | undefined;
}) {
  return (
    <g className={related ? "wire-g is-related" : "wire-g"} data-lane={event.lane}>
      {connectors.map((c, k) => (
        <path
          key={k}
          className={`wire-conn wire-conn-${c.kind}`}
          d={connectorPath(laneX(c.fromLane), x, y, event.lane)}
        />
      ))}
      {endY !== null && (
        <line
          className="wire-span"
          data-open={open || undefined}
          x1={x}
          y1={y + MARK_R[event.lane] + 1}
          x2={x}
          y2={endY}
        />
      )}
      <Mark event={event} x={x} y={y} open={open} />
    </g>
  );
});

function StepBar({ ms }: { ms?: number }) {
  if (ms === undefined) return null;
  return (
    <span className="wire-tail">
      <span className="wire-bar" style={{ width: barWidth(ms) }} />
      <span className="wire-ms">{formatMs(ms)}</span>
    </span>
  );
}

function Detail({ event, innerRef }: { event: WireEvent; innerRef: React.RefObject<HTMLDivElement> }) {
  const pairs = Object.entries(event.detail ?? {}).filter(
    (entry): entry is [string, string | number | boolean] => entry[1] !== undefined && entry[1] !== null,
  );
  const steps: WireStep[] = event.steps ?? [];
  return (
    <div className="wire-detail" ref={innerRef}>
      {pairs.length === 0 && steps.length === 0 && <span className="wire-detail-empty">no detail</span>}
      {pairs.length > 0 && (
        <dl className="wire-kv">
          {pairs.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{String(v)}</dd>
            </div>
          ))}
        </dl>
      )}
      {steps.length > 0 && (
        <ol className="wire-steps">
          {steps.map((step, i) => (
            <li key={i}>
              <span className="wire-step-label">{step.label}</span>
              {step.ok === false && <span className="wire-tag">failed</span>}
              <StepBar ms={step.ms} />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function rowSentence(event: WireEvent, ms: number | null): string {
  const parts = [event.lane, event.label];
  if (event.note) parts.push(event.note);
  const sentence = parts.join(" ");
  return ms === null ? sentence : `${sentence} in ${formatMs(ms)}`;
}

/* One text row. Memoised by props identity: `event` and `retry` come from the
   memoised layout, `related` is undefined until something is hovered, and
   `now` is passed only while the span is open, so the 1s clock re-renders
   open rows alone. */
const Row = memo(function Row({
  event,
  open,
  retry,
  expanded,
  related,
  now,
  detailRef,
  onToggle,
  onEnter,
  onLeave,
}: {
  event: WireEvent;
  open: boolean;
  retry: boolean;
  expanded: boolean;
  related: boolean | undefined;
  now: number | undefined;
  detailRef: React.RefObject<HTMLDivElement>;
  onToggle(id: string): void;
  onEnter(id: string): void;
  onLeave(id: string): void;
}) {
  const e = event;
  const isSpan = e.endAt === undefined || e.endAt > e.at;
  const ms = isSpan ? (e.endAt ?? now ?? e.at) - e.at : null;
  const tags: string[] = [];
  if (e.bytes !== undefined) {
    tags.push(`${formatBytes(e.bytes)}${e.budget !== undefined ? `/${formatBytes(e.budget)}` : ""}`);
  }
  if (e.truncated) tags.push("cut");
  if (retry) tags.push("retry");
  if (e.note?.includes("· staged")) tags.push("staged");
  const width = ms !== null ? barWidth(ms) : 0;
  const serverW = ms !== null && e.serverMs !== undefined && ms > 0
    ? Math.min(width, (width * e.serverMs) / ms)
    : null;
  return (
    <div className="wire-item">
      {/* Drawn and hit 16px tall, below the 44px floor (§13): a band would
          overlap the neighbours and steal their taps. Tab focus is precise. */}
      <button
        type="button"
        className="wire-row"
        data-lane={e.lane}
        data-outcome={e.outcome}
        data-open={open || undefined}
        data-related={related === undefined ? undefined : String(related)}
        aria-expanded={expanded}
        aria-label={rowSentence(e, ms)}
        onClick={() => onToggle(e.id)}
        onMouseEnter={() => onEnter(e.id)}
        onMouseLeave={() => onLeave(e.id)}
        onFocus={() => onEnter(e.id)}
        onBlur={() => onLeave(e.id)}
      >
        <span className="wire-clock">{formatClock(e.at)}</span>
        <span className="wire-graph-cell" />
        <span className="wire-text">
          <span className="wire-label">{e.label}</span>
          {e.note && <span className="wire-note">{e.note}</span>}
          <span className="wire-tail">
            {tags.map((tag) => (
              <span key={tag} className="wire-tag">{tag}</span>
            ))}
            {ms !== null && (
              <>
                <span className="wire-bar" style={{ width }}>
                  {serverW !== null && (
                    <span className="wire-bar-server" style={{ width: serverW, left: (width - serverW) / 2 }} />
                  )}
                </span>
                <span className="wire-ms">{formatMs(ms)}</span>
              </>
            )}
          </span>
        </span>
      </button>
      {expanded && <Detail event={e} innerRef={detailRef} />}
    </div>
  );
});

interface Props {
  /** The socket is open right now (the live dot). */
  live: boolean;
  /** Lanes (and "ping") switched off; remembered by the diagnostics store. */
  hidden: string[];
  onHiddenChange(next: string[]): void;
}

export function WireTimeline({ live, hidden, onHiddenChange }: Props) {
  const state = useSyncExternalStore(
    (cb) => wire.subscribe(cb),
    () => wire.state,
  );
  const { events } = state;
  const hiddenKey = hidden.join(",");
  const hiddenSet = useMemo(() => new Set(hidden as Array<WireLane | "ping">), [hiddenKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = useMemo(
    () => buildTimeline(events, { now: Date.now(), hidden: hiddenSet }),
    [events, hiddenSet],
  );

  // Open spans grow while the reader watches: a once-a-second clock, only
  // while something is open, and handed only to the open rows.
  const anyOpen = events.some((e) => e.endAt === undefined);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!anyOpen) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [anyOpen]);

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [hotId, setHotId] = useState<string | null>(null);
  const related = useMemo(
    () => (hotId ? relatedIds(events, hotId) : null),
    [events, hotId],
  );
  const onToggle = useCallback((id: string) => setExpandedId((current) => (current === id ? null : id)), []);
  const onEnter = useCallback((id: string) => setHotId(id), []);
  const onLeave = useCallback((id: string) => setHotId((current) => (current === id ? null : current)), []);

  /* The expanded detail block pushes the rows under it down; the graph is
     one SVG over the whole list, so its rows below shift by the measured
     height of that block. */
  const expandedIndex = useMemo(() => {
    if (!expandedId) return null;
    const index = rows.findIndex((row) => row.kind === "event" && row.event.id === expandedId);
    return index < 0 ? null : index;
  }, [rows, expandedId]);
  const detailRef = useRef<HTMLDivElement>(null);
  const [detailH, setDetailH] = useState(0);
  useLayoutEffect(() => {
    const el = detailRef.current;
    if (!el) {
      setDetailH(0);
      return;
    }
    const measure = () => setDetailH(el.getBoundingClientRect().height);
    measure();
    // The block the reader just opened stays in view, with the least scroll.
    el.parentElement?.scrollIntoView({ block: "nearest" });
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [expandedIndex]);
  const rowTop = (index: number) =>
    index * ROW_H + (expandedIndex !== null && index > expandedIndex ? detailH : 0);
  const graphHeight = rows.length * ROW_H + (expandedIndex !== null ? detailH : 0);

  /* Follow the newest row while the reader is at the bottom; scrolling up
     pauses that until they ask for the newest again. Only a new row moves
     the list, never an expanded block. */
  const scrollRef = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const followingRef = useRef(true);
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_SLACK_PX;
    followingRef.current = atBottom;
    setFollowing(atBottom);
  };
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && followingRef.current) el.scrollTop = el.scrollHeight;
  }, [rows.length]);

  const toggle = (name: string) => {
    onHiddenChange(hidden.includes(name) ? hidden.filter((h) => h !== name) : [...hidden, name]);
  };

  const shownCount = rows.reduce((n, row) => n + (row.kind === "event" ? 1 : 0), 0);

  return (
    <div className="wire" data-testid="diag-wire">
      <div className="wire-head">
        <span className="wire-count">
          <i className="wire-live" data-live={live || undefined} aria-hidden="true" />
          <span className="sr-only">{live ? "socket open" : "socket closed"}, </span>
          {shownCount} on the wire
        </span>
        <div className="wire-lanes" role="group" aria-label="Lanes shown">
          {[...LANES, "ping"].map((name) => (
            <button
              key={name}
              type="button"
              className="wire-chip"
              aria-pressed={!hidden.includes(name)}
              onClick={() => toggle(name)}
            >
              {name}
            </button>
          ))}
        </div>
      </div>

      <div className="wire-scroll" ref={scrollRef} onScroll={onScroll}>
        {rows.length === 0 ? (
          <div className="wire-empty">nothing on the wire yet</div>
        ) : (
          <div className="wire-list" data-hot={hotId ? "true" : undefined}>
            <svg
              className="wire-graph"
              width={GRAPH_W}
              height={graphHeight}
              viewBox={`0 0 ${GRAPH_W} ${graphHeight}`}
              aria-hidden="true"
            >
              {rows.map((row, index) => {
                if (row.kind !== "event") return null;
                return (
                  <GraphRow
                    key={row.event.id}
                    event={row.event}
                    connectors={row.connectors}
                    x={laneX(row.lane)}
                    y={rowTop(index) + ROW_H / 2}
                    endY={row.spanRows > 0 ? rowTop(index + row.spanRows) + ROW_H / 2 : null}
                    open={row.open}
                    related={related ? related.has(row.event.id) : undefined}
                  />
                );
              })}
            </svg>

            {rows.map((row, index) => {
              if (row.kind === "minute") {
                return (
                  <div key={`m${index}`} className="wire-minute" role="presentation">
                    <span className="wire-clock">{row.label}</span>
                    <span className="wire-rule" />
                  </div>
                );
              }
              if (row.kind === "gap") {
                return (
                  <div key={`g${index}`} className="wire-gap" role="presentation">
                    <span className="wire-clock" />
                    <span className="wire-gap-break" />
                    <span className="wire-gap-label">· {formatMs(row.ms)} ·</span>
                  </div>
                );
              }
              const e = row.event;
              return (
                <Row
                  key={e.id}
                  event={e}
                  open={row.open}
                  retry={e.replayed === true || (e.lane === "http" && row.connectors.some((c) => c.kind === "link"))}
                  expanded={e.id === expandedId}
                  related={related ? related.has(e.id) : undefined}
                  now={row.open ? now : undefined}
                  detailRef={detailRef}
                  onToggle={onToggle}
                  onEnter={onEnter}
                  onLeave={onLeave}
                />
              );
            })}
          </div>
        )}
        {!following && rows.length > 0 && (
          <button
            type="button"
            className="wire-newest"
            onClick={() => {
              followingRef.current = true;
              setFollowing(true);
              const el = scrollRef.current;
              if (el) el.scrollTop = el.scrollHeight;
            }}
          >
            ↓ newest
          </button>
        )}
      </div>
    </div>
  );
}

export type { TimelineRow };
