import type pg from "pg";
import type { Feasibility } from "@webmcp-hackathon/contracts";
import {
  ATTRIBUTE_LABELS,
  CUISINE_IMPLICATION_SATISFACTION_FLOOR,
  PRICE_LEVEL_EUR,
  DISH_TOKENS,
  areaById,
  coversWindow,
  criterionFor,
  implies,
  isVerified,
  leans,
  normalizeCuisineTokens,
  normalizeStatus,
  parseOpeningHours,
  questionKey,
  windowSpan,
  type DossierHours,
} from "@webmcp-hackathon/contracts";
import {
  applyAttestations,
  confirmedForCandidate,
  loadAttestations,
  loadConfirmedFacts,
  type ConfirmedFactRow,
} from "./attestations.ts";
import { applyEnrichmentAttributes, loadCached, type Enrichment } from "./enrich/index.ts";
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
 * - cuisine predicates normalize OSM multi-values and use the sourced
 *   implication taxonomy. An implication at or above the verified evidence
 *   floor may satisfy an inclusion; below that it remains a guess.
 *   Implications may add a place but never rule one out; missing cuisine
 *   evidence stays uncertain;
 * - agent-private declarations consult recorded screening verdicts:
 *   unacceptable -> excluded, missing/needs_info -> uncertain;
 * - free-text needs read the stable question criterion in the dossier;
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
    label?: string;
    status: string;
    value?: string | number;
    source?: string;
    confidence?: number;
    attestedBy?: string;
    confirmedByName?: string;
    confirmedByParticipant?: string;
    confirmedAt?: string;
    note?: string;
    sourceUrl?: string;
    explicit?: boolean;
  }>;
  /** Parsed OSM hours stored with the candidate record. */
  hours?: DossierHours[];
  /** Cached structured hours published by the place's own site. */
  website_hours?: string[];
  extras?: { website?: string; wikidata?: string; address?: string } | null;
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
    window?: { start?: string; end?: string };
    phrase?: string;
    perPersonMax?: { amount: number; currency: string };
  } | null;
  withdrawn: boolean;
  /** Set aside by its owner: kept, shown, but not evaluated. Absent rows
   * (older callers, unit fixtures) are active. */
  active?: boolean;
  created_at_revision?: number;
  scope_hint?: { affects?: string; category?: string } | null;
  /** Server-only owner position joined at read time. Never projected. */
  owner_origin?: { lat: number; lng: number } | null;
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
  /** Safe explanation for a different viewer when the shared predicate's
   * owner position must not be recoverable from the reason. */
  peerText?: string;
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
  /** Reader-facing positive evidence used by eligible rows. */
  satisfiedReasons?: EligibilityReason[];
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
    if (r.ownerId === viewerId || r.ownerId === "") return r.text.slice(0, 60);
    if (r.shared) return (r.peerText ?? r.text).slice(0, 60);
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
  // A clear place says what actually cleared it when the room knows —
  // "serves Italian" earns its bytes. The old generic filler did not, and
  // an omitted `why` reads the same way with none of the payload.
  const satisfied = (row.satisfiedReasons ?? [])
    .filter((r) => r.shared || r.ownerId === viewerId)
    .map((r) => r.text);
  if (satisfied.length === 0) return undefined;
  return [...new Set(satisfied)].join("; ").slice(0, 60);
}

/**
 * A cuisine token as a reader sees it. A dish is a common noun and stays
 * lowercase ("serves pizza"); a token that names a people or a place keeps
 * its capital ("Italian", "Middle Eastern") — sentence case, CLAUDE.md 12.
 */
