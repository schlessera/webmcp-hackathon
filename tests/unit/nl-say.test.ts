import { afterEach, describe, expect, it } from "vitest";
import { say } from "../../apps/server/src/nl/say.ts";
import { setTransport } from "../../apps/server/src/nl/openai.ts";
import { installLandmarksForTests, resetLandmarks } from "../../apps/server/src/landmarks.ts";
import { shouldPreserveNlText } from "../../apps/web/src/nl-result.ts";
import type { SpatialContextResult } from "@webmcp-hackathon/contracts";

/**
 * The fast tier's mapping from the model's draft to payloads the command bus
 * accepts. The wire is scripted: what is under test is that nothing the model
 * says can reach the room outside the closed payload vocabulary.
 */

const context = {
  ok: true,
  revision: 3,
  phase: "gathering",
  scope: { scopeId: "s", area: { kind: "circle", center: { lat: 52.5, lng: 13.4 }, radiusM: 800 }, transport: ["walk"], category: "restaurant" },
  area: { areaId: "berlin-mitte", label: "Berlin Mitte", kind: "osm-snapshot", source: "test", dataAsOf: "2026-09-01T00:00:00Z", poolSize: 15, focusVenues: 15 },
  feasibility: { state: "feasible", eligible: 10, uncertain: 2, excluded: 3 },
  total: 15,
  matching: 10,
  candidates: [],
  facets: [
    {
      key: "cuisine",
      label: "cuisine",
      type: "enum",
      counts: { unknown: 2 },
      values: [
        { value: "italian", label: "Italian", count: 3 },
        { value: "vietnamese", label: "Vietnamese", count: 2 },
      ],
    },
  ],
  activeNeeds: [],
  privateEffects: [],
  participants: [],
  proposals: [],
} as unknown as SpatialContextResult;

function scripted(draft: unknown, inspect?: (body: Record<string, unknown>) => void) {
  setTransport(async (body) => {
    inspect?.(body);
    return ({
    output: [
      { type: "message", content: [{ type: "output_text", text: JSON.stringify(draft) }] },
    ],
    });
  });
}

afterEach(() => {
  setTransport(null);
  resetLandmarks();
});

