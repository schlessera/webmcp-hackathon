import type {
  CandidateDossier,
  InspectCandidatesResponse,
  PrepareNavigationResponse,
  SpatialContextResponse,
} from "@webmcp-hackathon/contracts";
import { withTransaction } from "./db.ts";
import type { Participant } from "./auth.ts";
import {
  classifyAll,
  feasibilityOf,
  loadEligibilityInputs,
  whyFor,
} from "./eligibility.ts";
import { computeFacetsBundle } from "./facets.ts";
import { IMPASSE_TEXT } from "./impasse.ts";
import { presentIn } from "./presence.ts";
import type { DataSource } from "./places.ts";
import { applyAttestations, loadAttestations } from "./attestations.ts";
import {
  applyEnrichmentAttributes,
  enrichmentView,
  ensureEnrichments,
  lookupTargetOf,
} from "./enrich/index.ts";
import { pool } from "./db.ts";

/** How long a place panel waits for a fresh lookup before opening with what
 * is cached. The lookup keeps running and lands for the next read. */
const INSPECT_LOOKUP_WAIT_MS = 3500;

/**
 * Spatial read paths — SPATIAL-PROTOCOL.md §6 read commands. Reads carry no
 * baseRevision (they never conflict) and follow the sync-path consistency
 * discipline: FOR SHARE on the room row so a concurrent command's bump stays
 * outside the read window.
 */

export interface SpatialContextOptions {
  /**
   * Return the context AS IF this need were inactive — the press-and-hold
   * preview, computed by the same classifier as the real set so the map can
   * settle honestly instead of guessing. Own or shared needs only.
   */
  excludeRequirementId?: string;
}

