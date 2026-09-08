/**
 * What crossed the wire, as events with causal links: HTTP requests, socket
 * frames, WebMCP tool calls, agent turns and page moments. The `{ }` drawer
 * draws this as a timeline; nothing in the main UI reads it (CLAUDE.md §6).
 *
 * Privacy floor: never a confirmation nonce, never a token or invite secret,
 * never the text of an agent-private condition. Callers put only wire
 * metadata here; `detail` is rendered verbatim in the drawer.
 */

import { WIRE_SERVER_SPAN_LIMIT, type WireServerTrace } from "@webmcp-hackathon/contracts";

export type WireLane = "page" | "http" | "ws" | "tool" | "agent";
export type WireOutcome = "ok" | "error" | "cancelled" | "blocked";
export interface WireStep { label: string; ms?: number; ok?: boolean }
export interface WireEvent {
  id: string;
  lane: WireLane;
  /** Short mono label: "POST commands", "event ×2", "submit_requirement", "say". */
  label: string;
  /** Right-hand summary: "ok rev 13", "sync_required", "3 pending · need". */
  note?: string;
  at: number;                 // Date.now(), absolute
  /** Spans: set when the span closes. Instants (`mark`) carry `endAt === at`,
   * which is how a zero-length moment is told apart from a span still open. */
  endAt?: number;
  /** Monotonic elapsed time; unaffected by wall-clock adjustments. */
  durationMs?: number;
  headersMs?: number;
  bodyMs?: number;
  parseMs?: number;
  status?: number;
  failureKind?: "network" | "decode";
  serverTrace?: WireServerTrace;
  outcome?: WireOutcome;      // spans, once closed
  /** Direction for ws frames: "in" (server→page) | "out" (page→server). */
  dir?: "in" | "out";
  parentId?: string;          // explicit causal parent
  correlationId?: string;
  idempotencyKey?: string;
  revision?: number;          // rev the item carried (response rev / frame rev)
  fromRevision?: number;
  serverMs?: number;          // from x-server-ms
  bytes?: number;             // response body / tool result size (UTF-8 bytes)
  budget?: number;            // tool result budget (chars) when bytes is a tool result
  truncated?: boolean;        // tool result was structurally compacted
  replayed?: boolean;
  steps?: WireStep[];         // nested sub-steps: agent calls, facts stages, route/agent tiers
  /** Expanded-row detail. Keys shown as "k v" mono pairs. NEVER a nonce, never private text. */
  detail?: Record<string, string | number | boolean | null | undefined>;
}

export interface WireState {
  /** Chronological by insertion; the layout sorts by `at` anyway. */
  events: WireEvent[];
  seq: number;
  dropped?: number;
  omittedPings?: number;
  startedAt?: number;
  retainedBytes?: number;
}

type Listener = () => void;
type BeginInput = Omit<WireEvent, "id" | "at"> & { id?: string; at?: number };

/** History is independent of rendering: only the viewport is mounted. */
export const WIRE_RING = 5000;
/** Serialized metadata budget; also bounds recordings with unusually rich traces. */
export const WIRE_BYTE_BUDGET = 12 * 1024 * 1024;
/** Keepalives are kept, but never more than this many: they must not push
 * the spans that matter out of the ring. */
export const PING_CAP = 100;

let counter = 0;
function newId(): string {
  counter += 1;
  return `w_${counter.toString(36)}`;
}

function isPing(e: WireEvent): boolean {
  return e.lane === "ws" && e.label === "ping";
}

/* JS has no async context, so a parent is carried on the AbortSignal a caller
   already threads through its downstream requests. */
const parents = new WeakMap<AbortSignal, string>();

function boundedMetadata<T extends Partial<WireEvent>>(event: T): T {
  const next = { ...event };
  for (const key of ["label", "note"] as const) if (typeof next[key] === "string") next[key] = next[key]!.slice(0, 256);
  if (next.detail) next.detail = Object.fromEntries(Object.entries(next.detail).slice(0, 32)
    .filter(([key]) => !/token|secret|nonce|password|authorization|cookie|prompt|condition|payload|^body$/i.test(key))
    .map(([key, value]) => [key.slice(0, 64), typeof value === "string" ? value.slice(0, 256) : value]));
  if (next.steps) next.steps = next.steps.slice(0, 32).map((step) => ({ label: step.label.slice(0, 80),
    ...(typeof step.ms === "number" && Number.isFinite(step.ms) ? { ms: Math.max(0, step.ms) } : {}),
    ...(typeof step.ok === "boolean" ? { ok: step.ok } : {}) }));
  return next;
}

