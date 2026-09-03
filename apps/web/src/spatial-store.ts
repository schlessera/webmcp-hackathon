import { fetchExplorePlaces, spatialContext } from "./api.ts";
import { diagnostics } from "./diagnostics-store.ts";
import type {
  CommandEnvelope,
  ExplorePlace,
  OutstandingItem,
  SpatialContext,
} from "./spatial-types.ts";

/**
 * Module-level spatial state shared by the React tree and the WebMCP tool
 * callbacks (which live outside React). Same external-store pattern as
 * diagnostics: subscribe + immutable state swaps.
 *
 * Refetches are coalesced: a burst of WS events triggers one in-flight fetch
 * plus at most one queued follow-up, and a response for an older revision than
 * the one already rendered is dropped (revision-gated).
 */

export interface SpatialState {
  context: SpatialContext | null;
  /** Candidate the local viewer has open (pin tap / focus_destination). */
  selectedId: string | null;
  /** Bumped by focus_destination so the map pans even to the same pin. */
  focusNonce: number;
  /** Scope centre last requested through this viewer's own command path. */
  localScopeCenterKey: string | null;
  /** Latest outstanding list for THIS participant (from sync/command results).
   * A grant beyond the delegated bound comes back as an adjustment_request
   * with staged:true — that flag alone drives the in-page confirm card. */
  outstanding: OutstandingItem[];
  /** The set as it would be without one need, while its brief row is held.
   * Never merged into `context`: the live truth must survive the gesture. */
  preview: SpatialContext | null;
  previewNeedId: string | null;
  /** Who has which place open right now (peers and self), from the presence
   * frame. Ephemeral: never part of `context`, never persisted. */
  viewing: Record<string, string>;
  /** What the person's agent last said, newest first. Dismissed by the
   * reader; nothing here is room state. */
  agentReplies: AgentReply[];
  /** A sentence is with the agent right now. */
  agentBusy: boolean;
  /** What the agent is doing with it, for the composer's status line. */
  agentPhase: "reading" | "applying" | null;
  /**
   * Places the server is looking up right now, from the `lookups` frame.
   * Presentation only: a busy ring on those dots, a line in the panel. An
   * empty list clears every ring.
   */
  busy: string[];
  busyReason: LookupReason | null;
  /**
   * Needs this page has said and the room has not settled yet. A row exists
   * from the moment of saying; it settles when the commit has landed and
   * the first round of lookups it triggered is over (or 8 s, whichever
   * first). Client-side state — nothing here is room truth.
   */
  pendingNeeds: PendingNeed[];
  /** Bumped when a `facts` frame lands; carries the places it named so an
   * open panel knows whether it is one of them. */
  facts: { ids: string[]; nonce: number };
  /** A context refetch is in flight. */
  refetching: boolean;
  /** Bounded snapshot-place cache across recent viewport reads, by stable ref. */
  explore: Map<string, ExplorePlace>;
  /** Whether the most recent viewport held more than the endpoint cap. */
  exploreTruncated: boolean;
}

export interface LookupReason {
  kind: "need" | "place" | "pool";
  label?: string;
}

export interface PendingNeed {
  localId: string;
  /** What the person said, in their words or the facet's label. */
  label: string;
  visibility: string;
  startedAt: number;
  /** The server accepted it at this moment (the row is now real). */
  committedAt: number | null;
  /** The need's id once the context shows it. */
  needId: string | null;
  boundAt: number | null;
}

/** After the commit, how long the room may stay quiet before a pending need
 * counts as settled — the server never started a lookup for it. */
const PENDING_GRACE_MS = 600;
/** Whatever happens, a pending need settles after this. */
const PENDING_CAP_MS = 8000;

export interface AgentReply {
  id: string;
  text: string;
  /** What the agent changed, for the record row under the reply. */
  actions: Array<{ tool: string; ok: boolean; effect: string }>;
  /** true for a question answered, false for a move made. */
  answer: boolean;
}

type Listener = () => void;

export type ConfirmationKind = "agreement" | "private_request";

interface HeldConfirmation {
  nonce: string;
  expiresAt: number;
}

/** How long a confirm/commit gesture waits for its nonce to land on the socket. */
const CONFIRMATION_WAIT_MS = 3000;
const EXPLORE_CACHE_MAX = 3000;

function sameExplorePlace(a: ExplorePlace, b: ExplorePlace): boolean {
  return (
    a.ref === b.ref &&
    a.name === b.name &&
    a.category === b.category &&
    a.location.lat === b.location.lat &&
    a.location.lng === b.location.lng &&
    a.candidateId === b.candidateId &&
    a.added === b.added
  );
}

