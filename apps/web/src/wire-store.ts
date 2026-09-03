/**
 * What crossed the wire, as events with causal links: HTTP requests, socket
 * frames, WebMCP tool calls, agent turns and page moments. The `{ }` drawer
 * draws this as a timeline; nothing in the main UI reads it (CLAUDE.md §6).
 *
 * Privacy floor: never a confirmation nonce, never a token or invite secret,
 * never the text of an agent-private condition. Callers put only wire
 * metadata here; `detail` is rendered verbatim in the drawer.
 */

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
}

type Listener = () => void;
type BeginInput = Omit<WireEvent, "id" | "at"> & { id?: string; at?: number };

/** Ring size: enough for a whole demo session, small enough to lay out per render. */
export const WIRE_RING = 400;
/** Keepalives are kept, but never more than this many: they must not push
 * the spans that matter out of the ring. */
export const PING_CAP = 30;

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

class WireStore {
  state: WireState = { events: [], seq: 0 };
  private listeners = new Set<Listener>();
  private pending = false;

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Opens a span; returns its id for `end` / `patch`. */
  begin(e: BeginInput): string {
    const id = e.id ?? newId();
    this.push({ ...e, id, at: e.at ?? Date.now() });
    return id;
  }

  /** Closes a span. Unknown ids (fallen off the ring) are ignored. */
  end(id: string, patch: Partial<WireEvent> & { outcome: WireOutcome }): void {
    this.patch(id, { endAt: Date.now(), ...patch });
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
      next[i] = { ...events[i], ...partial, id };
      this.commit(next);
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
      if (pings >= PING_CAP && oldest >= 0) next.splice(oldest, 1);
    }
    if (next.length >= WIRE_RING) next = next.slice(next.length - WIRE_RING + 1);
    next.push(event);
    this.commit(next);
  }

  private commit(events: WireEvent[]): void {
    this.state = { events, seq: this.state.seq + 1 };
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
