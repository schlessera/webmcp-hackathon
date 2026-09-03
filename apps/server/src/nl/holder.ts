import { participantById, type Participant } from "../auth.ts";
import { pool } from "../db.ts";
import { onCommit } from "../commit-notifications.ts";
import { held, heldFor } from "./held-registry.ts";
import { screen } from "./screening.ts";

/**
 * Where an agent-private condition lives: with the agent, in memory, never in
 * a table and never in an event. The room holds a content-free declaration
 * (SubmitRequirement with visibility agent-private) and receives verdicts.
 *
 * Single process, like presence.ts: a restart forgets every held condition,
 * which leaves the declaration pending (uncertain) until it is said again.
 * That is the honest failure — nothing is guessed.
 */

const inFlight = new Set<string>();
const rerun = new Set<string>();

export function hold(participantId: string, roomId: string, text: string): void {
  const generation = (held.get(participantId)?.generation ?? 0) + 1;
  held.set(participantId, { roomId, text, generation });
}

export { heldFor };

export function release(participantId: string): void {
  held.delete(participantId);
}

/** The room still carries this person's active agent-private declaration.
 * Withdrawn from any surface (the page, a tool, the agent itself), the held
 * text goes with it: an agent must not keep weighing a need the room no
 * longer has. */
async function declarationStands(actor: Participant): Promise<boolean> {
  const rows = await pool.query(
    `SELECT 1 FROM requirements
      WHERE room_id = $1 AND owner_id = $2 AND visibility = 'agent-private' AND NOT withdrawn
      LIMIT 1`,
    [actor.roomId, actor.id],
  );
  return (rows.rowCount ?? 0) > 0;
}

/**
 * Places this agent has not yet screened under the current declaration. The
 * council's outstanding list is not the right cursor here: it re-lists a
 * `needs_info` verdict as pending (the room's honest signal that evidence is
 * missing), and re-screening the same record against the same condition
 * cannot say more. A new declaration clears the owner's verdicts
 * (engine.ts), which is what makes "no verdict row" mean "not yet screened".
 */
async function unscreened(actor: Participant): Promise<string[]> {
  const rows = await pool.query(
    `SELECT c.id FROM candidates c
      LEFT JOIN verdicts v
        ON v.room_id = c.room_id AND v.candidate_id = c.id AND v.owner_id = $2
       AND v.screened_map_revision = c.map_revision
     WHERE c.room_id = $1 AND v.verdict IS NULL
     ORDER BY c.id LIMIT 10`,
    [actor.roomId, actor.id],
  );
  return rows.rows.map((r) => r.id as string);
}

/**
 * Screen every place this agent has not yet screened, ten at a time. One
 * run per participant at a time; a commit that lands mid-run queues one
 * more pass rather than a parallel one.
 */
export async function screenPending(actor: Participant): Promise<number> {
  const current = held.get(actor.id);
  if (!current) return 0;
  if (inFlight.has(actor.id)) {
    rerun.add(actor.id);
    return 0;
  }
  inFlight.add(actor.id);
  const { text: condition, generation } = current;
  // Still the condition being screened? A restatement mid-run bumps the
  // generation; verdicts from the older text must never land on the newer
  // declaration.
  const stillCurrent = () => held.get(actor.id)?.generation === generation;
  let total = 0;
  try {
    if (!(await declarationStands(actor))) {
      release(actor.id);
      return 0;
    }
    for (let batch = 0; batch < 8; batch += 1) {
      if (!stillCurrent()) break;
      const ids = await unscreened(actor);
      if (ids.length === 0) break;
      const outcome = await screen(actor, condition, ids, stillCurrent);
      if (outcome.screened === 0) break;
      total += outcome.screened;
    }
  } catch (err) {
    console.error("agent screening failed:", err);
  } finally {
    inFlight.delete(actor.id);
    if (rerun.delete(actor.id)) void screenPending(actor);
  }
  return total;
}

/** A commit anywhere in a room wakes every agent holding a condition there
 * (and lets one whose declaration was withdrawn let go of it). */
onCommit((n) => {
  for (const [participantId, h] of held) {
    if (h.roomId !== n.roomId) continue;
    void participantById(participantId)
      .then((actor) => actor && screenPending(actor))
      .catch((err) => console.error("agent wake failed:", err));
  }
});
