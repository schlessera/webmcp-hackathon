import { describe, expect, it } from "vitest";
import {
  CUISINE_IMPLICATION_SATISFACTION_FLOOR,
  CUISINE_RULES,
  implies,
  normalizeCuisineTokens,
} from "../../packages/contracts/src/cuisine.ts";
import { VERIFIED_CONFIDENCE_FLOOR } from "../../packages/contracts/src/status.ts";

/** T3.6: sourced cuisine implications are additive evidence, with noisy venue-type tags omitted. */
describe("cuisine taxonomy", () => {
  it("ships the four evidence blocks plus two sourced connective rules", () => {
    expect(CUISINE_RULES).toHaveLength(62);
    expect(CUISINE_RULES.every((rule) => rule.evidence.length > 0)).toBe(true);
  });

  it("puts pizza at yes-level and contested curry below the yes threshold", () => {
    expect(implies("pizza")).toContainEqual({ cuisine: "italian", confidence: 0.95 });
    expect(implies("curry")).toContainEqual({ cuisine: "indian", confidence: 0.6 });
    expect(CUISINE_IMPLICATION_SATISFACTION_FLOOR).toBe(VERIFIED_CONFIDENCE_FLOOR);
  });

  it("normalizes case, semicolon lists, italian_pizza, and named spelling drift", () => {
    expect(normalizeCuisineTokens([" Pizza ; HOTPOT ", "Italian_Pizza;taco"])).toEqual([
      "pizza", "hot_pot", "italian", "tacos",
    ]);
    expect(implies("PIZZA; taco").map((row) => row.cuisine)).toEqual(expect.arrayContaining(["italian", "mexican"]));
  });

  it("allows one extra transitive hop with multiplied confidence", () => {
    expect(implies("sichuan")).toContainEqual({ cuisine: "asian", confidence: 0.855 });
  });

  it("connects paella to Spanish and shawarma to Middle Eastern cuisine", () => {
    expect(implies("paella").find((row) => row.cuisine === "spanish")?.confidence)
      .toBeCloseTo(0.72);
    expect(implies("shawarma").find((row) => row.cuisine === "middle_eastern")?.confidence)
      .toBeCloseTo(0.72);
  });

  it("leaves unspecific and noisy venue-type values without implications", () => {
    for (const token of ["regional", "local", "international", "chicken", "coffee_shop", "sandwich", "barbecue", "seafood", "noodle", "breakfast", "fish", "steak_house"]) {
      expect(implies(token), token).toEqual([]);
    }
  });
});
