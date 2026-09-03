import type { LookupsMessage } from "@webmcp-hackathon/contracts";
import {
  hostGateOpen as outboundHostGateOpen,
  routeFor as outboundRouteFor,
  type OutboundPurpose,
  type OutboundRoute,
} from "../net/outbound.ts";
import { PipelineFrames } from "./frames.ts";
import { createPipelinePools, type PipelinePools, type PoolName } from "./pools.ts";
import {
  PipelineQueue,
  ReadyBuffer,
  pipelineDedupeKey,
  type PipelineKind,
  type PipelineItem,
  type PipelinePriority,
  type QueuedPipelineItem,
} from "./queue.ts";
import { PipelineVolumeModel } from "./volume.ts";

export interface DispatchResult<T> {
  value: T;
  /** The route observed by the transport, which corrects scheduler accounting. */
  actualRoute: OutboundRoute;
  status?: number;
  failureClass?: string;
}

export type PipelineDispatcher = <T>(
  item: PipelineItem,
  route: OutboundRoute | undefined,
  attempt: 0 | 1,
  signal?: AbortSignal,
) => Promise<DispatchResult<T>>;

export interface SchedulerOptions {
  pools?: PipelinePools;
  queue?: PipelineQueue;
  ready?: ReadyBuffer;
  volume?: PipelineVolumeModel;
  frames?: PipelineFrames;
  dispatcher?: PipelineDispatcher;
  routeFor?: (host: string, purpose: OutboundPurpose) => OutboundRoute;
  hostGateOpen?: (host: string) => boolean;
  timeouts?: Partial<Record<PipelineKind, number>>;
}

type EnqueueOptions = {
  present?: boolean;
  reason?: NonNullable<LookupsMessage["reason"]> & {
    visibility?: "shared" | "application-private" | "agent-private";
  };
};

type EnqueueListener = (item: PipelineItem) => void;

const DEFAULT_PIPELINE_TIMEOUT_MS: Readonly<Record<PipelineKind, number>> = {
  "fetch.site": 30_000,
  "fetch.asset": 30_000,
  "fetch.search": 45_000,
  "process.judge": 120_000,
  "process.adjudicate": 120_000,
  "process.vision": 60_000,
  "process.decode": 30_000,
};

const PIPELINE_TIMEOUT_ENV: Readonly<Record<PipelineKind, string>> = {
  "fetch.site": "PIPELINE_TIMEOUT_FETCH_SITE_MS",
  "fetch.asset": "PIPELINE_TIMEOUT_FETCH_ASSET_MS",
  "fetch.search": "PIPELINE_TIMEOUT_FETCH_SEARCH_MS",
  "process.judge": "PIPELINE_TIMEOUT_PROCESS_JUDGE_MS",
  "process.adjudicate": "PIPELINE_TIMEOUT_PROCESS_ADJUDICATE_MS",
  "process.vision": "PIPELINE_TIMEOUT_PROCESS_VISION_MS",
  "process.decode": "PIPELINE_TIMEOUT_PROCESS_DECODE_MS",
};

function positiveTimeout(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function poolForKind(item: PipelineItem, route?: OutboundRoute): PoolName {
  if (item.intent === "interactive") return "interactive";
  if (item.kind === "fetch.search") return "search";
  if (item.kind === "fetch.site" || item.kind === "fetch.asset") return route ?? "direct";
  if (item.kind === "process.vision") return "vision";
  if (item.kind === "process.decode") return "image-decode";
  return "llm-matrix";
}

function blockShaped(result: Pick<DispatchResult<unknown>, "status" | "failureClass">): boolean {
  return result.status === 403 || result.status === 429 || result.status === 503 ||
    result.failureClass === "connect-502" || result.failureClass === "proxy-reported-target";
}

function blockShapedError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const candidate = error as Error & {
    status?: number;
    failureClass?: string;
    outboundFailure?: { proxyStatus?: number; leg?: string };
  };
  return candidate.status === 403 || candidate.status === 429 || candidate.status === 503 ||
    candidate.failureClass === "connect-502" || candidate.outboundFailure?.proxyStatus === 502;
}

function withSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => rejectAbort(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  return Promise.race([promise, aborted]).finally(() => {
    signal.removeEventListener("abort", onAbort);
  });
}

/** Process-global admission controller: DRR queue, route-aware pools and host hints. */
export class PipelineScheduler {
  readonly pools: PipelinePools;
  readonly queue: PipelineQueue;
  readonly ready: ReadyBuffer;
  readonly volume: PipelineVolumeModel;
  readonly frames: PipelineFrames;
  private readonly dispatcher?: PipelineDispatcher;
  private readonly routeAuthority: (host: string, purpose: OutboundPurpose) => OutboundRoute;
  private readonly gateOpen: (host: string) => boolean;
  private readonly timeouts: Record<PipelineKind, number>;
  private pumping = false;
  private pumpAgain = false;
  private pumpRuns = 0;
  private readonly inFlight = new Map<string, PipelineItem>();
  private readonly batches = new Map<string, PipelineItem[]>();
  private readonly roomEpochs = new Map<string, number>();
  private readonly routeCompletions: Record<OutboundRoute, number> = { direct: 0, proxy: 0 };
  private readonly enqueueListeners = new Set<EnqueueListener>();

  constructor(options: SchedulerOptions = {}) {
    this.pools = options.pools ?? createPipelinePools();
    this.queue = options.queue ?? new PipelineQueue();
    this.ready = options.ready ?? new ReadyBuffer();
    this.volume = options.volume ?? new PipelineVolumeModel({
      fetch: this.pools.proxy.limit + this.pools.direct.limit + this.pools.search.limit,
      process: this.pools["llm-matrix"].limit,
    });
    this.frames = options.frames ?? new PipelineFrames(this.volume);
    this.dispatcher = options.dispatcher;
    this.routeAuthority = options.routeFor ?? outboundRouteFor;
    this.gateOpen = options.hostGateOpen ?? outboundHostGateOpen;
    this.timeouts = Object.fromEntries(
      (Object.keys(DEFAULT_PIPELINE_TIMEOUT_MS) as PipelineKind[]).map((kind) => [
        kind,
        options.timeouts?.[kind] ?? positiveTimeout(
          process.env[PIPELINE_TIMEOUT_ENV[kind]],
          DEFAULT_PIPELINE_TIMEOUT_MS[kind],
        ),
      ]),
    ) as Record<PipelineKind, number>;
    this.ready.onDrain(() => this.wake());
  }

  enqueue<T>(
    item: Omit<PipelineItem, "predictedPool" | "predictedRoute">,
    run?: (
      route: OutboundRoute | undefined,
      attempt: 0 | 1,
      signal?: AbortSignal,
    ) => Promise<DispatchResult<T>>,
    options: EnqueueOptions = {},
  ): Promise<T> {
    const predictedRoute = this.enqueueRoute(item);
    const planned: PipelineItem = {
      ...item,
      ...(predictedRoute ? { predictedRoute } : {}),
      predictedPool: poolForKind(item as PipelineItem, predictedRoute),
    };
    const execute = async (route?: OutboundRoute, signal?: AbortSignal): Promise<T> => {
      const dispatch = run ?? (this.dispatcher
        ? ((chosen, attempt, dispatchSignal) =>
          this.dispatcher!(planned, chosen, attempt, dispatchSignal) as Promise<DispatchResult<T>>)
        : undefined);
      if (!dispatch) throw new Error("pipeline item has no dispatcher");
      let first: DispatchResult<T>;
      try {
        first = await withSignal(dispatch(route, 0, signal), signal);
      } catch (error) {
        if (planned.intent !== "interactive" || route !== "direct" || !blockShapedError(error)) throw error;
        const retried = await withSignal(dispatch("proxy", 1, signal), signal);
        this.routeCompletions[retried.actualRoute] += 1;
        return retried.value;
      }
      if (planned.intent === "interactive" && route === "direct" && blockShaped(first)) {
        const retried = await withSignal(dispatch("proxy", 1, signal), signal);
        this.routeCompletions[retried.actualRoute] += 1;
        return retried.value;
      }
      this.routeCompletions[first.actualRoute] += 1;
      return first.value;
    };
    const queued = this.queue.enqueue(planned, execute, options.present === false ? 1 : 4);
    if (queued.inserted) {
      for (const listener of this.enqueueListeners) listener(planned);
      this.volume.enqueue(planned);
      this.frames.update(planned, "queued", options.reason);
      this.wake();
    }
    return queued.promise as Promise<T>;
  }

