import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { criterionFor, normalizeQuestion, questionKey } from "../../packages/contracts/src/criteria.ts";

/** E1: every askable need maps to one stable fact identity; deterministic needs do not. */
describe("criterionFor", () => {
  it("maps vocabulary attributes to their labelled key criterion", () => {
    expect(criterionFor({ kind: "attribute", key: "wheelchair-accessible", expect: "verified_true" })).toEqual({
      id: "wheelchair-accessible", kind: "key", key: "wheelchair-accessible", label: "step-free access",
    });
  });

  it("gives equivalent question sentences the same browser-safe SHA-1 identity", () => {
    const variants = ["  Can   the kids RUN? ", "can the kids run.", "CAN THE KIDS RUN"];
    const expected = `q:${createHash("sha1").update("can the kids run").digest("hex")}`;
    expect(new Set(variants.map(questionKey))).toEqual(new Set([expected]));
    expect(normalizeQuestion(variants[0])).toBe("can the kids run");
    expect(criterionFor({ kind: "text", text: variants[0] })).toEqual({
      id: expected,
      kind: "question",
      text: "can the kids run",
      label: "Can the kids RUN?",
    });
  });

  it("maps both cuisine predicates to one cuisine criterion", () => {
    const criterion = { id: "cuisine", kind: "key", key: "cuisine", label: "cuisine" };
    expect(criterionFor({ kind: "inclusion", key: "cuisine", values: ["italian"], lifetime: "session" })).toEqual(criterion);
    expect(criterionFor({ kind: "exclusion", key: "cuisine", values: ["italian"], lifetime: "durable" })).toEqual(criterion);
  });

  it("does not create lookup work for budget or scope predicates", () => {
    expect(criterionFor({ kind: "budget", perPersonMax: { amount: 20, currency: "EUR" } })).toBeNull();
    expect(criterionFor({ kind: "scope", dimension: "walk_min", max: 10 })).toBeNull();
  });
});
