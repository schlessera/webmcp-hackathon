import type {
  ActiveNeed,
  Facet,
  FacetValueCount,
  PrivateEffect,
  Visibility,
} from "@webmcp-hackathon/contracts";
import {
  ATTRIBUTE_LABELS,
  ATTRIBUTE_VOCABULARY,
  CUISINE_IMPLICATION_SATISFACTION_FLOOR,
  PRICE_LEVEL_EUR,
  criterionFor,
  implies,
  normalizeCuisineTokens,
  windowLabel,
  windowSpanText,
} from "@webmcp-hackathon/contracts";
import {
  classifyAll,
  classifyCandidate,
  haversineMeters,
  type CandidateEligibility,
  type CandidateRow,
  type EligibilityInputs,
  type RequirementRow,
  type ScopeState,
} from "./eligibility.ts";

/**
 * The data behind every control (FACETS.md).
 *
 * Three products, all computed over ONE snapshot of the room in memory:
 *
 * - `facets` — what is askable about the current results. Server-authored
 *   labels, one renderer per type, no domain field: the client must never
 *   learn what kind of place these are (CLAUDE.md invariant 1).
 * - `activeNeeds` — the viewer's own and the room's shared needs with their
 *   counterfactual deltas (the "-19" in a brief row, the "+3" chip).
 * - `privateEffects` — a peer's private need reduced to its effect on the
 *   count. Never the predicate, the value, or the places it removed
 *   (invariant 5): the effect is public, the content is not.
 *
 * Everything is measured against the IN-SCOPE candidate list. Places outside
 * the scope circle are not in the running, so attributing their absence to a
 * need would make every count wrong by the same large constant.
 */

export interface FacetsBundle {
  /** In-scope places: the denominator of "N of TOTAL". */
  total: number;
  /** In-scope places satisfying every active need. */
  matching: number;
  /** In-scope places that likely satisfy every active need (§8.2). */
  likely: number;
  facets: Facet[];
  activeNeeds: ActiveNeed[];
  privateEffects: PrivateEffect[];
}

const WALK_SPEED_M_PER_MIN = 4500 / 60;
const HISTOGRAM_BUCKETS = 5;
/** Handled by a facet of their own rather than as boolean claims. */
const NON_BOOLEAN_KEYS = new Set(["cuisine", "price-level"]);

export function inScope(
  candidates: CandidateRow[],
  scope: ScopeState | null,
): CandidateRow[] {
  const area = scope?.area;
  if (area?.kind !== "circle") return candidates;
  return candidates.filter(
    (c) => haversineMeters(c.location, area.center) <= area.radiusM,
  );
}

const isActive = (r: RequirementRow) => r.active !== false;
/**
 * One pass over the room for one viewer. `suppressRequirementId` computes the
 * whole bundle AS IF that need were inactive — the press-and-hold preview,
 * which has to be the real classification and not an estimate.
 */