  /**
   * Admit one matrix rectangle as one pool job while accounting each
   * (place, criterion) cell independently. Cells may already be represented
   * in the ready buffer; in that case `buffered` preserves their outstanding
   * volume and processing stage until the rectangle starts.
   */
  enqueueBatch<T>(
    items: Array<Omit<PipelineItem, "predictedPool" | "predictedRoute">>,
    run: () => Promise<T>,
    options: EnqueueOptions & { buffered?: boolean } = {},
  ): Promise<T> {
    if (items.length === 0) return Promise.reject(new Error("pipeline batch is empty"));
    const plannedItems: PipelineItem[] = items.map((entry) => ({
      ...entry,
      predictedPool: poolForKind(entry as PipelineItem),
    }));
    const criteria = [...new Map(plannedItems.flatMap((entry) => entry.criteria).map((entry) => [
      entry.id,
      entry,
    ])).values()];
    const representativeBase = {
      ...plannedItems[0],
      criteria,
      dedupeKey: pipelineDedupeKey({
        ...plannedItems[0],
        osmRef: plannedItems.map((entry) => entry.dedupeKey).sort().join(","),
        criteria,
      }),
    };
    const representative: PipelineItem = {
      ...representativeBase,
      predictedPool: poolForKind(representativeBase),
    };
    const queued = this.queue.enqueue(
      representative,
      async () => run(),
      options.present === false ? 1 : 4,
    );
    if (queued.inserted) {
      for (const entry of plannedItems) {
        for (const listener of this.enqueueListeners) listener(entry);
      }
      this.batches.set(representative.dedupeKey, plannedItems);
      if (!options.buffered) {
        for (const entry of plannedItems) {
          this.volume.enqueue(entry);
          this.frames.update(entry, "processing", options.reason);
        }
      }
      this.wake();
    } else {
      const tracked = this.batches.get(representative.dedupeKey);
      if (!tracked) {
        if (options.buffered) {
          for (const entry of plannedItems) this.dropBuffered(entry);
        }
        return Promise.reject(new Error("pipeline batch dedupe representative is not a batch"));
      }
      const alreadyRunning = tracked.some((entry) => this.inFlight.has(entry.dedupeKey));
      tracked.push(...plannedItems);
      if (!options.buffered) {
        for (const entry of plannedItems) {
          this.volume.enqueue(entry);
          this.frames.update(entry, "processing", options.reason);
        }
      }
      if (alreadyRunning) {
        for (const entry of plannedItems) {
          this.inFlight.set(entry.dedupeKey, entry);
          this.volume.start(entry);
          this.frames.update(entry, "processing", options.reason);
        }
      }
    }
    return queued.promise as Promise<T>;
  }

  /** Marks fetched evidence as process work while it waits for the batcher. */
  buffer(item: PipelineItem, options: EnqueueOptions = {}): void {
    this.volume.enqueue(item);
    this.frames.update(item, "processing", options.reason);
  }

  dropBuffered(item: PipelineItem): void {
    this.volume.drop(item);
    this.frames.update(item, null);
  }

  /** Called by the outbound gate release path or tests; it never polls. */
  notifyHostGateReleased(_host: string): void {
    this.wake();
  }

