import { createHash } from "node:crypto";
import type { Criterion } from "@webmcp-hackathon/contracts";
import type { OutboundPurpose, OutboundRoute } from "../net/outbound.ts";
import type { PoolName } from "./pools.ts";

export type PipelineKind =
  | "fetch.site"
  | "fetch.search"
  | "fetch.asset"
  | "process.judge"
  | "process.adjudicate"
  | "process.vision"
  | "process.decode";
export type PipelinePriority = 0 | 1 | 2 | 3 | 4;
export type PipelineIntent = "interactive" | "background";

export interface PipelineItem {
  roomId: string;
  candidateId: string;
  osmRef: string;
  kind: PipelineKind;
  criteria: Criterion[];
  priority: PipelinePriority;
  intent: PipelineIntent;
  host?: string;
  purpose?: OutboundPurpose;
  predictedRoute?: OutboundRoute;
  predictedPool?: PoolName;
  dedupeKey: string;
  evidenceHash?: string;
  /** Vocabulary-sweep work survives need-epoch changes while it stays queued. */
  sweep?: boolean;
  needsEpoch: number;
  enqueuedAt: number;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

export interface QueuedPipelineItem<T = unknown> {
  item: PipelineItem;
  run: (route?: OutboundRoute, signal?: AbortSignal) => Promise<T>;
  completion: Deferred<T>;
}

export interface EnqueueResult<T> {
  inserted: boolean;
  promise: Promise<T>;
}

interface RoomQueue {
  priorities: Array<Map<PoolName, QueuedPipelineItem[]>>;
  quantum: number;
  deficit: number;
  admissions: number;
}

export function pipelineDedupeKey(
  item: Pick<PipelineItem, "kind" | "osmRef" | "criteria" | "intent"> & { evidenceHash?: string },
): string {
  return createHash("sha1").update([
    item.kind,
    item.osmRef,
    item.criteria.map((criterion) => criterion.id).sort().join(","),
    item.evidenceHash ?? "",
    item.intent,
  ].join("\0")).digest("hex");
}

/** Per-room priority queues with DRR across rooms and promise-joining dedupe. */
export class PipelineQueue {
  private readonly rooms = new Map<string, RoomQueue>();
  private readonly roomOrder: string[] = [];
  private readonly byKey = new Map<string, QueuedPipelineItem>();
  private roomCursor = 0;
  lastProbeCount = 0;

  enqueue<T>(
    item: PipelineItem,
    run: (route?: OutboundRoute, signal?: AbortSignal) => Promise<T>,
    quantum = 4,
  ): EnqueueResult<T> {
    const existing = this.byKey.get(item.dedupeKey) as QueuedPipelineItem<T> | undefined;
    if (existing) {
      if (
        item.priority < existing.item.priority &&
        this.move(existing, item.priority, item.predictedPool)
      ) {
        existing.item.priority = item.priority;
        existing.item.predictedPool = item.predictedPool;
        existing.item.predictedRoute = item.predictedRoute;
      }
      return { inserted: false, promise: existing.completion.promise };
    }
    let room = this.rooms.get(item.roomId);
    if (!room) {
      room = {
        priorities: Array.from({ length: 5 }, () => new Map()),
        quantum: Math.max(1, quantum),
        deficit: 0,
        admissions: 0,
      };
      this.rooms.set(item.roomId, room);
      this.roomOrder.push(item.roomId);
    } else {
      room.quantum = Math.max(1, quantum);
    }
    const entry: QueuedPipelineItem<T> = { item, run, completion: deferred<T>() };
    this.poolEntries(room, item.priority, this.poolOf(item)).push(entry as QueuedPipelineItem);
    this.byKey.set(item.dedupeKey, entry as QueuedPipelineItem);
    return { inserted: true, promise: entry.completion.promise };
  }

  get size(): number {
    return this.byKey.size;
  }