export function computeFacetsBundle(
  inputs: EligibilityInputs,
  viewerId: string,
  suppressRequirementId?: string,
  classified?: CandidateEligibility[],
): FacetsBundle {
  const candidates = inScope(inputs.candidates, inputs.scope);
  const effective = inputs.requirements.filter(
    (r) => r.id !== suppressRequirementId,
  );
  const active = effective.filter(isActive);
  const candidateIds = new Set(candidates.map((candidate) => candidate.id));
  const rows = (classified ?? classifyAll(
    candidates,
    active,
    inputs.verdicts,
    inputs.scope,
    inputs.timezone,
  )).filter((row) => candidateIds.has(row.candidateId));
  const matching = rows.filter((row) => row.eligibility === "eligible").length;
  const likely = rows.filter((row) => row.eligibility === "likely").length;

  const activeNeeds: ActiveNeed[] = [];
  const privateEffects: PrivateEffect[] = [];
  const ordered = [...inputs.requirements].sort(
    (a, b) =>
      (a.created_at_revision ?? 0) - (b.created_at_revision ?? 0) ||
      a.id.localeCompare(b.id),
  );
  // One candidate traversal builds every need's independent outcome. The
  // main classification supplied by spatialContext is reused for totals;
  // counterfactual eligible counts are then derived from these rows instead
  // of running classifyAll once per need and facet.
  const aloneByRequirement = new Map(ordered.map((requirement) => [
    requirement.id,
    candidates.map((candidate) => classifyCandidate(
      candidate,
      [{ ...requirement, active: true }],
      inputs.verdicts,
      inputs.scope,
      inputs.timezone ?? "UTC",
    )),
  ]));
  const scopeOnly = candidates.map((candidate) => classifyCandidate(
    candidate,
    [],
    inputs.verdicts,
    inputs.scope,
    inputs.timezone ?? "UTC",
  ));

  for (const req of ordered) {
    // What this need ALONE does, so its row's numbers do not depend on which
    // other need happened to exclude a place first (classify short-circuits).
    const alone = aloneByRequirement.get(req.id)!;
    const ruledOut = alone.filter((r) => r.eligibility === "excluded").length;

    if (req.owner_id === viewerId || req.visibility === "shared") {
      const suppressed = req.id === suppressRequirementId;
      const stillActive = isActive(req) && !suppressed;
      const criterion = criterionFor(req.payload as never, criterionContext(inputs));
      activeNeeds.push({
        id: req.id,
        ...(criterion ? { criterionId: criterion.id } : {}),
        label: labelForRequirement(req, req.owner_id === viewerId, criterionContext(inputs)),
        ruledOut,
        unknown: alone.filter(
          (r) =>
            r.eligibility === "uncertain" &&
            (r.uncertainReasons ?? []).some((x) => x.requirementId === req.id),
        ).length,
        likely: alone.filter(
          (r) => r.eligibility === "likely" && (r.likelyReasons ?? []).some((x) => x.requirementId === req.id),
        ).length,
        unlikely: alone.filter(
          (r) => r.eligibility === "unlikely" && (r.likelyReasons ?? []).some((x) => x.requirementId === req.id),
        ).length,
        wouldReturn: stillActive
          ? candidates.filter((_candidate, index) =>
              scopeOnly[index].eligibility === "eligible" &&
              active.every((other) =>
                other.id === req.id ||
                aloneByRequirement.get(other.id)![index].eligibility === "eligible"
              )
            ).length - matching
          : 0,
        active: stillActive,
        visibility: req.visibility as Visibility,
        hardness: req.hardness === "soft" ? "soft" : "hard",
        ownerId: req.owner_id,
        ...referentView(req, inputs.scope),
      });
      continue;
    }

    // A peer's private need. Its effect is public; nothing else about it is.
    // Inactive ones are omitted because they have no effect to report.
    if (!isActive(req) || req.id === suppressRequirementId) continue;
    privateEffects.push({
      owner: req.owner_id,
      ruledOut,
      ...(req.scope_hint?.category ? { topic: req.scope_hint.category } : {}),
    });
  }

  return {
    total: candidates.length,
    matching,
    likely,
    facets: [
      ...computeFacets(
        candidates,
        inputs.scope,
        inputs.origins?.get(viewerId) ?? inputs.scope?.area?.center,
      ),
      ...temporalFacets(
        active.filter((req) => req.owner_id === viewerId || req.visibility === "shared"),
        inputs,
        aloneByRequirement,
      ),
    ],
    activeNeeds,
    privateEffects,
  };
}

function referentView(
  req: RequirementRow,
  scope: ScopeState | null,
): Pick<ActiveNeed, "referent"> {
  const referent = req.payload?.kind === "scope" ? req.payload.referent : undefined;
  if (!referent || referent.kind === "self") return {};
  const label = req.referent_label ?? (
    referent.kind === "scopeCenter"
      ? "the room centre"
      : referent.kind === "point"
        ? referent.label?.trim() || "this point"
        : referent.kind === "participant"
          ? "where someone starts from"
          : referent.kind === "candidate"
            ? "a place no longer in the room"
            : "an unknown landmark"
  );
  const location = referent.kind === "point"
    ? { lat: referent.lat, lng: referent.lng }
    : referent.kind === "scopeCenter"
      ? scope?.area?.center
      : req.referent_location ?? undefined;
  return {
    referent: {
      kind: referent.kind,
      label,
      ...(location ? { location } : {}),
    },
  };
}

function criterionContext(inputs: EligibilityInputs): { timezone: string; now: Date } {
  return {
    timezone: inputs.timezone ?? "UTC",
    // Direct pure-function callers that do not use temporal needs need no
    // clock. A temporal caller supplies one; the epoch fallback is stable.
    now: inputs.now ?? new Date(0),
  };
}

function temporalFacets(
  requirements: RequirementRow[],
  inputs: EligibilityInputs,
  aloneByRequirement: Map<string, CandidateEligibility[]>,
): Facet[] {
  const facets = new Map<string, Facet>();
  for (const requirement of requirements) {
    if (requirement.payload?.kind !== "time") continue;
    const criterion = criterionFor(requirement.payload as never, criterionContext(inputs));
    if (!criterion || facets.has(criterion.id)) continue;
    const rows = aloneByRequirement.get(requirement.id) ?? [];
    const counts: NonNullable<Facet["counts"]> = {
      yes: 0,
      likely: 0,
      unlikely: 0,
      no: 0,
      unknown: 0,
    };
    for (const row of rows) {
      const bucket = row.eligibility === "eligible"
        ? "yes"
        : row.eligibility === "excluded"
          ? "no"
          : row.eligibility === "uncertain"
            ? "unknown"
            : row.eligibility;
      counts[bucket] = (counts[bucket] ?? 0) + 1;
    }
    facets.set(criterion.id, {
      key: criterion.id,
      label: criterion.label,
      type: "temporal",
      counts,
    });
  }
  return [...facets.values()];
}

