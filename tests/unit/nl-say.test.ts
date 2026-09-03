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

  it("passes pre-parsed concepts to the model and maps only the remainder", async () => {
    let request: Record<string, unknown> | undefined;
    scripted({
      intent: "need", confidence: 0.9, reply: null,
      concepts: [draftConcept({
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

  it("validates absolute time windows and rejects offset-free ones", async () => {
    scripted({
      intent: "need", confidence: 1, reply: null,
      concepts: [draftConcept({
        role: "time", surface: "tomorrow for lunch", phrase: "tomorrow for lunch", gist: "tomorrow lunch",
        windowStart: "2026-09-04T12:00:00+02:00", windowEnd: "2026-09-04T14:00:00+02:00", topic: "time",
      })],
    });
    const out = await say("open tomorrow for lunch", "shared", context, new Date("2026-09-03T08:15:30Z"));
    expect(out.needs[0].payload).toMatchObject({ kind: "time", phrase: "tomorrow for lunch" });

    scripted({
      intent: "need", confidence: 1, reply: null,
      concepts: [draftConcept({ role: "time", surface: "tomorrow", windowStart: "tomorrow", windowEnd: "later", gist: "tomorrow" })],
    });
    expect((await say("tomorrow", "shared", context)).intent).toBe("unclear");
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
