import { describe, expect, it } from "vitest";
import { PING_CAP, WIRE_RING, utf8Bytes, wire, type WireEvent } from "../../apps/web/src/wire-store.ts";
import { readJson, routeLabel } from "../../apps/web/src/api.ts";
import { encodeToolResult } from "../../apps/web/src/webmcp.ts";
import {
  LANES,
  buildTimeline,
  formatBytes,
  formatClock,
  formatMs,
  relatedIds,
  type TimelineRow,
} from "../../apps/web/src/wire-timeline.ts";

/** A minute-aligned base so wall-clock minute boundaries are predictable. */
const T0 = new Date(2026, 8, 3, 12, 3, 0, 0).getTime();

let n = 0;
function ev(partial: Partial<WireEvent> & { lane: WireEvent["lane"]; at: number }): WireEvent {
  n += 1;
  return { id: partial.id ?? `e${n}`, label: partial.label ?? partial.lane, ...partial };
}
const eventRows = (rows: TimelineRow[]) =>
  rows.filter((r): r is Extract<TimelineRow, { kind: "event" }> => r.kind === "event");
const rowFor = (rows: TimelineRow[], id: string) =>
  eventRows(rows).find((r) => r.event.id === id)!;
const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));

describe("wire store", () => {
  it("begin/end/mark produce the expected shapes", async () => {
    const before = wire.state.events.length;
    const span = wire.begin({ lane: "http", label: "POST /api/x", correlationId: "c1" });
    const open = wire.state.events.find((e) => e.id === span)!;
    expect(open.endAt).toBeUndefined();
    expect(open.outcome).toBeUndefined();
    expect(open.correlationId).toBe("c1");
    wire.end(span, { outcome: "ok", note: "ok rev 3", revision: 3 });
    const closed = wire.state.events.find((e) => e.id === span)!;
    expect(closed.endAt).toBeGreaterThanOrEqual(closed.at);
    expect(closed.outcome).toBe("ok");
    expect(closed.note).toBe("ok rev 3");
    expect(closed.revision).toBe(3);

    const mark = wire.mark({ lane: "ws", label: "ping", dir: "in" });
    const instant = wire.state.events.find((e) => e.id === mark)!;
    expect(instant.endAt).toBe(instant.at);
    expect(instant.outcome).toBeUndefined();
    expect(wire.state.events.length).toBe(before + 2);

    wire.patch(span, { steps: [{ label: "route", ms: 12 }] });
    expect(wire.state.events.find((e) => e.id === span)!.steps).toEqual([{ label: "route", ms: 12 }]);
    await flush();
  });

  it("coalesces a burst into one notification", async () => {
    let calls = 0;
    const off = wire.subscribe(() => {
      calls += 1;
    });
    wire.mark({ lane: "page", label: "a" });
    wire.mark({ lane: "page", label: "b" });
    wire.mark({ lane: "page", label: "c" });
    expect(calls).toBe(0);
    await flush();
    expect(calls).toBe(1);
    off();
  });

  it("caps the ring and drops the oldest", async () => {
    const first = wire.mark({ lane: "page", label: "first of many" });
    for (let i = 0; i < WIRE_RING + 5; i += 1) wire.mark({ lane: "page", label: `fill ${i}` });
    expect(wire.state.events.length).toBe(WIRE_RING);
    expect(wire.state.events.some((e) => e.id === first)).toBe(false);
    expect(wire.state.events[WIRE_RING - 1].label).toBe(`fill ${WIRE_RING + 4}`);
    // Ending a span that fell off the ring is a no-op, not an error.
    wire.end(first, { outcome: "ok" });
    expect(wire.state.events.some((e) => e.id === first)).toBe(false);
    await flush();
  });

  it("carries a parent on an AbortSignal", () => {
    const parent = wire.begin({ lane: "tool", label: "sync_session" });
    const controller = new AbortController();
    wire.bindParent(controller.signal, parent);
    expect(wire.parentFor(controller.signal)).toBe(parent);
    expect(wire.parentFor(new AbortController().signal)).toBeUndefined();
    expect(wire.parentFor(undefined)).toBeUndefined();

    const upstream = new AbortController();
    const child = wire.child(parent, upstream.signal);
    expect(wire.parentFor(child.signal)).toBe(parent);
    expect(child.signal.aborted).toBe(false);
    upstream.abort();
    expect(child.signal.aborted).toBe(true);

    const dead = wire.child(parent, upstream.signal);
    expect(dead.signal.aborted).toBe(true);
    wire.end(parent, { outcome: "ok" });
  });

  it("child().off() detaches from the upstream so later aborts and listeners do not linger", () => {
    const parent = wire.begin({ lane: "tool", label: "inspect_candidates" });
    const upstream = new AbortController();
    const added: unknown[] = [];
    const removed: unknown[] = [];
    const originalAdd = upstream.signal.addEventListener.bind(upstream.signal);
    const originalRemove = upstream.signal.removeEventListener.bind(upstream.signal);
    upstream.signal.addEventListener = ((type: string, fn: unknown, opts?: unknown) => {
      added.push(fn);
      return originalAdd(type, fn as EventListener, opts as AddEventListenerOptions);
    }) as typeof upstream.signal.addEventListener;
    upstream.signal.removeEventListener = ((type: string, fn: unknown) => {
      removed.push(fn);
      return originalRemove(type, fn as EventListener);
    }) as typeof upstream.signal.removeEventListener;

    const child = wire.child(parent, upstream.signal);
    expect(added).toHaveLength(1);
    child.off();
    expect(removed).toEqual(added);
    upstream.abort();
    expect(child.signal.aborted).toBe(false);
    wire.end(parent, { outcome: "ok" });
  });

  it("keeps at most PING_CAP pings, evicting the oldest ping before anything else", async () => {
    const keep = wire.mark({ lane: "http", label: "POST commands", note: "ok rev 1" });
    const firstPing = wire.mark({ lane: "ws", label: "ping", dir: "in" });
    for (let i = 0; i < PING_CAP + 4; i += 1) wire.mark({ lane: "ws", label: "ping", dir: "in" });
    const pings = wire.state.events.filter((e) => e.lane === "ws" && e.label === "ping");
    expect(pings).toHaveLength(PING_CAP);
    expect(wire.state.events.some((e) => e.id === firstPing)).toBe(false);
    expect(wire.state.events.some((e) => e.id === keep)).toBe(true);
    await flush();
  });
});