/** FACETS.md §1. Order is render order: booleans by yes-count, then the
 * enum, then the numerics — the composer takes its suggestion pills off the
 * top and a "walking time" pill first would be useless. */
export function computeFacets(
  candidates: CandidateRow[],
  scope: ScopeState | null,
  viewerOrigin?: { lat: number; lng: number },
): Facet[] {
  const booleans: Facet[] = [];
  for (const key of ATTRIBUTE_VOCABULARY) {
    if (NON_BOOLEAN_KEYS.has(key)) continue;
    const present = candidates.some((c) =>
      c.attributes?.some((a) => a.key === key),
    );
    if (!present) continue;
    let yes = 0;
    let likely = 0;
    let unlikely = 0;
    let no = 0;
    let unknown = 0;
    for (const c of candidates) {
      const status = c.attributes?.find((a) => a.key === key)?.status;
      if (status === "verified_true") yes += 1;
      else if (status === "likely_true") likely += 1;
      else if (status === "likely_false") unlikely += 1;
      else if (status === "verified_false") no += 1;
      else unknown += 1; // unknown, or no claim at all
    }
    booleans.push({
      key,
      label: labelForKey(key),
      type: "boolean",
      counts: { yes, ...(likely ? { likely } : {}), ...(unlikely ? { unlikely } : {}), no, unknown },
    });
  }
  booleans.sort(
    (a, b) => (b.counts.yes ?? 0) + (b.counts.likely ?? 0) - (a.counts.yes ?? 0) - (a.counts.likely ?? 0),
  );

  const facets = [...booleans];
  const cuisine = cuisineFacet(candidates);
  if (cuisine) facets.push(cuisine);
  const walk = walkFacet(candidates, viewerOrigin ?? scope?.area?.center);
  if (walk) facets.push(walk);
  const price = priceFacet(candidates);
  if (price) facets.push(price);
  return facets;
}

/** Every observed token and sourced implication remains available for routing.
 * Its count is narrower: the number that the same inclusion would classify as
 * eligible, so selecting a value cannot make the displayed count collapse. */
