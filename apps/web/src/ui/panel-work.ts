/**
 * When the place panel reads as busy.
 *
 * Two signals say a lookup is running, and only one of them stays true on its
 * own. The room's `lookups` frames are live: every change re-sends the whole
 * pending set, so the store's busy set clears itself. A dossier's
 * `lookupPending` is a snapshot from the moment of that read, and the panel
 * re-reads the dossier only when a `facts` frame names this place. After an
 * open's terminal frame no more frames name it, so a `true` latched there has
 * nothing left to clear it and the panel stays busy for as long as the panel
 * stays open.
 *
 * So the snapshot is honoured only for as long as a `lookups` frame carrying
 * the same news could still be in flight — the server coalesces those over
 * 250 ms — and after that the live set is the only signal.
 */
export const LOOKUP_HINT_MS = 1_500;

export function lookupHintHolds(input: {
  lookupPending: boolean;
  readAt: number | null;
  now: number;
}): boolean {
  return input.lookupPending && input.readAt !== null &&
    input.now - input.readAt < LOOKUP_HINT_MS;
}

/** A lookup is running for this place, live set first. */
export function panelLookingUp(input: {
  busy: boolean;
  lookupPending: boolean;
  readAt: number | null;
  now: number;
}): boolean {
  return input.busy || lookupHintHolds(input);
}

/** One "something is happening here" signal for the panel's nav: the room's
 * pipeline, the open fast track, a read this page asked for, or the very
 * first dossier read. */
export function panelWorking(input: {
  lookingUp: boolean;
  openStage: string | null;
  lookupAsked: boolean;
  hasDossier: boolean;
}): boolean {
  return input.lookingUp || input.openStage !== null || input.lookupAsked ||
    !input.hasDossier;
}
