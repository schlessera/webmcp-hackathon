import type pg from "pg";
import type { Feasibility } from "@webmcp-hackathon/contracts";

/**
 * Deterministic eligibility per SPATIAL-PROTOCOL.md §8 (spike subset):
 * - hard shared/application-private attribute requirements evaluate against
 *   dossier attributes; only verified_false vs expectation hard-excludes;
 *   unknown/unverified yields uncertain.
 * - agent-private declarations consult recorded screening verdicts:
 *   unacceptable -> excluded, missing/needs_info -> uncertain.
 * - soft requirements never exclude.
 */

export type Eligibility = "eligible" | "uncertain" | "excluded";

interface CandidateRow {
  id: string;
  name: string;
  category: string;
  price_level: number;
  walk_min: number;
  attributes: Array<{ key: string; status: string }>;
}
interface RequirementRow {
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
}
interface VerdictRow {
  owner_id: string;
  candidate_id: string;
  verdict: string;
}

export interface CandidateEligibility {
  candidateId: string;
  name: string;
  eligibility: Eligibility;
  why: string;
  walkMin: number;
  priceLevel: number;
}

export async function computeEligibility(
  q: pg.PoolClient | pg.Pool,
  roomId: string,
): Promise<CandidateEligibility[]> {
  const [candidates, requirements, verdicts] = await Promise.all([
    q.query("SELECT * FROM candidates WHERE room_id = $1 ORDER BY id", [roomId]),
    q.query(
      "SELECT * FROM requirements WHERE room_id = $1 AND NOT withdrawn",
      [roomId],
    ),
    q.query("SELECT * FROM verdicts WHERE room_id = $1", [roomId]),
  ]);
  return (candidates.rows as CandidateRow[]).map((c) =>
    classify(c, requirements.rows as RequirementRow[], verdicts.rows as VerdictRow[]),
  );
}

function classify(
  candidate: CandidateRow,
  requirements: RequirementRow[],
  verdicts: VerdictRow[],
): CandidateEligibility {
  let uncertain = false;
  const reasons: string[] = [];

  for (const req of requirements) {
    if (req.hardness !== "hard") continue;

    if (req.visibility === "agent-private") {
      const verdict = verdicts.find(
        (v) => v.owner_id === req.owner_id && v.candidate_id === candidate.id,
      );
      if (!verdict || verdict.verdict === "needs_info") {
        uncertain = true;
        reasons.push("private screen pending");
      } else if (verdict.verdict === "unacceptable") {
        // Never cite owner or reason for agent-private exclusions.
        return summary(candidate, "excluded", "excluded by a private requirement");
      }
      continue;
    }

    // Every accepted hard requirement kind is evaluated; nothing the command
    // schema admits may silently pass. Where the dossier carries no evidence
    // for a dimension, the answer is uncertain — never eligible (attribute
    // honesty: unknown != verified).
    // Public why-strings cite evidence status and SHARED requirements only
    // (SPATIAL-PROTOCOL.md §8): application-private details stay generic.
    const shared = req.visibility === "shared";
    const p = req.payload;
    switch (p?.kind) {
      case "attribute": {
        const attr = candidate.attributes.find((a) => a.key === p.key);
        const status = attr?.status ?? "unknown";
        const expect = p.expect ?? "verified_true";
        if (status === "unknown" || status === "unverified") {
          uncertain = true;
          reasons.push(shared ? `${p.key} unverified` : "evidence pending");
        } else if (status !== expect) {
          // A verified status contradicting the expectation hard-excludes.
          return summary(
            candidate,
            "excluded",
            shared
              ? expect === "verified_true"
                ? `no verified ${p.key}`
                : `verified ${p.key}`
              : "excluded by a private requirement",
          );
        }
        break;
      }
      case "scope": {
        if (p.dimension === "walk_min" && typeof p.max === "number") {
          if (candidate.walk_min > p.max) {
            return summary(
              candidate,
              "excluded",
              shared ? `beyond ${p.max} min walk` : "excluded by a private requirement",
            );
          }
        } else {
          // radius_m needs distance evidence the dossier does not carry yet.
          uncertain = true;
          reasons.push("scope evidence pending");
        }
        break;
      }
      case "budget": {
        // Dossiers carry a 1-4 price level, not per-person prices; without a
        // verified mapping the honest answer is uncertain.
        uncertain = true;
        reasons.push("budget evidence pending");
        break;
      }
      case "exclusion": {
        if (p.key === "cuisine" && p.values?.includes(candidate.category)) {
          return summary(
            candidate,
            "excluded",
            shared ? `excluded ${candidate.category}` : "excluded by a private requirement",
          );
        }
        if (p.key !== "cuisine") {
          uncertain = true;
          reasons.push("exclusion evidence pending");
        }
        break;
      }
      default:
        // A hard requirement whose payload we cannot evaluate must not pass.
        uncertain = true;
        reasons.push("unevaluated requirement");
    }
  }

  if (uncertain) {
    return summary(candidate, "uncertain", reasons.join("; ").slice(0, 120));
  }
  return summary(candidate, "eligible", "meets all evaluable requirements");
}

function summary(
  c: CandidateRow,
  eligibility: Eligibility,
  why: string,
): CandidateEligibility {
  return {
    candidateId: c.id,
    name: c.name,
    eligibility,
    why,
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
