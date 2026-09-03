import type pg from "pg";
import { PRICE_LEVEL_EUR } from "@webmcp-hackathon/contracts";
import {
  classifyAll,
  feasibilityOf,
  loadEligibilityInputs,
  type CandidateEligibility,
  type CandidateRow,
  type RequirementRow,
  type ScopeState,
  type VerdictRow,
} from "./eligibility.ts";
import { isDecided, type Phase } from "./phase.ts";

/**
 * Impasse pipeline — NEGOTIATION-PROTOCOL.md §7.2 steps 1-5. Deterministic
 * throughout: greedy-deletion minimal conflict set over hard requirements
 * (newest first), and quantified adjustments whose projectedGain is the
 * actually recomputed eligible count, never an estimate.
 *
 * POC deviation, deliberate: the protocol triggers the pipeline on
 * `infeasible` (0 eligible, all screening resolved). Attribute-evidence
 * uncertainty (unknown/unverified dossier attributes) has no evidence-request
 * pipeline in this slice, so it does NOT block impasse detection — only
 * pending agent-private screening does. Feasibility classification shown to
 * participants stays honest (`uncertain`), while the council still detects
 * that no verified option exists and proposes recovery.
 */

export const IMPASSE_TEXT =
  "No option currently satisfies every confirmed requirement. " +
  "The council is privately checking possible adjustments.";

export interface AdjustmentDraft {
  kind: "scope_change" | "requirement_relaxation";
  target: Record<string, unknown>;
  change: Record<string, unknown>;
  projectedGain: { newCandidates: number };
  requiresConsentOf: string;
  withinDelegatedBound: boolean;
}

const eligibleCount = (rows: CandidateEligibility[]) =>
  rows.filter((r) => r.eligibility === "eligible").length;

/** Screening still pending: an agent-private declaration lacks verdicts. */
export function screeningPending(
  candidates: CandidateRow[],
  requirements: RequirementRow[],
  verdicts: VerdictRow[],
): boolean {
  const declared = requirements.filter(
    (r) => r.visibility === "agent-private" && r.hardness === "hard" && !r.withdrawn,
  );
  return declared.some((req) =>
    candidates.some((c) => {
      const v = verdicts.find(
        (x) =>
          x.owner_id === req.owner_id &&
          x.candidate_id === c.id &&
          // X12: a stale verdict is unresolved for impasse purposes too;
          // otherwise recovery could begin while re-screening is pending.
          Number.isSafeInteger(x.screened_map_revision) &&
          Number.isSafeInteger(c.map_revision) &&
          x.screened_map_revision === c.map_revision,
      );
      return !v || v.verdict === "needs_info";
    }),
  );
}

/**
 * Greedy-deletion minimal conflict set: start from all hard requirements,
 * newest first; drop each whose removal leaves the room still without an
 * eligible candidate. The survivors are an irreducible conflicting set.
 */
export function minimalConflictSet(
  candidates: CandidateRow[],
  requirements: RequirementRow[],
  verdicts: VerdictRow[],
  scope: ScopeState | null,
): RequirementRow[] {
  const hard = requirements
    .filter((r) => r.hardness === "hard" && !r.withdrawn)
    .sort(
      (a, b) =>
        (b.created_at_revision ?? 0) - (a.created_at_revision ?? 0) ||
        b.id.localeCompare(a.id),
    );
  const infeasibleWith = (set: RequirementRow[]) =>
    eligibleCount(classifyAll(candidates, set, verdicts, scope)) === 0;

  let set = [...hard];
  for (const req of hard) {
    const without = set.filter((r) => r.id !== req.id);
    if (infeasibleWith(without)) set = without;
  }
  return set;
}

const RADIUS_STEP_M = 200;
const RADIUS_MAX_M = 2000;

