import { afterEach, describe, expect, it } from "vitest";
import type { SpatialContextResult } from "@webmcp-hackathon/contracts";
import { say } from "../../apps/server/src/nl/say.ts";
import { setTransport } from "../../apps/server/src/nl/openai.ts";
import { installLandmarksForTests, resetLandmarks } from "../../apps/server/src/landmarks.ts";
import { shouldPreserveNlText } from "../../apps/web/src/nl-result.ts";

const context = {
  ok: true,
  revision: 3,
  phase: "gathering",
  scope: { scopeId: "s", area: { kind: "circle", center: { lat: 52.5, lng: 13.4 }, radiusM: 800 }, transport: ["walk"], category: "places" },
  area: { areaId: "berlin-mitte", label: "Berlin Mitte", kind: "osm-snapshot", source: "test", dataAsOf: "2026-09-01T00:00:00Z", poolSize: 15, focusVenues: 15 },
  feasibility: { state: "feasible", eligible: 10, likely: 0, uncertain: 2, unlikely: 0, excluded: 3 },
  total: 15,
  matching: 10,
  likely: 0,
  candidates: [],
  facets: [{
    key: "cuisine", label: "cuisine", type: "enum", counts: { unknown: 2 },
    values: [{ value: "italian", label: "Italian", count: 3 }, { value: "vietnamese", label: "Vietnamese", count: 2 }],
  }],
  activeNeeds: [],
  privateEffects: [],
  participants: [],
  proposals: [],
} as unknown as SpatialContextResult;

const draftConcept = (overrides: Record<string, unknown>) => ({
  role: "quality",
  surface: "quiet",
  polarity: "include",
  hardness: "hard",
  quantityValue: null,
  quantityUnit: null,
  quantityBound: null,
  mode: null,
  referentKind: null,
  referentName: null,
  attributeKey: null,
  values: [],
  dayRef: null,
  dayPart: null,
  clockHour: null,
  clockMinute: null,
  windowStart: null,
  windowEnd: null,
  phrase: null,
  topic: null,
  unresolved: null,
  gist: "quiet inside",
  ...overrides,
});

function scripted(draft: unknown, inspect?: (body: Record<string, unknown>) => void) {
  setTransport(async (body) => {
    inspect?.(body);
    return { output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(draft) }] }] };
  });
}

afterEach(() => {
  setTransport(null);
  resetLandmarks();
});

