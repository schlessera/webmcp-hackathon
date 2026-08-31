import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyAll,
  feasibilityOf,
  haversineMeters,
  type CandidateRow,
  type RequirementRow,
  type ScopeState,
} from "../../apps/server/src/eligibility.ts";
import {
  generateAdjustments,
  minimalConflictSet,
  screeningPending,
} from "../../apps/server/src/impasse.ts";

/** Lane 1 additions: deterministic eligibility + impasse math, incl. the real
 * Berlin Mitte dataset the demo ships. */

const datasetPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..", "..", "packages", "contracts", "data", "berlin-mitte-venues.json",
);
const dataset = JSON.parse(readFileSync(datasetPath, "utf8")) as {
  manifest: {
    demoCenter: { lat: number; lng: number };
    demoRadii: { narrow: number; wide: number };
    vetoTargetId: string;
  };
  venues: Array<{
    candidateId: string;
    name: string;
    location: { lat: number; lng: number };
    category: string;
    priceLevel: number | null;
    attributes: Array<{ key: string; status: string; value?: string | number }>;
  }>;
};

const candidates: CandidateRow[] = dataset.venues.map((v) => ({
  id: v.candidateId,
  name: v.name,
  category: v.category,
  price_level: v.priceLevel,
  walk_min: 5,
  location: v.location,
  attributes: v.attributes,
}));

const scopeAt = (radiusM: number): ScopeState => ({
  scopeId: "scope_test",
  area: { kind: "circle", center: dataset.manifest.demoCenter, radiusM },
  transport: ["walk"],
  category: "food",
});

let seq = 0;
const req = (
  payload: RequirementRow["payload"],
  overrides: Partial<RequirementRow> = {},
): RequirementRow => ({
  id: `req_${++seq}`,
  owner_id: "p_org",
  visibility: "shared",
  hardness: "hard",
  payload,
  withdrawn: false,
  created_at_revision: seq,
  ...overrides,
});

/** The demo requirement set: Sarah veg (shared), Joe lactose (app-private),
 * organizer non-Italian exclusion + 15 EUR budget. */
const demoRequirements = (): RequirementRow[] => [
  req({ kind: "attribute", key: "vegetarian-options", expect: "verified_true" }, { owner_id: "p_sarah" }),
  req({ kind: "attribute", key: "lactose-free-options", expect: "verified_true" }, { owner_id: "p_joe", visibility: "application-private" }),
  req({ kind: "exclusion", key: "cuisine", values: ["italian"], lifetime: "session" } as never),
  req({ kind: "budget", perPersonMax: { amount: 15, currency: "EUR" } }),
];

const eligibleIds = (rows: ReturnType<typeof classifyAll>) =>
  rows.filter((r) => r.eligibility === "eligible").map((r) => r.candidateId);

describe("eligibility against the Berlin Mitte dataset", () => {
  it("demo requirement set yields 0 eligible at 800 m and 4 at 1400 m", () => {
    const at800 = classifyAll(candidates, demoRequirements(), [], scopeAt(800));
    expect(eligibleIds(at800)).toEqual([]);

    const at1400 = classifyAll(candidates, demoRequirements(), [], scopeAt(1400));
    expect(eligibleIds(at1400)).toHaveLength(4);
    expect(eligibleIds(at1400)).toContain(dataset.manifest.vetoTargetId);
  });

  it("scope excludes out-of-area candidates with a neutral reason", () => {
    const rows = classifyAll(candidates, [], [], scopeAt(800));
    const outside = rows.filter((r) => r.eligibility === "excluded");
    expect(outside.length).toBeGreaterThan(0);
    for (const row of outside) {
      expect(row.why).toBe("outside the current search area");
      expect(
        haversineMeters(row.location, dataset.manifest.demoCenter),
      ).toBeGreaterThan(800);
    }
  });

  it("budget maps price levels to EUR bands: band above cap excludes, missing level is uncertain", () => {
    const budget = [req({ kind: "budget", perPersonMax: { amount: 15, currency: "EUR" } })];
    const rows = classifyAll(
      [
        { ...candidates[0], id: "c_cheap", price_level: 2, attributes: [] },
        { ...candidates[0], id: "c_pricey", price_level: 3, attributes: [] },
        { ...candidates[0], id: "c_unknown", price_level: null, attributes: [] },
      ],
      budget,
      [],
      null,
    );
    expect(rows.find((r) => r.candidateId === "c_cheap")!.eligibility).toBe("eligible");
    const pricey = rows.find((r) => r.candidateId === "c_pricey")!;
    expect(pricey.eligibility).toBe("excluded");
    expect(pricey.why).toBe("estimated cost above the shared budget");
    expect(rows.find((r) => r.candidateId === "c_unknown")!.eligibility).toBe("uncertain");
  });

  it("cuisine exclusion matches the cuisine attribute value, not just category", () => {
    const italian = candidates.find((c) =>
      c.attributes.some((a) => a.key === "cuisine" && a.value === "italian"),
    );
    expect(italian).toBeDefined();
    const rows = classifyAll(
      [italian!],
      [req({ kind: "exclusion", key: "cuisine", values: ["italian"], lifetime: "session" } as never)],
      [],
      null,
    );
    expect(rows[0].eligibility).toBe("excluded");
    expect(rows[0].why).toBe("excluded italian");
  });

  it("application-private exclusions never cite content in why-strings", () => {
    const rows = classifyAll(
      candidates,
      [
        req(
          { kind: "attribute", key: "lactose-free-options", expect: "verified_true" },
          { visibility: "application-private", owner_id: "p_joe" },
        ),
      ],
      [],
      scopeAt(1400),
    );
    for (const row of rows) {
      if (row.eligibility === "excluded" && row.why !== "outside the current search area") {
        expect(row.why).toBe("excluded by a private requirement");
        expect(row.why).not.toContain("lactose");
      }
    }
  });
});