describe("say: draft → payloads", () => {
  it("resolves landmark distance phrases without a model call", async () => {
    installLandmarksForTests("berlin-mitte", [{
      id: "lm_cafe",
      name: "Café Einstein",
      kind: "attraction",
      location: { lat: 52.5, lng: 13.4 },
    }]);
    setTransport(async () => { throw new Error("the landmark fallback must stay offline"); });
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
      meta: { model: "landmark-index" },
    });
    const near = await say("near Café Einstein", "shared", context);
    expect(near.needs[0].payload).toMatchObject({ dimension: "walk_min", max: 10 });
  });

  it("returns small choice payloads when several landmarks plausibly match", async () => {
    installLandmarksForTests("berlin-mitte", [
      { id: "lm_square", name: "Alexanderplatz", kind: "square", location: { lat: 52.5219, lng: 13.3899 } },
      { id: "lm_u", name: "U Alexanderplatz", kind: "station", location: { lat: 52.522, lng: 13.3899 } },
      { id: "lm_s", name: "S Alexanderplatz", kind: "station", location: { lat: 52.5221, lng: 13.3899 } },
      { id: "lm_far", name: "Alexanderplatz Park", kind: "park", location: { lat: 52.51, lng: 13.4 } },
    ]);
    const out = await say("within 10 minutes of Alexanderplatz", "shared", context);
    expect(out.intent).toBe("unclear");
    expect(out.reply).toBe("Which Alexanderplatz did you mean?");
    expect(out.choices).toHaveLength(3);
    expect(out.choices?.map((choice) => choice.label)).toEqual([
      "Alexanderplatz · square",
      "U Alexanderplatz · station",
      "S Alexanderplatz · station",
    ]);
    expect(out.choices?.[0].payload).toMatchObject({
      dimension: "walk_min",
      max: 10,
      referent: { kind: "landmark", landmarkId: "lm_square" },
    });
  });
  it("maps typed needs onto the closed payload union and keeps the topic", async () => {
    scripted({
      intent: "need",
      reply: null,
      needs: [
        { kind: "attribute", attributeKey: "vegetarian-options", expect: "verified_true", amountEur: null, walkMin: null, excludeValues: [], text: null, topic: "dietary", gist: "vegetarian food" },
        { kind: "budget", attributeKey: null, expect: null, amountEur: 14.6, walkMin: null, excludeValues: [], text: null, topic: "budget", gist: "under fifteen" },
        { kind: "walk", attributeKey: null, expect: null, amountEur: null, walkMin: 10, excludeValues: [], text: null, topic: "distance", gist: "close by" },
      ],
    });
    const out = await say("vegetarian, cheap, close by", "shared", context);
    expect(out.intent).toBe("need");
    expect(out.needs.map((n) => n.payload)).toEqual([
      { kind: "attribute", key: "vegetarian-options", expect: "verified_true" },
      { kind: "budget", perPersonMax: { amount: 15, currency: "EUR" } },
      { kind: "scope", dimension: "walk_min", max: 10 },
    ]);
    expect(out.needs[0].topic).toBe("dietary");
  });

  it("maps distance-from-me language to scope predicates", async () => {
    let request: Record<string, unknown> | undefined;
    scripted({
      intent: "need",
      reply: null,
      needs: [
        { kind: "walk", attributeKey: null, expect: null, amountEur: null, walkMin: 20, radiusM: null, excludeValues: [], includeValues: [], text: null, window: null, phrase: null, topic: "distance", gist: "within twenty minutes" },
        { kind: "walk", attributeKey: null, expect: null, amountEur: null, walkMin: null, radiusM: 2000, excludeValues: [], includeValues: [], text: null, window: null, phrase: null, topic: "distance", gist: "within two kilometres" },
      ],
    }, (body) => { request = body; });

    const out = await say("not more than 20 min from me, within 2 km of me", "shared", context);
    expect(out.needs.map((need) => need.payload)).toEqual([
      { kind: "scope", dimension: "walk_min", max: 20 },
      { kind: "scope", dimension: "radius_m", max: 2000 },
    ]);
    expect(request?.instructions).toContain("'close to me' is walkMin 10");
  });

  it("refuses keys and cuisine values outside what the server published", async () => {
    scripted({
      intent: "need",
      reply: null,
      needs: [
        { kind: "attribute", attributeKey: "has-karaoke", expect: "verified_true", amountEur: null, walkMin: null, excludeValues: [], text: "karaoke night", topic: "atmosphere", gist: "karaoke" },
        { kind: "exclusion", attributeKey: null, expect: null, amountEur: null, walkMin: null, excludeValues: ["italian", "martian"], text: null, topic: null, gist: "no italian" },
        { kind: "exclusion", attributeKey: null, expect: null, amountEur: null, walkMin: null, excludeValues: ["martian"], text: "no martian food", topic: null, gist: "no martian" },
      ],
    });
    const out = await say("karaoke, no italian, no martian", "shared", context);
    expect(out.needs.map((n) => n.payload)).toEqual([
      // An unknown key falls back to the honest text predicate.
      { kind: "text", text: "karaoke night" },
      // Only published cuisine values survive.
      { kind: "exclusion", key: "cuisine", values: ["italian"], lifetime: "session" },
    ]);
  });

  it("returns unclear instead of turning an unmatched cuisine exclusion into text", async () => {
    scripted({
      intent: "need",
      reply: null,
      needs: [
        { kind: "exclusion", attributeKey: null, expect: null, amountEur: null, walkMin: null, excludeValues: ["sushi"], text: "no sushi", topic: "cuisine", gist: "no sushi" },
      ],
    });
    const out = await say("no sushi", "application-private", context);
    expect(out.intent).toBe("unclear");
    expect(out.needs).toEqual([]);
  });

  it("caps free-text needs at the promised 120 characters", async () => {
    scripted({
      intent: "need",
      reply: null,
      needs: [
        { kind: "text", attributeKey: null, expect: null, amountEur: null, walkMin: null, excludeValues: [], text: "x".repeat(200), topic: null, gist: "long detail" },
      ],
    });
    const out = await say("x".repeat(200), "shared", context);
    expect(out.needs[0].payload).toEqual({ kind: "text", text: "x".repeat(120) });
  });

  it("a wanted cuisine is an inclusion, never an exclusion (the 'Asian cuisine please' bug)", async () => {
    scripted({
      intent: "need",
      reply: null,
      needs: [
        { kind: "inclusion", attributeKey: null, expect: null, amountEur: null, walkMin: null, excludeValues: [], includeValues: ["vietnamese", "martian"], text: null, topic: "cuisine", gist: "vietnamese" },
        { kind: "inclusion", attributeKey: null, expect: null, amountEur: null, walkMin: null, excludeValues: [], includeValues: ["martian"], text: "martian food", topic: null, gist: "martian" },
      ],
    });
    const out = await say("Vietnamese please, or martian", "shared", context);
    expect(out.needs.map((n) => n.payload)).toEqual([
      { kind: "inclusion", key: "cuisine", values: ["vietnamese"], lifetime: "session" },
      { kind: "text", text: "martian food" },
    ]);
  });

  it("accepts a case-varied cuisine value published through taxonomy implications", async () => {
    scripted({
      intent: "need",
      reply: null,
      needs: [
        { kind: "inclusion", attributeKey: null, expect: null, amountEur: null, walkMin: null, excludeValues: [], includeValues: ["Italian"], text: null, topic: null, gist: "italian" },
      ],
    });
    const out = await say("Italian", "shared", context);
    expect(out.needs[0].payload).toEqual({
      kind: "inclusion", key: "cuisine", values: ["italian"], lifetime: "session",
    });
  });

  it("a need intent with nothing usable reads as unclear; ask and act carry no needs", async () => {
    scripted({ intent: "need", reply: null, needs: [] });
    expect((await say("hmm", "shared", context)).intent).toBe("unclear");
    scripted({ intent: "act", reply: null, needs: [{ kind: "text", attributeKey: null, expect: null, amountEur: null, walkMin: null, excludeValues: [], text: "x", topic: null, gist: "x" }] });
    const act = await say("put it forward", "shared", context);
    expect(act.intent).toBe("act");
    expect(act.needs).toEqual([]);
  });

  it("an unparseable answer is unclear, never a need", async () => {
    setTransport(async () => ({ output: [{ type: "message", content: [{ type: "output_text", text: "not json" }] }] }));
    const out = await say("???", "shared", context);
    expect(out.intent).toBe("unclear");
    expect(out.needs).toEqual([]);
  });

  it("resolves tomorrow for lunch against the room clock as time, never text", async () => {
    let request: Record<string, unknown> | undefined;
    scripted({
      intent: "need",
      reply: null,
      needs: [{
        kind: "time",
        attributeKey: null,
        expect: null,
        amountEur: null,
        walkMin: null,
        excludeValues: [],
        includeValues: [],
        text: null,
        window: {
          start: "2026-09-04T12:00:00+02:00",
          end: "2026-09-04T14:00:00+02:00",
        },
        phrase: "tomorrow for lunch",
        topic: "time",
        gist: "tomorrow lunch",
      }],
    }, (body) => { request = body; });

    const out = await say(
      "open tomorrow for lunch",
      "shared",
      context,
      new Date("2026-09-03T08:15:30.000Z"),
    );
    expect(out.needs).toHaveLength(1);
    expect(out.needs[0].payload).toEqual({
      kind: "time",
      window: {
        start: "2026-09-04T12:00:00+02:00",
        end: "2026-09-04T14:00:00+02:00",
      },
      phrase: "tomorrow for lunch",
    });
    expect(out.needs[0].payload.kind).not.toBe("text");
    expect(request?.instructions).toContain("Area timezone: Europe/Berlin.");
    expect(request?.instructions).toContain("Current local date/time: 2026-09-03T10:15:30+02:00.");
  });

  it("resolves a named weekday and an explicit clock time to concrete windows", async () => {
    const fixed = new Date("2026-09-03T08:15:30.000Z");
    const timeNeed = (start: string, end: string, phrase: string) => ({
      kind: "time",
      attributeKey: null,
      expect: null,
      amountEur: null,
      walkMin: null,
      excludeValues: [],
      includeValues: [],
      text: null,
      window: { start, end },
      phrase,
      topic: "time",
      gist: phrase,
    });
    scripted({
      intent: "need", reply: null,
      needs: [timeNeed(
        "2026-09-04T18:00:00+02:00",
        "2026-09-04T21:00:00+02:00",
        "Friday evening",
      )],
    });
    expect((await say("open Friday evening", "shared", context, fixed)).needs[0].payload)
      .toMatchObject({
        kind: "time",
        window: {
          start: "2026-09-04T18:00:00+02:00",
          end: "2026-09-04T21:00:00+02:00",
        },
      });

    scripted({
      intent: "need", reply: null,
      needs: [timeNeed(
        "2026-09-03T18:00:00+02:00",
        "2026-09-03T20:00:00+02:00",
        "at 7pm",
      )],
    });
    expect((await say("open today at 7pm", "shared", context, fixed)).needs[0].payload)
      .toMatchObject({
        kind: "time",
        window: {
          start: "2026-09-03T18:00:00+02:00",
          end: "2026-09-03T20:00:00+02:00",
        },
      });
  });

  it("drops malformed, offset-free, and inverted model windows", async () => {
    scripted({
      intent: "need",
      reply: null,
      needs: [
        { kind: "time", window: { start: "tomorrow", end: "later" }, phrase: "tomorrow", topic: "time", gist: "tomorrow" },
        { kind: "time", window: { start: "2026-09-04T14:00:00+02:00", end: "2026-09-04T12:00:00+02:00" }, phrase: "lunch", topic: "time", gist: "lunch" },
        { kind: "time", window: { start: "2026-09-04T12:00:00Z", end: "2026-09-04T14:00:00Z" }, phrase: "lunch", topic: "time", gist: "lunch" },
      ],
    });
    const out = await say("open tomorrow for lunch", "shared", context, new Date("2026-09-03T08:15:30.000Z"));
    expect(out.intent).toBe("unclear");
    expect(out.needs).toEqual([]);
  });

  it("preserves failed ask/act text for retry instead of creating a fallback need", () => {
    expect(shouldPreserveNlText({ ok: false, intent: "ask" })).toBe(true);
    expect(shouldPreserveNlText({ ok: false, intent: "act" })).toBe(true);
    expect(shouldPreserveNlText({ ok: true, intent: "act", partial: true })).toBe(true);
    expect(shouldPreserveNlText({ ok: true, intent: "need" })).toBe(false);
  });
});
