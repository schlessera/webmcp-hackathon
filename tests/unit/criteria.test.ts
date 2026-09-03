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

  it("maps both cuisine predicates to one answerable, value-specific cuisine criterion", () => {
    const criterion = {
      id: expect.stringMatching(/^cuisine:[0-9a-f]{40}$/),
      kind: "key",
      key: "cuisine",
      label: "serves italian food",
      values: ["italian"],
      question: "Does this place serve italian food?",
    };
    expect(criterionFor({ kind: "inclusion", key: "cuisine", values: ["italian"], lifetime: "session" })).toEqual(criterion);
    expect(criterionFor({ kind: "exclusion", key: "cuisine", values: ["italian"], lifetime: "durable" })).toEqual(criterion);
    expect(criterionFor({ kind: "inclusion", key: "cuisine", values: ["japanese"], lifetime: "session" })?.id)
      .not.toBe(criterionFor({ kind: "inclusion", key: "cuisine", values: ["italian"], lifetime: "session" })?.id);
  });

  it("gives a time window a stable key criterion and a composed label", () => {
    const payload = {
      kind: "time" as const,
      window: {
        start: "2026-09-02T12:00:00+02:00",
        end: "2026-09-02T14:00:00+02:00",
      },
      phrase: "open tomorrow for lunch",
    };
    expect(criterionFor(payload, {
      timezone: "Europe/Berlin",
      now: new Date("2026-09-01T10:00:00+02:00"),
    })).toEqual({
      id: "open:2026-09-02T12:00:00+02:00-2026-09-02T14:00:00+02:00",
      kind: "key",
      key: "open:2026-09-02T12:00:00+02:00-2026-09-02T14:00:00+02:00",
      label: "open tomorrow 12:00–14:00 (Wed)",
    });
  });

  it("does not create lookup work for budget or scope predicates", () => {
    expect(criterionFor({ kind: "budget", perPersonMax: { amount: 20, currency: "EUR" } })).toBeNull();
    expect(criterionFor({ kind: "scope", dimension: "walk_min", max: 10 })).toBeNull();
  });
});
