/**
 * One rule, written once: which of a room's candidate rows are live.
 *
 * A row with a NULL `step_id` belongs to the room itself — that is every
 * room that predates plans, room_demo included, and they behave exactly as
 * they always did. A row with a step belongs to that step, and is live only
 * while that step is the one the room is on.
 *
 * Both fragments are self-contained: they read the room's active step
 * themselves rather than taking a parameter, so they can be pasted into a
 * query without disturbing its parameter numbering. A query that enumerates
 * a room's pool and does NOT mention one of them is a query that has
 * forgotten steps exist.
 */

/** For `FROM candidates` with no table alias. */
export const LIVE_POOL =
  "(step_id IS NULL OR step_id = (SELECT r.active_step_id FROM rooms r WHERE r.id = room_id))";

/** For a query that aliases the table as `c`. */
export const LIVE_POOL_C =
  "(c.step_id IS NULL OR c.step_id = (SELECT r.active_step_id FROM rooms r WHERE r.id = c.room_id))";