export function generateAdjustments(
  candidates: CandidateRow[],
  requirements: RequirementRow[],
  verdicts: VerdictRow[],
  scope: ScopeState | null,
  conflictSet: RequirementRow[],
  organizerId: string,
): AdjustmentDraft[] {
  const drafts: AdjustmentDraft[] = [];

  // (a) Neutral scope expansion: smallest radius step that recovers >= 3
  // eligible candidates, else the step with the best gain.
  if (scope?.area?.kind === "circle") {
    let best: { radius: number; gain: number } | null = null;
    for (
      let radius = scope.area.radiusM + RADIUS_STEP_M;
      radius <= RADIUS_MAX_M;
      radius += RADIUS_STEP_M
    ) {
      const widened: ScopeState = {
        ...scope,
        area: { ...scope.area, radiusM: radius },
      };
      const gain = eligibleCount(
        classifyAll(candidates, requirements, verdicts, widened),
      );
      if (!best || gain > best.gain) best = { radius, gain };
      if (gain >= 3) break;
    }
    if (best && best.gain > 0) {
      drafts.push({
        kind: "scope_change",
        target: { dimension: "radius_m" },
        change: { dimension: "radius_m", from: scope.area.radiusM, to: best.radius },
        projectedGain: { newCandidates: best.gain },
        requiresConsentOf: organizerId,
        withinDelegatedBound: false,
      });
    }
  }

  // (b) Relaxations of non-locked conflicting requirements with real gain.
  // Locked requirements (incl. protected-category defaults) are never targets.
  const bands = Object.values(PRICE_LEVEL_EUR).sort((a, b) => a - b);
  for (const req of conflictSet) {
    const delegation = (req as { delegation?: { mode?: string; bound?: { dimension?: string; max?: number } } })
      .delegation;
    if (delegation?.mode === "locked") continue;
    const p = req.payload;
    if (!p) continue;

    if (p.kind === "budget" && p.perPersonMax) {
      const nextBand = bands.find((b) => b > p.perPersonMax!.amount);
      if (nextBand === undefined) continue;
      const relaxed: RequirementRow = {
        ...req,
        payload: {
          ...p,
          perPersonMax: { ...p.perPersonMax, amount: nextBand },
        },
      };
      const gain = eligibleCount(
        classifyAll(
          candidates,
          requirements.map((r) => (r.id === req.id ? relaxed : r)),
          verdicts,
          scope,
        ),
      );
      if (gain > 0) {
        drafts.push({
          kind: "requirement_relaxation",
          target: { requirementId: req.id },
          change: {
            dimension: "per_person_eur",
            from: p.perPersonMax.amount,
            to: nextBand,
          },
          projectedGain: { newCandidates: gain },
          requiresConsentOf: req.owner_id,
          withinDelegatedBound:
            delegation?.mode === "negotiable" &&
            delegation.bound?.dimension === "per_person_eur" &&
            typeof delegation.bound.max === "number" &&
            nextBand <= delegation.bound.max,
        });
      }
    } else if (p.kind === "exclusion" || p.kind === "inclusion") {
      const gain = eligibleCount(
        classifyAll(
          candidates,
          requirements.filter((r) => r.id !== req.id),
          verdicts,
          scope,
        ),
      );
      if (gain > 0) {
        drafts.push({
          kind: "requirement_relaxation",
          target: { requirementId: req.id },
          change: { dimension: p.kind, from: p.values ?? [], to: [] },
          projectedGain: { newCandidates: gain },
          requiresConsentOf: req.owner_id,
          withinDelegatedBound: false,
        });
      }
    }
  }

  return drafts;
}

export interface ImpasseEvent {
  type: string;
  actorId: string | null;
  visibility: string;
  payload: Record<string, unknown>;
}

/**
 * Post-command impasse bracket, run inside the command transaction after
 * eligibility recomputation. Emits impasse_detected + adjustment_proposed on
 * entry, impasse_resolved (and expires open adjustments) on recovery.
 */
