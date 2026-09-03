/**
 * Timeline layout for the `{ }` drawer: turns the wire store's events into
 * rows with span extents and connectors, the way a git graph is laid out
 * before it is drawn. Pure; no DOM, no React; unit-tested in node.
 */
import type { WireEvent, WireLane } from "./wire-store.ts";

export const LANES: WireLane[] = ["page", "http", "ws", "tool", "agent"];

export interface TimelineOptions {
  /** Reserved for open-span rendering; the layout itself is time-independent. */
  now: number;
  /** Two consecutive events further apart than this get a gap row (default 1500). */
  gapMs?: number;
  hidden?: Set<WireLane | "ping">;
}

export interface Connector {
  fromLane: number;
  toLane: number;
  /** Drawn on this row, from the source's column to this row's column. */
  kind: "parent" | "link";
}

export type TimelineRow =
  | {
      kind: "event";
      event: WireEvent;
      lane: number;
      open: boolean;
      /** Rows (of any kind) this span covers downward from its own row, ≥0. */
      spanRows: number;
      /** Root ancestor id via `parentId`, else the event's own id. */
      groupId: string;
      connectors: Connector[];
    }
  | { kind: "gap"; ms: number }
  | { kind: "minute"; label: string };

const DEFAULT_GAP_MS = 1500;

function isOpen(e: WireEvent): boolean {
  return e.endAt === undefined;
}

function isWsEventFrame(e: WireEvent): boolean {
  return e.lane === "ws" && e.dir === "in" && e.label.startsWith("event");
}

function byAt(a: WireEvent, b: WireEvent): number {
  return a.at - b.at;
}

function minuteLabel(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** The wall-clock (local) minute an instant falls in. */
function minuteKey(at: number): number {
  return Math.floor((at - new Date(at).getTimezoneOffset() * 60_000) / 60_000);
}

/** Soft relationships between events that no `parentId` states. Source first. */
export function linkPairs(events: WireEvent[]): Array<[source: string, target: string]> {
  const sorted = events.slice().sort(byAt);
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < sorted.length; i += 1) {
    const e = sorted[i];
    if (isWsEventFrame(e)) {
      let source: WireEvent | undefined;
      if (e.correlationId) {
        source = sorted.find((h) => h.lane === "http" && h.correlationId === e.correlationId && h.id !== e.id);
      }
      if (!source && e.revision !== undefined) {
        // Revision fallback only from spans that could have committed (they
        // carry an idempotency key). A read that merely observed the same
        // room head, such as a sync page, is never drawn as a cause: that
        // would attribute a peer's move to this page.
        for (let j = i - 1; j >= 0; j -= 1) {
          const h = sorted[j];
          if (h.lane === "http" && h.outcome === "ok" && h.idempotencyKey && h.revision === e.revision) {
            source = h;
            break;
          }
        }
      }
      if (source) pairs.push([source.id, e.id]);
    } else if (e.lane === "http" && e.idempotencyKey) {
      for (let j = i - 1; j >= 0; j -= 1) {
        const h = sorted[j];
        if (h.lane === "http" && h.idempotencyKey === e.idempotencyKey) {
          pairs.push([h.id, e.id]);
          break;
        }
      }
    }
  }
  return pairs;
}