describe("readJson", () => {
  it("throws on an empty body, as response.json() did", async () => {
    await expect(readJson(new Response("", { status: 200 }))).rejects.toBeInstanceOf(SyntaxError);
  });
  it("throws on a non-JSON body", async () => {
    await expect(readJson(new Response("<html>502</html>", { status: 502 }))).rejects.toBeInstanceOf(SyntaxError);
  });
  it("returns the parsed body and its UTF-8 size", async () => {
    const text = JSON.stringify({ ok: true, name: "Café" });
    const { body, bytes } = await readJson(new Response(text));
    expect(body).toEqual({ ok: true, name: "Café" });
    expect(bytes).toBe(text.length + 1);
    expect(bytes).toBe(utf8Bytes(text));
  });
  it("labels routes without the /api/ prefix or a query", () => {
    expect(routeLabel("POST", "/api/spatial/context")).toBe("POST spatial/context");
    expect(routeLabel("POST", "/api/commands")).toBe("POST commands");
    expect(routeLabel("GET", "/api/landmarks?q=x")).toBe("GET landmarks");
  });
});

describe("encodeToolResult", () => {
  it("reports whether the result was compacted", () => {
    expect(encodeToolResult({ ok: true }).truncated).toBe(false);
    const big = { ok: true, rows: Array.from({ length: 200 }, (_, i) => ({ i, text: "x".repeat(40) })) };
    const encoded = encodeToolResult(big, 400);
    expect(encoded.truncated).toBe(true);
    expect(encoded.content[0].text.length).toBeLessThanOrEqual(400);
  });
});

