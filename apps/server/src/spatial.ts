import type {
  CandidateDossier,
  InspectCandidatesResponse,
  PrepareNavigationResponse,
  SpatialContextResponse,
} from "@webmcp-hackathon/contracts";
import { withTransaction } from "./db.ts";
import type { Participant } from "./auth.ts";
import {
  computeEligibility,
  feasibilityOf,
  loadScope,
} from "./eligibility.ts";
import { IMPASSE_TEXT } from "./impasse.ts";

/**
 * Spatial read paths — SPATIAL-PROTOCOL.md §6 read commands. Reads carry no
 * baseRevision (they never conflict) and follow the sync-path consistency
 * discipline: FOR SHARE on the room row so a concurrent command's bump stays
 * outside the read window.
 */

export async function spatialContext(
  actor: Participant,
): Promise<SpatialContextResponse> {
  return withTransaction(async (client) => {
    const room = (
      await client.query(
        "SELECT revision, phase, impasse_active FROM rooms WHERE id = $1 FOR SHARE",
        [actor.roomId],
      )
    ).rows[0];
    if (!room) return notFound();

    const [rows, scope, proposals, stances, agreementRow, arrivalRow] =
      await Promise.all([
        computeEligibility(client, actor.roomId),
        loadScope(client, actor.roomId),
        client.query(
          `SELECT id, candidate_id, status FROM proposals
            WHERE room_id = $1 AND status <> 'withdrawn' ORDER BY id`,
          [actor.roomId],
        ),
        client.query(
          "SELECT proposal_id, participant_id, disposition FROM stances WHERE room_id = $1",
          [actor.roomId],
        ),
        client.query(
          `SELECT id, candidate_id, status, committed_at_revision FROM proposals
            WHERE room_id = $1 AND status IN ('staged', 'committed')
            ORDER BY status = 'committed' DESC, id DESC LIMIT 1`,
          [actor.roomId],
        ),
        client.query(
          "SELECT mode, pickup_note FROM arrival_plans WHERE room_id = $1 AND participant_id = $2",
          [actor.roomId, actor.id],
        ),
      ]);

    const stanceRows = stances.rows as Array<{
      proposal_id: string;
      participant_id: string;
      disposition: string;
    }>;
    const proposalViews = (proposals.rows as Array<{
      id: string;
      candidate_id: string;
      status: string;
    }>).map((pr) => {
      const own = stanceRows.find(
        (s) => s.proposal_id === pr.id && s.participant_id === actor.id,
      );
      const forProposal = stanceRows.filter((s) => s.proposal_id === pr.id);
      return {
        proposalId: pr.id,
        candidateId: pr.candidate_id,
        status: pr.status as "open" | "withdrawn" | "vetoed" | "staged" | "committed",
        // Aggregate counts only: per-peer attribution stays in projected
        // events where visibility rules apply.
        stanceCounts: {
          accept: forProposal.filter((s) => s.disposition === "accept").length,
          reject: forProposal.filter((s) => s.disposition === "reject").length,
          other: forProposal.filter(
            (s) => s.disposition !== "accept" && s.disposition !== "reject",
          ).length,
        },
        ...(own ? { ownStance: own.disposition } : {}),
      };
    });

    const agreement = agreementRow.rows[0]
      ? {
          proposalId: agreementRow.rows[0].id as string,
          candidateId: agreementRow.rows[0].candidate_id as string,
          status: agreementRow.rows[0].status as "staged" | "committed",
          ...(agreementRow.rows[0].status === "committed" &&
          agreementRow.rows[0].committed_at_revision !== null
            ? { committedAtRevision: Number(agreementRow.rows[0].committed_at_revision) }
            : {}),
        }
      : undefined;

    const arrival = arrivalRow.rows[0]
      ? {
          mode: arrivalRow.rows[0].mode as "walk" | "bike" | "car",
          ...(arrivalRow.rows[0].pickup_note
            ? { pickupNote: arrivalRow.rows[0].pickup_note as string }
            : {}),
        }
      : undefined;

    return {
      ok: true as const,
      revision: room.revision as number,
      phase: room.phase as string,
      scope,
      feasibility: feasibilityOf(rows),
      candidates: rows.map((r) => ({
        candidateId: r.candidateId,
        name: r.name,
        location: r.location,
        category: r.category,
        eligibility: r.eligibility,
        why: r.why,
        walkMin: r.walkMin,
        priceLevel: r.priceLevel ?? 0,
      })),
      proposals: proposalViews,
      ...(agreement ? { agreement } : {}),
      ...(arrival ? { arrival } : {}),
      ...(room.impasse_active
        ? { impasse: { active: true as const, text: IMPASSE_TEXT } }
        : {}),
    };
  });
}

