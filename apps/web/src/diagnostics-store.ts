/** Development diagnostics panel state: registration errors must be visible. */
import { wire } from "./wire-store.ts";

export interface DiagnosticsState {
  modelContextPresent: boolean;
  registration: "pending" | "registered" | "failed" | "unsupported";
  registrationError: string | null;
  wsState: "connecting" | "open" | "closed";
  /** navigator.onLine as the browser last reported it. */
  online: boolean;
  /** The socket claims open but nothing (not even a keepalive) has arrived
   * for ten seconds: a half-open link, treated as dropped. */
  wsStale: boolean;
  buildId: string | null;
  serverBuildId: string | null;
  /** The serving process can hand a sentence to the person's agent. */
  nlAvailable: boolean;
  /** Which drawer folds the reader opened or closed (W13): survives the
   * drawer closing and reopening; a fold never seen falls back to its default. */
  folds: Record<string, boolean>;
  /** Wire timeline lanes (and "ping") the reader switched off; same lifetime
   * as `folds`. Keepalives are off until asked for. */
  wireHidden: string[];
}

type Listener = () => void;

class DiagnosticsStore {
  state: DiagnosticsState = {
    modelContextPresent: false,
    registration: "pending",
    registrationError: null,
    wsState: "connecting",
    online: typeof navigator === "undefined" ? true : navigator.onLine,
    wsStale: false,
    buildId: null,
    serverBuildId: null,
    nlAvailable: false,
    folds: {},
    wireHidden: ["ping"],
  };
  private listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  update(partial: Partial<DiagnosticsState>): void {
    this.state = { ...this.state, ...partial };
    for (const l of this.listeners) l();
  }
  /** A page moment on the wire timeline (the old text log's entry point). */
  log(line: string): void {
    wire.mark({ lane: "page", label: line });
  }
}

export const diagnostics = new DiagnosticsStore();