function humanizeCuisine(value: string): string {
  const words = value.replace(/[_-]+/g, " ").trim();
  if (DISH_TOKENS.has(value)) return words;
  return words.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

interface CuisineHit {
  token: string;
  wanted: string;
  confidence: number;
  exact: boolean;
}

function cuisineHit(tokens: string[], values: string[] | undefined): CuisineHit | null {
  const wanted = normalizeCuisineTokens(values ?? []);
  for (const token of tokens) {
    if (wanted.includes(token)) return { token, wanted: token, confidence: 1, exact: true };
  }
  let best: CuisineHit | null = null;
  for (const token of tokens) {
    for (const implication of implies(token)) {
      if (!wanted.includes(implication.cuisine)) continue;
      if (!best || implication.confidence > best.confidence) {
        best = { token, wanted: implication.cuisine, confidence: implication.confidence, exact: false };
      }
    }
  }
  return best;
}

function cuisineEvidence(hit: CuisineHit, likely = false): string {
  const wanted = humanizeCuisine(hit.wanted);
  return hit.exact
    ? `serves ${wanted}`
    : `serves ${humanizeCuisine(hit.token)}, which is ${likely ? "likely" : "usually"} ${wanted}`;
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

/** Minutes on foot from a supplied origin. Recomputed on every read: the
 * seeded walk_min is only a last-resort compatibility fallback. */
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
  /** IANA timezone from the room's AreaDefinition. */
  timezone?: string;
  /** One read-time clock shared by labels and dossier projections. */
  now?: Date;
  /** Server-only cache rows used by background scheduling guards. */
  enrichments?: Map<string, Enrichment>;
  /** Server-only origins, keyed by owner. Values never enter peer projections. */
  origins?: Map<string, { lat: number; lng: number }>;
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
  const [candidates, requirements, verdicts, scope, attestations, room, participantOrigins] = await Promise.all([
    q.query("SELECT * FROM candidates WHERE room_id = $1 ORDER BY id", [roomId]),
    q.query(
      "SELECT * FROM requirements WHERE room_id = $1 AND NOT withdrawn",
      [roomId],
    ),
    q.query("SELECT * FROM verdicts WHERE room_id = $1", [roomId]),
    loadScope(q, roomId),
    loadAttestations(q, roomId),
    q.query("SELECT area_id FROM rooms WHERE id = $1", [roomId]),
    q.query("SELECT id, origin FROM participants WHERE room_id = $1", [roomId]),
  ]);
  const center = scope?.area?.center;
  const origins = new Map<string, { lat: number; lng: number }>();
  for (const row of participantOrigins.rows as Array<{
    id: string;
    origin: { lat?: unknown; lng?: unknown } | null;
  }>) {
    if (
      typeof row.origin?.lat === "number" && Number.isFinite(row.origin.lat) &&
      typeof row.origin?.lng === "number" && Number.isFinite(row.origin.lng)
    ) {
      origins.set(row.id, { lat: row.origin.lat, lng: row.origin.lng });
    }
  }
  const refs = (candidates.rows as CandidateRow[]).map((c) => c.osm_ref).filter((r): r is string => Boolean(r));
  const [enrichments, confirmedFacts] = await Promise.all([
    loadCached(q, refs),
    loadConfirmedFacts(q, refs),
  ]);
  return {
    // Merged here, at read time, so every classifier pass (facets, impasse,
    // previews) sees the same dossier the ledger shows.
    candidates: (candidates.rows as CandidateRow[]).map((c) => ({
      ...c,
      attributes: mergedAttributes(
        c,
        enrichments.get(c.osm_ref ?? ""),
        attestations,
        confirmedFacts,
      ),
      website_hours: enrichments.get(c.osm_ref ?? "")?.website?.hours,
      walk_min: walkMinutesFrom(center, c.location, c.walk_min),
    })),
    requirements: (requirements.rows as RequirementRow[]).map((requirement) => ({
      ...requirement,
      owner_origin: origins.get(requirement.owner_id) ?? null,
    })),
    verdicts: verdicts.rows as VerdictRow[],
    scope,
    timezone: areaById(room.rows[0]?.area_id as string)?.timezone ?? "UTC",
    now: new Date(),
    enrichments,
    origins,
  };
}

/**
 * One place's attributes as the room reads them, in precedence order
 * (SPATIAL-PROTOCOL.md §8.1–8.2): the record, normalised to the graded
 * vocabulary; looked-up facts (cached only — the classifier never waits on
 * the network) into slots the record left open; guesses from the kind of
 * place into slots still unknown; room attestations next; confirmed facts
 * last, so permanent person evidence outranks every server-derived fact while
 * retaining the record-dispute rule.
 */
export function mergedAttributes(
  c: Pick<CandidateRow, "id" | "category" | "attributes" | "osm_ref">,
  enrichment: Parameters<typeof applyEnrichmentAttributes>[1],
  attestations: Parameters<typeof applyAttestations>[2],
  confirmedFacts: ConfirmedFactRow[] = [],
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
      applyInferredAttributes(
        applyEnrichmentAttributes(normalised, enrichment),
        enrichment?.inferred as Parameters<typeof applyInferredAttributes>[1],
      ),
      observedAt,
    ),
    [
      ...attestations,
      ...confirmedForCandidate(c.osm_ref, c.id, confirmedFacts),
    ],
  );
}