export async function impasseBracket(
  client: pg.PoolClient,
  roomId: string,
  after: CandidateEligibility[],
): Promise<ImpasseEvent[]> {
  const room = (
    await client.query(
      "SELECT revision, phase, impasse_active FROM rooms WHERE id = $1",
      [roomId],
    )
  ).rows[0];
  if (!room) return [];
  // The decision is committed: recovery negotiation is over, whatever late
  // requirement edits do to the eligibility picture.
  if (isDecided(room.phase as Phase)) return [];
  const feasibility = feasibilityOf(after);

  if (feasibility.eligible > 0) {
    if (!room.impasse_active) return [];
    await client.query("UPDATE rooms SET impasse_active = false WHERE id = $1", [
      roomId,
    ]);
    await client.query(
      `UPDATE adjustments SET status = 'expired'
        WHERE room_id = $1 AND status IN ('proposed', 'staged_grant')`,
      [roomId],
    );
    return [
      {
        type: "impasse_resolved",
        actorId: null,
        visibility: "shared",
        payload: { eligible: feasibility.eligible },
      },
    ];
  }

  // The SAME snapshot the main classifier reads, walking times included: a
  // council that reasons over the seeded walk_min while eligibility reasons
  // over the distance from the current scope centre would propose adjustments
  // whose projected gain the classifier never realizes.
  const inputs = await loadEligibilityInputs(client, roomId);
  const candidateRows = inputs.candidates;
  // Needs their owner has set aside are not in force: the council reasons
  // about, and offers to relax, only what is actually classifying candidates.
  const requirementRows = inputs.requirements.filter((r) => r.active !== false);
  const verdictRows = inputs.verdicts;
  const scope = inputs.scope;

  // No candidates at all, or nothing hard requested yet: an empty room is not
  // an impasse. Screening in flight defers detection to the verdicts.
  if (candidateRows.length === 0) return [];
  if (!requirementRows.some((r) => r.hardness === "hard")) return [];
  if (screeningPending(candidateRows, requirementRows, verdictRows)) return [];

  const conflict = minimalConflictSet(
    candidateRows,
    requirementRows,
    verdictRows,
    scope,
  );
  const drafts = generateAdjustments(
    candidateRows,
    requirementRows,
    verdictRows,
    scope,
    conflict,
    await organizerOf(client, roomId),
  );

  // Regeneration discipline: while the impasse stands, every
  // eligibility-perturbing command may contribute NEW recovery options (the
  // requirement set has changed), but an adjustment already open is never
  // duplicated and one the addressee denied is never resurrected in this
  // session (denial is persisted by its canonical change key).
  const existingRows = (
    await client.query(
      "SELECT id, kind, target, change, requires_consent_of, status FROM adjustments WHERE room_id = $1",
      [roomId],
    )
  ).rows as Array<{
    id: string;
    kind: string;
    target: unknown;
    change: { dimension?: unknown; from?: unknown; to?: unknown };
    requires_consent_of: string;
    status: string;
  }>;
  const keyOf = (
    kind: string,
    consentOf: string,
    target: unknown,
    change: { dimension?: unknown; from?: unknown; to?: unknown },
  ) =>
    [
      kind, consentOf, JSON.stringify(target),
      String(change.dimension), String(change.from), String(change.to),
    ].join("|");
  const suppressed = new Set(
    existingRows
      .filter((r) => ["proposed", "staged_grant", "denied"].includes(r.status))
      .map((r) => keyOf(r.kind, r.requires_consent_of, r.target, r.change)),
  );
  const newDrafts = drafts.filter(
    (d) => !suppressed.has(keyOf(d.kind, d.requiresConsentOf, d.target, d.change)),
  );
  // Supersession: a draft's projected gain is only true for the requirement
  // set it was computed against. An open (not yet staged) adjustment the
  // fresh pass no longer produces is stale — its "+4" would now apply to a
  // different room — so it expires rather than staying actionable beside the
  // replacement. Staged grants are mid-consent and are left alone.
  const freshKeys = new Set(
    drafts.map((d) => keyOf(d.kind, d.requiresConsentOf, d.target, d.change)),
  );
  const stale = existingRows.filter(
    (r) =>
      r.status === "proposed" &&
      !freshKeys.has(keyOf(r.kind, r.requires_consent_of, r.target, r.change)),
  );
  if (stale.length > 0) {
    await client.query(
      "UPDATE adjustments SET status = 'expired' WHERE id = ANY($1)",
      [stale.map((r) => r.id)],
    );
  }

  const events: ImpasseEvent[] = [];
  if (!room.impasse_active) {
    await client.query("UPDATE rooms SET impasse_active = true WHERE id = $1", [
      roomId,
    ]);
    events.push({
      type: "impasse_detected",
      actorId: null,
      visibility: "shared",
      payload: { conflictSize: conflict.length },
    });
  } else if (newDrafts.length === 0) {
    return [];
  }

  let seq = existingRows.length;
  for (const draft of newDrafts) {
    seq += 1;
    // adjustments.id is a global PK: scope the deterministic counter by room.
    const id = `adj_${roomId.replace(/^room_/, "")}_${seq}`;
    await client.query(
      `INSERT INTO adjustments (id, room_id, kind, target, change, projected_gain,
                                requires_consent_of, within_delegated_bound, status, created_at_revision)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'proposed', $9)`,
      [
        id,
        roomId,
        draft.kind,
        JSON.stringify(draft.target),
        JSON.stringify(draft.change),
        JSON.stringify(draft.projectedGain),
        draft.requiresConsentOf,
        draft.withinDelegatedBound,
        room.revision,
      ],
    );
    events.push({
      type: "adjustment_proposed",
      actorId: null,
      visibility: "application-private",
      payload: {
        targetParticipantId: draft.requiresConsentOf,
        adjustmentId: id,
        kind: draft.kind,
        change: draft.change,
        projectedGain: draft.projectedGain,
        withinDelegatedBound: draft.withinDelegatedBound,
      },
    });
  }
  return events;
}

async function organizerOf(client: pg.PoolClient, roomId: string): Promise<string> {
  const row = (
    await client.query(
      "SELECT id FROM participants WHERE room_id = $1 AND role = 'organizer' ORDER BY id LIMIT 1",
      [roomId],
    )
  ).rows[0];
  return row?.id ?? "";
}
