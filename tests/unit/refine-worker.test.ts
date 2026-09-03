import { afterEach, describe, expect, it, vi } from "vitest";
import type { EligibilityInputs } from "../../apps/server/src/eligibility.ts";
import {
  buildRefinementQueue,
  buildRefinementQuery,
  exhaustRefinementBudgetsForTest,
  exhaustRefinementSearchesForTest,
  refinementView,
  REFINE_IDLE_STOP_MS,
  refinementActive,
  refinementBudgetSleepForTest,
  refinementLookupReason,
  refinementQueueCounts,
  refinementTickDelay,
  REFINE_IDLE_TICK_MS,
  REFINE_SEARCH_CONCURRENCY,
  REFINE_TICK_MS,
  resetRefinement,
  startRefinement,
  noteRefinementPresence,
  searchRefinementPlaces,
  refinementSearchDomains,
} from "../../apps/server/src/refine/worker.ts";
import { resetProgress } from "../../apps/server/src/enrich/progress.ts";

const keys = [
  "vegetarian-options", "vegan-options", "gluten-free-options", "halal-options",
  "lactose-free-options", "wheelchair-accessible", "outdoor-seating", "dog-friendly",
  "takeaway", "delivery", "price-level",
];

function attributes(overrides: Record<string, { status: string; observedAt?: string }> = {}) {
  return keys.map((key) => ({ key, status: overrides[key]?.status ?? "verified_true", ...(overrides[key]?.observedAt ? { observedAt: overrides[key].observedAt } : {}) }));
}

function inputs(visibility = "shared"): EligibilityInputs {
  const old = "2020-01-01T00:00:00.000Z";
  return {
    candidates: [
      { id: "active-far", map_revision: 1, osm_ref: "node/1", name: "A", category: "cafe", price_level: 2, walk_min: 5, location: { lat: 1, lng: 1 }, attributes: attributes({ "dog-friendly": { status: "unknown" } }) },
      { id: "active-near", map_revision: 1, osm_ref: "node/2", name: "B", category: "cafe", price_level: 2, walk_min: 2, location: { lat: 1, lng: 1 }, attributes: attributes({ "dog-friendly": { status: "unknown" } }) },
      { id: "stale", map_revision: 1, osm_ref: "node/3", name: "C", category: "cafe", price_level: 2, walk_min: 1, location: { lat: 1, lng: 1 }, attributes: attributes(Object.fromEntries(keys.map((key) => [key, { status: "verified_true", observedAt: old }]))) },
      { id: "vocabulary", map_revision: 1, osm_ref: "node/4", name: "D", category: "cafe", price_level: 2, walk_min: 1, location: { lat: 1, lng: 1 }, attributes: attributes({ delivery: { status: "unknown" } }) },
    ],
    requirements: [{ id: "need", owner_id: "p", visibility, hardness: "hard", payload: { kind: "attribute", key: "dog-friendly", expect: "verified_true" }, withdrawn: false, active: true }],
    verdicts: [],
    scope: null,
  };
}

afterEach(() => {
  resetRefinement();
  resetProgress();
});

