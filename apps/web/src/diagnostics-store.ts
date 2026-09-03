/** Development diagnostics panel state: registration errors must be visible. */

export interface DiagnosticsState {
  modelContextPresent: boolean;
  registration: "pending" | "registered" | "failed" | "unsupported";
  registrationError: string | null;
  wsState: "connecting" | "open" | "closed";
  buildId: string | null;
  serverBuildId: string | null;
  /** The serving process can hand a sentence to the person's agent. */
  nlAvailable: boolean;
  lines: string[];
  /** Which drawer folds the reader opened or closed (W13): survives the
   * drawer closing and reopening; a fold never seen falls back to its default. */
  folds: Record<string, boolean>;
}

type Listener = () => void;

class DiagnosticsStore {
  state: DiagnosticsState = {
    modelContextPresent: false,
    registration: "pending",
    registrationError: null,
    wsState: "connecting",
    buildId: null,
    serverBuildId: null,
    nlAvailable: false,
    lines: [],
    folds: {},
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
  log(line: string): void {
    const stamped = `${new Date().toISOString().slice(11, 19)} ${line}`;
    this.update({ lines: [...this.state.lines.slice(-49), stamped] });
  }
}

export const diagnostics = new DiagnosticsStore();
