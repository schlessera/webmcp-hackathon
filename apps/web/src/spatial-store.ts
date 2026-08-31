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
  /** Latest outstanding list for THIS participant (from sync/command results). */
  outstanding: OutstandingItem[];
  /** A grant that the server staged pending in-page confirmation. */
  stagedConfirm: { requestId: string; summary: string } | null;
}

type Listener = () => void;

class SpatialStore {
  state: SpatialState = {
    context: null,
    selectedId: null,
    focusNonce: 0,
    outstanding: [],
    stagedConfirm: null,
  };
  private listeners = new Set<Listener>();
  private inflight: Promise<SpatialContext | null> | null = null;
  private queued = false;

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
  stageConfirm(value: SpatialState["stagedConfirm"]): void {
    this.update({ stagedConfirm: value });
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