describe("minimal conflict set and adjustments", () => {
  it("greedy deletion finds the irreducible conflicting set deterministically", () => {
    const requirements = demoRequirements();
    const first = minimalConflictSet(candidates, requirements, [], scopeAt(800));
    const second = minimalConflictSet(candidates, requirements, [], scopeAt(800));
    expect(first.map((r) => r.id)).toEqual(second.map((r) => r.id));
    // Lactose alone is infeasible at 800 m (no verified lactose-free venue
    // inside), so the minimal set is exactly that requirement.
    expect(first).toHaveLength(1);
    expect(first[0].payload?.key).toBe("lactose-free-options");
    // Irreducibility: removing the surviving requirement recovers feasibility.
    const without = requirements.filter((r) => r.id !== first[0].id);
    const rows = classifyAll(candidates, without, [], scopeAt(800));
    expect(eligibleIds(rows).length).toBeGreaterThan(0);
  });

  it("proposes a scope widening whose gain is the actually recomputed count", () => {
    const requirements = demoRequirements();
    const conflict = minimalConflictSet(candidates, requirements, [], scopeAt(800));
    const drafts = generateAdjustments(
      candidates, requirements, [], scopeAt(800), conflict, "p_org",
    );
    const scopeDraft = drafts.find((d) => d.kind === "scope_change");
    expect(scopeDraft).toBeDefined();
    expect(scopeDraft!.requiresConsentOf).toBe("p_org");
    expect(scopeDraft!.withinDelegatedBound).toBe(false);
    const to = Number(scopeDraft!.change.to);
    const widened = classifyAll(candidates, requirements, [], scopeAt(to));
    expect(scopeDraft!.projectedGain.newCandidates).toBe(eligibleIds(widened).length);
    expect(scopeDraft!.projectedGain.newCandidates).toBeGreaterThanOrEqual(3);
  });

  it("never targets a locked requirement with a relaxation", () => {
    const locked = req(
      { kind: "budget", perPersonMax: { amount: 5, currency: "EUR" } },
      { delegation: { mode: "locked" } } as never,
    );
    const drafts = generateAdjustments(
      candidates, [locked], [], scopeAt(800), [locked], "p_org",
    );
    expect(drafts.filter((d) => d.kind === "requirement_relaxation")).toHaveLength(0);
  });

  it("budget relaxation steps to the next EUR band and honors negotiable bounds", () => {
    const cheapScope = scopeAt(1400);
    const budget = req(
      { kind: "budget", perPersonMax: { amount: 10, currency: "EUR" } },
      { delegation: { mode: "negotiable", bound: { dimension: "per_person_eur", max: 20 } } } as never,
    );
    const veg = req(
      { kind: "attribute", key: "vegetarian-options", expect: "verified_true" },
      { owner_id: "p_sarah" },
    );
    const conflict = minimalConflictSet(candidates, [budget, veg], [], cheapScope);
    const drafts = generateAdjustments(
      candidates, [budget, veg], [], cheapScope, conflict, "p_org",
    );
    const relax = drafts.find((d) => d.kind === "requirement_relaxation");
    if (relax) {
      expect(relax.change.from).toBe(10);
      expect(relax.change.to).toBe(15);
      expect(relax.withinDelegatedBound).toBe(true);
    }
  });

  it("screeningPending blocks only on unresolved agent-private verdicts", () => {
    const declaration = req(null, { visibility: "agent-private", owner_id: "p_joe" });
    const two = candidates.slice(0, 2);
    expect(screeningPending(two, [declaration], [])).toBe(true);
    const verdicts = two.map((c) => ({
      owner_id: "p_joe", candidate_id: c.id, verdict: "acceptable",
    }));
    expect(screeningPending(two, [declaration], verdicts)).toBe(false);
    expect(
      screeningPending(two, [declaration], [
        { ...verdicts[0], verdict: "needs_info" }, verdicts[1],
      ]),
    ).toBe(true);
  });
});

describe("feasibility classification", () => {
  it("maps eligible counts to states", () => {
    const mk = (eligibility: "eligible" | "uncertain" | "excluded") => ({
      candidateId: "c", name: "n", category: "cafe",
      location: { lat: 0, lng: 0 }, eligibility, why: "", walkMin: 1, priceLevel: 1,
    });
    expect(feasibilityOf([mk("eligible"), mk("eligible"), mk("eligible")]).state).toBe("feasible");
    expect(feasibilityOf([mk("eligible")]).state).toBe("fragile");
    expect(feasibilityOf([mk("uncertain")]).state).toBe("uncertain");
    expect(feasibilityOf([mk("excluded")]).state).toBe("infeasible");
  });
});
