import { afterEach, describe, expect, it } from "vitest";
import { say } from "../../apps/server/src/nl/say.ts";
import { setTransport } from "../../apps/server/src/nl/openai.ts";
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

function scripted(draft: unknown) {
  setTransport(async () => ({
    output: [
      { type: "message", content: [{ type: "output_text", text: JSON.stringify(draft) }] },
    ],
  }));
}

afterEach(() => setTransport(null));

describe("say: draft → payloads", () => {
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
      // No surviving value: text again, never an invented exclusion.
      { kind: "text", text: "no martian food" },
    ]);
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
});