export function buildTimeline(events: WireEvent[], opts: TimelineOptions): TimelineRow[] {
  const gapMs = opts.gapMs ?? DEFAULT_GAP_MS;
  const hidden = opts.hidden ?? new Set<WireLane | "ping">();
  const byId = new Map(events.map((e) => [e.id, e] as const));

  // Groups follow every event, hidden or not, so toggling a lane does not
  // re-root what remains.
  const rootOf = (e: WireEvent): string => {
    let current = e;
    const seen = new Set<string>([e.id]);
    while (current.parentId && byId.has(current.parentId) && !seen.has(current.parentId)) {
      current = byId.get(current.parentId)!;
      seen.add(current.id);
    }
    return current.id;
  };

  const shown = events
    .filter((e) => !hidden.has(e.lane) && !(e.lane === "ws" && e.label === "ping" && hidden.has("ping")))
    .sort(byAt);

  const rows: TimelineRow[] = [];
  const rowIndexOf = new Map<string, number>();
  let lastMinute: number | null = null;
  let prev: WireEvent | null = null;
  for (const e of shown) {
    if (prev && e.at - prev.at > gapMs) rows.push({ kind: "gap", ms: e.at - prev.at });
    const minute = minuteKey(e.at);
    if (minute !== lastMinute) {
      rows.push({ kind: "minute", label: minuteLabel(e.at) });
      lastMinute = minute;
    }
    rowIndexOf.set(e.id, rows.length);
    rows.push({
      kind: "event",
      event: e,
      lane: LANES.indexOf(e.lane),
      open: isOpen(e),
      spanRows: 0,
      groupId: rootOf(e),
      connectors: [],
    });
    prev = e;
  }

  // Span extents: down to the last row whose event started before the span
  // ended (gap and minute rows in between are covered too, so the drawn line
  // reaches the right row).
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (row.kind !== "event") continue;
    const e = row.event;
    if (e.endAt !== undefined && e.endAt <= e.at) continue;
    let last = i;
    for (let j = i + 1; j < rows.length; j += 1) {
      const other = rows[j];
      if (other.kind !== "event") continue;
      if (e.endAt !== undefined && other.event.at > e.endAt) break;
      last = j;
    }
    if (e.endAt === undefined) last = rows.length - 1;
    row.spanRows = last - i;
  }

  // Connectors: parent on the child's row, links on the later row.
  const laneOf = (id: string): number | undefined => {
    const index = rowIndexOf.get(id);
    if (index === undefined) return undefined;
    const row = rows[index];
    return row.kind === "event" ? row.lane : undefined;
  };
  for (const row of rows) {
    if (row.kind !== "event" || !row.event.parentId) continue;
    const fromLane = laneOf(row.event.parentId);
    if (fromLane !== undefined) row.connectors.push({ fromLane, toLane: row.lane, kind: "parent" });
  }
  for (const [source, target] of linkPairs(shown)) {
    const index = rowIndexOf.get(target);
    const fromLane = laneOf(source);
    if (index === undefined || fromLane === undefined) continue;
    const row = rows[index];
    if (row.kind === "event") row.connectors.push({ fromLane, toLane: row.lane, kind: "link" });
  }
  return rows;
}

/** The parent chain, every descendant, and everything linked, both ways. */
export function relatedIds(events: WireEvent[], id: string): Set<string> {
  const edges = new Map<string, Set<string>>();
  const join = (a: string, b: string) => {
    if (!edges.has(a)) edges.set(a, new Set());
    if (!edges.has(b)) edges.set(b, new Set());
    edges.get(a)!.add(b);
    edges.get(b)!.add(a);
  };
  for (const e of events) if (e.parentId) join(e.parentId, e.id);
  for (const [a, b] of linkPairs(events)) join(a, b);

  const related = new Set<string>([id]);
  const queue = [id];
  while (queue.length) {
    const current = queue.pop()!;
    for (const next of edges.get(current) ?? []) {
      if (related.has(next)) continue;
      related.add(next);
      queue.push(next);
    }
  }
  return related;
}

/** "41.208": seconds and milliseconds of the wall clock. */
export function formatClock(at: number): string {
  const d = new Date(at);
  return `${String(d.getSeconds()).padStart(2, "0")}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

/** "96ms", "1.2s", "1m 05s". */
export function formatMs(ms: number): string {
  const v = Math.max(0, ms);
  if (v < 1000) return `${Math.round(v)}ms`;
  if (v < 60_000) return `${(v / 1000).toFixed(1)}s`;
  const minutes = Math.floor(v / 60_000);
  const seconds = Math.round((v - minutes * 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/** "812B", "1.2K", "12K", "1.5M". */
export function formatBytes(n: number): string {
  const v = Math.max(0, n);
  if (v < 1000) return `${Math.round(v)}B`;
  if (v < 10_000) return `${(v / 1000).toFixed(1)}K`;
  if (v < 1_000_000) return `${Math.round(v / 1000)}K`;
  return `${(v / 1_000_000).toFixed(1)}M`;
}
