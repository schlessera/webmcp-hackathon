import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyAll,
  feasibilityOf,
  haversineMeters,
  whyFor,
  type CandidateRow,
  type RequirementRow,
  type ScopeState,
} from "../../apps/server/src/eligibility.ts";
import { computeFacetsBundle } from "../../apps/server/src/facets.ts";
import {
  generateAdjustments,
  minimalConflictSet,
  screeningPending,
} from "../../apps/server/src/impasse.ts";
import { questionKey } from "../../packages/contracts/src/criteria.ts";

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
  map_revision: 0,
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
  it("does not treat absent map revisions as a current private verdict", () => {
    const candidate = { ...candidates[0] };
    delete (candidate as Partial<typeof candidate>).map_revision;
    const need: RequirementRow = {
      id: "req_private_missing_revision",
      owner_id: "p_private",
      visibility: "agent-private",
      hardness: "hard",
      payload: null,
      withdrawn: false,
    };
    const rows = classifyAll(
      [candidate],
      [need],
      [{ owner_id: "p_private", candidate_id: candidate.id, verdict: "unacceptable" }],
      null,
    );
    expect(rows[0].eligibility).toBe("uncertain");
  });

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
      expect(whyFor(row, "p_anyone")).toBe("outside the current search area");
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
    expect(whyFor(pricey, "p_peer")).toBe("estimated cost above the shared budget");
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
    expect(whyFor(rows[0], "p_peer")).toBe("serves Italian");
  });

  it("cuisine exclusion matches individual tokens of multi-valued OSM tags", () => {
    const multi: CandidateRow = {
      ...candidates[0],
      id: "c_multi",
      category: "restaurant",
      attributes: [
        { key: "cuisine", status: "verified_true", value: "pizza;italian" },
      ],
    };
    const rows = classifyAll(
      [multi],
      [req({ kind: "exclusion", key: "cuisine", values: ["italian"], lifetime: "session" } as never)],
      [],
      null,
    );
    expect(rows[0].eligibility).toBe("excluded");
    expect(whyFor(rows[0], "p_peer")).toBe("serves Italian");
  });

  it("cuisine inclusion: a verified match passes, a verified mismatch is ruled out, no record is unsure", () => {
    const mk = (id: string, attrs: CandidateRow["attributes"]): CandidateRow => ({
      ...candidates[0], id, category: "restaurant", attributes: attrs,
    });
    const rows = classifyAll(
      [
        mk("c_match", [{ key: "cuisine", status: "verified_true", value: "asian;vietnamese" }]),
        mk("c_miss", [{ key: "cuisine", status: "verified_true", value: "italian" }]),
        mk("c_none", [{ key: "cuisine", status: "unknown" }]),
      ],
      [req({ kind: "inclusion", key: "cuisine", values: ["asian"], lifetime: "session" } as never)],
      [],
      null,
    );
    const by = Object.fromEntries(rows.map((r) => [r.candidateId, r]));
    expect(by.c_match.eligibility).toBe("eligible");
    expect(by.c_miss.eligibility).toBe("excluded");
    expect(whyFor(by.c_miss, "p_peer")).toBe("does not serve Asian");
    expect(by.c_none.eligibility).toBe("uncertain");
    expect(whyFor(by.c_none, "p_peer")).toBe("cuisine not known");
  });

  it("uses cuisine implications to add places but never to exclude them", () => {
    const pizza: CandidateRow = {
      ...candidates[0], id: "c_pizza", category: "restaurant",
      attributes: [{ key: "cuisine", status: "verified_true", value: "pizza" }],
    };
    const included = classifyAll(
      [pizza],
      [req({ kind: "inclusion", key: "cuisine", values: ["italian"], lifetime: "session" } as never)],
      [], null,
    )[0];
    expect(included.eligibility).toBe("eligible");
    expect(whyFor(included, "p_peer")).toBe("serves pizza, which is usually Italian");

    const avoided = classifyAll(
      [pizza],
      [req({ kind: "exclusion", key: "cuisine", values: ["italian"], lifetime: "session" } as never)],
      [], null,
    )[0];
    expect(avoided.eligibility).toBe("unlikely");
    expect(whyFor(avoided, "p_peer")).toBe("serves pizza, which is usually Italian");
  });

  it("keeps a below-threshold cuisine implication likely", () => {
    const curry: CandidateRow = {
      ...candidates[0], id: "c_curry", category: "restaurant",
      attributes: [{ key: "cuisine", status: "verified_true", value: "curry" }],
    };
    const row = classifyAll(
      [curry],
      [req({ kind: "inclusion", key: "cuisine", values: ["indian"], lifetime: "session" } as never)],
      [], null,
    )[0];
    expect(row).toMatchObject({ eligibility: "likely", confidence: 0.6 });
    expect(whyFor(row, "p_peer")).toBe("serves curry, which is likely Indian");
  });

  it("application-private exclusions never cite content in peer why-strings; owners see their own", () => {
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
      if (row.eligibility !== "excluded") continue;
      const peerWhy = whyFor(row, "p_sarah");
      if (peerWhy === "outside the current search area") continue;
      expect(peerWhy).toBe("ruled out by a private condition");
      expect(peerWhy).not.toContain("lactose");
      expect(whyFor(row, "p_joe")).toContain("lactose");
    }
  });

  it("a free-text question stays pending until its criterion has evidence", () => {
    const rows = classifyAll(
      candidates,
      [req({ kind: "text", text: "somewhere the kids can run" } as never)],
      [],
      scopeAt(1400),
    );
    expect(rows.every((r) => r.eligibility === "uncertain")).toBe(true);
    expect(whyFor(rows[0], "p_org")).toContain("somewhere the kids can run");
  });

  it("reads likely, unlikely, unknown, and attested evidence for a question criterion", () => {
    const text = "somewhere the kids can run";
    const key = questionKey(text);
    const mk = (id: string, attributes: CandidateRow["attributes"]): CandidateRow => ({
      ...candidates[0], id, attributes,
    });
    const rows = classifyAll(
      [
        mk("q_yes", [{ key, status: "likely_true", confidence: 0.55, source: "infer:model" }]),
        mk("q_no", [{ key, status: "likely_false", confidence: 0.5, source: "web:search" }]),
        mk("q_unknown", []),
        mk("q_attested", [{ key, status: "verified_true", confidence: 0.9, source: "agent:p_sarah", attestedBy: "p_sarah" }]),
      ],
      [req({ kind: "text", text } as never)],
      [], null,
    );
    const by = Object.fromEntries(rows.map((row) => [row.candidateId, row]));
    expect(by.q_yes).toMatchObject({ eligibility: "likely", confidence: 0.55 });
    expect(whyFor(by.q_yes, "p_peer")).toBe("somewhere the kids can run likely");
    expect(by.q_no).toMatchObject({ eligibility: "unlikely", confidence: 0.5 });
    expect(whyFor(by.q_no, "p_peer")).toBe("somewhere the kids can run unlikely");
    expect(by.q_unknown.eligibility).toBe("uncertain");
    expect(whyFor(by.q_unknown, "p_peer")).toBe("somewhere the kids can run not known");
    expect(by.q_attested.eligibility).toBe("eligible");
    expect(whyFor(by.q_attested, "p_peer")).toBe(text);
  });

  it("a need its owner set aside classifies nothing", () => {
    const veto = req(
      { kind: "attribute", key: "vegetarian-options", expect: "verified_false" },
      { active: false },
    );
    const rows = classifyAll(candidates, [veto], [], null);
    expect(rows.every((r) => r.eligibility === "eligible")).toBe(true);
    expect(
      classifyAll(candidates, [{ ...veto, active: true }], [], null)
        .some((r) => r.eligibility === "excluded"),
    ).toBe(true);
  });

  it("every reason names the requirement it came from (the scope circle names none)", () => {
    const need = req({ kind: "attribute", key: "lactose-free-options", expect: "verified_true" });
    const rows = classifyAll(candidates, [need], [], scopeAt(800));
    const outside = rows.find(
      (r) => r.exclusion?.text === "outside the current search area",
    )!;
    expect(outside.exclusion!.requirementId).toBe("");
    const pending = rows.find((r) => r.eligibility === "uncertain")!;
    expect(pending.uncertainReasons!.every((x) => x.requirementId === need.id)).toBe(true);
  });

  it("peer why-strings are count-invariant, and private effects carry counts without content", () => {
    // Candidate A: excluded by ONE private requirement. Candidate B: excluded
    // by a different owner's private requirement, with TWO more private
    // requirements pending. Peers must see identical strings for both.
    const a: CandidateRow = {
      ...candidates[0], id: "c_a",
      attributes: [{ key: "vegetarian-options", status: "verified_false" }],
    };
    const b: CandidateRow = {
      ...candidates[0], id: "c_b",
      attributes: [{ key: "outdoor-seating", status: "verified_false" }],
    };
    const reqs = [
      req({ kind: "attribute", key: "vegetarian-options", expect: "verified_true" },
        { visibility: "application-private", owner_id: "p_joe" }),
      req({ kind: "attribute", key: "outdoor-seating", expect: "verified_true" },
        { visibility: "application-private", owner_id: "p_sarah" }),
      req({ kind: "attribute", key: "dog-friendly", expect: "verified_true" },
        { visibility: "application-private", owner_id: "p_org" }),
    ];
    const rows = classifyAll([a, b], reqs, [], null);
    const [rowA, rowB] = rows;
    expect(rowA.eligibility).toBe("excluded");
    expect(rowB.eligibility).toBe("excluded");
    expect(whyFor(rowA, "p_peer")).toBe(whyFor(rowB, "p_peer"));

    // Uncertain rows too: one vs three pending private requirements read the
    // same to a peer who owns none of them.
    const bare: CandidateRow = { ...candidates[0], id: "c_c", attributes: [] };
    const one = classifyAll([bare], reqs.slice(0, 1), [], null)[0];
    const three = classifyAll([bare], reqs, [], null)[0];
    expect(one.eligibility).toBe("uncertain");
    expect(three.eligibility).toBe("uncertain");
    expect(whyFor(one, "p_peer")).toBe(whyFor(three, "p_peer"));
    expect(whyFor(one, "p_peer")).not.toContain("vegetarian");

    // The boundary the redesign moved (CLAUDE.md invariant 5): a peer now
    // learns THAT each private need exists, whose it is, and how many places
    // it ruled out — and still nothing about what it is. Why-strings stay
    // count-invariant; the counts live in privateEffects instead.
    const bundle = computeFacetsBundle(
      { candidates: [a, b, bare], requirements: reqs, verdicts: [], scope: null },
      "p_peer",
    );
    expect(bundle.privateEffects).toEqual([
      { owner: "p_joe", ruledOut: 1 },
      { owner: "p_sarah", ruledOut: 1 },
      { owner: "p_org", ruledOut: 0 },
    ]);
    expect(bundle.activeNeeds).toEqual([]);
    const wire = JSON.stringify(bundle.privateEffects);
    for (const content of ["vegetarian", "outdoor", "dog", "verified", "c_a", "c_b"]) {
      expect(wire).not.toContain(content);
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
      screened_map_revision: c.map_revision,
    }));
    expect(screeningPending(two, [declaration], verdicts)).toBe(false);
    expect(screeningPending(two, [declaration], [
      { ...verdicts[0], screened_map_revision: verdicts[0].screened_map_revision - 1 },
      verdicts[1],
    ])).toBe(true);
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