export class WireStore {
  state: WireState = { events: [], seq: 0, dropped: 0, startedAt: Date.now() };
  private listeners = new Set<Listener>();
  private pending = false;
  private clocks = new Map<string, number>();
  private sizes = new Map<string, number>();
  private retainedBytes = 0;
  private references = new Map<string, string[]>();
  private dependents = new Map<string, number>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Opens a span; returns its id for `end` / `patch`. */
  begin(e: BeginInput): string {
    const id = e.id ?? newId();
    if (e.endAt === undefined) this.clocks.set(id, performance.now());
    this.push({ ...e, id, at: e.at ?? Date.now() });
    return id;
  }

  /** Closes a span. Unknown ids (fallen off the ring) are ignored. */
  end(id: string, patch: Partial<WireEvent> & { outcome: WireOutcome }): void {
    const started = this.clocks.get(id);
    this.clocks.delete(id);
    if (patch.note === "network") {
      const prior = this.state.events.find((e) => e.id === id);
      patch = { ...patch, note: prior?.failureKind === "decode" ? "invalid JSON" : "network",
        failureKind: prior?.failureKind ?? "network" };
    }
    this.patch(id, { endAt: Date.now(), ...(started !== undefined ? { durationMs: performance.now() - started } : {}), ...patch });
  }

  received(id: string, response: Response): void {
    const started = this.clocks.get(id);
    const raw = response.headers.get("x-server-ms");
    const serverMs = raw === null ? undefined : Number(raw);
    this.patch(id, { status: response.status,
      ...(started !== undefined ? { headersMs: performance.now() - started } : {}),
      ...(serverMs !== undefined && Number.isFinite(serverMs) && serverMs >= 0 ? { serverMs } : {}),
      serverTrace: parseServerTrace(response.headers.get("x-wire-trace")),
    });
  }

  clear(): void {
    this.clocks.clear();
    this.sizes.clear();
    this.references.clear();
    this.dependents.clear();
    this.retainedBytes = 0;
    this.state = { ...this.state, dropped: 0, omittedPings: 0, startedAt: Date.now() };
    this.commit([]);
  }

  /** Records an instant: no duration, no outcome required. */
  mark(e: BeginInput): string {
    const id = e.id ?? newId();
    const at = e.at ?? Date.now();
    this.push({ ...e, id, at, endAt: at });
    return id;
  }

  /** True while a span with this id is in the ring and not yet closed. */
  isOpen(id: string): boolean {
    const found = this.state.events.find((e) => e.id === id);
    return found !== undefined && found.endAt === undefined;
  }

  patch(id: string, partial: Partial<WireEvent>): void {
    const events = this.state.events;
    for (let i = events.length - 1; i >= 0; i -= 1) {
      if (events[i].id !== id) continue;
      const next = events.slice();
      next[i] = { ...events[i], ...boundedMetadata(partial), id };
      this.measure(next[i]);
      this.commit(this.trimHistory(next));
      return;
    }
  }

  private push(event: WireEvent): void {
    let next = this.state.events.slice();
    if (isPing(event)) {
      // The oldest ping goes first, before anything else is considered.
      let pings = 0;
      let oldest = -1;
      for (let i = 0; i < next.length; i += 1) {
        if (!isPing(next[i])) continue;
        pings += 1;
        if (oldest < 0) oldest = i;
      }
      if (pings >= PING_CAP && oldest >= 0) {
        this.forget(next.splice(oldest, 1)[0]);
        this.state = { ...this.state, omittedPings: (this.state.omittedPings ?? 0) + 1 };
      }
    }
    const bounded = boundedMetadata(event);
    next.push(bounded);
    this.measure(bounded);
    this.commit(this.trimHistory(next));
  }

  private measure(event: WireEvent): void {
    const bytes = utf8Bytes(JSON.stringify(event));
    this.retainedBytes += bytes - (this.sizes.get(event.id) ?? 0);
    this.sizes.set(event.id, bytes);
    this.releaseReferences(event.id);
    const keys = [
      ...(event.parentId ? [`parent:${event.parentId}`] : []),
      ...(event.lane === "ws" && event.dir === "in" && event.label.startsWith("event") && event.correlationId ? [`correlation:${event.correlationId}`] : []),
    ];
    this.references.set(event.id, keys);
    for (const key of keys) this.dependents.set(key, (this.dependents.get(key) ?? 0) + 1);
  }