  roomItems(roomId: string): PipelineItem[] {
    const room = this.rooms.get(roomId);
    return room ? this.entries(room).map((entry) => entry.item) : [];
  }

  has(dedupeKey: string): boolean {
    return this.byKey.has(dedupeKey);
  }

  /** Selects at most 32 entries. Eligibility is a hint and reserves nothing. */
  take(
    pool: PoolName,
    eligible: (item: PipelineItem) => boolean,
    scanCap = 32,
    onError?: (entry: QueuedPipelineItem, error: unknown) => void,
  ): QueuedPipelineItem | undefined {
    this.lastProbeCount = 0;
    if (this.roomOrder.length === 0) return undefined;
    const roomCount = this.roomOrder.length;
    const startingCursor = this.roomCursor;
    for (let visited = 0; visited < roomCount && this.lastProbeCount < scanCap; visited += 1) {
      const index = (startingCursor + visited) % roomCount;
      const roomId = this.roomOrder[index];
      const room = this.rooms.get(roomId);
      if (!room) continue;
      if (room.deficit <= 0) room.deficit += room.quantum;
      if (room.deficit <= 0) continue;
      const priorities = this.priorityOrder(room, pool);
      const roomProbeLimit = this.lastProbeCount + Math.max(
        1,
        Math.floor((scanCap - this.lastProbeCount) / (roomCount - visited)),
      );
      for (const priority of priorities) {
        const entries = room.priorities[priority].get(pool) ?? [];
        for (
          let i = 0;
          i < entries.length && this.lastProbeCount < scanCap &&
          this.lastProbeCount < roomProbeLimit;
          i += 1
        ) {
          const entry = entries[i];
          this.lastProbeCount += 1;
          let admitted = false;
          try {
            admitted = eligible(entry.item);
          } catch (error) {
            entries.splice(i, 1);
            i -= 1;
            if (onError) onError(entry, error);
            else this.settle(entry, undefined, error);
            continue;
          }
          if (!admitted) continue;
          entries.splice(i, 1);
          room.deficit -= 1;
          room.admissions += 1;
          // Spend this room's quantum before moving to the next room. An
          // ineligible room retains unused deficit, which is the DRR carry.
          this.roomCursor = room.deficit > 0
            ? index
            : (index + 1) % Math.max(1, roomCount);
          return entry;
        }
      }
    }
    // A closed host at the cursor must not pin every later wake to that room.
    this.roomCursor = (startingCursor + 1) % Math.max(1, roomCount);
    return undefined;
  }

  settle(entry: QueuedPipelineItem, result: unknown, error?: unknown): void {
    this.byKey.delete(entry.item.dedupeKey);
    if (error === undefined) entry.completion.resolve(result);
    else entry.completion.reject(error);
    this.pruneRoom(entry.item.roomId);
  }

  /** Re-rank queued entries only. Entries already taken by a pool are untouched. */
  reprioritise(
    roomId: string,
    ranking: Map<string, PipelinePriority>,
  ): PipelineItem[] {
    const room = this.rooms.get(roomId);
    if (!room) return [];
    const changed: PipelineItem[] = [];
    for (const entry of [...this.entries(room)]) {
      const next = ranking.get(entry.item.dedupeKey) ??
        ranking.get(entry.item.candidateId) ?? ranking.get(entry.item.osmRef);
      if (next === undefined || next === entry.item.priority) continue;
      const nextPool = next === 0 &&
          (entry.item.kind === "fetch.site" || entry.item.kind === "fetch.asset")
        ? "direct"
        : entry.item.predictedPool;
      this.move(entry, next, nextPool);
      entry.item.priority = next;
      entry.item.predictedPool = nextPool;
      changed.push(entry.item);
    }
    return changed;
  }

