import type pg from "pg";
import type { Feasibility } from "@webmcp-hackathon/contracts";
import { ATTRIBUTE_LABELS, PRICE_LEVEL_EUR, leans, isVerified, normalizeStatus } from "@webmcp-hackathon/contracts";
import { applyAttestations, loadAttestations } from "./attestations.ts";
import { applyEnrichmentAttributes, loadCached } from "./enrich/index.ts";
import { applyInferredAttributes } from "./enrich/infer.ts";
import { applyGuesses } from "./guess.ts";

/** Reason texts are reader-facing (CLAUDE.md §6): the label, never the key. */
const labelOf = (key: string | undefined): string =>
  (key && (ATTRIBUTE_LABELS as Record<string, string>)[key]) || (key ?? "this").replace(/-/g, " ");

/**
 * Deterministic eligibility per SPATIAL-PROTOCOL.md §8:
 * - the session scope is an implicit hard constraint: candidates outside the
 *   scope circle are excluded ("outside the current search area");
 * - hard shared/application-private requirements evaluate against dossier
 *   attributes; only verified evidence contradicting the expectation
 *   hard-excludes; unknown yields uncertain (attribute honesty); a likely
 *   fact (§8.2) yields "likely" or "unlikely" with the product of the
 *   confidences it rests on — counted and drawn apart, never folded in;
 * - budget compares perPersonMax against the PRICE_LEVEL_EUR band for the
 *   candidate's price level;
 * - cuisine exclusions match the candidate's cuisine attribute value
 *   (tokenized on ';' — OSM multi-values like "pizza;italian"), falling back
 *   to its category; cuisine inclusions require a verified cuisine token
 *   among the wanted values, and a place with no cuisine on record is
 *   uncertain, never excluded;
 * - agent-private declarations consult recorded screening verdicts:
 *   unacceptable -> excluded, missing/needs_info -> uncertain;
 * - free-text needs are unverifiable by construction: every candidate is
 *   pending against one, and none is excluded;
 * - inactive requirements (set aside by their owner) are skipped entirely;
 * - soft requirements never exclude.
 *
 * The core is pure (classifyAll) so the impasse pipeline can re-run it against
 * hypothetical scopes and requirement subsets.
 *
 * Why-strings are PER VIEWER (whyFor): classification collects structured
 * reasons carrying owner and visibility, and the projection collapses every
 * contribution the viewer does not own from a non-shared requirement into one
 * fixed token that varies neither with the count nor the identity of the
 * private constraints involved (audit: private-requirement fingerprinting).
 */

export type Eligibility = "eligible" | "likely" | "uncertain" | "unlikely" | "excluded";

export interface CandidateRow {
  id: string;
  map_revision: number;
  osm_ref?: string | null;
  name: string;
  category: string;
  price_level: number | null;
  walk_min: number;
  location: { lat: number; lng: number };
  attributes: Array<{
    key: string;
    status: string;
    value?: string | number;
    source?: string;
    confidence?: number;
    attestedBy?: string;
  }>;
  extras?: { website?: string; wikidata?: string } | null;
}
export interface RequirementRow {
  id: string;
  owner_id: string;
  visibility: string;
  hardness: string;
  payload: {
    kind: string;
    key?: string;
    expect?: string;
    dimension?: string;
    max?: number;
    values?: string[];
    text?: string;
    perPersonMax?: { amount: number; currency: string };
  } | null;
  withdrawn: boolean;
  /** Set aside by its owner: kept, shown, but not evaluated. Absent rows
   * (older callers, unit fixtures) are active. */
  active?: boolean;
  created_at_revision?: number;
  scope_hint?: { affects?: string; category?: string } | null;
}
export interface VerdictRow {
  owner_id: string;
  candidate_id: string;
  verdict: string;
  screened_map_revision: number;
}
export interface ScopeState {
  scopeId: string;
  area: { kind: "circle"; center: { lat: number; lng: number }; radiusM: number };
  transport: string[];
  category: string;
}

/** One structured contribution to a candidate's classification. `text` is the
 * description its OWNER may see; shared reasons are safe for everyone. */
