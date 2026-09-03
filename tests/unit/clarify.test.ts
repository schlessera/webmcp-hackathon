import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Concept, Interpretation } from "@webmcp-hackathon/contracts";
import { mapInterpretation, type UnderstandInput } from "../../apps/server/src/nl/understand/map.ts";
import { setTransport } from "../../apps/server/src/nl/openai.ts";

beforeEach(() => setTransport(async () => { throw new Error("model called"); }));
afterEach(() => setTransport(null));

const baseConcept: Concept = {
  role: "money",
  surface: "under 20",
  polarity: "include",
  hardness: "hard",
  quantity: { value: 20, unit: null, bound: "max" },
  mode: null,
  referent: null,
  attributeKey: null,
  values: [],
  window: null,
  phrase: null,
  topic: "budget",
  unresolved: "unit",
  gist: "under twenty",
  origin: "preparse",
};

function room(scope = "shared", overrides: Partial<UnderstandInput["room"]> = {}): UnderstandInput {
  return {
    text: "under 20",
    scope,
    room: {
      areaId: "berlin-mitte",
      timezone: "Europe/Berlin",
      currency: "EUR",
      now: new Date("2026-09-03T10:00:00Z"),
      hasOwnOrigin: true,
      transport: ["walk", "bike"],
      facets: [{ key: "wheelchair-accessible", label: "step-free access", type: "boolean", counts: { yes: 3, unknown: 1 } }],
      activeNeeds: [],
      candidateWalkMinutes: [4, 10, 20],
      candidateNames: [],
      participantNames: [],
      ...overrides,
    },
  };
}

function interpretation(concepts: Concept[], intent: Interpretation["intent"] = "need", confidence = 1): Interpretation {
  return { intent, concepts, confidence, reply: null, meta: { model: null, ms: 0, preparsedWhole: true } };
}

describe("clarification composition", () => {
  it("offers two concrete unit readings", () => {
    const out = mapInterpretation(interpretation([baseConcept]), room());
    expect(out.intent).toBe("clarify");
    expect(out.clarify).toMatchObject({
      question: "20 what?",
      allowFreeText: true,
      said: "under 20",
      choices: [{ label: "€20 per person" }, { label: "20 min walk" }],
    });
  });

  it("offers each available mode instead of guessing", () => {
    const travel: Concept = {
      ...baseConcept,
      role: "travel_time",
      surface: "under 10 min",
      quantity: { value: 10, unit: "min", bound: "max" },
      referent: { kind: "self", name: null },
      unresolved: null,
      gist: "travel time",
    };
    const out = mapInterpretation(interpretation([travel]), { ...room(), text: travel.surface });
    expect(out.clarify?.choices.map((choice) => choice.label)).toEqual(["10 min on foot", "10 min by bike"]);
  });

  it("submits an understood part while asking about the rest", () => {
    const distance: Concept = {
      ...baseConcept,
      role: "distance",
      surface: "within 500 m",
      quantity: { value: 500, unit: "m", bound: "max" },
      referent: { kind: "self", name: null },
      unresolved: null,
      gist: "distance",
    };
    const out = mapInterpretation(interpretation([distance, baseConcept]), room());
    expect(out.intent).toBe("clarify");
    expect(out.needs).toHaveLength(1);
    expect(out.needs[0].payload).toMatchObject({ kind: "scope", dimension: "radius_m", max: 500 });
  });

  it("applies safe assumptions instead of asking", () => {
    const close: Concept = {
      ...baseConcept,
      role: "travel_time",
      surface: "close by",
      quantity: { value: 10, unit: "min", bound: "max" },
      mode: "walk",
      referent: { kind: "self", name: null },
      unresolved: null,
      gist: "close by",
    };
    const out = mapInterpretation(interpretation([close]), room("shared", { hasOwnOrigin: false }));
    expect(out.intent).toBe("need");
    expect(out.clarify).toBeNull();
    expect(out.needs[0].assumed).toContain("area centre");
  });

  it("never exposes a clarification card for agent-private scope", () => {
    const out = mapInterpretation(interpretation([baseConcept]), room("agent-private"));
    expect(out.clarify).toBeNull();
    expect(out.intent).not.toBe("clarify");
  });

  it("uses room facets for unclear suggestions", () => {
    const out = mapInterpretation(interpretation([], "other"), { ...room(), text: "hi there" });
    expect(out.intent).toBe("unclear");
    expect(out.suggestions?.map((choice) => choice.label)).toEqual([
      "step-free access",
      "within 10 min walk",
      "budget €25",
    ]);
  });

  it("keeps clarification copy within the COPY rules", () => {
    const out = mapInterpretation(interpretation([baseConcept]), room());
    const strings = [out.clarify!.question, ...out.clarify!.choices.map((choice) => choice.label)];
    expect(out.clarify!.choices.length).toBeGreaterThanOrEqual(2);
    expect(out.clarify!.choices.length).toBeLessThanOrEqual(3);
    for (const text of strings) {
      expect(text).not.toContain("!");
      expect(text.length).toBeLessThanOrEqual(text === out.clarify!.question ? 120 : 60);
      expect(text).not.toMatch(/\bfilter\b/i);
    }
    expect(out.clarify!.question[0]).toMatch(/[A-Z0-9€$]/);
  });
});
