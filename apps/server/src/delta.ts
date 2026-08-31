import type pg from "pg";
import type { Delta, ProjectedEvent } from "@webmcp-hackathon/contracts";
import { projectEvent, type StoredEvent } from "./projection.ts";

const DELTA_CAP = 10;

export async function buildDelta(
  q: pg.PoolClient | pg.Pool,
  roomId: string,
  viewerId: string,
  sinceRevision: number,
): Promise<Delta> {
  const rows = (
    await q.query(
      `SELECT revision, type, actor_id, visibility, payload
         FROM events WHERE room_id = $1 AND revision > $2 ORDER BY revision ASC`,
      [roomId, sinceRevision],
    )
  ).rows;
  const projected: ProjectedEvent[] = [];
  for (const row of rows) {
    const event: StoredEvent = {
      revision: row.revision,
      type: row.type,
      actorId: row.actor_id,
      visibility: row.visibility,
      payload: row.payload,
    };
    const view = projectEvent(event, viewerId);
    if (view) projected.push(view);
  }
  // Most recent first, capped (NEGOTIATION-PROTOCOL.md §6.1). No cursor is
  // emitted yet: sinceRevision is the only continuation input, so a cursor
  // could not be consumed — the brief must remain sufficient to act, and
  // adding a cursor later is an additive change.
  projected.reverse();
  const truncated = projected.length > DELTA_CAP;
  return {
    fromRevision: sinceRevision,
    events: projected.slice(0, DELTA_CAP),
    truncated,
  };
}
