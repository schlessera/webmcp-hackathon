/**
 * Who is looking at a room right now: participants with at least one open
 * realtime socket, and which place (if any) each of them has open. In-memory,
 * per process — the demo runs one server. The durable half (has this person
 * ever opened the room) is participants.arrived_at, stamped by sync.
 *
 * Viewing is kept PER SOCKET: two tabs of one person can look at two places,
 * and closing one must not leave the other's choice misreported. The room
 * sees one place per person — whichever of their open tabs spoke last.
 */
const open = new Map<string, Map<string, number>>();
/** roomId -> participantId -> socketId -> { candidateId, at } */
const viewing = new Map<string, Map<string, Map<string, { candidateId: string; at: number }>>>();
let clock = 0;
type PresenceListener = (roomId: string, present: Set<string>) => void;
const presenceListeners = new Set<PresenceListener>();

function notifyPresence(roomId: string): void {
  const present = presentIn(roomId);
  for (const listener of presenceListeners) listener(roomId, present);
}

/** Process-local lifecycle hook for work that should follow open sockets. */
export function onPresenceChange(listener: PresenceListener): () => void {
  presenceListeners.add(listener);
  return () => presenceListeners.delete(listener);
}

/** Returns true when the participant went from absent to present. */
export function markOpen(roomId: string, participantId: string): boolean {
  let room = open.get(roomId);
  if (!room) {
    room = new Map();
    open.set(roomId, room);
  }
  const count = room.get(participantId) ?? 0;
  room.set(participantId, count + 1);
  if (count === 0) notifyPresence(roomId);
  return count === 0;
}

/** Returns true when the participant went from present to absent. */
export function markClosed(roomId: string, participantId: string, socketId?: string): boolean {
  if (socketId !== undefined) forgetSocket(roomId, participantId, socketId);
  const room = open.get(roomId);
  if (!room) return false;
  const count = room.get(participantId) ?? 0;
  if (count <= 1) {
    room.delete(participantId);
    if (room.size === 0) open.delete(roomId);
    // A person with no open socket is no longer looking at anything.
    viewing.get(roomId)?.delete(participantId);
    if (viewing.get(roomId)?.size === 0) viewing.delete(roomId);
    if (count === 1) notifyPresence(roomId);
    return count === 1;
  }
  room.set(participantId, count - 1);
  return false;
}

export function presentIn(roomId: string): Set<string> {
  return new Set(open.get(roomId)?.keys() ?? []);
}

function forgetSocket(roomId: string, participantId: string, socketId: string): void {
  const person = viewing.get(roomId)?.get(participantId);
  if (!person) return;
  person.delete(socketId);
  if (person.size === 0) viewing.get(roomId)?.delete(participantId);
  if (viewing.get(roomId)?.size === 0) viewing.delete(roomId);
}

function shownFor(roomId: string, participantId: string): string | null {
  const person = viewing.get(roomId)?.get(participantId);
  if (!person) return null;
  let best: { candidateId: string; at: number } | null = null;
  for (const v of person.values()) if (!best || v.at > best.at) best = v;
  return best?.candidateId ?? null;
}

/**
 * Record which place one socket has open. Returns true when what the room
 * sees for this participant changed (so a second tab quietly agreeing with
 * the first costs no frame).
 */
export function setViewing(
  roomId: string,
  participantId: string,
  socketId: string,
  candidateId: string | null,
): boolean {
  const before = shownFor(roomId, participantId);
  if (candidateId === null) {
    forgetSocket(roomId, participantId, socketId);
  } else {
    let room = viewing.get(roomId);
    if (!room) {
      room = new Map();
      viewing.set(roomId, room);
    }
    let person = room.get(participantId);
    if (!person) {
      person = new Map();
      room.set(participantId, person);
    }
    person.set(socketId, { candidateId, at: ++clock });
  }
  return shownFor(roomId, participantId) !== before;
}

export function viewingIn(
  roomId: string,
): Array<{ participantId: string; candidateId: string }> {
  const out: Array<{ participantId: string; candidateId: string }> = [];
  for (const participantId of viewing.get(roomId)?.keys() ?? []) {
    const candidateId = shownFor(roomId, participantId);
    if (candidateId) out.push({ participantId, candidateId });
  }
  return out;
}