export async function spatialContext(
  actor: Participant,
  options: SpatialContextOptions = {},
): Promise<SpatialContextResponse> {
  return withTransaction(async (client) => {
    const room = (
      await client.query(
        "SELECT revision, phase, impasse_active, data_source FROM rooms WHERE id = $1 FOR SHARE",
        [actor.roomId],
      )
    ).rows[0];
    if (!room) return notFound();

    const [inputs, proposals, stances, participantRows, agreementRow, arrivalRow] =
      await Promise.all([
        loadEligibilityInputs(client, actor.roomId),
        client.query(
          `SELECT id, candidate_id, status FROM proposals
            WHERE room_id = $1 AND status <> 'withdrawn' ORDER BY id`,
          [actor.roomId],
        ),
        client.query(
          "SELECT proposal_id, participant_id, disposition, visibility FROM stances WHERE room_id = $1",
          [actor.roomId],
        ),
        client.query(
          `SELECT id, display_name, role, ready_state, arrived_at FROM participants
            WHERE room_id = $1 ORDER BY role <> 'organizer', id`,
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

    // A preview may only suppress a need this viewer can already see. An
    // unknown id and a peer's private one fail identically: confirming that a
    // foreign requirement exists is the existence oracle §3 forbids.
    const excludeId = options.excludeRequirementId;
    if (excludeId !== undefined) {
      const target = inputs.requirements.find((r) => r.id === excludeId);
      if (!target || (target.owner_id !== actor.id && target.visibility !== "shared")) {
        return {
          ok: false as const,
          error: {
            code: "not_found" as const,
            message: "Unknown requirementId.",
            recovery: "Preview only your own needs or the room's shared ones.",
          },
        };
      }
    }
    const effective = inputs.requirements.filter((r) => r.id !== excludeId);
    const rows = classifyAll(
      inputs.candidates,
      effective,
      inputs.verdicts,
      inputs.scope,
    );
    const scope = inputs.scope;
    const bundle = computeFacetsBundle(inputs, actor.id, excludeId);
    const present = presentIn(actor.roomId);
    const participants = (participantRows.rows as Array<{
      id: string;
      display_name: string;
      role: string;
      ready_state: string;
      arrived_at: Date | null;
    }>).map((p) => ({
      participantId: p.id,
      displayName: p.display_name,
      role: p.role as "organizer" | "member",
      readyState: p.ready_state as "contributing" | "ready",
      arrived: p.id === actor.id || p.arrived_at !== null,
      present: present.has(p.id),
    }));

    const stanceRows = stances.rows as Array<{
      proposal_id: string;
      participant_id: string;
      disposition: string;
      visibility: string;
    }>;
    const proposalViews = (proposals.rows as Array<{
      id: string;
      candidate_id: string;
      status: string;
    }>).map((pr) => {
      const own = stanceRows.find(
        (s) => s.proposal_id === pr.id && s.participant_id === actor.id,
      );
      // Name only what this viewer can already derive: their own stance plus
      // shared-visible ones. A stance they may not see reads "none", exactly
      // like silence, so a small room cannot de-anonymize a private stance by
      // subtraction (audit finding 3). A standing veto stays a boolean, never
      // attributed — the proposal status reveals that much already.
      const visibleStances = new Map(
        stanceRows
          .filter(
            (s) =>
              s.proposal_id === pr.id &&
              (s.participant_id === actor.id || s.visibility === "shared"),
          )
          .map((s) => [s.participant_id, s.disposition]),
      );
      const vetoStands = stanceRows.some(
        (s) => s.proposal_id === pr.id && s.disposition === "reject",
      );
      // The §3.7 precondition, computed over the FULL stance table (private
      // stances included) so the page can say what staging waits on. Names
      // only for readiness, which the roster already publishes; the
      // acceptance gap is a count, so a private accept stays silent.
      const allStances = new Map(
        stanceRows
          .filter((s) => s.proposal_id === pr.id)
          .map((s) => [s.participant_id, s.disposition]),
      );
      const notReady = participants
        .filter((p) => p.readyState !== "ready")
        .map((p) => p.participantId);
      const unaccepted = participants.filter((p) => {
        const d = allStances.get(p.participantId);
        return d !== "accept" && d !== "abstain";
      }).length;
      const staging = {
        ready: pr.status === "open" && notReady.length === 0 && unaccepted === 0 && !vetoStands,
        notReady,
        unaccepted,
        vetoStands,
      };
      return {
        proposalId: pr.id,
        candidateId: pr.candidate_id,
        status: pr.status as "open" | "withdrawn" | "vetoed" | "staged" | "committed",
        stances: participants.map((person) => {
          const disposition = visibleStances.get(person.participantId);
          return {
            participantId: person.participantId,
            stance:
              disposition === "accept"
                ? ("accept" as const)
                : disposition === "reject"
                  ? ("veto" as const)
                  : ("none" as const),
          };
        }),
        vetoStands,
        ...(own ? { ownStance: own.disposition } : {}),
        staging,
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

    const source = room.data_source as DataSource | null;
    return {
      ok: true as const,
      revision: room.revision as number,
      phase: room.phase as string,
      scope,
      ...(source
        ? {
            area: {
              areaId: source.areaId,
              label: source.label,
              kind: source.kind,
              source: source.source,
              dataAsOf: source.extractTimestamp,
              poolSize: source.poolSize,
              focusVenues: source.focusVenues,
            },
          }
        : {}),
      feasibility: feasibilityOf(rows),
      total: bundle.total,
      matching: bundle.matching,
      facets: bundle.facets,
      activeNeeds: bundle.activeNeeds,
      privateEffects: bundle.privateEffects,
      participants,
      candidates: rows.map((r) => ({
        candidateId: r.candidateId,
        name: r.name,
        location: r.location,
        category: r.category,
        eligibility: r.eligibility,
        // Per-viewer redaction: private contributions collapse to fixed
        // tokens for everyone but their owner.
        why: whyFor(r, actor.id),
        walkMin: r.walkMin,
        // null passes through: a phantom 0 would put mass at the bottom of
        // every price reading.
        priceLevel: r.priceLevel,
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
    const attestations = await loadAttestations(client, actor.roomId);
    const targets = rows
      .map((r) => lookupTargetOf(r as { osm_ref: string | null; extras: Record<string, unknown> | null }))
      .filter((t): t is NonNullable<typeof t> => t !== null);
    const enrichments = await ensureEnrichments(pool, targets, INSPECT_LOOKUP_WAIT_MS);
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
    const dossiers: CandidateDossier[] = rows.map((r) => {
      const enrichment = r.osm_ref ? enrichments.get(r.osm_ref as string) : undefined;
      const view = enrichmentView(r.extras ?? null, enrichment);
      const webPrice = enrichment?.website?.priceLevel;
      return {
        candidateId: r.id,
        name: r.name,
        location: r.location,
        category: r.category,
        // A published price range fills an unknown band for the panel's meta
        // line, the same way it fills the price-level attribute.
        priceLevel: r.price_level ?? (webPrice ?? null),
        hours: r.hours ?? [],
        attributes: applyAttestations(
          r.id as string,
          applyEnrichmentAttributes(r.attributes ?? [], enrichment),
          attestations,
        ),
        mapRevision: r.map_revision,
        ...(view.links.length ? { links: view.links } : {}),
        ...(view.description ? { description: view.description } : {}),
        ...(view.rating ? { rating: view.rating } : {}),
        ...(view.awards ? { awards: view.awards } : {}),
      };
    });
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
