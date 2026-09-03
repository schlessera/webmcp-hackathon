import type { FactsMessage, LookupsMessage } from "@webmcp-hackathon/contracts";

/** Room-local presentation state for background lookups. It is deliberately
 * not persisted or revisioned: a restart simply means no work is pending. */

type LookupReason = NonNullable<LookupsMessage["reason"]>;
type ProgressListener = (roomId: string, message: LookupsMessage) => void;
type FactsListener = (roomId: string, message: FactsMessage) => void;

interface RoomProgress {
  /** The last frame sent for this room, so a timer never repeats it. */
  lastSent?: string;
  counts: Map<string, number>;
  batches: Map<symbol, { ids: string[]; reason?: LookupReason; deadlineAt: number }>;
  timer?: ReturnType<typeof setTimeout>;
  watchdog?: ReturnType<typeof setTimeout>;
  watchdogAt?: number;
}

export const LOOKUP_COALESCE_MS = 250;
export const LOOKUP_DEADLINE_MS = 5 * 60_000;
const rooms = new Map<string, RoomProgress>();
const progressListeners = new Set<ProgressListener>();
const factsListeners = new Set<FactsListener>();

function state(roomId: string): RoomProgress {
  let room = rooms.get(roomId);
  if (!room) {
    room = { counts: new Map(), batches: new Map() };
    rooms.set(roomId, room);
  }
  return room;
}

/**
 * One frame carries one reason, so overlapping batches have to agree on it.
 * Refinement wins that contest whenever it is in the set: it is the work a
 * person is watching and the only work the count block names, while a pool
 * warm-up is background. Before this, a fill running alongside refinement
 * left every ring either labelled "pool" or unattributed, and the page could
 * not tell the user why anything was busy.
 */
export function currentLookups(roomId: string): LookupsMessage {
  const room = rooms.get(roomId);
  const pending = room ? [...room.counts.keys()].sort() : [];
  const all = room ? [...room.batches.values()].map((batch) => batch.reason) : [];
  const refining = all.filter((candidate) => candidate?.kind === "refine");
  const reasons = refining.length > 0 ? refining : all;
  const reason = reasons[0];
  const reasonKey = reason ? JSON.stringify(reason) : undefined;
  const agrees = reasons.every((candidate) => JSON.stringify(candidate) === reasonKey);
  // Mixed refinement labels collapse to the bare kind rather than picking one
  // batch's need to speak for the rest.
  const resolved = reason && !agrees && refining.length > 0
    ? { kind: "refine" as const }
    : reason;
  return {
    type: "lookups",
    pending,
    ...(pending.length && resolved && (agrees || refining.length > 0)
      ? { reason: resolved }
      : {}),
  };
}

function removeBatch(room: RoomProgress, batchId: symbol): void {
  const batch = room.batches.get(batchId);
  if (!batch) return;
  room.batches.delete(batchId);
  for (const id of batch.ids) {
    const count = room.counts.get(id) ?? 0;
    if (count <= 1) room.counts.delete(id);
    else room.counts.set(id, count - 1);
  }
}

function sweepExpired(room: RoomProgress, now: number): void {
  for (const [batchId, batch] of room.batches) {
    if (batch.deadlineAt <= now) removeBatch(room, batchId);
  }
}

function armWatchdog(roomId: string, room: RoomProgress, now: number): void {
  const deadlineAt = Math.min(
    ...[...room.batches.values()].map((batch) => batch.deadlineAt),
  );
  if (!Number.isFinite(deadlineAt)) {
    if (room.watchdog) clearTimeout(room.watchdog);
    room.watchdog = undefined;
    room.watchdogAt = undefined;
    return;
  }
  if (room.watchdog && room.watchdogAt === deadlineAt) return;
  if (room.watchdog) clearTimeout(room.watchdog);
  room.watchdogAt = deadlineAt;
  room.watchdog = setTimeout(() => {
    room.watchdog = undefined;
    room.watchdogAt = undefined;
    schedule(roomId);
  }, Math.max(0, deadlineAt - now));
}

function emit(roomId: string): void {
  const room = state(roomId);
  const message = currentLookups(roomId);
  const encoded = JSON.stringify(message);
  if (room.lastSent !== encoded) {
    room.lastSent = encoded;
    for (const listener of progressListeners) listener(roomId, message);
  }
  if (message.pending.length === 0) rooms.delete(roomId);
}

/**
 * Coalesce: the first change in a quiet room goes out at once, so a lookup
 * that lives 300 ms is still seen as pending; later changes wait for the
 * timer, and the clearing frame always follows.
 */
function schedule(roomId: string, immediate = false): void {
  const room = state(roomId);
  const now = Date.now();
  sweepExpired(room, now);
  armWatchdog(roomId, room, now);
  if (room.timer) return;
  if (immediate) emit(roomId);
  room.timer = setTimeout(() => {
    room.timer = undefined;
    emit(roomId);
  }, LOOKUP_COALESCE_MS);
}

/** Add a batch to the pending set. The returned function removes exactly
 * this batch, with reference counts protecting overlapping requests. */
export function beginLookups(
  roomId: string,
  candidateIds: string[],
  reason?: LookupReason,
): () => void {
  const ids = [...new Set(candidateIds)];
  const room = state(roomId);
  const batchId = Symbol("lookup-batch");
  room.batches.set(batchId, {
    ids,
    reason,
    deadlineAt: Date.now() + LOOKUP_DEADLINE_MS,
  });
  const wasQuiet = room.counts.size === 0;
  for (const id of ids) room.counts.set(id, (room.counts.get(id) ?? 0) + 1);
  schedule(roomId, wasQuiet);
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    const active = rooms.get(roomId);
    if (!active) return;
    if (!active.batches.has(batchId)) return;
    removeBatch(active, batchId);
    schedule(roomId);
  };
}

export function lookupPending(roomId: string, candidateId: string): boolean {
  return (rooms.get(roomId)?.counts.get(candidateId) ?? 0) > 0;
}

export function onLookupProgress(listener: ProgressListener): () => void {
  progressListeners.add(listener);
  return () => progressListeners.delete(listener);
}

export function publishFacts(roomId: string, message: FactsMessage): void {
  for (const listener of factsListeners) listener(roomId, message);
}

export function onFacts(listener: FactsListener): () => void {
  factsListeners.add(listener);
  return () => factsListeners.delete(listener);
}

/** Test-only reset for module-local room state and timers. */
export function resetProgress(): void {
  for (const room of rooms.values()) {
    if (room.timer) clearTimeout(room.timer);
    if (room.watchdog) clearTimeout(room.watchdog);
  }
  rooms.clear();
}
