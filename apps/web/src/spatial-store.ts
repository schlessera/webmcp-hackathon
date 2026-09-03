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
  /** Bounded snapshot-place cache across recent viewport reads, by stable ref. */
  explore: Map<string, ExplorePlace>;
  /** Whether the most recent viewport held more than the endpoint cap. */
  exploreTruncated: boolean;
  /** Candidate ids currently being looked up; map dots expose data-busy. */
  lookupPending: Set<string>;
}

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
    explore: new Map(),
    exploreTruncated: false,
    lookupPending: new Set(),
  };
  private listeners = new Set<Listener>();
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
  setAgentBusy(agentBusy: boolean): void {
    if (this.state.agentBusy !== agentBusy) this.update({ agentBusy });
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
      lookupPending: new Set(),
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

  setLookupPending(candidateIds: string[]): void {
    this.update({ lookupPending: new Set(candidateIds) });
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
