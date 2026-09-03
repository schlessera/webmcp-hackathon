export type PoolName =
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
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  private peak = 0;

  constructor(name: PoolName, limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("pool limit must be positive");
    this.name = name;
    this.limit = limit;
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

  async submit<T>(run: () => Promise<T> | T): Promise<T> {
    if (this.active >= this.limit || this.waiting.length > 0) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.reserve();
    }
    try {
      return await run();
    } finally {
      this.release();
    }
  }

  private reserve(): void {
    this.active += 1;
    this.peak = Math.max(this.peak, this.active);
  }

  private release(): void {
    this.active -= 1;
    const next = this.waiting.shift();
    if (!next) return;
    this.reserve();
    next();
  }
}

export type PipelinePools = Record<PoolName, PipelinePool>;

export function createPipelinePools(overrides: Partial<Record<PoolName, number>> = {}): PipelinePools {
  const limits: Record<PoolName, number> = {
    proxy: boundedEnv("POOL_PROXY", 8, 8, 12),
    direct: boundedEnv("POOL_DIRECT", 4),
    search: boundedEnv("POOL_SEARCH", 4),
    "llm-matrix": boundedEnv("POOL_LLM_MATRIX", 2),
    vision: boundedEnv("POOL_VISION", 1),
    "image-decode": boundedEnv("POOL_IMAGE_DECODE", 2),
    ...overrides,
  };
  return Object.fromEntries(
    Object.entries(limits).map(([name, limit]) => [name, new PipelinePool(name as PoolName, limit)]),
  ) as PipelinePools;
}