  /** Drop queued entries only; in-flight work retains its completion and cache value. */
  dropQueued(roomId: string, predicate: (item: PipelineItem) => boolean): PipelineItem[] {
    const room = this.rooms.get(roomId);
    if (!room) return [];
    const dropped: PipelineItem[] = [];
    for (const entry of [...this.entries(room)]) {
      if (!predicate(entry.item)) continue;
      this.remove(entry);
      this.byKey.delete(entry.item.dedupeKey);
      entry.completion.reject(new OutOfScopePipelineItemError());
      dropped.push(entry.item);
    }
    this.pruneRoom(roomId);
    return dropped;
  }

  /** Need changes retain fetches and drop only stale queued judge cells. */
  changeNeeds(roomId: string, needsEpoch: number, activeCriterionIds: Set<string>): PipelineItem[] {
    const room = this.rooms.get(roomId);
    if (!room) return [];
    const dropped: PipelineItem[] = [];
    for (const priority of room.priorities) {
      for (const entries of priority.values()) {
        for (let index = entries.length - 1; index >= 0; index -= 1) {
          const entry = entries[index];
          if (entry.item.kind.startsWith("fetch.")) {
            entry.item.needsEpoch = needsEpoch;
            continue;
          }
          if (
            entry.item.kind === "process.judge" &&
            !entry.item.sweep &&
            entry.item.criteria.some((criterion) => !activeCriterionIds.has(criterion.id))
          ) {
            entries.splice(index, 1);
            this.byKey.delete(entry.item.dedupeKey);
            entry.completion.reject(new StalePipelineItemError());
            dropped.push(entry.item);
          } else {
            entry.item.needsEpoch = needsEpoch;
          }
        }
      }
    }
    this.pruneRoom(roomId);
    return dropped;
  }

  clear(error = new Error("pipeline queue cleared")): void {
    for (const entry of this.byKey.values()) entry.completion.reject(error);
    this.byKey.clear();
    this.rooms.clear();
    this.roomOrder.length = 0;
    this.roomCursor = 0;
  }

  private priorityOrder(room: RoomQueue, pool: PoolName): PipelinePriority[] {
    const nonEmpty = room.priorities.flatMap((entries, priority) =>
      entries.get(pool)?.length ? [priority as PipelinePriority] : []
    );
    if (nonEmpty.length === 0) return [];
    if ((room.admissions + 1) % 8 === 0) {
      const lowest = nonEmpty.at(-1)!;
      return [lowest, ...nonEmpty.filter((priority) => priority !== lowest)];
    }
    return nonEmpty;
  }

  private pruneRoom(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (room && room.priorities.some((pools) =>
      [...pools.values()].some((entries) => entries.length > 0)
    )) return;
    this.rooms.delete(roomId);
    const index = this.roomOrder.indexOf(roomId);
    if (index >= 0) this.roomOrder.splice(index, 1);
    if (this.roomCursor >= this.roomOrder.length) this.roomCursor = 0;
  }

  private poolOf(item: PipelineItem): PoolName {
    return item.predictedPool ?? "llm-matrix";
  }

  private poolEntries(
    room: RoomQueue,
    priority: PipelinePriority,
    pool: PoolName,
  ): QueuedPipelineItem[] {
    let entries = room.priorities[priority].get(pool);
    if (!entries) {
      entries = [];
      room.priorities[priority].set(pool, entries);
    }
    return entries;
  }

  private entries(room: RoomQueue): QueuedPipelineItem[] {
    return room.priorities.flatMap((pools) => [...pools.values()].flat());
  }

  private remove(entry: QueuedPipelineItem): boolean {
    const room = this.rooms.get(entry.item.roomId);
    if (!room) return false;
    const entries = room.priorities[entry.item.priority].get(this.poolOf(entry.item));
    const index = entries?.indexOf(entry) ?? -1;
    if (index < 0) return false;
    entries!.splice(index, 1);
    return true;
  }