describe("say orchestration", () => {
  it.each([
    ["quiet tonight", "quiet"],
    ["step-free entry without staff help", "step-free-entrance"],
    ["Stufenloser Eingang ohne Hilfe", "step-free-entrance"],
    ["gluten-free options without cross-contamination", "gluten-free-options"],
    ["Wi-Fi fast enough for a video call", "wifi"],
    ["dogs allowed inside", "dog-friendly"],
  ])("preserves known qualifiers even when the model chooses a bare attribute: %s", async (text, key) => {
    scripted({ intent: "need", confidence: 1, reply: null, unrepresented: [], concepts: [
      draftConcept({ role: "attribute", surface: text, attributeKey: key }),
    ] });
    const out = await say(text, "shared", context);
    expect(out.intent).toBe("need");
    expect(out.needs.map((need) => need.payload)).toEqual([{ kind: "text", text, evidenceKeys: [key] }]);
  });

  it.each([
    ["quiet tonight", "quiet"],
    ["preferably quiet", "quiet"],
    ["no outdoor seating", "outdoor seating"],
    ["quiet and vegan options", "quiet"],
    ["quieter", "quiet"],
  ])("clarifies uncovered source wording instead of applying a partial reading: %s", async (text, surface) => {
    scripted({ intent: "need", confidence: 1, reply: null, unrepresented: [], concepts: [
      draftConcept({ role: "attribute", surface, attributeKey: "quiet" }),
    ] });
    const out = await say(text, "shared", context);
    expect(out).toMatchObject({ intent: "clarify", needs: [], clarify: { allowFreeText: true, said: text } });
  });

  it("allows ordinary framing outside the source span", async () => {
    scripted({ intent: "need", confidence: 1, reply: null, unrepresented: [], concepts: [
      draftConcept({ role: "attribute", surface: "quiet", attributeKey: "quiet" }),
    ] });
    const out = await say("Please find us a quiet place", "shared", context);
    expect(out).toMatchObject({ intent: "need", needs: [{ payload: { key: "quiet", expect: "verified_true" } }] });
  });

  it("does not turn an explicitly waived feature into a requirement", async () => {
    scripted({ intent: "need", confidence: 1, reply: null, unrepresented: [], concepts: [
      draftConcept({ role: "attribute", surface: "quiet is essential", attributeKey: "quiet" }),
    ] });
    const out = await say("Wi-Fi is not required, but quiet is essential", "shared", context);
    expect(out.intent).toBe("need");
    expect(out.needs.map((need) => need.payload)).toEqual([{ kind: "attribute", key: "quiet", expect: "verified_true" }]);
  });

  it.each([true, false])("refuses model overflow atomically (explicitly reported: %s)", async (reported) => {
    const surfaces = ["vegan options", "Wi-Fi", "quiet", "takeaway", "delivery"];
    const keys = ["vegan-options", "wifi", "quiet", "takeaway", "delivery"];
    scripted({ intent: "need", confidence: 1, reply: null, unrepresented: reported ? ["dogs welcome"] : [],
      concepts: surfaces.map((surface, i) => draftConcept({ role: "attribute", surface, attributeKey: keys[i] })),
    });
    const out = await say([...surfaces, "dogs welcome"].join(" and "), "shared", context);
    expect(out).toMatchObject({ intent: "clarify", needs: [], clarify: { allowFreeText: true } });
  });

  it("does not truncate six fully pre-parsed quantities", async () => {
    setTransport(async () => { throw new Error("the deterministic path must stay offline"); });
    const out = await say("under 10 EUR and within 100 m and under 20 EUR and within 200 m and under 30 EUR and within 300 m", "shared", context);
    expect(out).toMatchObject({ intent: "clarify", needs: [], meta: { model: null } });
    expect(out.clarify?.question).toContain("five");
  });

  it("checks every OR group, even when one was already preserved", async () => {
    const text = "Wi-Fi or quiet, and takeaway or delivery";
    scripted({ intent: "need", confidence: 1, reply: null, concepts: [
      draftConcept({ surface: "Wi-Fi or quiet", evidenceKeys: ["wifi", "quiet"] }),
      draftConcept({ role: "attribute", surface: "takeaway", attributeKey: "takeaway" }),
      draftConcept({ role: "attribute", surface: "delivery", attributeKey: "delivery" }),
    ] });
    const out = await say(text, "shared", context);
    expect(out.needs).toHaveLength(1);
    expect(out.needs[0].payload).toMatchObject({ kind: "text", text });
  });

  it("clarifies an invalid OR split when fallback would make a preference mandatory", async () => {
    scripted({ intent: "need", confidence: 1, reply: null, concepts: [
      draftConcept({ role: "attribute", surface: "Wi-Fi", attributeKey: "wifi" }),
      draftConcept({ role: "attribute", surface: "quiet", attributeKey: "quiet" }),
      draftConcept({ role: "attribute", surface: "preferably takeaway", attributeKey: "takeaway", hardness: "soft" }),
    ] });
    const out = await say("Wi-Fi or quiet, and preferably takeaway", "shared", context);
    expect(out).toMatchObject({ intent: "clarify", needs: [] });
  });

  it("clarifies when mapping cannot preserve a returned quantitative clause", async () => {
    scripted({ intent: "need", confidence: 1, reply: null, concepts: [
      draftConcept({ role: "attribute", surface: "quiet", attributeKey: "quiet" }),
      draftConcept({ role: "money", surface: "within budget", quantityValue: null }),
    ] });
    const out = await say("quiet and within budget", "shared", context);
    expect(out).toMatchObject({ intent: "clarify", needs: [] });
  });

  it.each([
    ["dogs allowed inside or on a covered terrace", ["dog-friendly", "outdoor-seating"]],
    ["quiet tonight", ["quiet"]],
    ["a toilet within 300 m", ["nearby-toilets"]],
    ["step-free entry without staff help", ["step-free-entrance"]],
    ["Wi-Fi fast enough for a call", ["wifi"]],
  ])("preserves the complete qualified condition: %s", async (text, evidenceKeys) => {
    let request: Record<string, unknown> | undefined;
    scripted({ intent: "need", confidence: 1, reply: null,
      concepts: [draftConcept({ role: "quality", surface: text, evidenceKeys })] }, (body) => { request = body; });
    const result = await say(text, "shared", context);
    expect(result.needs.map((n) => n.payload)).toEqual([{ kind: "text", text, evidenceKeys }]);
    expect(JSON.stringify(request?.input)).toContain(text);
  });
  it("keeps conjunctions independent and preserves a per-clause preference", async () => {
    scripted({ intent: "need", confidence: 1, reply: null, concepts: [
      draftConcept({ role: "attribute", surface: "dogs welcome", attributeKey: "dog-friendly" }),
      draftConcept({ role: "attribute", surface: "preferably quiet", attributeKey: "quiet", hardness: "soft" }),
      draftConcept({ role: "attribute", surface: "no stairs", attributeKey: "step-free-entrance" }),
    ] });
    const result = await say("dogs welcome and preferably quiet and no stairs", "shared", context);
    expect(result.needs.map((n) => [n.payload.key, n.hardness])).toEqual([
      ["dog-friendly", "hard"], ["quiet", "soft"], ["step-free-entrance", "hard"],
    ]);
  });
  it("repairs a model split that would turn an OR into two must-haves", async () => {
    scripted({ intent: "need", confidence: 1, reply: null, concepts: [
      draftConcept({ role: "attribute", surface: "Wi-Fi", attributeKey: "wifi" }),
      draftConcept({ role: "attribute", surface: "quiet", attributeKey: "quiet" }),
    ] });
    const result = await say("Wi-Fi or quiet", "shared", context);
    expect(result.needs).toHaveLength(1);
    expect(result.needs[0].payload).toEqual({ kind: "text", text: "Wi-Fi or quiet", evidenceKeys: ["wifi", "quiet"] });
  });
  it("asks for a shorter condition when the model cannot preserve all qualifiers", async () => {
    const text = "dogs inside or on a covered terrace, " + "with additional conditions that must stay together, ".repeat(5);
    scripted({ intent: "need", confidence: 0.9, reply: null, concepts: [
      draftConcept({ role: "quality", surface: "dogs inside or on a covered terrace", unresolved: "value" }),
    ] });
    const result = await say(text, "shared", context);
    expect(result.needs).toEqual([]);
    expect(result.intent).toBe("clarify");
    expect(result.clarify?.question).toContain("shorten");
  });
  it("resolves a landmark distance phrase through the index, with no model call", async () => {
    installLandmarksForTests("berlin-mitte", [{
      id: "lm_cafe",
      name: "Café Einstein",
      kind: "attraction",
      location: { lat: 52.5, lng: 13.4 },
    }]);
    setTransport(async () => { throw new Error("the landmark path must stay offline"); });
    await expect(say("300 m from Café Einstein", "shared", context)).resolves.toMatchObject({
      intent: "need",
      needs: [{
        payload: {
          kind: "scope",
          dimension: "radius_m",
          max: 300,
          referent: { kind: "landmark", landmarkId: "lm_cafe" },
        },
      }],
      meta: { model: null },
    });
    const near = await say("near Café Einstein", "shared", context);
    expect(near.needs[0].payload).toMatchObject({ dimension: "walk_min", max: 10 });
  });

  it("asks which landmark was meant when several plausibly match", async () => {
    installLandmarksForTests("berlin-mitte", [
      { id: "lm_square", name: "Alexanderplatz", kind: "square", location: { lat: 52.5219, lng: 13.3899 } },
      { id: "lm_u", name: "U Alexanderplatz", kind: "station", location: { lat: 52.522, lng: 13.3899 } },
      { id: "lm_s", name: "S Alexanderplatz", kind: "station", location: { lat: 52.5221, lng: 13.3899 } },
      { id: "lm_far", name: "Alexanderplatz Park", kind: "park", location: { lat: 52.51, lng: 13.4 } },
    ]);
    setTransport(async () => { throw new Error("the landmark path must stay offline"); });
    const out = await say("within 10 minutes of Alexanderplatz", "shared", context);
    expect(out.intent).toBe("clarify");
    expect(out.needs).toEqual([]);
    expect(out.clarify?.choices.length).toBeGreaterThanOrEqual(2);
    expect(out.clarify?.choices[0].needs[0].payload).toMatchObject({
      dimension: "walk_min",
      max: 10,
      referent: { kind: "landmark" },
    });
  });
  it("skips the model for a fully pre-parsed sentence", async () => {
    setTransport(async () => { throw new Error("model called"); });
    const out = await say("places that are at most 500m away from me", "shared", context);
    expect(out).toMatchObject({
      intent: "need",
      needs: [{ payload: { kind: "scope", dimension: "radius_m", max: 500 }, label: "within 500 m of where you start" }],
      clarify: null,
      meta: { model: null },
    });
  });

  it("passes the entire mixed sentence to the model so qualifiers retain their scope", async () => {
    let request: Record<string, unknown> | undefined;
    scripted({
      intent: "need", confidence: 0.9, reply: null,
      concepts: [draftConcept({ role: "distance", surface: "within 500 m", quantityValue: 500, quantityUnit: "m", quantityBound: "max", referentKind: "self", gist: "distance" }), draftConcept({
        role: "attribute", surface: "vegetarian", attributeKey: "vegetarian-options",
        topic: "dietary", gist: "vegetarian options",
      })],
    }, (body) => { request = body; });
    const out = await say("vegetarian and within 500 m", "shared", context);
    expect(out.needs.map((need) => need.payload)).toEqual([
      { kind: "scope", dimension: "radius_m", max: 500 },
      { kind: "attribute", key: "vegetarian-options", expect: "verified_true" },
    ]);
    expect(request?.service_tier).toBe("default");
    expect(request?.instructions).toContain("Already understood, do not repeat");
    expect(request?.instructions).toContain("Never guess a unit");
    expect(JSON.stringify(request?.input)).toContain("vegetarian and within 500 m");
  });

  it("maps model-only kind and quality concepts through the closed union", async () => {
    scripted({
      intent: "need", confidence: 0.9, reply: null,
      concepts: [
        draftConcept({ role: "kind", surface: "no Italian", polarity: "exclude", values: ["Italian"], gist: "no italian" }),
        draftConcept({ role: "quality", surface: "kid friendly", gist: "good for children" }),
      ],
    });
    const out = await say("no Italian, kid friendly", "shared", context);
    expect(out.needs.map((need) => need.payload)).toEqual([
      { kind: "exclusion", key: "cuisine", values: ["italian"], lifetime: "session" },
      { kind: "text", text: "kid friendly" },
    ]);
  });

  // Golden stage-A drafts for the two families the live routing bench used to
  // lose (`ask-*`, `kind-*`). Each fixture is the JSON the model returns for a
  // corpus row, so stage B keeps its side of the contract without a model call.
  it("ask-002: keeps a question a question and still carries its stated need", async () => {
    scripted({
      intent: "ask", confidence: 0.9, reply: null,
      concepts: [draftConcept({
        role: "attribute", surface: "vegan", attributeKey: "vegan-options",
        topic: "dietary", gist: "vegan options",
      })],
    });
    const out = await say("is there anything vegan?", "shared", context);
    expect(out.intent).toBe("ask");
    expect(out.needs.map((need) => need.payload)).toEqual([
      { kind: "attribute", key: "vegan-options", expect: "verified_true" },
    ]);
    expect(out.clarify).toBeNull();
  });

  it("ask-003: routes a room move to act with nothing to submit", async () => {
    scripted({
      intent: "act", confidence: 0.9, reply: null,
      concepts: [draftConcept({ role: "place", surface: "Café Einstein", gist: "café einstein" })],
    });
    const out = await say("put Café Einstein forward", "shared", context);
    expect(out.intent).toBe("act");
    expect(out.needs).toEqual([]);
  });

  it("kind-003: a dish the room's cuisines can reach becomes an exclusion, not a question", async () => {
    scripted({
      intent: "need", confidence: 0.9, reply: null,
      concepts: [draftConcept({
        role: "kind", surface: "anything but pizza", polarity: "exclude",
        values: ["pizza"], gist: "no pizza",
      })],
    });
    const out = await say("anything but pizza", "shared", context);
    expect(out.intent).toBe("need");
    expect(out.needs.map((need) => need.payload)).toEqual([
      { kind: "exclusion", key: "cuisine", values: ["pizza"], lifetime: "session" },
    ]);
    expect(out.clarify).toBeNull();
  });

  it("kind-005: a dish the room's cuisines cannot reach asks instead of guessing", async () => {
    scripted({
      intent: "need", confidence: 0.9, reply: null,
      concepts: [draftConcept({
        role: "kind", surface: "avoid sushi", polarity: "exclude",
        values: ["sushi"], gist: "no sushi",
      })],
    });
    const out = await say("avoid sushi", "shared", context);
    expect(out.intent).toBe("clarify");
    expect(out.needs).toEqual([]);
    expect(out.clarify?.question).toContain("sushi");
  });

  it("ignores a stray quantity on a concept that measures nothing", async () => {
    scripted({
      intent: "need", confidence: 0.9, reply: null,
      concepts: [draftConcept({
        role: "attribute", surface: "vegane Optionen", attributeKey: "vegan-options",
        quantityValue: 0, quantityUnit: null, quantityBound: null, gist: "vegane optionen",
      })],
    });
    const out = await say("vegane Optionen", "shared", context);
    expect(out.intent).toBe("need");
    expect(out.needs.map((need) => need.payload)).toEqual([
      { kind: "attribute", key: "vegan-options", expect: "verified_true" },
    ]);
    expect(out.clarify).toBeNull();
  });

  it("tells the model that a question keeps its concepts and that a room move is act", async () => {
    let request: Record<string, unknown> | undefined;
    scripted({ intent: "other", confidence: 1, concepts: [], reply: null }, (body) => { request = body; });
    await say("anything", "shared", context);
    expect(request?.instructions).toContain("A question that also states a need is still ask");
    expect(request?.instructions).toContain("intent act");
    expect(request?.instructions).toContain("Never write 0 to mean there is no amount");
  });

  it("maps a model-only structured time draft without model date arithmetic", async () => {
    let request: Record<string, unknown> | undefined;
    scripted({
      intent: "need", confidence: 1, reply: null,
      concepts: [draftConcept({
        role: "time", surface: "after the keynote", phrase: "after the keynote", gist: "after keynote",
        dayRef: "tomorrow", dayPart: "lunch", topic: "time",
      })],
    }, (body) => { request = body; });
    const out = await say("after the keynote", "shared", context, new Date("2026-09-03T08:15:30Z"));
    expect(out.needs[0].payload).toEqual({
      kind: "time",
      phrase: "after the keynote",
      window: { start: "2026-09-04T12:00:00+02:00", end: "2026-09-04T14:00:00+02:00" },
    });
    expect(request?.instructions).toContain("Never calculate dates or offsets");
    expect(request?.instructions).toContain("dayRef, dayPart, clockHour and clockMinute");
  });

  it("keeps raw model windows only for explicit calendar dates", async () => {
    scripted({
      intent: "need", confidence: 1, reply: null,
      concepts: [draftConcept({
        role: "time", surface: "on the 12th", phrase: "on the 12th", gist: "on the 12th",
        windowStart: "2026-09-12T09:00:00+02:00", windowEnd: "2026-09-12T23:00:00+02:00",
      })],
    });
    expect((await say("on the 12th", "shared", context)).needs[0].payload).toMatchObject({ kind: "time" });

    scripted({
      intent: "need", confidence: 1, reply: null,
      concepts: [draftConcept({ role: "time", surface: "sometime soon", windowStart: "tomorrow", windowEnd: "later", gist: "soon" })],
    });
    expect((await say("sometime soon", "shared", context)).intent).toBe("clarify");
  });

  it("returns facet-built suggestions for valid off-topic input", async () => {
    scripted({ intent: "other", confidence: 1, concepts: [], reply: null });
    const out = await say("hello there", "shared", context);
    expect(out.intent).toBe("unclear");
    expect(out.suggestions).toHaveLength(3);
  });

  it("preserves failed ask/act text for retry instead of creating a fallback need", () => {
    expect(shouldPreserveNlText({ ok: false, intent: "ask" })).toBe(true);
    expect(shouldPreserveNlText({ ok: false, intent: "act" })).toBe(true);
    expect(shouldPreserveNlText({ ok: true, intent: "act", partial: true })).toBe(true);
    expect(shouldPreserveNlText({ ok: true, intent: "need" })).toBe(false);
  });
});