export interface EligibilityReason {
  /** The requirement this contribution came from; "" for the implicit scope
   * circle, which nobody stated as a need. */
  requirementId: string;
  ownerId: string;
  shared: boolean;
  text: string;
}

export interface CandidateEligibility {
  candidateId: string;
  /** Stable area-snapshot ref, when the candidate has one. */
  ref?: string;
  name: string;
  category: string;
  location: { lat: number; lng: number };
  eligibility: Eligibility;
  /** Present when excluded: the winning (first) exclusion reason. */
  exclusion?: EligibilityReason;
  /** Present when uncertain: every pending-evidence contribution. */
  uncertainReasons?: EligibilityReason[];
  /** Present when likely / unlikely: the guesses it rests on (§8.2). */
  likelyReasons?: EligibilityReason[];
  /** Present when likely / unlikely: product of the confidences of those guesses. */
  confidence?: number;
  walkMin: number;
  priceLevel: number | null;
}

const PRIVATE_EXCLUDED = "ruled out by a private condition";
const PRIVATE_PENDING = "a private condition not yet checked";

/**
 * The viewer-safe why-string. Shared reasons pass through; every contribution
 * from a non-shared requirement the viewer does not own collapses into one
 * fixed token, independent of how many private constraints touch the
 * candidate or whose they are.
 */
export function whyFor(row: CandidateEligibility, viewerId: string): string | undefined {
  if (row.eligibility === "excluded") {
    const r = row.exclusion!;
    if (r.shared || r.ownerId === viewerId) return r.text.slice(0, 60);
    return PRIVATE_EXCLUDED;
  }
  if (row.eligibility === "uncertain") {
    const visible = (row.uncertainReasons ?? [])
      .filter((r) => r.shared || r.ownerId === viewerId)
      .map((r) => r.text);
    const hasHiddenPrivate = (row.uncertainReasons ?? []).some(
      (r) => !r.shared && r.ownerId !== viewerId,
    );
    const parts = [...new Set(visible)];
    if (hasHiddenPrivate) parts.push(PRIVATE_PENDING);
    return parts.join("; ").slice(0, 60);
  }
  if (row.eligibility === "likely" || row.eligibility === "unlikely") {
    const visible = (row.likelyReasons ?? [])
      .filter((r) => r.shared || r.ownerId === viewerId)
      .map((r) => r.text);
    const hasHiddenPrivate = (row.likelyReasons ?? []).some(
      (r) => !r.shared && r.ownerId !== viewerId,
    );
    const parts = [...new Set(visible)];
    if (hasHiddenPrivate) parts.push(PRIVATE_PENDING);
    return parts.join("; ").slice(0, 60);
  }
  return undefined;
}

export function haversineMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export async function loadScope(
  q: pg.PoolClient | pg.Pool,
  roomId: string,
): Promise<ScopeState | null> {
  const row = (
    await q.query("SELECT scope FROM rooms WHERE id = $1", [roomId])
  ).rows[0];
  return (row?.scope as ScopeState) ?? null;
}

const WALK_SPEED_M_PER_MIN = 4500 / 60;

/** Minutes on foot from the scope centre. Recomputed on every read: the
 * seeded walk_min is measured from wherever the room started and goes stale
 * the moment the scope moves. */
export function walkMinutesFrom(
  center: { lat: number; lng: number } | undefined,
  location: { lat: number; lng: number },
  fallback: number,
): number {
  if (!center) return fallback;
  return Math.max(1, Math.round(haversineMeters(location, center) / WALK_SPEED_M_PER_MIN));
}

export interface EligibilityInputs {
  candidates: CandidateRow[];
  requirements: RequirementRow[];
  verdicts: VerdictRow[];
  scope: ScopeState | null;
}

/**
 * The four reads classification needs, in one round trip. Split out of
 * computeEligibility so counterfactual passes (facets, activeNeeds, impasse)
 * run in memory over one snapshot instead of re-querying per hypothesis.
 */
