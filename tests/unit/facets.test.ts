import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  computeFacets,
  computeFacetsBundle,
  inScope,
  labelForRequirement,
} from "../../apps/server/src/facets.ts";
import {
  classifyAll,
  type CandidateRow,
  type EligibilityInputs,
  type RequirementRow,
  type ScopeState,
} from "../../apps/server/src/eligibility.ts";

/**
 * FACETS.md against the real Berlin Mitte dataset. The counts here are the
 * honest distribution the demo ships, not fixtures: if the data changes these
 * numbers must change with it.
 */

const datasetPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..", "..", "packages", "contracts", "data", "berlin-mitte-venues.json",
);
const dataset = JSON.parse(readFileSync(datasetPath, "utf8")) as {
  manifest: { demoCenter: { lat: number; lng: number } };
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

/** The demo requirement set, in submission order. */
const demoRequirements = (): RequirementRow[] => {
  seq = 0;
  return [
    req({ kind: "attribute", key: "vegetarian-options", expect: "verified_true" }, { owner_id: "p_sarah" }),
    req({ kind: "attribute", key: "lactose-free-options", expect: "verified_true" }, { owner_id: "p_joe", visibility: "application-private" }),
    req({ kind: "exclusion", key: "cuisine", values: ["italian"], lifetime: "session" } as never),
    req({ kind: "budget", perPersonMax: { amount: 15, currency: "EUR" } }),
  ];
};

const inputsAt = (
  radiusM: number | null,
  requirements: RequirementRow[] = [],
): EligibilityInputs => ({
  candidates,
  requirements,
  verdicts: [],
  scope: radiusM === null ? null : scopeAt(radiusM),
});

const facetFor = (facets: ReturnType<typeof computeFacets>, key: string) =>
  facets.find((f) => f.key === key)!;

describe("facets describe what is askable about the current set", () => {
  const facets = computeFacets(candidates, null);

  it("counts each boolean attribute honestly: verified true, verified false, everything else unknown", () => {
    expect(facetFor(facets, "wheelchair-accessible").counts).toEqual({
      yes: 13, no: 9, unknown: 9, // 5 unverified + 4 with no claim at all
    });
    expect(facetFor(facets, "outdoor-seating").counts).toEqual({ yes: 24, no: 3, unknown: 4 });
    expect(facetFor(facets, "vegetarian-options").counts).toEqual({ yes: 22, no: 0, unknown: 9 });
    expect(facetFor(facets, "lactose-free-options").counts).toEqual({ yes: 4, no: 2, unknown: 25 });
    // Nothing is verified about dogs anywhere: the facet still exists, all
    // unknown. Missing data is a state we draw, not a reason to drop a facet.
    expect(facetFor(facets, "dog-friendly").counts).toEqual({ yes: 0, no: 0, unknown: 31 });
  });

  it("gives every facet a mandatory unknown count and a server-authored label", () => {
    for (const facet of facets) {
      expect(facet.counts.unknown, facet.key).toBeTypeOf("number");
      expect(facet.label, facet.key).toBeTruthy();
      expect(facet.label, facet.key).toBe(facet.label.toLowerCase());
    }
    expect(facetFor(facets, "wheelchair-accessible").label).toBe("step-free access");
    expect(facetFor(facets, "dog-friendly").label).toBe("dogs welcome");
  });

  it("carries no domain or category field for the client to branch on", () => {
    for (const facet of facets) {
      expect(Object.keys(facet)).not.toContain("domain");
      expect(Object.keys(facet)).not.toContain("category");
    }
  });

  it("orders boolean facets by yes-count so the composer's top pills are the useful ones", () => {
    const yesCounts = facets
      .filter((f) => f.type === "boolean")
      .map((f) => f.counts.yes ?? 0);
    expect(yesCounts).toEqual([...yesCounts].sort((a, b) => b - a));
    expect(facets[0].key).toBe("outdoor-seating");
  });

  it("counts cuisine as an enum, one count per multi-valued token", () => {
    const cuisine = facetFor(facets, "cuisine");
    expect(cuisine.type).toBe("enum");
    expect(cuisine.counts.unknown).toBe(6);
    expect(cuisine.values!.find((v) => v.value === "italian")!.count).toBe(3);
    // Buckets are disjoint and add up to the set, so a reader can total them.
    const c = cuisine.counts;
    expect((c.yes ?? 0) + (c.likely ?? 0) + (c.unlikely ?? 0) + (c.no ?? 0) + c.unknown)
      .toBe(31);
    expect(cuisine.values!.map((v) => v.count)).toEqual(
      [...cuisine.values!.map((v) => v.count)].sort((a, b) => b - a),
    );
    // Provider tokens are snake_case; the label is the only string shown.
    expect(cuisine.values!.some((v) => v.label.includes("_"))).toBe(false);

    const multi = computeFacets(
      [
        { ...candidates[0], id: "c_multi", attributes: [{ key: "cuisine", status: "verified_true", value: "pizza;italian" }] },
      ],
      null,
    );
    const tokens = facetFor(multi, "cuisine").values!.map((v) => v.value);
    expect(tokens.sort()).toEqual(["italian", "pizza"]);
  });

  it("keeps implied and likely cuisine values routable without counting guesses as matches", () => {
    const cuisine = facetFor(computeFacets([
      { ...candidates[0], id: "pizza", attributes: [{ key: "cuisine", status: "verified_true", value: "pizza" }] },
      { ...candidates[0], id: "thai", attributes: [{ key: "cuisine", status: "likely_true", value: "thai" }] },
    ], null), "cuisine");
    expect(cuisine.values).toEqual(expect.arrayContaining([
      { value: "italian", label: "Italian", count: 1 },
      { value: "thai", label: "Thai", count: 0 },
      { value: "asian", label: "Asian", count: 0 },
    ]));
    // The Thai place rests on a guess, the pizza place on the record: one each,
    // and "asian"/"italian" reach the value list only by implication.
    expect(cuisine.counts).toMatchObject({ yes: 1, likely: 1, unknown: 0 });
  });

  it("makes a cuisine value count equal the matching count after selection", () => {
    const curryPlaces: CandidateRow[] = [
      { ...candidates[0], id: "curry_1", attributes: [{ key: "cuisine", status: "verified_true", value: "curry;indian" }] },
      { ...candidates[0], id: "curry_2", attributes: [{ key: "cuisine", status: "verified_true", value: "curry" }] },
      { ...candidates[0], id: "curry_3", attributes: [{ key: "cuisine", status: "verified_true", value: "curry" }] },
    ];
    const need = req({ kind: "inclusion", key: "cuisine", values: ["indian"] } as never);
    const bundle = computeFacetsBundle(
      { candidates: curryPlaces, requirements: [need], verdicts: [], scope: null },
      "p_org",
    );
    const indian = facetFor(bundle.facets, "cuisine").values!
      .find((value) => value.value === "indian")!;
    expect(indian.count).toBe(1);
    expect(indian.count).toBe(bundle.matching);
    expect(bundle.likely).toBe(2);
  });

  it("measures walking time from the viewer's origin, falling back to the scope centre", () => {
    expect(facets.find((f) => f.key === "walk-minutes")).toBeUndefined();

    const near = facetFor(computeFacets(candidates, scopeAt(1400)), "walk-minutes");
    expect(near.type).toBe("numeric");
    expect(near.unit).toBe("min");
    expect(near.histogram).toHaveLength(5);
    expect(near.histogram!.reduce((a, b) => a + b, 0)).toBe(candidates.length);
    expect(near.counts.unknown).toBe(0);

    // Same places, a centre two kilometres away: every reading moves. This is
    // the bug the seeded walk_min carried — it never noticed the scope moved.
    const moved: ScopeState = {
      ...scopeAt(1400),
      area: {
        kind: "circle",
        center: { lat: dataset.manifest.demoCenter.lat + 0.02, lng: dataset.manifest.demoCenter.lng },
        radiusM: 1400,
      },
    };
    const far = facetFor(computeFacets(candidates, moved), "walk-minutes");
    expect(far.range!.max).toBeGreaterThan(near.range!.max);

    const viewer = facetFor(
      computeFacets(candidates, scopeAt(1400), moved.area.center),
      "walk-minutes",
    );
    expect(viewer.range).toEqual(far.range);
  });
});

describe("activeNeeds carry the counterfactual deltas the brief rows show", () => {
  it("reports what each need alone rules out, leaves unknown, and would give back", () => {
    const inputs = inputsAt(800, demoRequirements());
    const joe = computeFacetsBundle(inputs, "p_joe");
    expect(joe.total).toBe(21); // in-scope places at 800 m, out of 31
    expect(joe.matching).toBe(0); // the demo impasse

    const lactose = joe.activeNeeds.find((n) => n.id === "req_2")!;
    expect(lactose.label).toBe("lactose-free options");
    expect(lactose.ruledOut).toBe(2); // two places verified as having none
    expect(lactose.unknown).toBe(19); // nineteen never checked
    // One place with no cuisine fact now stays unsure under the separate
    // cuisine exclusion, so dropping lactose recovers ten verified matches.
    expect(lactose.wouldReturn).toBe(10);

    // Sarah's vegetarian need excludes nothing at all — no place in the set is
    // verified as lacking it. It only makes places unsure, which is exactly
    // what "unverified is not a failure" means numerically.
    const veg = joe.activeNeeds.find((n) => n.id === "req_1")!;
    expect(veg.criterionId).toBe("vegetarian-options");
    expect(veg.ruledOut).toBe(0);
    expect(veg.unknown).toBe(9);

    expect(joe.activeNeeds.find((n) => n.id === "req_3")!.ruledOut).toBe(3); // italian
    expect(joe.activeNeeds.find((n) => n.id === "req_4")!.ruledOut).toBe(1); // over €15
    expect(joe.activeNeeds.find((n) => n.id === "req_4")).not.toHaveProperty("criterionId");
  });

  it("wouldReturn equals the actually recomputed set, never an estimate", () => {
    const requirements = demoRequirements();
    const inputs = inputsAt(800, requirements);
    const bundle = computeFacetsBundle(inputs, "p_joe");
    const places = inScope(candidates, inputs.scope);
    for (const need of bundle.activeNeeds) {
      const without = classifyAll(
        places,
        requirements.filter((r) => r.id !== need.id),
        [],
        inputs.scope,
      ).filter((r) => r.eligibility === "eligible").length;
      expect(need.wouldReturn, need.label).toBe(without - bundle.matching);
    }
  });

  it("labels every payload kind from the server's own vocabulary", () => {
    const label = (payload: RequirementRow["payload"]) =>
      labelForRequirement(req(payload), true);
    expect(label({ kind: "attribute", key: "wheelchair-accessible", expect: "verified_true" }))
      .toBe("step-free access");
    expect(label({ kind: "attribute", key: "outdoor-seating", expect: "verified_false" }))
      .toBe("no outdoor seating");
    expect(label({ kind: "budget", perPersonMax: { amount: 15, currency: "EUR" } }))
      .toBe("budget €15");
    expect(label({ kind: "budget", perPersonMax: { amount: 20, currency: "USD" } }))
      .toBe("budget $20");
    expect(label({ kind: "scope", dimension: "walk_min", max: 12 })).toBe("within 12 min walk of where you start");
    expect(label({ kind: "scope", dimension: "travel_min", max: 20, mode: "bike" }))
      .toBe("within 20 min by bike of where you start");
    expect(label({ kind: "scope", dimension: "travel_min", max: 15, mode: "car" }))
      .toBe("within 15 min by car of where you start");
    expect(label({ kind: "scope", dimension: "radius_m", max: 800 })).toBe("within 800 m of where you start");
    expect(label({ kind: "exclusion", key: "cuisine", values: ["italian"] })).toBe("avoid italian");
    expect(label({ kind: "inclusion", key: "cuisine", values: ["asian", "vietnamese"] })).toBe("only asian, vietnamese");
    expect(label({ kind: "text", text: "somewhere the kids can run" }))
      .toBe("somewhere the kids can run");
    const timeLabel = label({
      kind: "time",
      window: {
        start: "2026-09-04T12:00:00+02:00",
        end: "2026-09-04T14:00:00+02:00",
      },
    });
    expect(timeLabel).toBe("open Fri 12:00–14:00");
    expect(timeLabel).not.toContain("2026-");
    // agent-private: the server holds no content to label.
    expect(labelForRequirement(req(null, { visibility: "agent-private" }), true))
      .toBe("your agent's condition");
  });
});

describe("the privacy boundary: effects are public, contents are not", () => {
  it("gives peers a count and an owner, and the owner the need itself", () => {
    const inputs = inputsAt(800, demoRequirements());

    for (const peer of ["p_org", "p_sarah"]) {
      const view = computeFacetsBundle(inputs, peer);
      expect(view.activeNeeds.map((n) => n.id)).toEqual(["req_1", "req_3", "req_4"]);
      expect(view.privateEffects).toEqual([{ owner: "p_joe", ruledOut: 2 }]);
      // The effect is visible; nothing about the condition is. (The facets
      // array does name lactose-free options — it describes the DATA, not
      // anyone's need, and reads the same whether Joe stated one or not.)
      const attributable = JSON.stringify({
        activeNeeds: view.activeNeeds,
        privateEffects: view.privateEffects,
      });
      expect(attributable).not.toContain("lactose");
      expect(attributable).not.toContain("verified_true");
    }

    const owner = computeFacetsBundle(inputs, "p_joe");
    expect(owner.activeNeeds.map((n) => n.id)).toContain("req_2");
    expect(owner.privateEffects).toEqual([]);
  });

  it("passes through the owner's opt-in topic, and omits it when they gave none", () => {
    const withHint = computeFacetsBundle(
      inputsAt(800, [
        req({ kind: "scope", dimension: "walk_min", max: 5 }, {
          owner_id: "p_sarah",
          visibility: "application-private",
          scope_hint: { affects: "candidate-eligibility", category: "distance" },
        }),
      ]),
      "p_org",
    );
    expect(withHint.privateEffects[0].topic).toBe("distance");

    const without = computeFacetsBundle(
      inputsAt(800, [
        req({ kind: "scope", dimension: "walk_min", max: 5 }, {
          owner_id: "p_sarah",
          visibility: "application-private",
        }),
      ]),
      "p_org",
    );
    expect(without.privateEffects[0]).not.toHaveProperty("topic");
  });

  it("reports an agent-private need's effect as its screening verdicts, with no payload to leak", () => {
    const declaration = req(null, { owner_id: "p_joe", visibility: "agent-private" });
    const places = inScope(candidates, scopeAt(800));
    const bundle = computeFacetsBundle(
      {
        candidates,
        requirements: [declaration],
        verdicts: places.slice(0, 3).map((c, i) => ({
          owner_id: "p_joe",
          candidate_id: c.id,
          verdict: i === 0 ? "unacceptable" : "acceptable",
          screened_map_revision: c.map_revision,
        })),
        scope: scopeAt(800),
      },
      "p_org",
    );
    expect(bundle.privateEffects).toEqual([{ owner: "p_joe", ruledOut: 1 }]);
  });
});

describe("setting a need aside", () => {
  it("stops it classifying but keeps its row, greyed, with nothing to give back", () => {
    const requirements = demoRequirements();
    requirements[2].active = false; // the italian exclusion
    const bundle = computeFacetsBundle(inputsAt(800, requirements), "p_joe");

    const off = bundle.activeNeeds.find((n) => n.id === "req_3")!;
    expect(off.active).toBe(false);
    // What it WOULD rule out is still reported — that is the cost of turning
    // it back on — but it gives nothing back while it is off.
    expect(off.ruledOut).toBe(3);
    expect(off.wouldReturn).toBe(0);

    const on = computeFacetsBundle(inputsAt(800, demoRequirements()), "p_joe");
    expect(bundle.matching).toBeGreaterThanOrEqual(on.matching);
  });

  it("omits an inactive private need from privateEffects: no effect, nothing to report", () => {
    const requirements = demoRequirements();
    requirements[1].active = false; // Joe's private lactose need
    expect(computeFacetsBundle(inputsAt(800, requirements), "p_org").privateEffects)
      .toEqual([]);
  });

  it("previews a need's absence with the real classifier, not an estimate", () => {
    const requirements = demoRequirements();
    const live = computeFacetsBundle(inputsAt(1400, requirements), "p_joe");
    const preview = computeFacetsBundle(inputsAt(1400, requirements), "p_joe", "req_2");
    const withoutIt = computeFacetsBundle(
      inputsAt(1400, requirements.filter((r) => r.id !== "req_2")),
      "p_joe",
    );
    expect(preview.matching).toBe(withoutIt.matching);
    expect(preview.matching - live.matching).toBe(
      live.activeNeeds.find((n) => n.id === "req_2")!.wouldReturn,
    );
    expect(preview.activeNeeds.find((n) => n.id === "req_2")!.active).toBe(false);
  });
});

describe("free text needs", () => {
  it("produce no facet but retain a question criterion and real counts", () => {
    const text = req({ kind: "text", text: "somewhere the kids can run" });
    const bundle = computeFacetsBundle(inputsAt(1400, [text]), "p_org");
    expect(bundle.matching).toBe(0);
    const need = bundle.activeNeeds[0];
    expect(need.ruledOut).toBe(0);
    expect(need.unknown).toBe(bundle.total);
    expect(need.label).toBe("somewhere the kids can run");
    expect(need.criterionId).toMatch(/^q:[0-9a-f]{40}$/);
    expect(bundle.facets.some((facet) => facet.key === need.criterionId)).toBe(false);
  });
});

describe("time needs", () => {
  const window = {
    start: "2026-09-04T12:00:00+02:00",
    end: "2026-09-04T14:00:00+02:00",
  };
  const timeNeed = () => req({ kind: "time", window } as never);
  const base = candidates[0];
  const timed: CandidateRow[] = [
    {
      ...base, id: "t_yes", hours: [{ day: "fri", open: "11:00", close: "15:00" }],
      attributes: [{ key: "hours", status: "verified_true", source: "osm:opening_hours" }],
    },
    {
      ...base, id: "t_no", hours: [{ day: "fri", open: "11:00", close: "13:00" }],
      attributes: [{ key: "hours", status: "verified_true", source: "osm:opening_hours" }],
    },
    { ...base, id: "t_likely", hours: [], website_hours: ["Fr 11:00-15:00"], attributes: [] },
    { ...base, id: "t_unlikely", hours: [], website_hours: ["Fr 08:00-11:00"], attributes: [] },
    { ...base, id: "t_unknown", hours: [], attributes: [] },
  ];
  const inputs = (requirements: RequirementRow[]): EligibilityInputs => ({
    candidates: timed,
    requirements,
    verdicts: [],
    scope: null,
    timezone: "Europe/Berlin",
    now: new Date("2026-09-03T10:00:00+02:00"),
  });

  it("appears only for an active time need and its disjoint buckets sum to the set", () => {
    const need = timeNeed();
    const bundle = computeFacetsBundle(inputs([need]), "p_org");
    const criterionId = `open:${window.start}-${window.end}`;
    const facet = bundle.facets.find((item) => item.key === criterionId)!;
    expect(facet).toMatchObject({
      type: "temporal",
      label: "open tomorrow 12:00–14:00 (Fri)",
      counts: { yes: 1, likely: 1, unlikely: 1, no: 1, unknown: 1 },
    });
    expect(Object.values(facet.counts).reduce((sum, count) => sum + (count ?? 0), 0))
      .toBe(bundle.total);
    expect(bundle.activeNeeds[0].criterionId).toBe(criterionId);

    const inactive = computeFacetsBundle(inputs([{ ...need, active: false }]), "p_org");
    expect(inactive.facets.some((item) => item.type === "temporal")).toBe(false);
    expect(computeFacets(timed, null).some((item) => item.type === "temporal")).toBe(false);
  });
});
