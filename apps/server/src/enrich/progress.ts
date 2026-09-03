import type { FactsMessage, LookupsMessage } from "@webmcp-hackathon/contracts";

/** Room-local presentation state for background lookups. It is deliberately
 * not persisted or revisioned: a restart simply means no work is pending. */

type LookupReason = NonNullable<LookupsMessage["reason"]>;
type ProgressListener = (roomId: string, message: LookupsMessage) => void;
type FactsListener = (roomId: string, message: FactsMessage) => void;

interface RoomProgress {
  counts: Map<string, number>;
  batches: Map<symbol, { ids: string[]; reason?: LookupReason }>;
  timer?: ReturnType<typeof setTimeout>;
}

export const LOOKUP_COALESCE_MS = 250;
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

export function currentLookups(roomId: string): LookupsMessage {
  const room = rooms.get(roomId);
  const pending = room ? [...room.counts.keys()].sort() : [];
  const reasons = room ? [...room.batches.values()].map((batch) => batch.reason) : [];
  const reason = reasons[0];
  const reasonKey = reason ? JSON.stringify(reason) : undefined;
  const reasonAgrees = Boolean(
    reason && reasons.every((candidate) => JSON.stringify(candidate) === reasonKey),
  );
  return {
    type: "lookups",
    pending,
    ...(pending.length && reasonAgrees ? { reason } : {}),
  };
}

function schedule(roomId: string): void {
  const room = state(roomId);
  if (room.timer) return;
  room.timer = setTimeout(() => {
    room.timer = undefined;
    const message = currentLookups(roomId);
    for (const listener of progressListeners) listener(roomId, message);
    if (message.pending.length === 0) rooms.delete(roomId);
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
  room.batches.set(batchId, { ids, reason });
  for (const id of ids) room.counts.set(id, (room.counts.get(id) ?? 0) + 1);
  schedule(roomId);
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    const active = rooms.get(roomId);
    if (!active) return;
    const batch = active.batches.get(batchId);
    if (!batch) return;
    active.batches.delete(batchId);
    for (const id of batch.ids) {
      const count = active.counts.get(id) ?? 0;
      if (count <= 1) active.counts.delete(id);
      else active.counts.set(id, count - 1);
    }
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
  for (const room of rooms.values()) if (room.timer) clearTimeout(room.timer);
  rooms.clear();
}