export async function computeEligibility(
  q: pg.PoolClient | pg.Pool,
  roomId: string,
): Promise<CandidateEligibility[]> {
  const inputs = await loadEligibilityInputs(q, roomId);
  return classifyAll(
    inputs.candidates,
    inputs.requirements,
    inputs.verdicts,
    inputs.scope,
    inputs.timezone,
  );
}

export function classifyAll(
  candidates: CandidateRow[],
  requirements: RequirementRow[],
  verdicts: VerdictRow[],
  scope: ScopeState | null,
  timezone = "UTC",
): CandidateEligibility[] {
  return candidates.map((c) => classifyCandidate(c, requirements, verdicts, scope, timezone));
}

export function classifyCandidate(
  candidate: CandidateRow,
  requirements: RequirementRow[],
  verdicts: VerdictRow[],
  scope: ScopeState | null,
  timezone: string,
): CandidateEligibility {
  const pending: EligibilityReason[] = [];
  const satisfied: EligibilityReason[] = [];
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
          } else if (attr?.source === "person:confirmed") {
            satisfied.push({
              ...owner,
              text: `${attr.confirmedByName ?? "Someone"} confirmed it`,
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
        const origin = req.owner_origin ?? scope?.area?.center;
        if (p.dimension === "walk_min" && typeof p.max === "number") {
          if (!origin) {
            pending.push({ ...owner, text: "distance not on record" });
          } else {
            const minutes = walkMinutesFrom(origin, candidate.location, candidate.walk_min);
            if (minutes > p.max) {
              return excluded(candidate, {
                ...owner,
                text: `${minutes} min from you`,
                peerText: "too far for one person",
              });
            }
          }
        } else if (p.dimension === "radius_m" && typeof p.max === "number") {
          if (!origin) {
            pending.push({ ...owner, text: "distance not on record" });
          } else if (
            haversineMeters(candidate.location, origin) > p.max
          ) {
            return excluded(candidate, {
              ...owner,
              text: `${Math.round(haversineMeters(candidate.location, origin))} m from you`,
              peerText: "too far for one person",
            });
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
      case "time": {
        const start = p.window?.start;
        const end = p.window?.end;
        if (typeof start !== "string" || typeof end !== "string") {
          pending.push({ ...owner, text: "opening time not known" });
          break;
        }
        const window = { start, end };
        const span = windowSpan(window, timezone);
        const hoursAttr = candidate.attributes.find((a) => a.key === "hours");
        const verified =
          hoursAttr?.status === "verified_true" &&
          hoursAttr.source === "osm:opening_hours" &&
          (candidate.hours?.length ?? 0) > 0;
        if (verified) {
          const coverage = coversWindow(candidate.hours!, window, timezone);
          if (coverage === "covered") {
            satisfied.push({ ...owner, text: `open ${span}` });
          } else if (coverage === "uncovered") {
            return excluded(candidate, { ...owner, text: `closed ${span}` });
          } else {
            pending.push({ ...owner, text: `is it open ${span}?` });
          }
          break;
        }

        const siteHours = parseOpeningHours(candidate.website_hours?.join("; "));
        if (siteHours) {
          const coverage = coversWindow(siteHours, window, timezone);
          if (coverage !== "unknown") {
            likely.push({
              ...owner,
              lean: coverage === "covered",
              confidence: 0.6,
              text: coverage === "covered" ? `likely open ${span}` : `likely closed ${span}`,
            });
            break;
          }
        }
        pending.push({ ...owner, text: `is it open ${span}?` });
        break;
      }
      case "text": {
        // A stored text payload carries its sentence; without one there is no
        // question to ask, so the place stays uncertain rather than passing.
        if (typeof p.text !== "string" || !p.text.trim()) {
          pending.push({ ...owner, text: "unevaluated requirement" });
          break;
        }
        const criterion = criterionFor(p as never);
        const attr = candidate.attributes.find((a) => a.key === questionKey(p.text as string));
        const status = attr?.status ?? "unknown";
        const label = criterion?.label ?? p.text.trim();
        const lean = leans(status);
        if (lean === null) {
          pending.push({ ...owner, text: `${label} not known` });
        } else {
          const attested = Boolean(attr?.attestedBy);
          const explicitOwnSite =
            attr?.explicit === true &&
            attr.source?.startsWith("web:") === true &&
            (attr.confidence ?? 0) >= 0.7;
          if (isVerified(status) && (attested || explicitOwnSite)) {
            if (lean) {
              satisfied.push({
                ...owner,
                text: attr?.source === "person:confirmed"
                  ? `${attr.confirmedByName ?? "Someone"} confirmed it`
                  : label,
              });
            }
            else return excluded(candidate, { ...owner, text: `${label} is not confirmed` });
          } else {
            likely.push({
              ...owner,
              lean,
              confidence: attr?.confidence ?? 0.5,
              text: `${label} ${lean ? "likely" : "unlikely"}`,
            });
          }
        }
        break;
      }
      case "inclusion": {
        if (p.key === "cuisine") {
          const criterion = criterionFor(p as never);
          const direct = criterion
            ? candidate.attributes.find((attribute) => attribute.key === criterion.id)
            : undefined;
          const directLean = leans(direct?.status ?? "unknown");
          if (directLean !== null) {
            const label = criterion?.label ?? "serves the requested cuisine";
            if (isVerified(direct!.status)) {
              if (directLean) satisfied.push({ ...owner, text: label });
              else return excluded(candidate, { ...owner, text: `does not ${label}` });
            } else {
              likely.push({
                ...owner,
                lean: directLean,
                confidence: direct?.confidence ?? 0.5,
                text: `${label} ${directLean ? "likely" : "unlikely"}`,
              });
            }
            break;
          }
          const attr = candidate.attributes.find((a) => a.key === "cuisine");
          const known = attr?.status === "verified_true" || attr?.status === "likely_true";
          const tokens =
            known && typeof attr?.value === "string"
              ? normalizeCuisineTokens(attr.value)
              : [];
          const hit = cuisineHit(tokens, p.values);
          const wanted = normalizeCuisineTokens(p.values ?? []).map(humanizeCuisine).join(" or ");
          if (tokens.length === 0) {
            pending.push({ ...owner, text: "cuisine not known" });
          } else if (!hit) {
            if (attr?.status === "likely_true") {
              likely.push({
                ...owner,
                lean: false,
                confidence: attr.confidence ?? 0.5,
                text: `likely does not serve ${wanted || "the requested cuisine"}`,
              });
            } else {
              return excluded(candidate, { ...owner, text: `does not serve ${wanted || "the requested cuisine"}` });
            }
          } else if (
            attr?.status === "likely_true" ||
            (!hit.exact && hit.confidence < CUISINE_IMPLICATION_SATISFACTION_FLOOR)
          ) {
            likely.push({
              ...owner,
              lean: true,
              confidence: attr?.status === "likely_true"
                ? (attr.confidence ?? 0.5) * hit.confidence
                : hit.confidence,
              text: attr?.status === "likely_true"
                ? `likely serves ${humanizeCuisine(hit.wanted)}`
                : cuisineEvidence(hit, true),
            });
          } else {
            satisfied.push({ ...owner, text: cuisineEvidence(hit) });
          }
        } else {
          pending.push({ ...owner, text: `${labelOf(p.key)} not known` });
        }
        break;
      }
      case "exclusion": {
        if (p.key === "cuisine") {
          const criterion = criterionFor(p as never);
          const direct = criterion
            ? candidate.attributes.find((attribute) => attribute.key === criterion.id)
            : undefined;
          const directLean = leans(direct?.status ?? "unknown");
          if (directLean !== null) {
            const label = criterion?.label ?? "serves the avoided cuisine";
            if (isVerified(direct!.status)) {
              if (directLean) return excluded(candidate, { ...owner, text: label });
              satisfied.push({ ...owner, text: `does not ${label}` });
            } else {
              likely.push({
                ...owner,
                lean: !directLean,
                confidence: direct?.confidence ?? 0.5,
                text: `${label} ${directLean ? "likely" : "unlikely"}`,
              });
            }
            break;
          }
          const attr = candidate.attributes.find((a) => a.key === "cuisine");
          const fact = attr ? normalizeStatus(attr) : undefined;
          const tokens = typeof fact?.value === "string" ? normalizeCuisineTokens(fact.value) : [];
          const hit = cuisineHit(tokens, p.values);
          const wanted = normalizeCuisineTokens(p.values ?? []).map(humanizeCuisine).join(" or ");
          if (!fact) {
            const categoryHit = cuisineHit(normalizeCuisineTokens(candidate.category), p.values);
            if (categoryHit) {
              // Category is suggestive fallback data, never decisive cuisine
              // evidence — even when its token is an exact match.
              likely.push({
                ...owner,
                lean: false,
                confidence: 0.5 * categoryHit.confidence,
                text: `category suggests ${humanizeCuisine(categoryHit.wanted)}`,
              });
            } else {
              pending.push({ ...owner, text: "cuisine not known" });
            }
          } else if (fact.status === "verified_true") {
            if (!hit && tokens.length === 0) {
              pending.push({ ...owner, text: "cuisine not known" });
            } else if (hit?.exact) {
              return excluded(candidate, { ...owner, text: cuisineEvidence(hit) });
            } else if (hit) {
              // An implication may add a place to a set but must never rule
              // one out. Even high-confidence implied exclusions stay unlikely.
              likely.push({
                ...owner,
                lean: false,
                confidence: hit.confidence,
                text: cuisineEvidence(hit),
              });
            }
          } else if (fact.status === "likely_true") {
            if (tokens.length === 0) {
              pending.push({ ...owner, text: "cuisine not known" });
            } else {
              likely.push({
                ...owner,
                lean: !hit,
                confidence: fact.confidence * (hit?.confidence ?? 1),
                text: hit
                  ? `likely serves ${humanizeCuisine(hit.wanted)}`
                  : `likely does not serve ${wanted || "the avoided cuisine"}`,
              });
            }
          } else if (hit?.exact && fact.status === "verified_false") {
            satisfied.push({
              ...owner,
              text: `does not serve ${humanizeCuisine(hit.wanted)}`,
            });
          } else if (hit?.exact && fact.status === "likely_false") {
            likely.push({
              ...owner,
              lean: true,
              confidence: fact.confidence,
              text: `likely does not serve ${humanizeCuisine(hit.wanted)}`,
            });
          } else {
            // Unknown values and negative facts about some other or narrower
            // cuisine do not answer this exclusion.
            pending.push({ ...owner, text: "cuisine not known" });
          }
        } else {
          pending.push({ ...owner, text: `${labelOf(p.key)} not known` });
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
  return {
    ...base(candidate),
    eligibility: "eligible",
    ...(satisfied.length ? { satisfiedReasons: satisfied } : {}),
  };
}

const strip = (l: EligibilityReason & { lean: boolean; confidence: number }): EligibilityReason => ({
  requirementId: l.requirementId,
  ownerId: l.ownerId,
  shared: l.shared,
  text: l.text,
  ...(l.peerText ? { peerText: l.peerText } : {}),
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
