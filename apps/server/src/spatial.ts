import type {
  CandidateDossier,
  InspectCandidatesResponse,
  PrepareNavigationResponse,
  SpatialContextResponse,
} from "@webmcp-hackathon/contracts";
import { POOL_CAP, areaById } from "@webmcp-hackathon/contracts";
import { withTransaction } from "./db.ts";
import type { Participant } from "./auth.ts";
import {
  classifyAll,
  feasibilityOf,
  loadEligibilityInputs,
  mergedAttributes,
  whyFor,
} from "./eligibility.ts";
import { computeFacetsBundle, labelForRequirement } from "./facets.ts";
import { IMPASSE_TEXT } from "./impasse.ts";
import { presentIn } from "./presence.ts";
import { fillPlan, loadSnapshot, type DataSource } from "./places.ts";
import { startPoolFill } from "./pool-fill.ts";
import { loadAttestations } from "./attestations.ts";
import {
  enrichmentView,
  loadCached,
  lookupNow,
  lookupTargetOf,
  type RoomLookupTarget,
} from "./enrich/index.ts";
import { lookupPending } from "./enrich/progress.ts";
import { pool } from "./db.ts";

/** How long a place panel waits for a fresh lookup before opening with what
 * is cached. The lookup keeps running and lands for the next read. */
const INSPECT_LOOKUP_WAIT_MS = 3500;

type NeedVerdict = NonNullable<CandidateDossier["needs"]>[number]["verdict"];

/** Harshest first: the aggregate peer-private row reports the worst verdict
 * any one of those needs reaches, so the row can never understate the effect. */
const VERDICT_SEVERITY: Record<NeedVerdict, number> = {
  no: 0,
  unlikely: 1,
  unknown: 2,
  likely: 3,
  yes: 4,
};

