import { describe, expect, it } from "vitest";
import { classifyAll, feasibilityOf, whyFor, type CandidateRow, type RequirementRow } from "../../apps/server/src/eligibility.ts";
import { computeFacetsBundle } from "../../apps/server/src/facets.ts";
import { applyGuesses, guessesFor } from "../../apps/server/src/guess.ts";
import { graded, normalizeStatus } from "../../packages/contracts/src/status.ts";

/**
 * Graded evidence (SPATIAL-PROTOCOL.md §8.2): a likely fact yields likely /
 * unlikely with its confidence, never in or out; guesses fill only unknown
 * slots and say why; the old `unverified` reads as likely at ≤ 0.5.
 */

const candidate = (id: string, attributes: CandidateRow["attributes"], category = "restaurant"): CandidateRow => ({
  id, name: id, category, price_level: null, walk_min: 5, location: { lat: 52.5, lng: 13.4 }, attributes,
});
const need = (key: string, expect: "verified_true" | "verified_false" = "verified_true", id = `r_${key}`): RequirementRow => ({
  id, owner_id: "p_joe", visibility: "shared", hardness: "hard",
  payload: { kind: "attribute", key, expect }, withdrawn: false,
});

describe("status vocabulary", () => {
  it("reads legacy unverified as likely at no more than 0.5 and fills a missing confidence", () => {
    expect(normalizeStatus({ status: "unverified", confidence: 0.9 })).toMatchObject({ status: "likely_true", confidence: 0.5 });
    expect(normalizeStatus({ status: "unverified" })).toMatchObject({ status: "likely_true", confidence: 0.5 });
    expect(normalizeStatus({ status: "verified_true" })).toMatchObject({ status: "verified_true", confidence: 0.8 });
    expect(normalizeStatus({ status: "nonsense" })).toMatchObject({ status: "unknown", confidence: 0 });
  });
  it("grades by confidence", () => {
    expect(graded(true, 0.7)).toBe("verified_true");
    expect(graded(true, 0.69)).toBe("likely_true");
    expect(graded(false, 0.2)).toBe("likely_false");
  });
});

describe("classifier", () => {
  it("a likely fact with a need reads likely, against a need reads unlikely, and confidences compound", () => {
    const rows = classifyAll(
      [
        candidate("c_likely", [{ key: "vegan-options", status: "likely_true", confidence: 0.6 }, { key: "outdoor-seating", status: "likely_true", confidence: 0.5 }]),
        candidate("c_unlikely", [{ key: "vegan-options", status: "likely_false", confidence: 0.55 }, { key: "outdoor-seating", status: "verified_true" }]),
        candidate("c_mixed", [{ key: "vegan-options", status: "likely_true", confidence: 0.6 }, { key: "outdoor-seating", status: "unknown" }]),
        candidate("c_sure", [{ key: "vegan-options", status: "verified_true" }, { key: "outdoor-seating", status: "verified_true" }]),
        candidate("c_no", [{ key: "vegan-options", status: "verified_false" }, { key: "outdoor-seating", status: "likely_true", confidence: 0.6 }]),
      ],
      [need("vegan-options"), need("outdoor-seating")],
      [], null,
    );
    const by = Object.fromEntries(rows.map((r) => [r.candidateId, r]));
    expect(by.c_likely).toMatchObject({ eligibility: "likely", confidence: 0.3 });
    expect(whyFor(by.c_likely, "p_peer")).toBe("vegan-options likely; outdoor-seating likely");
    expect(by.c_unlikely).toMatchObject({ eligibility: "unlikely", confidence: 0.55 });
    expect(whyFor(by.c_unlikely, "p_peer")).toBe("vegan-options unlikely");
    // A gap outranks a guess for it: honest uncertainty first.
    expect(by.c_mixed.eligibility).toBe("uncertain");
    expect(by.c_sure.eligibility).toBe("eligible");
    // A verified no still excludes, whatever else is likely.
    expect(by.c_no.eligibility).toBe("excluded");
    expect(feasibilityOf(rows)).toMatchObject({ eligible: 1, likely: 1, uncertain: 1, unlikely: 1, excluded: 1 });
  });

  it("a likely cuisine makes inclusion and exclusion likely / unlikely instead of in / out", () => {
    const cuisineNeed: RequirementRow = { id: "r_in", owner_id: "p", visibility: "shared", hardness: "hard", payload: { kind: "inclusion", key: "cuisine", values: ["thai"] }, withdrawn: false };
    const rows = classifyAll(
      [
        candidate("c_thai", [{ key: "cuisine", status: "likely_true", value: "thai", confidence: 0.7 }]),
        candidate("c_pizza", [{ key: "cuisine", status: "likely_true", value: "pizza", confidence: 0.7 }]),
      ],
      [cuisineNeed], [], null,
    );
    expect(rows[0].eligibility).toBe("likely");
    expect(rows[1].eligibility).toBe("unlikely");
  });

  it("counts likely apart in the facets bundle and on the need row, never in matching", () => {
    const bundle = computeFacetsBundle(
      {
        candidates: [
          candidate("a", [{ key: "vegan-options", status: "likely_true", confidence: 0.6 }]),
          candidate("b", [{ key: "vegan-options", status: "verified_true" }]),
          candidate("c", [{ key: "vegan-options", status: "unknown" }]),
          candidate("d", [{ key: "vegan-options", status: "likely_false", confidence: 0.5 }]),
        ],
        requirements: [need("vegan-options")],
        verdicts: [],
        scope: null,
      },
      "p_joe",
    );
    expect(bundle.matching).toBe(1);
    expect(bundle.likely).toBe(1);
    expect(bundle.activeNeeds[0]).toMatchObject({ ruledOut: 0, unknown: 1, likely: 1, unlikely: 1 });
    const facet = bundle.facets.find((f) => f.key === "vegan-options")!;
    expect(facet.counts).toEqual({ yes: 1, likely: 1, unlikely: 1, no: 0, unknown: 1 });
  });
});

describe("guesses", () => {
  it("guess from the kind of place, with a reason, only into unknown slots", () => {
    expect(guessesFor("restaurant", "indian").map((g) => [g.key, g.status, g.source])).toEqual([
      ["vegetarian-options", "likely_true", "guess:cuisine"],
    ]);
    expect(guessesFor("restaurant", "steak_house").find((g) => g.key === "vegetarian-options")).toMatchObject({ status: "likely_false" });
    expect(guessesFor("fast_food", undefined)).toEqual([
      expect.objectContaining({ key: "price-level", status: "likely_true", value: 1, source: "guess:amenity" }),
    ]);
    expect(guessesFor("restaurant", "vegan").map((g) => g.key)).toEqual(["vegetarian-options", "vegan-options"]);
    expect(guessesFor("restaurant", undefined)).toEqual([]);

    const out = applyGuesses(
      "restaurant",
      [
        { key: "cuisine", status: "verified_true", value: "indian;curry" },
        { key: "vegetarian-options", status: "verified_false" },
        { key: "halal-options", status: "unknown" },
      ],
      "2026-09-02T00:00:00Z",
    );
    const by = Object.fromEntries(out.map((a) => [a.key, a]));
    // A verified no is never overwritten by a guess for yes.
    expect(by["vegetarian-options"].status).toBe("verified_false");
    expect(by["halal-options"].status).toBe("unknown");
    expect(by["price-level"]).toBeUndefined();
  });
});
