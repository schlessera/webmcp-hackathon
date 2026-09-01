/**
 * Who is looking at a room right now: participants with at least one open
 * realtime socket. In-memory, per process — the demo runs one server.
 * The durable half (has this person ever opened the room) is
 * participants.arrived_at, stamped by sync.
 */
const open = new Map<string, Map<string, number>>();

/** Returns true when the participant went from absent to present. */
export function markOpen(roomId: string, participantId: string): boolean {
  let room = open.get(roomId);
  if (!room) {
    room = new Map();
    open.set(roomId, room);
  }
  const count = room.get(participantId) ?? 0;
  room.set(participantId, count + 1);
  return count === 0;
}

/** Returns true when the participant went from present to absent. */
export function markClosed(roomId: string, participantId: string): boolean {
  const room = open.get(roomId);
  if (!room) return false;
  const count = room.get(participantId) ?? 0;
  if (count <= 1) {
    room.delete(participantId);
    if (room.size === 0) open.delete(roomId);
    return count === 1;
  }
  room.set(participantId, count - 1);
  return false;
}

export function presentIn(roomId: string): Set<string> {
  return new Set(open.get(roomId)?.keys() ?? []);
}
