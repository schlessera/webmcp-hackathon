export const PREFETCH_LIMIT = 2;
export const PREFETCH_OPEN_WINDOW_MS = 5_000;

export interface PrefetchContext {
  signal: AbortSignal;
}

interface PrefetchEntry {
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  opened: boolean;
  running: boolean;
}

interface QueuedPrefetch {
  key: string;
  run(context: PrefetchContext): Promise<void>;
}

/**
 * Process-local speculative-work gate. Cancellation is cooperative: queued
 * work is removed immediately and running work receives an AbortSignal so it
 * cannot advance to another stage after the five-second open window.
 */
export class PrefetchManager {
  readonly limit: number;
  readonly openWindowMs: number;
  private readonly entries = new Map<string, PrefetchEntry>();
  private readonly queue: QueuedPrefetch[] = [];
  private active = 0;

  constructor(limit = PREFETCH_LIMIT, openWindowMs = PREFETCH_OPEN_WINDOW_MS) {
    this.limit = limit;
    this.openWindowMs = openWindowMs;
  }

  preview(key: string, run: QueuedPrefetch["run"]): void {
    if (this.entries.has(key)) return;
    const controller = new AbortController();
    const entry: PrefetchEntry = {
      controller,
      opened: false,
      running: false,
      timer: setTimeout(() => this.cancel(key), this.openWindowMs),
    };
    entry.timer.unref?.();
    this.entries.set(key, entry);
    this.queue.push({ key, run });
    this.pump();
  }

  opened(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.opened = true;
    clearTimeout(entry.timer);
    if (!entry.running) this.entries.delete(key);
  }

  cancel(key: string): void {
    const entry = this.entries.get(key);
    if (!entry || entry.opened) return;
    clearTimeout(entry.timer);
    entry.controller.abort();
    const queued = this.queue.findIndex((candidate) => candidate.key === key);
    if (queued >= 0) this.queue.splice(queued, 1);
    this.entries.delete(key);
  }

  reset(): void {
    for (const entry of this.entries.values()) {
      clearTimeout(entry.timer);
      entry.controller.abort();
    }
    this.entries.clear();
    this.queue.length = 0;
    this.active = 0;
  }

  get inFlight(): number {
    return this.active;
  }

  get pending(): number {
    return this.queue.length;
  }

  private pump(): void {
    while (this.active < this.limit && this.queue.length > 0) {
      const queued = this.queue.shift()!;
      const entry = this.entries.get(queued.key);
      if (!entry || entry.controller.signal.aborted) continue;
      this.active += 1;
      entry.running = true;
      void queued.run({ signal: entry.controller.signal }).catch(() => undefined).finally(() => {
        this.active -= 1;
        entry.running = false;
        const current = this.entries.get(queued.key);
        if (current === entry && entry.opened) {
          this.entries.delete(queued.key);
        }
        this.pump();
      });
    }
  }
}

export const prefetchManager = new PrefetchManager();

export function prefetchKey(roomId: string, candidateId: string): string {
  return `${roomId}\u0000${candidateId}`;
}