/** Merge one viewport and retain the nearest places when the cache is full. */
export function mergeExploreCache(
  current: ReadonlyMap<string, ExplorePlace>,
  incoming: ExplorePlace[],
  bbox: [number, number, number, number],
): Map<string, ExplorePlace> {
  let changed = false;
  const merged = new Map(current);
  for (const place of incoming) {
    const previous = merged.get(place.ref);
    const next = {
      ...place,
      ...(!place.candidateId && previous?.added ? { added: true } : {}),
    };
    if (!previous || !sameExplorePlace(previous, next)) {
      merged.set(place.ref, next);
      changed = true;
    }
  }
  if (merged.size > EXPLORE_CACHE_MAX) {
    const [south, west, north, east] = bbox;
    const centerLat = (south + north) / 2;
    const centerLng = (west + east) / 2;
    const lngScale = Math.cos((centerLat * Math.PI) / 180);
    const distance = (place: ExplorePlace) =>
      (place.location.lat - centerLat) ** 2 +
      ((place.location.lng - centerLng) * lngScale) ** 2;
    const nearest = [...merged.values()]
      .sort((a, b) => distance(a) - distance(b) || a.ref.localeCompare(b.ref))
      .slice(0, EXPLORE_CACHE_MAX);
    return new Map(nearest.map((place) => [place.ref, place]));
  }
  return changed ? merged : (current as Map<string, ExplorePlace>);
}

class SpatialStore {
  state: SpatialState = {
    context: null,
    selectedId: null,
    focusNonce: 0,
    localScopeCenterKey: null,
    outstanding: [],
    preview: null,
    previewNeedId: null,
    viewing: {},
    agentReplies: [],
    agentBusy: false,
    agentPhase: null,
    busy: [],
    busyReason: null,
    pendingNeeds: [],
    facts: { ids: [], nonce: 0 },
    refetching: false,
    explore: new Map(),
    exploreTruncated: false,
  };
  private listeners = new Set<Listener>();
  private pendingTimer: number | null = null;
  private inflight: Promise<SpatialContext | null> | null = null;
  private queued = false;
  private previewAbort: AbortController | null = null;
  private confirmations = new Map<string, HeldConfirmation>();
  private confirmationWaiters = new Map<string, Array<() => void>>();
  private roomId: string | null = null;
  private exploreAbort: AbortController | null = null;

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  update(partial: Partial<SpatialState>): void {
    this.state = { ...this.state, ...partial };
    for (const l of this.listeners) l();
  }

