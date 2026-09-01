import { spatialContext } from "./api.ts";
import { diagnostics } from "./diagnostics-store.ts";
import type {
  CommandEnvelope,
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
  /** Latest outstanding list for THIS participant (from sync/command results).
   * A grant beyond the delegated bound comes back as an adjustment_request
   * with staged:true — that flag alone drives the in-page confirm card. */
  outstanding: OutstandingItem[];
  /** The set as it would be without one need, while its brief row is held.
   * Never merged into `context`: the live truth must survive the gesture. */
  preview: SpatialContext | null;
  previewNeedId: string | null;
}

type Listener = () => void;

export type ConfirmationKind = "agreement" | "private_request";

interface HeldConfirmation {
  nonce: string;
  expiresAt: number;
}

/** How long a confirm/commit gesture waits for its nonce to land on the socket. */
const CONFIRMATION_WAIT_MS = 3000;

class SpatialStore {
  state: SpatialState = {
    context: null,
    selectedId: null,
    focusNonce: 0,
    outstanding: [],
    preview: null,
    previewNeedId: null,
  };
  private listeners = new Set<Listener>();
  private inflight: Promise<SpatialContext | null> | null = null;
  private queued = false;
  private previewAbort: AbortController | null = null;
  private confirmations = new Map<string, HeldConfirmation>();
  private confirmationWaiters = new Map<string, Array<() => void>>();

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
  setOutstanding(outstanding: OutstandingItem[] | undefined): void {
    if (outstanding) this.update({ outstanding });
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
  return runner(type, input);
}
