export type PoolName =
  | "interactive"
  | "proxy"
  | "direct"
  | "search"
  | "llm-matrix"
  | "vision"
  | "image-decode";

function boundedEnv(name: string, fallback: number, min = 1, max = 64): number {
  const parsed = Number(process.env[name]);
  return Number.isInteger(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

/** A continuously refilled FIFO semaphore. A released slot is reserved before waking. */
export class PipelinePool {
  readonly name: PoolName;
  readonly limit: number;
  readonly reserved: number;
  private active = 0;
  private backgroundActive = 0;
  private readonly waiting: Array<{ priority: number; resolve(): void }> = [];
  private peak = 0;

  constructor(name: PoolName, limit: number, reserved = 0) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("pool limit must be positive");
    if (!Number.isInteger(reserved) || reserved < 0 || reserved > limit) {
      throw new Error("pool reservation must be between zero and the pool limit");
    }
    this.name = name;
    this.limit = limit;
    this.reserved = reserved;
  }

  get inFlight(): number {
    return this.active;
  }

  get maxInFlight(): number {
    return this.peak;
  }

  get queued(): number {
    return this.waiting.length;
  }

  get available(): number {
    return Math.max(0, this.limit - this.active);
  }

  /** Priority zero may use every free slot; all other work leaves the reserve untouched. */
  canRun(priority: number): boolean {
    return priority === 0
      ? this.active < this.limit
      : this.active < this.limit && this.backgroundActive < this.limit - this.reserved;
  }

  async submit<T>(run: () => Promise<T> | T, priority = 0): Promise<T> {
    if (!this.canRun(priority) || this.hasEarlierEligibleWaiter(priority)) {
      await new Promise<void>((resolve) => this.waiting.push({ priority, resolve }));
    } else {
      this.reserve(priority);
    }
    try {
      return await run();
    } finally {
      this.release(priority);
    }
  }

  private hasEarlierEligibleWaiter(priority: number): boolean {
    if (this.waiting.length === 0) return false;
    // Interactive work may pass background waiters that cannot use the
    // reserved capacity, but never another interactive waiter.
    return priority === 0
      ? this.waiting.some((entry) => entry.priority === 0)
      : true;
  }

  private reserve(priority: number): void {
    this.active += 1;
    if (priority !== 0) this.backgroundActive += 1;
    this.peak = Math.max(this.peak, this.active);
  }

  private release(priority: number): void {
    this.active -= 1;
    if (priority !== 0) this.backgroundActive -= 1;
    const interactive = this.waiting.findIndex((entry) => entry.priority === 0 && this.canRun(0));
    const background = this.waiting.findIndex((entry) => entry.priority !== 0 && this.canRun(1));
    const index = interactive >= 0 ? interactive : background;
    if (index < 0) return;
    const [next] = this.waiting.splice(index, 1);
    this.reserve(next.priority);
    next.resolve();
  }
}

export type PipelinePools = Record<PoolName, PipelinePool>;

export const RESERVED_PRIORITY_ZERO: Readonly<Record<PoolName, number>> = {
  interactive: 0,
  proxy: 0,
  direct: 2,
  search: 1,
  "llm-matrix": 1,
  vision: 1,
  "image-decode": 1,
};

export function createPipelinePools(
  overrides: Partial<Record<PoolName, number>> = {},
  reservations: Partial<Record<PoolName, number>> = {},
): PipelinePools {
  const limits: Record<PoolName, number> = {
    interactive: boundedEnv("POOL_INTERACTIVE", 3),
    proxy: boundedEnv("POOL_PROXY", 8, 8, 12),
    direct: boundedEnv("POOL_DIRECT", 4),
    search: boundedEnv("POOL_SEARCH", 4),
    "llm-matrix": boundedEnv("POOL_LLM_MATRIX", 2),
    vision: boundedEnv("POOL_VISION", 1),
    "image-decode": boundedEnv("POOL_IMAGE_DECODE", 2),
    ...overrides,
  };
  return Object.fromEntries(
    Object.entries(limits).map(([name, limit]) => {
      const poolName = name as PoolName;
      return [name, new PipelinePool(
        poolName,
        limit,
        Math.min(
          limit,
          reservations[poolName] ?? RESERVED_PRIORITY_ZERO[poolName],
        ),
      )];
    }),
  ) as PipelinePools;
}