  select(candidateId: string | null): void {
    this.update({ selectedId: candidateId });
  }
  focus(candidateId: string): void {
    this.update({ selectedId: candidateId, focusNonce: this.state.focusNonce + 1 });
  }
  noteLocalScopeCenter(center: { lat: number; lng: number }): void {
    this.update({ localScopeCenterKey: `${center.lat},${center.lng}` });
  }
  clearLocalScopeCenter(centerKey?: string): void {
    if (centerKey && this.state.localScopeCenterKey !== centerKey) return;
    if (this.state.localScopeCenterKey) this.update({ localScopeCenterKey: null });
  }
  setOutstanding(outstanding: OutstandingItem[] | undefined): void {
    if (outstanding) this.update({ outstanding });
  }
  setViewing(rows: Array<{ participantId: string; candidateId: string }>): void {
    const viewing: Record<string, string> = {};
    for (const r of rows) viewing[r.participantId] = r.candidateId;
    this.update({ viewing });
  }
  pushAgentReply(reply: Omit<AgentReply, "id">): void {
    const id = `r_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    this.update({ agentReplies: [{ id, ...reply }, ...this.state.agentReplies].slice(0, 3) });
  }
  dismissAgentReply(id: string): void {
    this.update({ agentReplies: this.state.agentReplies.filter((r) => r.id !== id) });
  }
  setAgentBusy(agentBusy: boolean, agentPhase: SpatialState["agentPhase"] = null): void {
    if (this.state.agentBusy !== agentBusy || this.state.agentPhase !== agentPhase) {
      this.update({ agentBusy, agentPhase: agentBusy ? agentPhase : null });
    }
  }

  /** The `lookups` frame: which places are being looked up right now. */
  setLookups(pending: string[], reason: LookupReason | null): void {
    const same =
      pending.length === this.state.busy.length &&
      pending.every((id, i) => id === this.state.busy[i]);
    if (!same || reason !== this.state.busyReason) {
      this.update({ busy: pending, busyReason: pending.length ? reason : null });
    }
    this.reconcilePending();
  }

  /** The `facts` frame: facts changed outside the event stream. */
  noteFacts(ids: string[]): void {
    this.update({ facts: { ids, nonce: this.state.facts.nonce + 1 } });
  }

  /** A need this page just said. Returns the local id the row is keyed by. */
  beginPendingNeed(label: string, visibility: string): string {
    const localId = `n_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    this.update({
      pendingNeeds: [
        ...this.state.pendingNeeds,
        { localId, label, visibility, startedAt: Date.now(), committedAt: null, needId: null, boundAt: null },
      ],
    });
    this.reconcilePending();
    return localId;
  }
  /** The server accepted (or refused) it. */
  settlePendingCommit(localId: string, ok: boolean): void {
    if (!ok) {
      this.update({ pendingNeeds: this.state.pendingNeeds.filter((n) => n.localId !== localId) });
      return;
    }
    this.update({
      pendingNeeds: this.state.pendingNeeds.map((n) =>
        n.localId === localId && n.committedAt === null ? { ...n, committedAt: Date.now() } : n,
      ),
    });
    this.reconcilePending();
  }
  /**
   * The context now shows needs this page has not seen: bind them, oldest
   * first, to the pending rows that were committed and are still unbound.
   */
  bindPendingNeeds(newNeedIds: string[]): string[] {
    if (newNeedIds.length === 0) return [];
    const queue = [...newNeedIds];
    const bound: string[] = [];
    const pendingNeeds = this.state.pendingNeeds.map((n) => {
      if (n.needId !== null || n.committedAt === null) return n;
      const needId = queue.shift();
      if (!needId) return n;
      bound.push(needId);
      return { ...n, needId, boundAt: Date.now() };
    });
    if (bound.length > 0) this.update({ pendingNeeds });
    this.reconcilePending();
    return bound;
  }
  /** A row said and sent, whose commit the page has not heard back on. */
  get awaitingCommit(): boolean {
    return this.state.pendingNeeds.some((n) => n.needId === null && n.committedAt === null);
  }
  /**
   * A pending need settles once it is bound and the room has been quiet
   * (no lookups) for the grace period, or at the cap. Timers re-run this
   * so the row settles on its own, not on the next unrelated update.
   */
  private reconcilePending(): void {
    if (this.pendingTimer !== null) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    if (this.state.pendingNeeds.length === 0) return;
    const now = Date.now();
    const quiet = this.state.busy.length === 0;
    let next = Infinity;
    const keep = this.state.pendingNeeds.filter((n) => {
      const cap = n.startedAt + PENDING_CAP_MS;
      if (now >= cap) return false;
      if (n.needId !== null && n.boundAt !== null) {
        const grace = n.boundAt + PENDING_GRACE_MS;
        if (quiet && now >= grace) return false;
        if (quiet) next = Math.min(next, grace);
      }
      next = Math.min(next, cap);
      return true;
    });
    if (keep.length !== this.state.pendingNeeds.length) this.update({ pendingNeeds: keep });
    if (keep.length > 0 && Number.isFinite(next)) {
      this.pendingTimer = window.setTimeout(() => {
        this.pendingTimer = null;
        this.reconcilePending();
      }, Math.max(20, next - Date.now()));
    }
  }

  /** A new room is the only boundary that clears accumulated exploration. */
  beginRoom(roomId: string): void {
    if (this.roomId === roomId) return;
    this.roomId = roomId;
    this.exploreAbort?.abort();
    this.exploreAbort = null;
    this.update({
      explore: new Map(),
      exploreTruncated: false,
      busy: [],
      busyReason: null,
      localScopeCenterKey: null,
    });
  }

  async loadExplore(
    roomId: string,
    bbox: [number, number, number, number],
  ): Promise<void> {
    if (this.roomId !== roomId) this.beginRoom(roomId);
    this.exploreAbort?.abort();
    const controller = new AbortController();
    this.exploreAbort = controller;
    const result = await fetchExplorePlaces(roomId, bbox, controller.signal);
    if (controller.signal.aborted || this.roomId !== roomId || !result.ok) return;
    const explore = mergeExploreCache(this.state.explore, result.places, bbox);
    if (
      explore !== this.state.explore ||
      result.truncated !== this.state.exploreTruncated
    ) {
      this.update({ explore, exploreTruncated: result.truncated });
    }
  }

  markExploreAdded(refs: string[]): void {
    if (refs.length === 0) return;
    const explore = new Map(this.state.explore);
    let changed = false;
    for (const ref of refs) {
      const place = explore.get(ref);
      if (!place || place.candidateId) continue;
      explore.set(ref, { ...place, added: true });
      changed = true;
    }
    if (changed) this.update({ explore });
  }