export async function inspectCandidates(
  actor: Participant,
  candidateIds: string[],
): Promise<InspectCandidatesResponse> {
  return withTransaction(async (client) => {
    const room = (
      await client.query(
        "SELECT revision FROM rooms WHERE id = $1 FOR SHARE",
        [actor.roomId],
      )
    ).rows[0];
    if (!room) return notFound();
    const rows = (
      await client.query(
        "SELECT * FROM candidates WHERE room_id = $1 AND id = ANY($2) ORDER BY id",
        [actor.roomId, candidateIds],
      )
    ).rows;
    const found = new Set(rows.map((r) => r.id as string));
    const missing = candidateIds.find((id) => !found.has(id));
    if (missing) {
      return {
        ok: false as const,
        error: {
          code: "not_found" as const,
          message: `Unknown candidateId "${missing}".`,
          recovery: "Call get_spatial_context to refresh candidate IDs.",
        },
      };
    }
    const dossiers: CandidateDossier[] = rows.map((r) => ({
      candidateId: r.id,
      name: r.name,
      location: r.location,
      category: r.category,
      priceLevel: r.price_level,
      hours: r.hours ?? [],
      attributes: r.attributes ?? [],
      mapRevision: r.map_revision,
    }));
    return { ok: true as const, revision: room.revision as number, candidates: dossiers };
  });
}

export async function prepareNavigation(
  actor: Participant,
  candidateId?: string,
): Promise<PrepareNavigationResponse> {
  return withTransaction(async (client) => {
    let targetId = candidateId;
    if (!targetId) {
      const committed = (
        await client.query(
          `SELECT candidate_id FROM proposals
            WHERE room_id = $1 AND status = 'committed' ORDER BY id DESC LIMIT 1`,
          [actor.roomId],
        )
      ).rows[0];
      if (!committed) {
        return {
          ok: false as const,
          error: {
            code: "phase_unavailable" as const,
            message: "No committed destination yet.",
            recovery:
              "Pass a candidateId, or reach agreement first for the committed destination.",
          },
        };
      }
      targetId = committed.candidate_id as string;
    }
    const candidate = (
      await client.query(
        "SELECT id, name, location FROM candidates WHERE id = $1 AND room_id = $2",
        [targetId, actor.roomId],
      )
    ).rows[0];
    if (!candidate) {
      return {
        ok: false as const,
        error: {
          code: "not_found" as const,
          message: `Unknown candidateId "${targetId}".`,
          recovery: "Call get_spatial_context to refresh candidate IDs.",
        },
      };
    }
    const { lat, lng } = candidate.location as { lat: number; lng: number };
    // Links are built from coordinates the session already holds — no
    // provider API call at handoff time (SPATIAL-PROTOCOL.md §9).
    return {
      ok: true as const,
      target: {
        candidateId: candidate.id as string,
        name: candidate.name as string,
        location: { lat, lng },
      },
      links: {
        geo: `geo:${lat},${lng}?q=${lat},${lng}(${encodeURIComponent(candidate.name)})`,
        googleMaps: `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`,
        appleMaps: `https://maps.apple.com/?daddr=${lat},${lng}`,
      },
    };
  });
}

function notFound() {
  return {
    ok: false as const,
    error: {
      code: "not_found" as const,
      message: "Session not found.",
      recovery: "Reopen the invitation link.",
    },
  };
}