  /** Process-local diagnostics seam for scripted tests and live measurement. */
  onEnqueue(listener: EnqueueListener): () => void {
    this.enqueueListeners.add(listener);
    return () => this.enqueueListeners.delete(listener);
  }

  needsChanged(roomId: string, needsEpoch: number, activeCriterionIds: Set<string>): PipelineItem[] {
    const previousEpoch = this.roomEpochs.get(roomId);
    const epochChanged = previousEpoch !== undefined && previousEpoch !== needsEpoch;
    this.roomEpochs.set(roomId, needsEpoch);
    const dropped = this.queue.changeNeeds(roomId, needsEpoch, activeCriterionIds);
    for (const item of dropped) {
      const tracked = this.batches.get(item.dedupeKey) ?? [item];
      for (const entry of tracked) {
        this.volume.drop(entry);
        this.frames.update(entry, null);
      }
      this.batches.delete(item.dedupeKey);
    }
    if (epochChanged) {
      this.volume.reset(roomId);
      for (const item of this.queue.roomItems(roomId)) this.volume.enqueue(item);
      for (const item of this.inFlight.values()) {
        if (item.roomId !== roomId) continue;
        this.volume.enqueue(item);
        this.volume.start(item);
      }
      this.frames.changed(roomId);
    }
    this.wake();
    return dropped;
  }

  reprioritise(
    roomId: string,
    ranking: Map<string, PipelinePriority>,
    owned: (item: PipelineItem) => boolean = () => true,
  ): PipelineItem[] {
    const changed = this.queue.reprioritise(roomId, ranking, (item, priority) => {
      const prioritised = { ...item, priority };
      const predictedRoute = this.enqueueRoute(prioritised);
      return {
        predictedPool: poolForKind(prioritised, predictedRoute),
        ...(predictedRoute ? { predictedRoute } : {}),
      };
    }, owned);
    if (changed.length > 0) {
      this.frames.changed(roomId);
      this.wake();
    }
    return changed;
  }

  dropQueued(roomId: string, predicate: (item: PipelineItem) => boolean): PipelineItem[] {
    const dropped = this.queue.dropQueued(roomId, (item) => {
      const tracked = this.batches.get(item.dedupeKey) ?? [item];
      return tracked.some(predicate);
    });
    for (const item of dropped) this.cleanup(item, true);
    if (dropped.length > 0) this.wake();
    return dropped;
  }

  accounting(): { inFlight: Record<PoolName, number>; completions: Record<OutboundRoute, number> } {
    return {
      inFlight: Object.fromEntries(
        Object.entries(this.pools).map(([name, pool]) => [name, pool.inFlight]),
      ) as Record<PoolName, number>,
      completions: { ...this.routeCompletions },
    };
  }

  /** Monotonic diagnostic used to bound scheduler work in regression tests. */
  get pumpCycles(): number {
    return this.pumpRuns;
  }

  reset(): void {
    this.queue.clear();
    this.frames.reset();
    this.inFlight.clear();
    this.batches.clear();
    this.roomEpochs.clear();
    this.pumpRuns = 0;
    this.routeCompletions.direct = 0;
    this.routeCompletions.proxy = 0;
  }

  private enqueueRoute(item: Omit<PipelineItem, "predictedPool" | "predictedRoute">): OutboundRoute | undefined {
    if (item.kind !== "fetch.site" && item.kind !== "fetch.asset") return undefined;
    const authoritative = item.host && item.purpose
      ? this.routeAuthority(item.host, item.purpose)
      : "direct";
    // This is a pool hint only. Dispatch repeats routeFor below and the
    // outbound client remains authoritative about the actual route.
    return item.priority === 0 ? "direct" : authoritative;
  }

  private dispatchRoute(item: PipelineItem): OutboundRoute | undefined {
    if (item.kind !== "fetch.site" && item.kind !== "fetch.asset") return undefined;
    const authoritative = item.host && item.purpose
      ? this.routeAuthority(item.host, item.purpose)
      : "direct";
    return authoritative;
  }