  /**
   * Press-and-hold: ask the server what the set looks like without one need.
   * A second hold aborts the first — an in-flight answer for a row the user
   * already released must never repaint the map.
   */
  startPreview(requirementId: string): void {
    this.previewAbort?.abort();
    const controller = new AbortController();
    this.previewAbort = controller;
    this.update({ previewNeedId: requirementId, preview: null });
    void (async () => {
      const result = (await spatialContext(controller.signal, requirementId)) as
        | SpatialContext
        | { ok: false };
      if (controller.signal.aborted) return;
      if (this.state.previewNeedId !== requirementId) return;
      if (result.ok) this.update({ preview: result });
    })();
  }

  endPreview(): void {
    this.previewAbort?.abort();
    this.previewAbort = null;
    if (this.state.preview || this.state.previewNeedId) {
      this.update({ preview: null, previewNeedId: null });
    }
  }

  /**
   * Confirmation nonces (INTERACTION-AND-BINDING.md §5.4). They arrive only on
   * the realtime channel and never enter React state or diagnostics — the page
   * holds each one just long enough for the gesture it authorizes.
   */
  putConfirmation(
    kind: ConfirmationKind,
    subjectId: string,
    nonce: string,
    expiresInMs: number,
  ): void {
    const key = `${kind}:${subjectId}`;
    this.confirmations.set(key, { nonce, expiresAt: Date.now() + expiresInMs });
    const waiting = this.confirmationWaiters.get(key);
    if (waiting) {
      this.confirmationWaiters.delete(key);
      for (const resolve of waiting) resolve();
    }
  }

  /**
   * The nonce for one staged subject, single-use here as it is on the server.
   * Briefly waits when it has not landed yet: the gesture becomes available
   * the moment the command result lands, which can just beat the socket frame.
   * Resolves to "" on timeout so the server answers with the honest
   * consent_required rather than the page inventing an error.
   */
  async takeConfirmation(
    kind: ConfirmationKind,
    subjectId: string,
    waitMs = CONFIRMATION_WAIT_MS,
  ): Promise<string> {
    const key = `${kind}:${subjectId}`;
    const take = () => {
      const held = this.confirmations.get(key);
      if (!held) return "";
      this.confirmations.delete(key);
      return held.expiresAt > Date.now() ? held.nonce : "";
    };
    const held = take();
    if (held) return held;
    await new Promise<void>((resolve) => {
      const waiters = this.confirmationWaiters.get(key) ?? [];
      const timer = setTimeout(() => {
        this.confirmationWaiters.set(
          key,
          (this.confirmationWaiters.get(key) ?? []).filter((w) => w !== onArrival),
        );
        resolve();
      }, waitMs);
      const onArrival = () => {
        clearTimeout(timer);
        resolve();
      };
      waiters.push(onArrival);
      this.confirmationWaiters.set(key, waiters);
    });
    return take();
  }

  /** Coalesced refetch; resolves with the freshest context it observed. */
  refetch(): Promise<SpatialContext | null> {
    if (this.inflight) {
      this.queued = true;
      return this.inflight;
    }
    this.inflight = (async () => {
      this.update({ refetching: true });
      try {
        const result = (await spatialContext()) as
          | SpatialContext
          | { ok: false; error?: { code: string } };
        if (result.ok) {
          const prev = this.state.context;
          if (!prev || result.revision >= prev.revision) {
            this.update({ context: result });
          }
          return this.state.context;
        }
        diagnostics.log(
          `spatial context unavailable: ${(result as { error?: { code: string } }).error?.code}`,
        );
        return this.state.context;
      } finally {
        this.inflight = null;
        this.update({ refetching: false });
        if (this.queued) {
          this.queued = false;
          void this.refetch();
        }
      }
    })();
    return this.inflight;
  }
}

export const spatial = new SpatialStore();

/**
 * Command-runner bridge: App owns baseRevision discipline (ref + catch-up on
 * sync_required) and registers its runner here so tool callbacks dispatch
 * through the exact same path as UI gestures — one command model, two entry
 * surfaces. Before registration (page still booting) commands answer
 * not_authenticated, mirroring the API layer's behavior.
 */
type CommandRunner = (
  type: string,
  input: Record<string, unknown>,
) => Promise<CommandEnvelope>;

let runner: CommandRunner | null = null;

export function registerCommandRunner(fn: CommandRunner): void {
  runner = fn;
}

export function runCommand(
  type: string,
  input: Record<string, unknown>,
): Promise<CommandEnvelope> {
  if (!runner) {
    return Promise.resolve({
      ok: false,
      error: {
        code: "not_authenticated",
        message: "The page is still initializing its session.",
        recovery: "Retry in a moment.",
      },
    });
  }
  return runner(type, input).then((result) => {
    if (result.ok && type === "AddCandidates" && Array.isArray(input.refs)) {
      spatial.markExploreAdded(input.refs.filter((ref): ref is string => typeof ref === "string"));
    }
    return result;
  });
}
