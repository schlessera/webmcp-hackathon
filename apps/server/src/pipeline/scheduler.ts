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
  type PipelineItem,
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
}

type EnqueueOptions = {
  present?: boolean;
  reason?: NonNullable<LookupsMessage["reason"]> & {
    visibility?: "shared" | "application-private" | "agent-private";
  };
};

type EnqueueListener = (item: PipelineItem) => void;

function poolForKind(item: PipelineItem, route?: OutboundRoute): PoolName {
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
  private pumping = false;
  private pumpAgain = false;
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
    this.ready.onDrain(() => this.wake());
  }

  enqueue<T>(
    item: Omit<PipelineItem, "predictedPool" | "predictedRoute">,
    run?: (route: OutboundRoute | undefined, attempt: 0 | 1) => Promise<DispatchResult<T>>,
    options: EnqueueOptions = {},
  ): Promise<T> {
    const predictedRoute = this.enqueueRoute(item);
    const planned: PipelineItem = {
      ...item,
      ...(predictedRoute ? { predictedRoute } : {}),
      predictedPool: poolForKind(item as PipelineItem, predictedRoute),
    };
    const execute = async (route?: OutboundRoute): Promise<T> => {
      const dispatch = run ?? (this.dispatcher
        ? ((chosen, attempt) => this.dispatcher!(planned, chosen, attempt) as Promise<DispatchResult<T>>)
        : undefined);
      if (!dispatch) throw new Error("pipeline item has no dispatcher");
      let first: DispatchResult<T>;
      try {
        first = await dispatch(route, 0);
      } catch (error) {
        if (planned.intent !== "interactive" || route !== "direct" || !blockShapedError(error)) throw error;
        const retried = await this.pools.proxy.submit(() => dispatch("proxy", 1));
        this.routeCompletions[retried.actualRoute] += 1;
        return retried.value;
      }
      if (planned.intent === "interactive" && route === "direct" && blockShaped(first)) {
        const retried = await this.pools.proxy.submit(() => dispatch("proxy", 1));
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
    const criteria = [...new Map(items.flatMap((entry) => entry.criteria).map((entry) => [
      entry.id,
      entry,
    ])).values()];
    const representativeBase = {
      ...items[0],
      criteria,
      dedupeKey: pipelineDedupeKey({
        ...items[0],
        osmRef: items.map((entry) => entry.dedupeKey).sort().join(","),
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
      for (const entry of items) {
        for (const listener of this.enqueueListeners) listener(entry as PipelineItem);
      }
      this.batches.set(representative.dedupeKey, items as PipelineItem[]);
      if (!options.buffered) {
        for (const entry of items) {
          this.volume.enqueue(entry as PipelineItem);
          this.frames.update(entry as PipelineItem, "processing", options.reason);
        }
      }
      this.wake();
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
    // Fetches are criterion-independent; buffered evidence is viewed through
    // the current set instead of being discarded or cancelling in-flight work.
    this.ready.rematch(roomId, activeCriterionIds);
    this.wake();
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

  reset(): void {
    this.queue.clear();
    this.frames.reset();
    this.inFlight.clear();
    this.batches.clear();
    this.roomEpochs.clear();
    this.routeCompletions.direct = 0;
    this.routeCompletions.proxy = 0;
  }

  private enqueueRoute(item: Omit<PipelineItem, "predictedPool" | "predictedRoute">): OutboundRoute | undefined {
    if (item.kind !== "fetch.site" && item.kind !== "fetch.asset") return undefined;
    const authoritative = item.host && item.purpose
      ? this.routeAuthority(item.host, item.purpose)
      : "direct";
    return item.intent === "interactive" ? "direct" : authoritative;
  }

  private dispatchRoute(item: PipelineItem): OutboundRoute | undefined {
    if (item.kind !== "fetch.site" && item.kind !== "fetch.asset") return undefined;
    const authoritative = item.host && item.purpose
      ? this.routeAuthority(item.host, item.purpose)
      : "direct";
    return item.intent === "interactive" ? "direct" : authoritative;
  }

  private eligible = (item: PipelineItem): boolean => {
    if (item.kind.startsWith("fetch.") && !this.ready.canAdmitFetch(item.roomId)) return false;
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
    do {
      this.pumpAgain = false;
      for (const [name, pool] of Object.entries(this.pools) as Array<[PoolName, PipelinePools[PoolName]]>) {
        let capacity = pool.available;
        while (capacity > 0) {
          const entry = this.queue.take(name, this.eligible, 32);
          if (!entry) break;
          capacity -= 1;
          this.launch(entry);
        }
      }
    } while (this.pumpAgain);
    this.pumping = false;
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
    void actualPool.submit(() => entry.run(route)).then(
      (value) => {
        for (const trackedItem of tracked) {
          this.inFlight.delete(trackedItem.dedupeKey);
          this.volume.settle(trackedItem);
          this.frames.update(trackedItem, null);
        }
        this.batches.delete(item.dedupeKey);
        this.queue.settle(entry, value);
      },
      (error) => {
        for (const trackedItem of tracked) {
          this.inFlight.delete(trackedItem.dedupeKey);
          this.volume.settle(trackedItem);
          this.frames.update(trackedItem, null);
        }
        this.batches.delete(item.dedupeKey);
        this.queue.settle(entry, undefined, error);
      },
    ).finally(() => this.wake());
  }
}

export const pipelineScheduler = new PipelineScheduler();
