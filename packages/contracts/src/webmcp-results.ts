import { BUDGETS } from "./tools.ts";
import {
  type CandidateDossier,
  type Eligibility,
  type FailureEnvelope,
  type InspectCandidatesResponse,
  type SpatialContextResult,
} from "./envelope.ts";

export interface ContextInput {
  cursor?: string;
  limit?: number;
  query?: string;
  eligibility?: Eligibility;
}
export interface InspectInput {
  candidateIds: string[];
  keys?: string[];
  details?: Array<"hours" | "evidence" | "links">;
}

export const CLASSIFICATION_MEANINGS = {
  eligible: "Meets all active hard needs on recorded evidence; not a fresh independent verification.",
  likely: "Meets hard needs using some likely evidence.",
  uncertain: "Evidence is missing or disputed; not a confirmed failure.",
  unlikely: "Likely evidence conflicts with a hard need.",
  excluded: "A hard need fails on recorded evidence or the place is outside the search scope.",
};

export function resultTooLarge(recovery: string, revision?: number): FailureEnvelope {
  return {
    ok: false,
    error: {
      code: "temporarily_unavailable",
      message: "The complete result exceeds this tool's output budget. No partial success is returned.",
      recovery: `${revision === undefined ? "" : `The operation may have committed at revision ${revision}. Check sync_session before retrying. `}${recovery}`,
    },
  };
}

const order: Record<Eligibility, number> = { eligible: 0, likely: 1, uncertain: 2, unlikely: 3, excluded: 4 };

/** Explicit projection: coordinates, images and peer-private payloads cannot
 * accidentally enter tool output through a spread of the full HTTP response. */
export function contextSummary(context: SpatialContextResult) {
  return {
    ok: true as const,
    revision: context.revision,
    phase: context.phase,
    identity: context.identity,
    goal: context.goal,
    timezone: context.timezone,
    activeStepId: context.activeStepId,
    steps: context.steps?.map(({ stepId, index, title, status, when, settled }) => ({
      stepId, index, title, status, when,
      ...(settled ? { settled: { candidateId: settled.candidateId, name: settled.name } } : {}),
    })),
    scope: context.scope ? {
      scopeId: context.scope.scopeId,
      radiusM: context.scope.area.radiusM,
      transport: context.scope.transport,
      category: context.scope.category,
    } : null,
    activeNeeds: (context.activeNeeds ?? []).map(({ id, criterionId, label, ownerId, visibility, hardness, active, window }) => ({
      requirementId: id, criterionId, label, ownerId, visibility, hardness, active, window,
    })),
    participants: (context.participants ?? []).map(({ participantId, displayName, role, readyState, present }) => ({
      participantId, displayName, role, readyState, present,
    })),
    feasibility: context.feasibility,
    classification: CLASSIFICATION_MEANINGS,
    ranking: { by: ["eligibility", "walkMin", "candidateId"], walkMin: "Straight-line estimate from your origin, or scope center; not a routed journey or quality ranking." },
    evidence: context.area ? { source: context.area.source, dataAsOf: context.area.dataAsOf } : undefined,
    progress: context.pool ? {
      poolSize: context.pool.size, target: context.pool.target, filling: context.pool.filling,
      queued: context.refine?.queued, paused: context.refine?.paused,
    } : undefined,
    proposals: (context.proposals ?? []).map(({ proposalId, candidateId, status, stances, vetoStands, ownStance, staging }) => ({
      proposalId, candidateId, status,
      visibleAccepts: stances.filter((s) => s.stance === "accept").length,
      vetoStands, ownStance, staging,
    })),
    agreement: context.agreement,
    impasse: context.impasse,
    outstanding: context.outstanding ?? [],
  };
}

function candidateRows(context: SpatialContextResult, input: ContextInput) {
  const query = input.query?.trim().toLocaleLowerCase();
  return context.candidates
    .filter((c) => (!input.eligibility || c.eligibility === input.eligibility) &&
      (!query || `${c.name} ${c.category}`.toLocaleLowerCase().includes(query)))
    .sort((a, b) => order[a.eligibility] - order[b.eligibility] || a.walkMin - b.walkMin || a.candidateId.localeCompare(b.candidateId))
    .map(({ candidateId, name, category, eligibility, why, walkMin, priceLevel, imageCount }) => ({
      candidateId, name, category, eligibility, why, walkMin, priceLevel, imageCount: imageCount ?? 0,
    }));
}

interface Snapshot {
  owner: string;
  summary: ReturnType<typeof contextSummary>;
  rows: ReturnType<typeof candidateRows>;
  limit: number;
  asOf: string;
  expiresAt: number;
  cursors: Map<number, string>;
}

/** Frozen viewer-specific snapshots keep ranking/counts stable between pages.
 * Tokens are document-local, bounded and reusable. Room mutations still require
 * a fresh sync; a candidate cursor never advances the event-sync watermark. */
export class ContextPager {
  private snapshots: Snapshot[] = [];
  private readonly now: () => number;
  private readonly id: () => string;
  constructor(now = () => Date.now(), id = () => crypto.randomUUID()) {
    this.now = now;
    this.id = id;
  }

  clear(): void { this.snapshots = []; }