  private eligible = (item: PipelineItem): boolean => {
    if (
      item.kind.startsWith("fetch.") && item.priority !== 0 &&
      item.intent !== "interactive" && !this.ready.canAdmitFetch(item.roomId)
    ) return false;
    return !item.host || this.gateOpen(item.host);
  };

  private wake(): void {
    if (this.pumping) {
      this.pumpAgain = true;
      return;
    }
    this.pump();
  }

  private pump(): void {
    this.pumping = true;
    try {
      do {
        this.pumpRuns += 1;
        this.pumpAgain = false;
        for (const [name, pool] of Object.entries(this.pools) as Array<[PoolName, PipelinePools[PoolName]]>) {
          while (pool.available > 0) {
            let entry: QueuedPipelineItem | undefined;
            try {
              entry = this.queue.take(
                name,
                (item) => pool.canRun(item.priority) && this.eligible(item),
                32,
                (failed, error) => this.fail(failed, error),
              );
              if (!entry) break;
              this.launch(entry);
            } catch (error) {
              if (entry) this.fail(entry, error);
              else console.warn(
                "pipeline pump failed:",
                error instanceof Error ? error.message : String(error),
              );
            }
          }
        }
      } while (this.pumpAgain);
    } finally {
      this.pumping = false;
    }
  }

  private launch(entry: QueuedPipelineItem): void {
    const item = entry.item;
    const tracked = this.batches.get(item.dedupeKey) ?? [item];
    const route = this.dispatchRoute(item);
    const actualPool = this.pools[poolForKind(item, route)];
    for (const trackedItem of tracked) {
      this.inFlight.set(trackedItem.dedupeKey, trackedItem);
      this.volume.start(trackedItem);
      this.frames.update(
        trackedItem,
        trackedItem.kind.startsWith("fetch.") ? "fetching" : "processing",
      );
    }
    void actualPool.submit(
      () => this.runWithDeadline(entry, route),
      item.priority,
    ).then(
      (value) => {
        this.cleanup(item);
        this.queue.settle(entry, value);
      },
      (error) => {
        if (error instanceof PipelineTimeoutError) {
          for (const trackedItem of tracked) this.frames.stall(trackedItem);
        }
        this.cleanup(item);
        this.queue.settle(entry, undefined, error);
      },
    ).finally(() => this.wake());
  }

  private runWithDeadline(
    entry: QueuedPipelineItem,
    route: OutboundRoute | undefined,
  ): Promise<unknown> {
    const timeoutMs = this.timeouts[entry.item.kind];
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new PipelineTimeoutError(entry.item.kind, timeoutMs);
        console.warn(JSON.stringify({
          msg: "pipeline timeout",
          roomId: entry.item.roomId,
          candidateId: entry.item.candidateId,
          kind: entry.item.kind,
          timeoutMs,
        }));
        controller.abort(error);
        reject(error);
      }, timeoutMs);
      timer.unref?.();
    });
    return Promise.race([entry.run(route, controller.signal), timeout]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  private fail(entry: QueuedPipelineItem, error: unknown): void {
    this.cleanup(entry.item, true);
    this.queue.settle(entry, undefined, error);
  }

  private cleanup(item: PipelineItem, dropped = false): void {
    const tracked = this.batches.get(item.dedupeKey) ?? [item];
    for (const trackedItem of tracked) {
      this.inFlight.delete(trackedItem.dedupeKey);
      if (dropped) this.volume.drop(trackedItem);
      else this.volume.settle(trackedItem);
      this.frames.update(trackedItem, null);
    }
    this.batches.delete(item.dedupeKey);
  }
}

export class PipelineTimeoutError extends Error {
  readonly kind: PipelineKind;
  readonly timeoutMs: number;

  constructor(kind: PipelineKind, timeoutMs: number) {
    super(`pipeline ${kind} timed out after ${timeoutMs} ms`);
    this.name = "PipelineTimeoutError";
    this.kind = kind;
    this.timeoutMs = timeoutMs;
  }
}

export const pipelineScheduler = new PipelineScheduler();