export async function loadEligibilityInputs(
  q: pg.PoolClient | pg.Pool,
  roomId: string,
): Promise<EligibilityInputs> {
  const [candidates, requirements, verdicts, scope, attestations] = await Promise.all([
    q.query("SELECT * FROM candidates WHERE room_id = $1 ORDER BY id", [roomId]),
    q.query(
      "SELECT * FROM requirements WHERE room_id = $1 AND NOT withdrawn",
      [roomId],
    ),
    q.query("SELECT * FROM verdicts WHERE room_id = $1", [roomId]),
    loadScope(q, roomId),
    loadAttestations(q, roomId),
  ]);
  const center = scope?.area?.center;
  const refs = (candidates.rows as CandidateRow[]).map((c) => c.osm_ref).filter((r): r is string => Boolean(r));
  const enrichments = await loadCached(q, refs);
  return {
    // Merged here, at read time, so every classifier pass (facets, impasse,
    // previews) sees the same dossier the ledger shows.
    candidates: (candidates.rows as CandidateRow[]).map((c) => ({
      ...c,
      attributes: mergedAttributes(c, enrichments.get(c.osm_ref ?? ""), attestations),
      walk_min: walkMinutesFrom(center, c.location, c.walk_min),
    })),
    requirements: requirements.rows as RequirementRow[],
    verdicts: verdicts.rows as VerdictRow[],
    scope,
  };
}

/**
 * One place's attributes as the room reads them, in precedence order
 * (SPATIAL-PROTOCOL.md §8.1–8.2): the record, normalised to the graded
 * vocabulary; looked-up facts (cached only — the classifier never waits on
 * the network) into slots the record left open; guesses from the kind of
 * place into slots still unknown; attestations last, so a person's word can
 * dispute any of the above.
 */
export function mergedAttributes(
  c: Pick<CandidateRow, "id" | "category" | "attributes">,
  enrichment: Parameters<typeof applyEnrichmentAttributes>[1],
  attestations: Parameters<typeof applyAttestations>[2],
): CandidateRow["attributes"] {
  const observedAt = new Date().toISOString();
  const normalised = (c.attributes ?? []).map((a) => normalizeStatus(a));
  return applyAttestations(
    c.id,
    // Record → looked-up facts → inference over what the place publishes →
    // the kind-of-place rules. Evidence with a quoted span outranks a rule
    // about cafés in general; both stay likely, never verified.
    applyGuesses(
      c.category,
      applyInferredAttributes(applyEnrichmentAttributes(normalised, enrichment), enrichment?.inferred),
      observedAt,
    ),
    attestations,
  );
}

export async function computeEligibility(
  q: pg.PoolClient | pg.Pool,
  roomId: string,
): Promise<CandidateEligibility[]> {
  const { candidates, requirements, verdicts, scope } =
    await loadEligibilityInputs(q, roomId);
  return classifyAll(candidates, requirements, verdicts, scope);
}

export function classifyAll(
  candidates: CandidateRow[],
  requirements: RequirementRow[],
  verdicts: VerdictRow[],
  scope: ScopeState | null,
): CandidateEligibility[] {
  return candidates.map((c) => classify(c, requirements, verdicts, scope));
}