  read(owner: string, input: ContextInput, context?: SpatialContextResult, budget = BUDGETS.contextResultMax) {
    this.snapshots = this.snapshots.filter((s) => s.owner === owner && s.expiresAt > this.now());
    if (input.cursor) {
      if (Object.keys(input).some((key) => key !== "cursor")) return this.invalid("A continuation accepts only cursor. Start a new snapshot to change filters or limit.");
      for (const snapshot of this.snapshots) {
        for (const [offset, cursor] of snapshot.cursors) {
          if (cursor === input.cursor) return this.page(snapshot, offset, budget);
        }
      }
      return this.invalid("This candidate cursor expired, belongs to another session, or was lost on reload. Call get_spatial_context without cursor.");
    }
    if (!context) return this.invalid("Start with get_spatial_context without cursor.");
    const snapshot: Snapshot = {
      owner,
      summary: contextSummary(context),
      rows: candidateRows(context, input),
      limit: input.limit ?? 8,
      asOf: new Date(this.now()).toISOString(),
      expiresAt: this.now() + 5 * 60_000,
      cursors: new Map(),
    };
    // Copy even nested values: live page-store updates cannot mutate a snapshot.
    snapshot.summary = structuredClone(snapshot.summary);
    this.snapshots.push(snapshot);
    if (this.snapshots.length > 4) this.snapshots.shift();
    return this.page(snapshot, 0, budget);
  }

  private invalid(message: string): FailureEnvelope {
    return { ok: false, error: { code: "invalid_input", message, recovery: "Call get_spatial_context without cursor for a fresh candidate snapshot." } };
  }

  private page(snapshot: Snapshot, offset: number, budget: number) {
    const total = snapshot.rows.length;
    const max = Math.min(snapshot.limit, total - offset);
    for (let count = max; count >= (total > offset ? 1 : 0); count--) {
      const nextOffset = offset + count;
      let nextCursor: string | undefined;
      if (nextOffset < total) {
        nextCursor = snapshot.cursors.get(nextOffset) ?? `c_${this.id()}`;
        snapshot.cursors.set(nextOffset, nextCursor);
      }
      const result = {
        ...snapshot.summary,
        snapshot: { asOf: snapshot.asOf, expiresAt: new Date(snapshot.expiresAt).toISOString() },
        candidates: snapshot.rows.slice(offset, nextOffset),
        page: {
          total, offset, returned: count, remaining: total - nextOffset,
          remainingEligible: snapshot.rows.slice(nextOffset).filter((c) => c.eligibility === "eligible").length,
          nextCursor,
        },
      };
      if (JSON.stringify(result).length <= budget) return result;
    }
    return resultTooLarge("The planning summary and one candidate must fit intact. Use sync_session for outstanding work and the page to read this room's full planning state.");
  }
}

export function inspectResult(result: InspectCandidatesResponse, input: InspectInput) {
  if (!result.ok) return result;
  const byId = new Map(result.candidates.map((d) => [d.candidateId, d]));
  const candidates = input.candidateIds.map((id) => byId.get(id));
  if (candidates.some((d) => !d)) return {
    ok: false as const,
    error: { code: "not_found" as const, message: "An inspected candidate was missing from the response.", recovery: "Refresh candidate IDs with get_spatial_context." },
  };
  const details = new Set(input.details ?? []);
  return {
    ok: true as const,
    revision: result.revision,
    candidates: (candidates as CandidateDossier[]).map((d) => {
      const needed = new Set(d.needs?.flatMap((need) => need.criterionId ? [need.criterionId] : []) ?? []);
      const keys = new Set(input.keys ?? [
        ...needed,
        ...d.attributes.filter((a) => a.status === "verified_true" || a.status === "likely_true").slice(0, 4).map((a) => a.key),
      ]);
      const byKey = new Map(d.attributes.map((attribute) => [attribute.key, attribute]));
      return {
        candidateId: d.candidateId, name: d.name, category: d.category, mapRevision: d.mapRevision,
        timezone: d.timezone, asOf: d.asOf,
        priceLevel: d.priceLevel, openNow: d.openNow, openUntil: d.openUntil, nextOpen: d.nextOpen,
        address: d.address, imageCount: d.images?.length ?? 0,
        attributes: [...keys].map((key) => {
          const a = byKey.get(key);
          if (!a) return { key, status: "unknown", source: "not on record" };
          return {
            key, label: a.label, value: a.value, status: a.status, source: a.source,
            observedAt: a.observedAt, confidence: a.confidence,
            ...(details.has("evidence") ? {
              note: a.note, sourceUrl: a.sourceUrl, attestedBy: a.attestedBy,
              confirmedByName: a.confirmedByName, confirmedAt: a.confirmedAt,
            } : {}),
          };
        }),
        availableKeys: d.attributes.map((a) => a.key),
        needs: d.needs ?? [],
        lookupPending: d.lookupPending ?? false, lookedUpAt: d.lookedUpAt,
        ...(details.has("hours") ? { hours: d.hours } : {}),
        ...(details.has("evidence") ? { sourceEvidence: d.sourceEvidence ?? [] } : {}),
        ...(details.has("links") ? { links: d.links ?? [] } : {}),
      };
    }),
  };
}

/** Derived from the actual projections so contract hashing tracks optional
 * tool output fields as well as the richer HTTP response types. */
export type WebMCPContextResponse = ReturnType<ContextPager["read"]>;
export type WebMCPInspectResponse = ReturnType<typeof inspectResult>;
