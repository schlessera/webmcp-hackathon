import { afterEach, describe, expect, it, vi } from "vitest";
import type { EligibilityInputs } from "../../apps/server/src/eligibility.ts";
import {
  buildRefinementQueue,
  exhaustRefinementBudgetsForTest,
  REFINE_IDLE_STOP_MS,
  refinementActive,
  refinementBudgetSleepForTest,
  refinementLookupReason,
  resetRefinement,
  startRefinement,
  noteRefinementPresence,
  searchRefinementPlaces,
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
  });

  it("dedupes a place already evaluated for the same criterion set", () => {
    const evaluated = new Map([["active-near", new Set(["dog-friendly"])]]);
    expect(buildRefinementQueue(inputs(), { evaluated, providerChecked: new Set() }, "room")
      .some((item) => item.candidate.id === "active-near")).toBe(false);
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
    const first = refinementBudgetSleepForTest("budget-room", 1, 1, 1_000);
    const second = refinementBudgetSleepForTest("budget-room", 1, 1, 1_000);
    expect(first).toBeGreaterThan(0);
    expect(second).toBe(first);
    expect(log).toHaveBeenCalledTimes(1);
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

  it("keeps 12 places in one batch and searches once per place for all criteria", async () => {
    const criterionA = { id: "a", kind: "key" as const, key: "a", label: "first words" };
    const criterionB = { id: "b", kind: "key" as const, key: "b", label: "second words" };
    const provider = vi.fn(async () => []);
    const requests = Array.from({ length: 12 }, (_, index) => ({
      candidateId: `p${index}`,
      name: `Place ${index}`,
      website: `https://place${index}.example/about`,
      criteria: [criterionA, criterionB],
    }));
    const responses = await searchRefinementPlaces(requests, "Berlin", provider);
    expect(responses).toHaveLength(12);
    expect(provider).toHaveBeenCalledTimes(12);
    for (const [query, opts] of provider.mock.calls) {
      expect(query).toContain("Berlin first words second words");
      expect(opts).toMatchObject({ domains: [expect.stringMatching(/^place\d+\.example$/)] });
    }
  });
});