  private releaseReferences(id: string): void {
    for (const key of this.references.get(id) ?? []) {
      const remaining = (this.dependents.get(key) ?? 1) - 1;
      if (remaining) this.dependents.set(key, remaining);
      else this.dependents.delete(key);
    }
    this.references.delete(id);
  }

  private forget(event: WireEvent): void {
    this.clocks.delete(event.id);
    this.retainedBytes -= this.sizes.get(event.id) ?? 0;
    this.sizes.delete(event.id);
    this.releaseReferences(event.id);
  }

  private trimHistory(next: WireEvent[]): WireEvent[] {
    while (next.length > WIRE_RING || this.retainedBytes > WIRE_BYTE_BUDGET) {
      // Keep the causes of retained work. Prefer completed leaves, then other
      // completed spans; open work goes last. Hard limits still always apply.
      let finished = next.findIndex((e) => e.endAt !== undefined &&
        !this.dependents.has(`parent:${e.id}`) &&
        !(e.lane === "http" && e.correlationId && this.dependents.has(`correlation:${e.correlationId}`)));
      if (finished < 0) finished = next.findIndex((e) => e.endAt !== undefined);
      const [evicted] = next.splice(finished < 0 ? 0 : finished, 1);
      this.forget(evicted);
      this.state = { ...this.state, dropped: (this.state.dropped ?? 0) + 1 };
    }
    return next;
  }

  private commit(events: WireEvent[]): void {
    this.state = { ...this.state, events, retainedBytes: this.retainedBytes, seq: this.state.seq + 1 };
    if (this.pending) return;
    this.pending = true;
    // One notification per burst: a socket frame fans out into several
    // store calls and the drawer should render once for all of them.
    queueMicrotask(() => {
      this.pending = false;
      for (const listener of this.listeners) listener();
    });
  }

  bindParent(signal: AbortSignal, id: string): void {
    parents.set(signal, id);
  }

  parentFor(signal?: AbortSignal): string | undefined {
    return signal ? parents.get(signal) : undefined;
  }

  /**
   * A signal that carries `parentId` and follows `upstream` (aborting
   * upstream aborts it). The caller passes `signal` to everything it does on
   * behalf of that span and calls `off()` when the work is over, so a host
   * that reuses one upstream signal across calls accumulates no listeners.
   */
  child(parentId: string, upstream?: AbortSignal): { signal: AbortSignal; off(): void } {
    const controller = new AbortController();
    parents.set(controller.signal, parentId);
    if (!upstream) return { signal: controller.signal, off() {} };
    if (upstream.aborted) {
      controller.abort();
      return { signal: controller.signal, off() {} };
    }
    const abort = () => controller.abort();
    upstream.addEventListener("abort", abort, { once: true });
    return {
      signal: controller.signal,
      off() {
        upstream.removeEventListener("abort", abort);
      },
    };
  }
}

export const wire = new WireStore();

/** `k v` detail values: trimmed, never undefined-stringified. */
export function trim(value: unknown, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const encoder = typeof TextEncoder === "undefined" ? null : new TextEncoder();

/** Size on the wire: UTF-8 bytes, not UTF-16 code units. */
export function utf8Bytes(text: string): number {
  return encoder ? encoder.encode(text).length : text.length;
}

/** A diagnostic header is untrusted input too. Ignore unsupported versions
 * and copy only bounded metadata, never arbitrary server objects. */
export function parseServerTrace(raw: string | null): WireServerTrace | undefined {
  if (!raw || raw.length > 7000) return undefined;
  try {
    const value = JSON.parse(raw);
    if (value?.version !== 1 || !Array.isArray(value.spans)) return undefined;
    const number = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
    return { version: 1, durationMs: number(value.durationMs) ?? 0, omitted: number(value.omitted) ?? 0,
      spans: value.spans.slice(0, WIRE_SERVER_SPAN_LIMIT).flatMap((span: any) => {
        if (!span || !["model", "outbound", "cache"].includes(span.kind) ||
          !["running", "ok", "error"].includes(span.outcome) || typeof span.label !== "string") return [];
        return [{ kind: span.kind, label: span.label.slice(0, 80), outcome: span.outcome,
          offsetMs: number(span.offsetMs) ?? 0,
          ...Object.fromEntries(["durationMs", "status", "bytes", "inputTokens", "outputTokens", "costUsd"]
            .flatMap((key) => number(span[key]) === undefined ? [] : [[key, span[key]]])),
        }];
      }) };
  } catch { return undefined; }
}
