import type pg from "pg";
import type { Feasibility } from "@webmcp-hackathon/contracts";
import { PRICE_LEVEL_EUR } from "@webmcp-hackathon/contracts";

/**
 * Deterministic eligibility per SPATIAL-PROTOCOL.md §8:
 * - the session scope is an implicit hard constraint: candidates outside the
 *   scope circle are excluded ("outside the current search area");
 * - hard shared/application-private requirements evaluate against dossier
 *   attributes; only verified evidence contradicting the expectation
 *   hard-excludes; unknown/unverified yields uncertain (attribute honesty);
 * - budget compares perPersonMax against the PRICE_LEVEL_EUR band for the
 *   candidate's price level;
 * - cuisine exclusions match the candidate's cuisine attribute value
 *   (tokenized on ';' — OSM multi-values like "pizza;italian"), falling back
 *   to its category;
 * - agent-private declarations consult recorded screening verdicts:
 *   unacceptable -> excluded, missing/needs_info -> uncertain;
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

export type Eligibility = "eligible" | "uncertain" | "excluded";

export interface CandidateRow {
  id: string;
  name: string;
  category: string;
  price_level: number | null;
  walk_min: number;
  location: { lat: number; lng: number };
  attributes: Array<{ key: string; status: string; value?: string | number }>;
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
    perPersonMax?: { amount: number; currency: string };
  } | null;
  withdrawn: boolean;
  created_at_revision?: number;
}
export interface VerdictRow {
  owner_id: string;
  candidate_id: string;
  verdict: string;
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
  ownerId: string;
  shared: boolean;
  text: string;
}

export interface CandidateEligibility {
  candidateId: string;
  name: string;
  category: string;
  location: { lat: number; lng: number };
  eligibility: Eligibility;
  /** Present when excluded: the winning (first) exclusion reason. */
  exclusion?: EligibilityReason;
  /** Present when uncertain: every pending-evidence contribution. */
  uncertainReasons?: EligibilityReason[];
  walkMin: number;
  priceLevel: number | null;
}

const PRIVATE_EXCLUDED = "excluded by a private requirement";
const PRIVATE_PENDING = "private evidence pending";

/**
 * The viewer-safe why-string. Shared reasons pass through; every contribution
 * from a non-shared requirement the viewer does not own collapses into one
 * fixed token, independent of how many private constraints touch the
 * candidate or whose they are.
 */
export function whyFor(row: CandidateEligibility, viewerId: string): string {
  if (row.eligibility === "excluded") {
    const r = row.exclusion!;
    if (r.shared || r.ownerId === viewerId) return r.text;
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
    return parts.join("; ").slice(0, 120);
  }
  return "meets all evaluable requirements";
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

export async function computeEligibility(
  q: pg.PoolClient | pg.Pool,
  roomId: string,
): Promise<CandidateEligibility[]> {
  const [candidates, requirements, verdicts, scope] = await Promise.all([
    q.query("SELECT * FROM candidates WHERE room_id = $1 ORDER BY id", [roomId]),
    q.query(
      "SELECT * FROM requirements WHERE room_id = $1 AND NOT withdrawn",
      [roomId],
    ),
    q.query("SELECT * FROM verdicts WHERE room_id = $1", [roomId]),
    loadScope(q, roomId),
  ]);
  return classifyAll(
    candidates.rows as CandidateRow[],
    requirements.rows as RequirementRow[],
    verdicts.rows as VerdictRow[],
    scope,
  );
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

  // Implicit hard constraint: the shared search scope.
  if (scope?.area?.kind === "circle") {
    const distance = haversineMeters(candidate.location, scope.area.center);
    if (distance > scope.area.radiusM) {
      return excluded(candidate, {
        ownerId: "",
        shared: true,
        text: "outside the current search area",
      });
    }
  }

  for (const req of requirements) {
    if (req.hardness !== "hard") continue;
    const owner = { ownerId: req.owner_id, shared: req.visibility === "shared" };

    if (req.visibility === "agent-private") {
      const verdict = verdicts.find(
        (v) => v.owner_id === req.owner_id && v.candidate_id === candidate.id,
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
        if (status === "unknown" || status === "unverified") {
          pending.push({ ...owner, text: `${p.key} unverified` });
        } else if (status !== expect) {
          // A verified status contradicting the expectation hard-excludes.
          return excluded(candidate, {
            ...owner,
            text:
              expect === "verified_true"
                ? `no verified ${p.key}`
                : `verified ${p.key}`,
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
            pending.push({ ...owner, text: "scope evidence pending" });
          } else if (
            haversineMeters(candidate.location, scope.area.center) > p.max
          ) {
            return excluded(candidate, { ...owner, text: `beyond ${p.max} m` });
          }
        } else {
          pending.push({ ...owner, text: "scope evidence pending" });
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
          pending.push({ ...owner, text: "budget evidence pending" });
        } else if (band > max) {
          return excluded(candidate, {
            ...owner,
            text: "estimated cost above the shared budget",
          });
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
            return excluded(candidate, { ...owner, text: `excluded ${hit}` });
          }
        } else {
          pending.push({ ...owner, text: "exclusion evidence pending" });
        }
        break;
      }
      default:
        // A hard requirement whose payload we cannot evaluate must not pass.
        pending.push({ ...owner, text: "unevaluated requirement" });
    }
  }

  if (pending.length > 0) {
    return {
      ...base(candidate),
      eligibility: "uncertain",
      uncertainReasons: pending,
    };
  }
  return { ...base(candidate), eligibility: "eligible" };
}

function excluded(
  c: CandidateRow,
  reason: EligibilityReason,
): CandidateEligibility {
  return { ...base(c), eligibility: "excluded", exclusion: reason };
}

function base(c: CandidateRow) {
  return {
    candidateId: c.id,
    name: c.name,
    category: c.category,
    location: c.location,
    walkMin: c.walk_min,
    priceLevel: c.price_level,
  };
}

export function feasibilityOf(rows: CandidateEligibility[]): Feasibility {
  const eligible = rows.filter((r) => r.eligibility === "eligible").length;
  const uncertain = rows.filter((r) => r.eligibility === "uncertain").length;
  const excluded = rows.filter((r) => r.eligibility === "excluded").length;
  const state =
    eligible >= 3
      ? "feasible"
      : eligible >= 1
        ? "fragile"
        : uncertain > 0
          ? "uncertain"
          : "infeasible";
  return { state, eligible, uncertain, excluded };
}