export function worstVerdict(verdicts: NeedVerdict[]): NeedVerdict {
  return verdicts.reduce((worst, verdict) =>
    VERDICT_SEVERITY[verdict] < VERDICT_SEVERITY[worst] ? verdict : worst,
  );
}

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
        "SELECT revision, phase, impasse_active, data_source, area_id FROM rooms WHERE id = $1 FOR SHARE",
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
    const poolSize = inputs.candidates.length;
    const area = typeof room.area_id === "string" ? areaById(room.area_id) : undefined;
    const snapshot = area ? loadSnapshot(area.id) : null;
    const explorable = snapshot !== null;
    let filling = false;
    let poolTarget = poolSize;
    if (area && snapshot && scope?.area.kind === "circle") {
      const plan = fillPlan(
        area,
        snapshot,
        scope.area.center,
        scope.area.radiusM,
        inputs.candidates.flatMap((candidate) => candidate.osm_ref ? [candidate.osm_ref] : []),
      );
      poolTarget = Math.min(plan.total, POOL_CAP);
      filling = poolSize < POOL_CAP && plan.batches.length > 0;
      // A read is also the restart recovery point: persisted candidates and
      // scope are enough to derive and resume whatever work is missing.
      if (filling) startPoolFill(actor.roomId);
    }
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
              poolSize,
              focusVenues: source.focusVenues,
            },
          }
        : {}),
      pool: { size: poolSize, cap: POOL_CAP, explorable, filling, target: poolTarget },
      feasibility: feasibilityOf(rows),
      total: bundle.total,
      matching: bundle.matching,
      likely: bundle.likely,
      facets: bundle.facets,
      activeNeeds: bundle.activeNeeds,
      privateEffects: bundle.privateEffects,
      participants,
      candidates: rows.map((r) => {
        const why = whyFor(r, actor.id);
        return {
          candidateId: r.candidateId,
          ...(r.ref ? { ref: r.ref } : {}),
          name: r.name,
          location: r.location,
          category: r.category,
          eligibility: r.eligibility,
          ...(r.confidence !== undefined ? { confidence: r.confidence } : {}),
          // Per-viewer redaction: private contributions collapse to fixed
          // tokens for everyone but their owner. Eligible rows omit it.
          ...(why !== undefined ? { why } : {}),
          walkMin: r.walkMin,
          // null passes through: a phantom 0 would put mass at the bottom of
          // every price reading.
          priceLevel: r.priceLevel,
        };
      }),
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
  options: { triggerLookup?: boolean; waitMs?: number } = {},
): Promise<InspectCandidatesResponse> {
  // R9: discover network targets without locking the room and without
  // checking out a client. The candidate rows are deliberately re-read in a
  // fresh transaction after enrichment, so this preflight is not the dossier
  // consistency snapshot.
  const roomExists = (
    await pool.query("SELECT 1 FROM rooms WHERE id = $1", [actor.roomId])
  ).rowCount;
  if (!roomExists) return notFound();
  const lookupRows = (
    await pool.query(
      "SELECT id, osm_ref, extras FROM candidates WHERE room_id = $1 AND id = ANY($2)",
      [actor.roomId, candidateIds],
    )
  ).rows;
  const initiallyFound = new Set(lookupRows.map((row) => row.id as string));
  const initiallyMissing = candidateIds.find((id) => !initiallyFound.has(id));
  if (initiallyMissing) {
    return {
      ok: false as const,
      error: {
        code: "not_found" as const,
        message: `Unknown candidateId "${initiallyMissing}".`,
        recovery: "Call get_spatial_context to refresh candidate IDs.",
      },
    };
  }
  const targets = lookupRows
    .map((row) => {
      const target = lookupTargetOf(
        row as { osm_ref: string | null; extras: Record<string, unknown> | null },
      );
      return target ? { candidateId: row.id as string, ...target } : null;
    })
    .filter((target): target is RoomLookupTarget => target !== null);

  if (options.triggerLookup !== false) {
    // Live lookup/progress starts outside the room lock. The panel may wait
    // for its bounded budget, while the same job continues into cache after
    // the read returns.
    const lookupJob = lookupNow(pool, actor.roomId, targets, {
      reason: { kind: "place" },
    });
    const waitMs = Math.max(0, options.waitMs ?? INSPECT_LOOKUP_WAIT_MS);
    if (waitMs > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        lookupJob.catch(() => []),
        new Promise<[]>(resolve => {
          timer = setTimeout(() => resolve([]), waitMs);
          timer.unref?.();
        }),
      ]);
      if (timer) clearTimeout(timer);
    } else {
      void lookupJob.catch(() => {
        /* explicit fire-and-forget lookups never fail the read */
      });
    }
  }

  // R9: only this short, network-free transaction holds the room share lock.
  // Revision, candidates, attestations and cached facts therefore describe
  // one consistent dossier snapshot without delaying mutations on the crawl.
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
    const attestations = await loadAttestations(client, actor.roomId);
    const refs = rows
      .map((row) => row.osm_ref as string | null)
      .filter((ref): ref is string => Boolean(ref));
    const enrichments = await loadCached(client, refs);
    const inputs = await loadEligibilityInputs(client, actor.roomId);
    const candidateById = new Map(inputs.candidates.map((candidate) => [candidate.id, candidate]));
    const needsFor = (candidateId: string): CandidateDossier["needs"] => {
      const candidate = candidateById.get(candidateId);
      if (!candidate) return [];
      const rows: NonNullable<CandidateDossier["needs"]> = [];
      const peerPrivate: NeedVerdict[] = [];
      for (const requirement of inputs.requirements) {
        if (requirement.active === false) continue;
        const classified = classifyAll(
          [candidate],
          [requirement],
          inputs.verdicts,
          null,
        )[0];
        const verdict =
          classified.eligibility === "eligible"
            ? "yes"
            : classified.eligibility === "excluded"
              ? "no"
              : classified.eligibility === "uncertain"
                ? "unknown"
                : classified.eligibility;
        // CLAUDE.md §5: a private need's effect is public, its content is not.
        // Every peer-private need collapses into ONE row carrying only the
        // harshest verdict, so a viewer cannot pair a per-place verdict with a
        // particular need — not even by counting rows.
        if (requirement.owner_id !== actor.id && requirement.visibility !== "shared") {
          peerPrivate.push(verdict);
          continue;
        }
        const why = whyFor(classified, actor.id);
        rows.push({
          requirementId: requirement.id,
          label: labelForRequirement(requirement, requirement.owner_id === actor.id),
          verdict,
          ...(classified.confidence !== undefined ? { confidence: classified.confidence } : {}),
          ...(why !== undefined ? { why } : {}),
        });
      }
      if (peerPrivate.length > 0) {
        rows.push({ private: true as const, verdict: worstVerdict(peerPrivate) });
      }
      return rows;
    };
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
        attributes: mergedAttributes(
          { id: r.id as string, category: r.category as string, attributes: r.attributes ?? [] },
          enrichment,
          attestations,
        ) as CandidateDossier["attributes"],
        mapRevision: r.map_revision,
        ...(r.extras?.address ? { address: String(r.extras.address) } : {}),
        ...(r.extras?.phone ? { phone: String(r.extras.phone) } : {}),
        needs: needsFor(r.id as string),
        lookupPending: lookupPending(actor.roomId, r.id as string),
        ...(lookedUpAtOf(enrichment) ? { lookedUpAt: lookedUpAtOf(enrichment) } : {}),
        ...(view.links.length ? { links: view.links } : {}),
        ...(view.description ? { description: view.description } : {}),
        ...(view.rating ? { rating: view.rating } : {}),
        ...(view.awards ? { awards: view.awards } : {}),
      };
    });
    return { ok: true as const, revision: room.revision as number, candidates: dossiers };
  });
}

/** Start an explicit lookup and return the dossiers exactly as they stand.
 * The work is fire-and-forget: a failed source/model never fails this read. */
/** The later of the provider read and the inference, as the panel's "looked
 * up N min ago"; undefined when nothing was ever looked up. */
function lookedUpAtOf(enrichment: { fetchedAt?: string; inferredAt?: string | null } | undefined): string | undefined {
  if (!enrichment) return undefined;
  const times = [enrichment.fetchedAt, enrichment.inferredAt]
    .filter((t): t is string => Boolean(t))
    .map((t) => new Date(t).getTime())
    .filter((t) => Number.isFinite(t));
  return times.length ? new Date(Math.max(...times)).toISOString() : undefined;
}

export async function lookUpPlaces(
  actor: Participant,
  candidateIds: string[],
  keys?: string[],
  force = false,
): Promise<InspectCandidatesResponse> {
  const rows = (
    await pool.query(
      "SELECT id, osm_ref, extras FROM candidates WHERE room_id = $1 AND id = ANY($2)",
      [actor.roomId, candidateIds],
    )
  ).rows;
  const targets = rows.flatMap((row) => {
    const target = lookupTargetOf(row as { osm_ref: string | null; extras: Record<string, unknown> | null });
    return target ? [{ candidateId: row.id as string, ...target }] : [];
  });
  void lookupNow(pool, actor.roomId, targets, {
    keys,
    reason: { kind: "place" },
    force,
  }).catch(() => {
    /* explicit lookups are advisory and never turn a read into a failure */
  });
  return inspectCandidates(actor, candidateIds, { triggerLookup: false, waitMs: 0 });
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
