import { describe, expect, it } from "vitest";
import { CUISINE_RULES, implies, normalizeCuisineTokens } from "../../packages/contracts/src/cuisine.ts";

/** T3.6: sourced cuisine implications are additive evidence, with noisy venue-type tags omitted. */
describe("cuisine taxonomy", () => {
  it("ships the four evidence blocks as 60 sourced rules", () => {
    expect(CUISINE_RULES).toHaveLength(60);
    expect(CUISINE_RULES.every((rule) => rule.evidence.length > 0)).toBe(true);
  });

  it("puts pizza at yes-level and contested curry below the yes threshold", () => {
    expect(implies("pizza")).toContainEqual({ cuisine: "italian", confidence: 0.95 });
    expect(implies("curry")).toContainEqual({ cuisine: "indian", confidence: 0.6 });
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

  it("leaves unspecific and noisy venue-type values without implications", () => {
    for (const token of ["regional", "local", "international", "chicken", "coffee_shop", "sandwich", "barbecue", "seafood", "noodle", "breakfast", "fish", "steak_house"]) {
      expect(implies(token), token).toEqual([]);
    }
  });
});