function cuisineFacet(candidates: CandidateRow[]): Facet | null {
  const available = new Set<string>();
  const counts = new Map<string, number>();
  let yes = 0;
  let likely = 0;
  let unlikely = 0;
  let no = 0;
  let unknown = 0;
  for (const c of candidates) {
    const attr = c.attributes?.find((a) => a.key === "cuisine");
    const positive = attr?.status === "verified_true" || attr?.status === "likely_true";
    const tokens = positive && typeof attr.value === "string" ? normalizeCuisineTokens(attr.value) : [];
    if (tokens.length === 0) {
      if (attr?.status === "likely_false") unlikely += 1;
      else if (attr?.status === "verified_false") no += 1;
      else unknown += 1;
      continue;
    }
    const exact = new Set(tokens);
    const implications = tokens.flatMap((token) => implies(token));
    for (const value of exact) available.add(value);
    for (const implication of implications) available.add(implication.cuisine);
    if (attr?.status === "verified_true") {
      const satisfying = new Set(exact);
      for (const implication of implications) {
        if (implication.confidence >= CUISINE_IMPLICATION_SATISFACTION_FLOOR) {
          satisfying.add(implication.cuisine);
        }
      }
      for (const value of satisfying) counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    // Buckets stay disjoint: one place lands in exactly one of them, so a
    // reader can add them up. All available values still widen `values`, which
    // is what routing a sentence like "Italian" reads; their individual count
    // is the stricter eligible count above.
    if (attr?.status === "verified_true") {
      yes += 1;
    } else if (attr?.status === "likely_true") {
      likely += 1;
    } else if (attr?.status === "likely_false") unlikely += 1;
    else if (attr?.status === "verified_false") no += 1;
    else unknown += 1;
  }
  if (available.size === 0) return null;
  const values: FacetValueCount[] = [...available]
    .map((value) => ({ value, label: humanize(value), count: counts.get(value) ?? 0 }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  return {
    key: "cuisine",
    label: labelForKey("cuisine"),
    type: "enum",
    values,
    counts: {
      yes,
      ...(likely ? { likely } : {}),
      ...(unlikely ? { unlikely } : {}),
      no,
      unknown,
    },
  };
}

/** Walking time from this viewer's origin, falling back to the shared scope
 * centre. Without either, the facet is absent rather than wrong. */
function walkFacet(
  candidates: CandidateRow[],
  center: { lat: number; lng: number } | undefined,
): Facet | null {
  if (!center || candidates.length === 0) return null;
  const minutes = candidates.map((c) =>
    Math.max(
      1,
      Math.round(haversineMeters(c.location, center) / WALK_SPEED_M_PER_MIN),
    ),
  );
  return {
    key: "walk-minutes",
    label: "walking time",
    type: "numeric",
    unit: "min",
    range: { min: Math.min(...minutes), max: Math.max(...minutes) },
    histogram: histogram(minutes),
    counts: { unknown: 0 },
  };
}

/** Price as the per-person EUR band the budget predicate compares against,
 * so the number the UI shows is the number a budget need is measured in. */
function priceFacet(candidates: CandidateRow[]): Facet | null {
  const bands: number[] = [];
  let unknown = 0;
  for (const c of candidates) {
    const band = PRICE_LEVEL_EUR[c.price_level as keyof typeof PRICE_LEVEL_EUR];
    if (band === undefined) unknown += 1;
    else bands.push(band);
  }
  if (bands.length === 0) return null;
  return {
    key: "price-level",
    label: labelForKey("price-level"),
    type: "numeric",
    unit: "EUR",
    range: { min: Math.min(...bands), max: Math.max(...bands) },
    histogram: histogram(bands),
    counts: { unknown },
  };
}

function histogram(values: number[]): number[] {
  const buckets = new Array(HISTOGRAM_BUCKETS).fill(0) as number[];
  const min = Math.min(...values);
  const max = Math.max(...values);
  for (const v of values) {
    const index =
      max === min
        ? 0
        : Math.min(
            HISTOGRAM_BUCKETS - 1,
            Math.floor(((v - min) / (max - min)) * HISTOGRAM_BUCKETS),
          );
    buckets[index] += 1;
  }
  return buckets;
}

function labelForKey(key: string): string {
  return (
    ATTRIBUTE_LABELS[key as keyof typeof ATTRIBUTE_LABELS] ??
    key.replace(/-/g, " ")
  );
}

/** Provider tokens are snake_case ("steak_house"); the UI shows this string
 * verbatim, so the humanizing happens here and nowhere else. */
function humanize(value: string): string {
  const words = value.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The row label for a need the viewer is allowed to see. Composed server-side
 * from the payload so the client never authors a domain word of its own.
 */
export function labelForRequirement(
  req: RequirementRow,
  ownedByViewer: boolean,
  context?: { timezone: string; now: Date },
): string {
  const p = req.payload;
  if (!p) {
    // agent-private: the server holds no content, by construction.
    return ownedByViewer ? "your agent's condition" : "a private need";
  }
  switch (p.kind) {
    case "attribute": {
      const label = labelForKey(String(p.key));
      return p.expect === "verified_false" ? `no ${label}` : label;
    }
    case "scope":
      return `${p.dimension === "walk_min"
        ? `within ${p.max} min walk`
        : `within ${p.max} m`} of ${scopeReferentLabel(req, ownedByViewer)}`;
    case "budget": {
      const b = p.perPersonMax;
      if (!b) return "a budget";
      return b.currency === "EUR"
        ? `budget €${b.amount}`
        : `budget ${b.amount} ${b.currency}`;
    }
    case "time": {
      const start = p.window?.start;
      const end = p.window?.end;
      if (typeof start === "string" && typeof end === "string") {
        if (context) return windowLabel({ start, end }, context.timezone, context.now);
        return p.phrase?.trim() || `open ${windowSpanText({ start, end })}`;
      }
      return p.phrase?.trim() || "open at the requested time";
    }
    case "exclusion":
      return `avoid ${(p.values ?? []).join(", ")}`;
    case "inclusion":
      return `only ${(p.values ?? []).join(", ")}`;
    case "text":
      return String(p.text ?? "").slice(0, 200);
    default:
      return "a need";
  }
}

function scopeReferentLabel(req: RequirementRow, ownedByViewer: boolean): string {
  const referent = req.payload?.kind === "scope" ? req.payload.referent : undefined;
  if (!referent || referent.kind === "self") {
    return ownedByViewer ? "where you start" : "where they start";
  }
  if (req.referent_label) return req.referent_label;
  if (referent.kind === "scopeCenter") return "the room centre";
  if (referent.kind === "point") return referent.label?.trim() || "this point";
  if (referent.kind === "participant") return "where someone starts from";
  if (referent.kind === "candidate") return "a place no longer in the room";
  return "an unknown landmark";
}