describe("continuous refinement queue", () => {
  it("orders active gaps by distance, then stale facts, then vocabulary gaps", () => {
    const queue = buildRefinementQueue(inputs(), { evaluated: new Map(), providerChecked: new Set() }, "room", Date.parse("2026-09-03T00:00:00Z"));
    expect(queue.map((item) => [item.candidate.id, item.tier])).toEqual([
      ["active-near", 1],
      ["active-far", 1],
      ["stale", 2],
      ["vocabulary", 3],
    ]);
    expect(refinementQueueCounts(queue)).toEqual({ total: 4, tier1: 2 });
  });

  it("dedupes a place already evaluated for the same criterion set", () => {
    const evaluated = new Map([["active-near", new Set(["dog-friendly"])]]);
    expect(buildRefinementQueue(inputs(), { evaluated, providerChecked: new Set() }, "room")
      .some((item) => item.candidate.id === "active-near")).toBe(false);
  });

  it("honours the persisted three-attempt daily cell cap", () => {
    const value = inputs();
    const today = Date.parse("2026-09-03T12:00:00Z");
    value.enrichments = new Map([["node/2", {
      osmRef: "node/2",
      fetchedAt: "2026-09-03T00:00:00Z",
      website: null,
      wikidata: null,
      inferred: {
        "dog-friendly": {
          omitted: true,
          observedAt: "2026-09-03T11:00:00Z",
          searchDay: "2026-09-03",
          searchAttempts: 3,
        },
      },
      error: null,
    }]]);
    const state = { evaluated: new Map(), providerChecked: new Set() };
    expect(buildRefinementQueue(value, state, "room", today)
      .some((item) => item.candidate.id === "active-near")).toBe(false);
    expect(buildRefinementQueue(value, state, "room", today + 24 * 60 * 60_000)
      .some((item) => item.candidate.id === "active-near")).toBe(true);
  });

  it("does not queue a time-window criterion for model evaluation", () => {
    const value = inputs();
    value.candidates = [value.candidates[0]];
    value.candidates[0].attributes = attributes();
    value.requirements = [{
      id: "time-need",
      owner_id: "p",
      visibility: "shared",
      hardness: "hard",
      payload: {
        kind: "time",
        window: {
          start: "2026-09-04T12:00:00+02:00",
          end: "2026-09-04T14:00:00+02:00",
        },
      },
      withdrawn: false,
      active: true,
    }];
    expect(buildRefinementQueue(
      value,
      { evaluated: new Map(), providerChecked: new Set() },
      "room",
    )).toEqual([]);
  });

  it("skips a place excluded by another active need and orders uncertain places by centre distance", () => {
    const value = inputs();
    value.scope = {
      scopeId: "scope",
      area: { kind: "circle", center: { lat: 52.52, lng: 13.4 }, radiusM: 5_000 },
      transport: ["walk"],
      category: "food",
    };
    value.candidates[0].location = { lat: 52.5201, lng: 13.4 };
    value.candidates[0].walk_min = 99;
    value.candidates[1].location = { lat: 52.53, lng: 13.4 };
    value.candidates[1].walk_min = 1;
    value.candidates[1].attributes = attributes({
      "dog-friendly": { status: "unknown" },
      delivery: { status: "verified_false" },
    });
    value.requirements.push({
      id: "delivery-need",
      owner_id: "p",
      visibility: "shared",
      hardness: "hard",
      payload: { kind: "attribute", key: "delivery", expect: "verified_true" },
      withdrawn: false,
      active: true,
    });
    const queue = buildRefinementQueue(
      value,
      { evaluated: new Map(), providerChecked: new Set() },
      "room",
    );
    expect(queue.some((item) => item.candidate.id === "active-near")).toBe(false);
    expect(queue[0].candidate.id).toBe("active-far");
    expect(queue[0].tier).toBe(1);
  });

  it("allows a label only when the sole reason is shared", () => {
    const shared = inputs("shared");
    const privateInputs = inputs("application-private");
    const item = buildRefinementQueue(shared, { evaluated: new Map(), providerChecked: new Set() }, "room")[0];
    expect(refinementLookupReason([item], shared)).toEqual({ kind: "refine", label: "dogs welcome" });
    expect(refinementLookupReason([item], privateInputs)).toEqual({ kind: "refine" });
  });

  it("sleeps for refill and logs one line for a budget pause", () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    exhaustRefinementBudgetsForTest("budget-room", 1_000);
    const first = refinementBudgetSleepForTest("budget-room", 1, 1_000);
    const second = refinementBudgetSleepForTest("budget-room", 1, 1_000);
    expect(first).toBeGreaterThan(0);
    expect(second).toBe(first);
    expect(log).toHaveBeenCalledTimes(1);
    expect(refinementView("budget-room", undefined, 1_000).paused).toBe("budget");
  });

  it("keeps working on site text when only the searches run out", () => {
    // The walk found a 343-place room out of searches 16 seconds after the
    // first need. Searches going quiet must not stop the reading.
    exhaustRefinementSearchesForTest("dry-room", 1_000);
    expect(refinementBudgetSleepForTest("dry-room", 2, 1_000)).toBe(0);
    const view = refinementView("dry-room", undefined, 1_000);
    expect(view.budgetLeft.searches).toBe(0);
    expect(view.budgetLeft.calls).toBeGreaterThan(0);
    expect(view.paused).toBe(null);
  });

  it("says why a still room is still", () => {
    process.env.ENRICH_NETWORK = "1";
    process.env.INFER = "1";
    process.env.OPENAI_API_KEY = "test";
    expect(refinementView("absent-room").paused).toBe("idle");
    startRefinement("present-room", false);
    expect(refinementView("present-room").paused).toBe(null);
    delete process.env.OPENAI_API_KEY;
    delete process.env.INFER;
    delete process.env.ENRICH_NETWORK;
  });

  it("stops ten minutes after the room becomes empty", () => {
    vi.useFakeTimers();
    process.env.ENRICH_NETWORK = "1";
    process.env.INFER = "1";
    process.env.OPENAI_API_KEY = "test";
    expect(startRefinement("idle-room", false)).toBe(true);
    noteRefinementPresence("idle-room", new Set());
    expect(refinementActive("idle-room")).toBe(true);
    vi.advanceTimersByTime(REFINE_IDLE_STOP_MS - 1);
    expect(refinementActive("idle-room")).toBe(true);
    vi.advanceTimersByTime(1);
    expect(refinementActive("idle-room")).toBe(false);
    delete process.env.OPENAI_API_KEY;
    delete process.env.INFER;
    delete process.env.ENRICH_NETWORK;
    vi.useRealTimers();
  });

  it("backs off when there is nothing left to refine", () => {
    expect(refinementTickDelay(1)).toBe(REFINE_TICK_MS);
    expect(refinementTickDelay(0)).toBe(REFINE_IDLE_TICK_MS);
    expect(REFINE_IDLE_TICK_MS).toBeGreaterThan(REFINE_TICK_MS);
  });

  it("bounds searches globally across concurrent room batches", async () => {
    const criterionA = { id: "a", kind: "key" as const, key: "a", label: "first words" };
    const criterionB = { id: "b", kind: "key" as const, key: "b", label: "second words" };
    let active = 0;
    let peak = 0;
    const provider = vi.fn(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return [];
    });
    const requests = Array.from({ length: 12 }, (_, index) => ({
      candidateId: `p${index}`,
      osmRef: `node/${index}`,
      name: `Place ${index}`,
      category: "cafe",
      website: `https://place${index}.example/about`,
      siteTextUsable: true,
      criteria: [criterionA, criterionB],
      searchCriteria: [criterionA, criterionB],
    }));
    const area = {
      city: "Berlin",
      label: "Berlin Mitte",
      countryCode: "DE",
    };
    const responses = (await Promise.all([
      searchRefinementPlaces(requests.slice(0, 6), area, provider),
      searchRefinementPlaces(requests.slice(6), area, provider),
    ])).flat();
    expect(responses).toHaveLength(12);
    expect(provider).toHaveBeenCalledTimes(12);
    expect(peak).toBe(REFINE_SEARCH_CONCURRENCY);
    for (const [query, opts] of provider.mock.calls) {
      expect(query).toMatch(/^Place \d+ Berlin first words second words$/);
      expect(opts).toBeUndefined();
    }
  });

  it("drops a cuisine-only item before lookup progress is announced", () => {
    const value = inputs();
    value.candidates = [value.candidates[0]];
    value.candidates[0].attributes = attributes();
    value.requirements = [{
      id: "cuisine-need",
      owner_id: "p",
      visibility: "shared",
      hardness: "hard",
      payload: { kind: "inclusion", key: "cuisine", values: ["italian"] },
      withdrawn: false,
      active: true,
    }];
    expect(buildRefinementQueue(
      value,
      { evaluated: new Map(), providerChecked: new Set() },
      "room",
    )).toEqual([]);
  });

  it("uses a venue domain only when its site had no usable text", () => {
    expect(refinementSearchDomains({
      website: "https://venue.example/about",
      siteTextUsable: true,
    })).toBeUndefined();
    expect(refinementSearchDomains({ website: undefined, siteTextUsable: false })).toBeUndefined();
    expect(refinementSearchDomains({
      website: "https://venue.example/about",
      siteTextUsable: false,
    })).toEqual(["venue.example"]);
  });

  it("keeps address, category, and private criteria out of outbound queries", () => {
    const criteria = [
      { id: "wheelchair-accessible", kind: "key" as const, key: "wheelchair-accessible", label: "step-free access" },
      { id: "q:one", kind: "question" as const, text: "room for a tandem stroller", label: "room for a tandem stroller" },
    ];
    const request = {
      name: "Ort",
      category: "biergarten",
      address: "Teststraße 7, 10115 Berlin",
      criteria,
      searchCriteria: [criteria[0]],
    };
    const german = buildRefinementQuery(request, {
      city: "Berlin",
      label: "Berlin Mitte",
      countryCode: "DE",
    }, "shaped");
    expect(german).toBe("Ort Berlin step-free access");
    const english = buildRefinementQuery({ ...request, address: undefined }, {
      city: "San Francisco",
      label: "San Francisco SoMa",
      countryCode: "US",
    }, "shaped");
    expect(english).toBe("Ort San Francisco step-free access");
    expect(german).not.toContain("room for a tandem stroller");
  });

  it("sends only the place identity and shared need words", () => {
    const request = {
      name: "Ort",
      searchCriteria: [
        { id: "wheelchair-accessible", kind: "key" as const, key: "wheelchair-accessible", label: "step-free access" },
      ],
    };
    const area = { city: "Berlin", label: "Berlin Mitte", countryCode: "DE" };
    const query = buildRefinementQuery(request, area);
    expect(query).toBe("Ort Berlin step-free access");
    // The district, the category and a local-language lexicon were all in the
    // query the privacy ruling retired. None of them may come back.
    expect(query).not.toContain("Mitte");
    expect(query).not.toContain("barrierefrei");
  });
});