function classify(
  candidate: CandidateRow,
  requirements: RequirementRow[],
  verdicts: VerdictRow[],
  scope: ScopeState | null,
): CandidateEligibility {
  const pending: EligibilityReason[] = [];
  // Guesses this place rests on (§8.2): each with its lean and confidence.
  const likely: Array<EligibilityReason & { lean: boolean; confidence: number }> = [];

  // Implicit hard constraint: the shared search scope.
  if (scope?.area?.kind === "circle") {
    const distance = haversineMeters(candidate.location, scope.area.center);
    if (distance > scope.area.radiusM) {
      return excluded(candidate, {
        requirementId: "",
        ownerId: "",
        shared: true,
        text: "outside the current search area",
      });
    }
  }

  for (const req of requirements) {
    // Set aside by its owner: still in the brief, but it classifies nothing.
    if (req.active === false) continue;
    if (req.hardness !== "hard") continue;
    const owner = {
      requirementId: req.id,
      ownerId: req.owner_id,
      shared: req.visibility === "shared",
    };

    if (req.visibility === "agent-private") {
      const verdict = verdicts.find(
        (v) =>
          v.owner_id === req.owner_id &&
          v.candidate_id === candidate.id &&
          // R3: a fact revision makes every earlier private verdict stale,
          // regardless of which path produced the changed facts.
          // X12: runtime data can still come from untyped counterfactual
          // callers. Missing revisions are never equal-by-accident.
          Number.isSafeInteger(v.screened_map_revision) &&
          Number.isSafeInteger(candidate.map_revision) &&
          v.screened_map_revision === candidate.map_revision,
      );
      if (!verdict || verdict.verdict === "needs_info") {
        pending.push({ ...owner, shared: false, text: "your private screening is pending" });
      } else if (verdict.verdict === "unacceptable") {
        return excluded(candidate, {
          ...owner,
          shared: false,
          text: "your screening verdict: unacceptable",
        });
      }
      continue;
    }

    // Every accepted hard requirement kind is evaluated; nothing the command
    // schema admits may silently pass. Where the dossier carries no evidence
    // for a dimension, the answer is uncertain — never eligible (attribute
    // honesty: unknown != verified). Reason texts are owner-visible; whyFor
    // decides what peers see.
    const p = req.payload;
    switch (p?.kind) {
      case "attribute": {
        const attr = candidate.attributes.find((a) => a.key === p.key);
        const status = attr?.status ?? "unknown";
        const expect = p.expect ?? "verified_true";
        const wanted = expect === "verified_true";
        const lean = leans(status);
        if (lean === null) {
          pending.push({ ...owner, text: `${labelOf(p.key)} not on record` });
        } else if (isVerified(status)) {
          if (lean !== wanted) {
            // A verified status contradicting the expectation hard-excludes.
            return excluded(candidate, {
              ...owner,
              text: wanted ? `no ${labelOf(p.key)} on record` : `${labelOf(p.key)} on record`,
            });
          }
        } else {
          // A likely fact: the place leans one way, at the fact's confidence.
          likely.push({
            ...owner,
            lean: lean === wanted,
            confidence: attr?.confidence ?? 0.5,
            text: lean === wanted ? `${labelOf(p.key)} likely` : `${labelOf(p.key)} unlikely`,
          });
        }
        break;
      }
      case "scope": {
        if (p.dimension === "walk_min" && typeof p.max === "number") {
          if (candidate.walk_min > p.max) {
            return excluded(candidate, {
              ...owner,
              text: `beyond ${p.max} min walk`,
            });
          }
        } else if (p.dimension === "radius_m" && typeof p.max === "number") {
          if (!scope?.area?.center) {
            pending.push({ ...owner, text: "distance not on record" });
          } else if (
            haversineMeters(candidate.location, scope.area.center) > p.max
          ) {
            return excluded(candidate, { ...owner, text: `beyond ${p.max} m` });
          }
        } else {
          pending.push({ ...owner, text: "distance not on record" });
        }
        break;
      }
      case "budget": {
        // Price levels are provider-normalized bands; the published
        // PRICE_LEVEL_EUR mapping makes them comparable to a per-person cap.
        const band =
          PRICE_LEVEL_EUR[candidate.price_level as keyof typeof PRICE_LEVEL_EUR];
        const max = p.perPersonMax?.amount;
        if (band === undefined || typeof max !== "number") {
          pending.push({ ...owner, text: "price not on record" });
        } else if (band > max) {
          return excluded(candidate, {
            ...owner,
            text: "estimated cost above the shared budget",
          });
        }
        break;
      }
      case "text": {
        // Nothing has been checked against free text, so nothing may pass on
        // it and nothing may be ruled out by it.
        pending.push({ ...owner, text: `"${p.text}" unverified` });
        break;
      }
      case "inclusion": {
        if (p.key === "cuisine") {
          const attr = candidate.attributes.find((a) => a.key === "cuisine");
          const known = attr?.status === "verified_true" || attr?.status === "likely_true";
          const tokens =
            known && typeof attr?.value === "string"
              ? attr.value.split(";").map((t) => t.trim()).filter(Boolean)
              : [];
          if (tokens.length === 0) {
            pending.push({ ...owner, text: "cuisine not on record" });
          } else if (!tokens.some((t) => p.values?.includes(t))) {
            if (attr?.status === "likely_true") {
              likely.push({ ...owner, lean: false, confidence: attr.confidence ?? 0.5, text: `probably not ${(p.values ?? []).join(" or ")}` });
            } else {
              return excluded(candidate, { ...owner, text: `not ${(p.values ?? []).join(" or ")}` });
            }
          } else if (attr?.status === "likely_true") {
            likely.push({ ...owner, lean: true, confidence: attr.confidence ?? 0.5, text: `probably ${(p.values ?? []).join(" or ")}` });
          }
        } else {
          pending.push({ ...owner, text: "cuisine not on record" });
        }
        break;
      }
      case "exclusion": {
        if (p.key === "cuisine") {
          const attr = candidate.attributes.find((a) => a.key === "cuisine");
          // OSM cuisine tags are multi-valued ("pizza;italian"): match per
          // token, never against the raw joined string.
          const tokens =
            typeof attr?.value === "string"
              ? attr.value.split(";").map((t) => t.trim()).filter(Boolean)
              : [candidate.category];
          const hit = tokens.find((t) => p.values?.includes(t));
          if (hit) {
            if (attr?.status === "likely_true") {
              likely.push({ ...owner, lean: false, confidence: attr.confidence ?? 0.5, text: `probably ${hit}` });
            } else {
              return excluded(candidate, { ...owner, text: `excluded ${hit}` });
            }
          }
        } else {
          pending.push({ ...owner, text: "cuisine not on record" });
        }
        break;
      }
      default:
        // A hard requirement whose payload we cannot evaluate must not pass.
        pending.push({ ...owner, text: "unevaluated requirement" });
    }
  }

  // Precedence: excluded > unlikely > uncertain > likely > eligible. A guess
  // against the place is more informative than a gap; a gap is more honest
  // than a guess for it.
  const against = likely.filter((l) => !l.lean);
  if (against.length > 0) {
    return {
      ...base(candidate),
      eligibility: "unlikely",
      likelyReasons: against.map(strip),
      confidence: product(against),
    };
  }
  if (pending.length > 0) {
    return {
      ...base(candidate),
      eligibility: "uncertain",
      uncertainReasons: pending,
    };
  }
  if (likely.length > 0) {
    return {
      ...base(candidate),
      eligibility: "likely",
      likelyReasons: likely.map(strip),
      confidence: product(likely),
    };
  }
  return { ...base(candidate), eligibility: "eligible" };
}