  private move(
    entry: QueuedPipelineItem,
    priority: PipelinePriority,
    pool = entry.item.predictedPool,
  ): boolean {
    const room = this.rooms.get(entry.item.roomId);
    if (!room || !this.remove(entry)) return false;
    this.poolEntries(room, priority, pool ?? this.poolOf(entry.item)).push(entry);
    return true;
  }
}

export class StalePipelineItemError extends Error {
  constructor() {
    super("pipeline item belongs to a stale need set");
    this.name = "StalePipelineItemError";
  }
}

export class OutOfScopePipelineItemError extends Error {
  constructor() {
    super("pipeline item is no longer in scope");
    this.name = "OutOfScopePipelineItemError";
  }
}

export interface ReadyCell<T = unknown> {
  roomId: string;
  candidateId: string;
  criterionId: string;
  priority: PipelinePriority;
  bytes: number;
  /** Cells sharing a charge key consume their place bytes only once. */
  chargeKey?: string;
  value: T;
}

/** Fetched evidence waiting for matrix admission, bounded globally and per room. */
export class ReadyBuffer<T = unknown> {
  readonly globalCap: number;
  readonly roomCap: number;
  private cells: Array<ReadyCell<T>> = [];
  private globalBytes = 0;
  private readonly roomBytes = new Map<string, number>();
  private readonly drainListeners = new Set<(roomId: string) => void>();

  constructor(globalCap = 4 * 1024 * 1024, roomCap = 512 * 1024) {
    this.globalCap = globalCap;
    this.roomCap = roomCap;
  }

  canAdmitFetch(roomId: string): boolean {
    return this.globalBytes < this.globalCap && (this.roomBytes.get(roomId) ?? 0) < this.roomCap;
  }

  push(cell: ReadyCell<T>): boolean {
    if (cell.bytes < 0 || !Number.isFinite(cell.bytes)) throw new Error("invalid ready-buffer size");
    const alreadyCharged = cell.chargeKey !== undefined && this.cells.some((entry) =>
      entry.roomId === cell.roomId && entry.chargeKey === cell.chargeKey
    );
    const addedBytes = alreadyCharged ? 0 : cell.bytes;
    if (
      this.globalBytes + addedBytes > this.globalCap ||
      (this.roomBytes.get(cell.roomId) ?? 0) + addedBytes > this.roomCap
    ) return false;
    this.cells.push(cell);
    this.globalBytes += addedBytes;
    this.roomBytes.set(cell.roomId, (this.roomBytes.get(cell.roomId) ?? 0) + addedBytes);
    return true;
  }

  take(predicate: (cell: ReadyCell<T>) => boolean, limit = Number.POSITIVE_INFINITY): ReadyCell<T>[] {
    const selected: ReadyCell<T>[] = [];
    const retained: ReadyCell<T>[] = [];
    const touched = new Set<string>();
    for (const cell of this.cells) {
      if (selected.length < limit && predicate(cell)) {
        selected.push(cell);
        touched.add(cell.roomId);
      } else retained.push(cell);
    }
    this.cells = retained;
    this.recountBytes();
    for (const roomId of touched) for (const listener of this.drainListeners) listener(roomId);
    return selected;
  }

  onDrain(listener: (roomId: string) => void): () => void {
    this.drainListeners.add(listener);
    return () => this.drainListeners.delete(listener);
  }

  bytes(roomId?: string): number {
    return roomId === undefined ? this.globalBytes : this.roomBytes.get(roomId) ?? 0;
  }

  get size(): number {
    return this.cells.length;
  }

  private recountBytes(): void {
    this.globalBytes = 0;
    this.roomBytes.clear();
    const charged = new Set<string>();
    for (const cell of this.cells) {
      const key = cell.chargeKey === undefined
        ? undefined
        : `${cell.roomId}\0${cell.chargeKey}`;
      if (key !== undefined && charged.has(key)) continue;
      if (key !== undefined) charged.add(key);
      this.globalBytes += cell.bytes;
      this.roomBytes.set(cell.roomId, (this.roomBytes.get(cell.roomId) ?? 0) + cell.bytes);
    }
  }
}
