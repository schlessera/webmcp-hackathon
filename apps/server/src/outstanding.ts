import type pg from "pg";
import type { OutstandingItem } from "@webmcp-hackathon/contracts";

/** Decisions currently pending for one participant. */
export async function outstandingFor(
  q: pg.PoolClient | pg.Pool,
  roomId: string,
  participantId: string,
): Promise<OutstandingItem[]> {
  const items: OutstandingItem[] = [];

  // Pending screening: participant holds an agent-private declaration and
  // candidates lack verdicts (or need re-screening after needs_info).
  const declared = (
    await q.query(
      `SELECT 1 FROM requirements
        WHERE room_id = $1 AND owner_id = $2
          AND visibility = 'agent-private' AND NOT withdrawn LIMIT 1`,
      [roomId, participantId],
    )
  ).rowCount;
  if (declared) {
    const pending = (
      await q.query(
        `SELECT c.id FROM candidates c
          LEFT JOIN verdicts v ON v.room_id = c.room_id
           AND v.candidate_id = c.id AND v.owner_id = $2
         WHERE c.room_id = $1 AND (v.verdict IS NULL OR v.verdict = 'needs_info')
         ORDER BY c.id LIMIT 10`,
        [roomId, participantId],
      )
    ).rows.map((r) => r.id as string);
    if (pending.length > 0) {
      const issued = (
        await q.query(
          `SELECT COALESCE(MAX(revision), 0) AS rev FROM events
            WHERE room_id = $1 AND type = 'evaluation_requested'
              AND payload->>'targetParticipantId' = $2`,
          [roomId, participantId],
        )
      ).rows[0].rev;
      items.push({
        type: "evaluation_request",
        candidateIds: pending,
        issuedAtRevision: Number(issued),
      });
    }
  }

  // Private adjustment requests awaiting this participant's decision or
  // in-page confirmation. Addressee-only: peers never see these rows.
  const adjustments = (
    await q.query(
      `SELECT id, kind, change, projected_gain, within_delegated_bound, status, created_at_revision
         FROM adjustments
        WHERE room_id = $1 AND requires_consent_of = $2
          AND status IN ('proposed', 'staged_grant')
        ORDER BY id`,
      [roomId, participantId],
    )
  ).rows;
  for (const row of adjustments) {
    items.push({
      type: "adjustment_request",
      requestId: row.id,
      issuedAtRevision: Number(row.created_at_revision),
      kind: row.kind,
      change: row.change,
      projectedGain: row.projected_gain,
      withinDelegatedBound: row.within_delegated_bound,
      staged: row.status === "staged_grant",
    });
  }

  // Open proposals without a stance from this participant.
  const stanceNeeded = (
    await q.query(
      `SELECT pr.id FROM proposals pr
        LEFT JOIN stances s ON s.proposal_id = pr.id AND s.participant_id = $2
       WHERE pr.room_id = $1 AND pr.status = 'open' AND s.disposition IS NULL
       ORDER BY pr.id`,
      [roomId, participantId],
    )
  ).rows;
  for (const row of stanceNeeded) {
    items.push({ type: "stance_needed", proposalId: row.id });
  }

  return items;
}
