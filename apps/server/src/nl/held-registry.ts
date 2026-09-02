/**
 * The in-memory registry of agent-private conditions the page's own agent
 * holds (docs/NL-AGENT.md). Split from holder.ts so outstanding.ts can ask
 * "is this person's condition held here?" without importing the engine.
 * The text never leaves this process: nothing here is written to a table,
 * an event, or a wire frame.
 */
export interface Held {
  roomId: string;
  text: string;
  /** Bumped on every (re)statement, so an in-flight screening of an older
   * condition can tell it has been superseded before it writes verdicts. */
  generation: number;
}

export const held = new Map<string, Held>();

export function heldFor(participantId: string): string | null {
  return held.get(participantId)?.text ?? null;
}

export function isHeld(participantId: string): boolean {
  return held.has(participantId);
}