describe("buildTimeline", () => {
  it("inserts a minute row before the first event and on every minute change", () => {
    const rows = buildTimeline(
      [
        ev({ lane: "page", at: T0 + 100 }),
        ev({ lane: "page", at: T0 + 200 }),
        ev({ lane: "page", at: T0 + 60_000 + 50 }),
      ],
      { now: T0 + 70_000, gapMs: 120_000 },
    );
    expect(rows.map((r) => r.kind)).toEqual(["minute", "event", "event", "minute", "event"]);
    expect(rows[0]).toEqual({ kind: "minute", label: "12:03" });
    expect(rows[3]).toEqual({ kind: "minute", label: "12:04" });
  });

  it("inserts a gap row when consecutive events are further apart than gapMs", () => {
    const rows = buildTimeline(
      [
        ev({ lane: "page", at: T0 }),
        ev({ lane: "page", at: T0 + 1000 }),
        ev({ lane: "page", at: T0 + 5200 }),
      ],
      { now: T0 + 6000, gapMs: 1500 },
    );
    expect(rows.map((r) => r.kind)).toEqual(["minute", "event", "event", "gap", "event"]);
    expect(rows[3]).toEqual({ kind: "gap", ms: 4200 });
  });

  it("orders rows by time regardless of insertion order", () => {
    const rows = buildTimeline(
      [ev({ id: "late", lane: "page", at: T0 + 500 }), ev({ id: "early", lane: "page", at: T0 + 100 })],
      { now: T0 + 1000 },
    );
    expect(eventRows(rows).map((r) => r.event.id)).toEqual(["early", "late"]);
  });

  it("measures spanRows for closed and open spans, gap rows included", () => {
    const rows = buildTimeline(
      [
        ev({ id: "turn", lane: "agent", at: T0, endAt: T0 + 4000, outcome: "ok" }),
        ev({ id: "req", lane: "http", at: T0 + 10, endAt: T0 + 300, outcome: "ok" }),
        ev({ id: "frame", lane: "ws", dir: "in", at: T0 + 290, endAt: T0 + 290 }),
        ev({ id: "late", lane: "ws", dir: "in", at: T0 + 3000, endAt: T0 + 3000 }),
        ev({ id: "after", lane: "page", at: T0 + 4500, endAt: T0 + 4500 }),
        ev({ id: "open", lane: "tool", at: T0 + 4600 }),
        ev({ id: "tail", lane: "page", at: T0 + 4700, endAt: T0 + 4700 }),
      ],
      { now: T0 + 5000, gapMs: 1500 },
    );
    // minute, turn, req, frame, gap, late, after, open, tail
    expect(rows.map((r) => r.kind)).toEqual([
      "minute", "event", "event", "event", "gap", "event", "event", "event", "event",
    ]);
    expect(rowFor(rows, "turn").spanRows).toBe(4); // through "late", counting the gap row
    expect(rowFor(rows, "turn").open).toBe(false);
    expect(rowFor(rows, "req").spanRows).toBe(1); // through "frame", which landed before it closed
    expect(rowFor(rows, "frame").spanRows).toBe(0); // an instant
    expect(rowFor(rows, "open").open).toBe(true);
    expect(rowFor(rows, "open").spanRows).toBe(1); // through the last row
    expect(rowFor(rows, "tail").open).toBe(false);
  });

  it("draws a parent connector on the child's row from the parent's lane", () => {
    const rows = buildTimeline(
      [
        ev({ id: "tool", lane: "tool", at: T0, endAt: T0 + 100, outcome: "ok" }),
        ev({ id: "req", lane: "http", parentId: "tool", at: T0 + 5, endAt: T0 + 90, outcome: "ok" }),
      ],
      { now: T0 + 200 },
    );
    expect(rowFor(rows, "req").connectors).toEqual([
      { fromLane: LANES.indexOf("tool"), toLane: LANES.indexOf("http"), kind: "parent" },
    ]);
    expect(rowFor(rows, "req").groupId).toBe("tool");
    expect(rowFor(rows, "tool").groupId).toBe("tool");
    expect(rowFor(rows, "tool").connectors).toEqual([]);
  });

  it("links a ws event frame to the http span that caused it, beating the revision match", () => {
    const rows = buildTimeline(
      [
        ev({ id: "other", lane: "http", at: T0, endAt: T0 + 50, outcome: "ok", revision: 7, correlationId: "c_other" }),
        ev({ id: "cause", lane: "http", at: T0 + 60, endAt: T0 + 120, outcome: "ok", revision: 7, correlationId: "c_cause" }),
        ev({ id: "frame", lane: "ws", dir: "in", label: "event ×1", at: T0 + 130, endAt: T0 + 130, revision: 7, correlationId: "c_other" }),
      ],
      { now: T0 + 200 },
    );
    expect(rowFor(rows, "frame").connectors).toEqual([
      { fromLane: LANES.indexOf("http"), toLane: LANES.indexOf("ws"), kind: "link" },
    ]);
    expect(relatedIds(rowsEvents(rows), "frame")).toEqual(new Set(["frame", "other"]));
  });

  it("falls back to the most recent earlier ok mutation span with the same revision", () => {
    const events = [
      ev({ id: "old", lane: "http", at: T0, endAt: T0 + 50, outcome: "ok", revision: 9, idempotencyKey: "i_a" }),
      ev({ id: "failed", lane: "http", at: T0 + 60, endAt: T0 + 70, outcome: "error", revision: 9, idempotencyKey: "i_b" }),
      ev({ id: "newest", lane: "http", at: T0 + 80, endAt: T0 + 120, outcome: "ok", revision: 9, idempotencyKey: "i_c" }),
      ev({ id: "frame", lane: "ws", dir: "in", label: "event ×2", at: T0 + 130, endAt: T0 + 130, revision: 9 }),
      ev({ id: "later", lane: "http", at: T0 + 140, endAt: T0 + 150, outcome: "ok", revision: 9, idempotencyKey: "i_d" }),
    ];
    const rows = buildTimeline(events, { now: T0 + 200 });
    expect(rowFor(rows, "frame").connectors).toEqual([
      { fromLane: LANES.indexOf("http"), toLane: LANES.indexOf("ws"), kind: "link" },
    ]);
    expect(relatedIds(events, "frame")).toEqual(new Set(["frame", "newest"]));
  });

  it("never links a frame to a read that merely observed the same revision", () => {
    const events = [
      ev({ id: "sync", lane: "http", label: "POST sync", at: T0, endAt: T0 + 50, outcome: "ok", revision: 41 }),
      ev({ id: "context", lane: "http", label: "POST spatial/context", at: T0 + 60, endAt: T0 + 90, outcome: "ok", revision: 41 }),
      ev({ id: "peer", lane: "ws", dir: "in", label: "event ×1", at: T0 + 100, endAt: T0 + 100, revision: 41 }),
      ev({ id: "cmd", lane: "http", label: "POST commands", at: T0 + 200, endAt: T0 + 260, outcome: "ok", revision: 42, idempotencyKey: "i_1" }),
      ev({ id: "own", lane: "ws", dir: "in", label: "event ×1", at: T0 + 270, endAt: T0 + 270, revision: 42 }),
    ];
    const rows = buildTimeline(events, { now: T0 + 300 });
    expect(rowFor(rows, "peer").connectors).toEqual([]);
    expect(relatedIds(events, "peer")).toEqual(new Set(["peer"]));
    expect(rowFor(rows, "own").connectors).toEqual([
      { fromLane: LANES.indexOf("http"), toLane: LANES.indexOf("ws"), kind: "link" },
    ]);
    expect(relatedIds(events, "own")).toEqual(new Set(["own", "cmd"]));
  });

  it("links a retried http span to the earlier attempt sharing its idempotency key", () => {
    const events = [
      ev({ id: "first", lane: "http", at: T0, endAt: T0 + 50, outcome: "error", idempotencyKey: "i_1", note: "sync_required" }),
      ev({ id: "catch", lane: "page", at: T0 + 55, endAt: T0 + 200, outcome: "ok" }),
      ev({ id: "second", lane: "http", at: T0 + 210, endAt: T0 + 260, outcome: "ok", idempotencyKey: "i_1" }),
    ];
    const rows = buildTimeline(events, { now: T0 + 300 });
    expect(rowFor(rows, "first").connectors).toEqual([]);
    expect(rowFor(rows, "second").connectors).toEqual([
      { fromLane: LANES.indexOf("http"), toLane: LANES.indexOf("http"), kind: "link" },
    ]);
    expect(relatedIds(events, "first")).toEqual(new Set(["first", "second"]));
  });

  it("drops hidden lanes and ping before computing gaps", () => {
    const events = [
      ev({ id: "a", lane: "http", at: T0, endAt: T0 + 20, outcome: "ok" }),
      ev({ id: "ping", lane: "ws", dir: "in", label: "ping", at: T0 + 1000, endAt: T0 + 1000 }),
      ev({ id: "presence", lane: "ws", dir: "in", label: "presence", at: T0 + 1400, endAt: T0 + 1400 }),
      ev({ id: "b", lane: "http", at: T0 + 2000, endAt: T0 + 2020, outcome: "ok" }),
    ];
    const all = buildTimeline(events, { now: T0 + 3000 });
    expect(all.filter((r) => r.kind === "gap")).toHaveLength(0);

    const noPing = buildTimeline(events, { now: T0 + 3000, hidden: new Set(["ping"]) });
    expect(eventRows(noPing).map((r) => r.event.id)).toEqual(["a", "presence", "b"]);
    expect(noPing.filter((r) => r.kind === "gap")).toHaveLength(0);

    const noWs = buildTimeline(events, { now: T0 + 3000, hidden: new Set(["ws"]) });
    expect(eventRows(noWs).map((r) => r.event.id)).toEqual(["a", "b"]);
    expect(noWs.filter((r) => r.kind === "gap")).toEqual([{ kind: "gap", ms: 2000 }]);
  });

  it("keeps groupId rooted through a hidden parent and skips its connector", () => {
    const events = [
      ev({ id: "tool", lane: "tool", at: T0, endAt: T0 + 100, outcome: "ok" }),
      ev({ id: "req", lane: "http", parentId: "tool", at: T0 + 5, endAt: T0 + 90, outcome: "ok" }),
    ];
    const rows = buildTimeline(events, { now: T0 + 200, hidden: new Set(["tool"]) });
    expect(rowFor(rows, "req").groupId).toBe("tool");
    expect(rowFor(rows, "req").connectors).toEqual([]);
  });
});

