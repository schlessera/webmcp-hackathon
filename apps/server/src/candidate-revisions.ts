import type pg from "pg";

export interface ScreeningRequestEvent {
  type: "evaluation_requested";
  actorId: null;
  visibility: "application-private";
  payload: { targetParticipantId: string; candidateIds: string[] };
}

/**
 * The one write path for candidate fact revisions.
 *
 * R3: verdict validity is tied to candidates.map_revision in every reader, so
 * bumping here invalidates stale private screening automatically. Returning a
 * fresh owner-only request also wakes page agents and gives external agents a
 * new outstanding issue without revealing the private condition to peers.
 */
export async function bumpCandidateMapRevisions(
  client: pg.PoolClient,
  roomId: string,
  candidateIds: string[],
): Promise<ScreeningRequestEvent[]> {
  if (candidateIds.length === 0) return [];
  const bumped = (
    await client.query(
      `UPDATE candidates
          SET map_revision = map_revision + 1
        WHERE room_id = $1 AND id = ANY($2)
      RETURNING id`,
      [roomId, candidateIds],
    )
  ).rows.map((row) => row.id as string);
  if (bumped.length === 0) return [];

  const owners = (
    await client.query(
      `SELECT DISTINCT owner_id
         FROM requirements
        WHERE room_id = $1 AND visibility = 'agent-private' AND NOT withdrawn
        ORDER BY owner_id`,
      [roomId],
    )
  ).rows.map((row) => row.owner_id as string);

  const events: ScreeningRequestEvent[] = [];
  for (const ownerId of owners) {
    for (let offset = 0; offset < bumped.length; offset += 10) {
      events.push({
        type: "evaluation_requested",
        actorId: null,
        visibility: "application-private",
        payload: {
          targetParticipantId: ownerId,
          candidateIds: bumped.slice(offset, offset + 10),
        },
      });
    }
  }
  return events;
}