const strip = (l: EligibilityReason & { lean: boolean; confidence: number }): EligibilityReason => ({
  requirementId: l.requirementId,
  ownerId: l.ownerId,
  shared: l.shared,
  text: l.text,
});
/** Independent guesses compound: the confidence that ALL of them hold. */
const product = (ls: Array<{ confidence: number }>) =>
  Math.round(ls.reduce((acc, l) => acc * Math.min(1, Math.max(0, l.confidence)), 1) * 100) / 100;

function excluded(
  c: CandidateRow,
  reason: EligibilityReason,
): CandidateEligibility {
  return { ...base(c), eligibility: "excluded", exclusion: reason };
}

function base(c: CandidateRow) {
  return {
    candidateId: c.id,
    ...(c.osm_ref ? { ref: c.osm_ref } : {}),
    name: c.name,
    category: c.category,
    location: c.location,
    walkMin: c.walk_min,
    priceLevel: c.price_level,
  };
}

export function feasibilityOf(rows: CandidateEligibility[]): Feasibility {
  const count = (e: Eligibility) => rows.filter((r) => r.eligibility === e).length;
  const eligible = count("eligible");
  const likely = count("likely");
  const uncertain = count("uncertain");
  const unlikely = count("unlikely");
  const excluded = count("excluded");
  // A guess never makes a room feasible; it keeps it from reading infeasible.
  const state =
    eligible >= 3
      ? "feasible"
      : eligible >= 1
        ? "fragile"
        : uncertain + likely + unlikely > 0
          ? "uncertain"
          : "infeasible";
  return { state, eligible, likely, uncertain, unlikely, excluded };
}