describe("relatedIds", () => {
  it("walks parents, descendants and links in both directions", () => {
    const events = [
      ev({ id: "turn", lane: "agent", at: T0, endAt: T0 + 900, outcome: "ok" }),
      ev({ id: "say", lane: "http", parentId: "turn", at: T0 + 5, endAt: T0 + 500, outcome: "ok" }),
      ev({ id: "cmd", lane: "http", parentId: "turn", at: T0 + 510, endAt: T0 + 600, outcome: "ok", revision: 4, correlationId: "c_cmd" }),
      ev({ id: "frame", lane: "ws", dir: "in", label: "event ×1", at: T0 + 610, endAt: T0 + 610, revision: 4, correlationId: "c_cmd" }),
      ev({ id: "unrelated", lane: "ws", dir: "in", label: "presence", at: T0 + 620, endAt: T0 + 620 }),
    ];
    const chain = new Set(["turn", "say", "cmd", "frame"]);
    expect(relatedIds(events, "turn")).toEqual(chain);
    expect(relatedIds(events, "frame")).toEqual(chain);
    expect(relatedIds(events, "say")).toEqual(chain);
    expect(relatedIds(events, "unrelated")).toEqual(new Set(["unrelated"]));
  });
});

describe("formatters", () => {
  it("formats the clock as ss.mmm", () => {
    expect(formatClock(new Date(2026, 8, 3, 12, 3, 41, 208).getTime())).toBe("41.208");
    expect(formatClock(new Date(2026, 8, 3, 12, 3, 5, 7).getTime())).toBe("05.007");
  });
  it("formats durations", () => {
    expect(formatMs(96)).toBe("96ms");
    expect(formatMs(96.4)).toBe("96ms");
    expect(formatMs(1234)).toBe("1.2s");
    expect(formatMs(4200)).toBe("4.2s");
    expect(formatMs(65_000)).toBe("1m 05s");
    expect(formatMs(-3)).toBe("0ms");
  });
  it("formats sizes", () => {
    expect(formatBytes(812)).toBe("812B");
    expect(formatBytes(1234)).toBe("1.2K");
    expect(formatBytes(1500)).toBe("1.5K");
    expect(formatBytes(12_345)).toBe("12K");
    expect(formatBytes(1_500_000)).toBe("1.5M");
  });
});

function rowsEvents(rows: TimelineRow[]): WireEvent[] {
  return eventRows(rows).map((r) => r.event);
}
