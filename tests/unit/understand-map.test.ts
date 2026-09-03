import Ajv from "ajv";
import addFormats from "ajv-formats";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  RequirementPayload,
  type Concept,
  type Interpretation,
} from "@webmcp-hackathon/contracts";
import {
  looksInterrogative,
  mapInterpretation,
  type UnderstandInput,
} from "../../apps/server/src/nl/understand/map.ts";
import { setFindLandmarks } from "../../apps/server/src/nl/understand/resolvers.ts";
import { setTransport } from "../../apps/server/src/nl/openai.ts";

const payloadAjv = new Ajv({ strict: false });
addFormats(payloadAjv);
const validPayload = payloadAjv.compile(RequirementPayload);

function concept(overrides: Partial<Concept> & Pick<Concept, "role" | "surface">): Concept {
  return {
    role: overrides.role,
    surface: overrides.surface,
    polarity: overrides.polarity ?? "include",
    hardness: overrides.hardness ?? "hard",
    quantity: overrides.quantity ?? null,
    mode: overrides.mode ?? null,
    referent: overrides.referent ?? null,
    attributeKey: overrides.attributeKey ?? null,
    values: overrides.values ?? [],
    window: overrides.window ?? null,
    timeSpec: overrides.timeSpec ?? null,
    phrase: overrides.phrase ?? null,
    topic: overrides.topic ?? null,
    unresolved: overrides.unresolved ?? null,
    gist: overrides.gist ?? overrides.surface.toLowerCase(),
    origin: overrides.origin ?? "model",
  };
}

function input(text: string, overrides: Partial<UnderstandInput["room"]> = {}): UnderstandInput {
  return {
    text,
    scope: "shared",
    room: {
      areaId: "berlin-mitte",
      timezone: "Europe/Berlin",
      currency: "EUR",
      now: new Date("2026-09-03T10:00:00Z"),
      hasOwnOrigin: true,
      transport: ["walk"],
      facets: [{
        key: "cuisine", label: "cuisine", type: "enum", counts: { unknown: 0 },
        values: [
          { value: "italian", label: "Italian", count: 2 },
          { value: "spanish", label: "Spanish", count: 1 },
        ],
      }],
      activeNeeds: [],
      candidateWalkMinutes: [5, 10, 15],
      candidateNames: [{ candidateId: "c1", name: "Café Einstein" }],
      participantNames: [{ participantId: "p1", name: "Sarah" }],
      ...overrides,
    },
  };
}

function interpretation(concepts: Concept[], intent: Interpretation["intent"] = "need", confidence = 1): Interpretation {
  return { intent, concepts, confidence, reply: null, meta: { model: null, ms: 0, preparsedWhole: false } };
}

beforeEach(() => setTransport(async () => { throw new Error("model called"); }));
afterEach(() => {
  setFindLandmarks(null);
  setTransport(null);
});

describe("stage-B mapping table", () => {
  it("maps distance without crossing the metres/minutes boundary", () => {
    const out = mapInterpretation(interpretation([concept({
      role: "distance", surface: "within 0.5 km",
      quantity: { value: 500, unit: "m", bound: "max" },
      referent: { kind: "self", name: null }, gist: "distance",
    })]), input("within 0.5 km"));
    expect(out.needs[0]).toMatchObject({
      payload: { kind: "scope", dimension: "radius_m", max: 500 },
      label: "within 500 m of where you start",
    });
    expect(out.needs[0].payload).not.toHaveProperty("mode");
  });

  it("reads an unqualified distance above 60 as metres without inventing minutes", () => {
    const out = mapInterpretation(interpretation([concept({
      role: "distance", surface: "under 500",
      quantity: { value: 500, unit: null, bound: "max" },
      referent: { kind: "self", name: null }, unresolved: "unit", gist: "distance",
    })]), input("under 500"));
    expect(out.needs[0]).toMatchObject({
      payload: { kind: "scope", dimension: "radius_m", max: 500 },
      label: "within 500 m of where you start",
      assumed: "read as metres",
    });
  });

  it.each([
    ["walk", "walk_min", "within 10 min walk of where you start"],
    ["bike", "travel_min", "within 10 min by bike of where you start"],
    ["car", "travel_min", "within 10 min by car of where you start"],
    ["transit", "travel_min", "within 10 min by transit of where you start"],
  ] as const)("maps travel time by %s", (mode, dimension, label) => {
    const out = mapInterpretation(interpretation([concept({
      role: "travel_time", surface: `10 min by ${mode}`,
      quantity: { value: 10, unit: "min", bound: "max" }, mode,
      referent: { kind: "self", name: null }, gist: "travel time",
    })]), input(`10 min by ${mode}`));
    expect(out.needs[0]).toMatchObject({ payload: { kind: "scope", dimension, max: 10 }, label });
  });

  it("maps EUR and USD money with server labels", () => {
    const eur = mapInterpretation(interpretation([concept({
      role: "money", surface: "€15", quantity: { value: 15, unit: "EUR", bound: "max" }, gist: "budget",
    })]), input("€15"));
    const usd = mapInterpretation(interpretation([concept({
      role: "money", surface: "$20", quantity: { value: 20, unit: "USD", bound: "max" }, gist: "budget",
    })]), input("$20"));
    expect(eur.needs[0]).toMatchObject({ label: "budget €15" });
    expect(usd.needs[0]).toMatchObject({ label: "budget $20" });
  });

  it("maps time, attributes, known kinds, and open qualities row by row", () => {
    const time = concept({
      role: "time", surface: "tomorrow for lunch", phrase: "tomorrow for lunch", gist: "tomorrow lunch",
      timeSpec: { day: { kind: "tomorrow" }, part: "lunch", clock: null },
    });
    const attribute = concept({ role: "attribute", surface: "step-free", attributeKey: "wheelchair-accessible", gist: "step-free access" });
    const kind = concept({ role: "kind", surface: "italian or spanish", values: ["italian", "spanish"], gist: "italian or spanish" });
    const quality = concept({ role: "quality", surface: "kid friendly", gist: "good for children" });
    const out = mapInterpretation(interpretation([time, attribute, kind, quality]), input("several needs"));
    expect(out.needs.map((need) => need.payload)).toEqual([
      { kind: "time", window: { start: "2026-09-04T12:00:00+02:00", end: "2026-09-04T14:00:00+02:00" }, phrase: time.phrase },
      { kind: "attribute", key: "wheelchair-accessible", expect: "verified_true" },
      { kind: "inclusion", key: "cuisine", values: ["italian", "spanish"], lifetime: "session" },
      { kind: "text", text: "kid friendly" },
    ]);
    expect(out.needs[3].label).toBe("good for children");
  });

  it("maps excluded known kinds and splits an unknown included kind into a safe question", () => {
    const excluded = concept({ role: "kind", surface: "no Italian", polarity: "exclude", values: ["italian"], gist: "no italian" });
    const unknown = concept({ role: "kind", surface: "Italian or Martian", values: ["italian", "martian"], gist: "italian or martian" });
    const out = mapInterpretation(interpretation([excluded, unknown]), input("no Italian; Italian or Martian"));
    expect(out.needs.map((need) => need.payload)).toEqual([
      { kind: "exclusion", key: "cuisine", values: ["italian"], lifetime: "session" },
      { kind: "inclusion", key: "cuisine", values: ["italian"], lifetime: "session" },
      { kind: "text", text: "is this a martian kind of place?" },
    ]);
    expect(out.needs[2].label).toBe("martian place");
  });

  it("clarifies an unknown excluded kind with a recorded alternative and a safe text need", () => {
    const out = mapInterpretation(interpretation([concept({
      role: "kind", surface: "no Martian", polarity: "exclude", values: ["martian"], gist: "no martian",
    })]), input("no Martian"));
    expect(out.intent).toBe("clarify");
    expect(out.clarify?.choices).toMatchObject([
      { label: "Avoid Italian", needs: [{ payload: { kind: "exclusion", key: "cuisine", values: ["italian"] } }] },
      { label: "Rule out places whose site mentions martian", needs: [{ payload: { kind: "text" } }] },
      { label: "Leave it out", needs: [] },
    ]);
  });

  it("resolves candidate, participant, centre, and landmark referents in order", () => {
    setFindLandmarks(() => [{
      id: "l1", name: "U Alexanderplatz", kind: "station", kindLabel: "U-Bahn",
      location: { lat: 52.52, lng: 13.41 }, score: 1,
    }]);
    const make = (name: string) => concept({
      role: "distance", surface: `500 m from ${name}`,
      quantity: { value: 500, unit: "m", bound: "max" }, referent: { kind: "named", name }, gist: "distance",
    });
    const rows = [
      mapInterpretation(interpretation([make("Café Einstein")]), input("candidate")),
      mapInterpretation(interpretation([make("Sarah")]), input("participant")),
      mapInterpretation(interpretation([{ ...make("centre"), referent: { kind: "scope_center", name: null } }]), input("centre")),
      mapInterpretation(interpretation([make("U Alexanderplatz")]), input("landmark")),
    ];
    expect(rows.map((row) => row.needs[0].payload)).toEqual([
      { kind: "scope", dimension: "radius_m", max: 500, referent: { kind: "candidate", candidateId: "c1" } },
      { kind: "scope", dimension: "radius_m", max: 500, referent: { kind: "participant", participantId: "p1" } },
      { kind: "scope", dimension: "radius_m", max: 500, referent: { kind: "scopeCenter" } },
      { kind: "scope", dimension: "radius_m", max: 500, referent: { kind: "landmark", landmarkId: "l1" } },
    ]);
    expect(rows[3].needs[0].label).toBe("within 500 m of U Alexanderplatz");
  });

  it("promotes a stated noun phrase to need unless it is genuinely interrogative", () => {
    const distance = concept({
      role: "distance", surface: "places within 500 m", quantity: { value: 500, unit: "m", bound: "max" },
      referent: { kind: "self", name: null }, gist: "distance",
    });
    expect(mapInterpretation(interpretation([distance], "ask"), input("places within 500 m")).intent).toBe("need");
    expect(mapInterpretation(interpretation([distance], "ask"), input("Is there anything within 500 m?")).intent).toBe("ask");
    expect(looksInterrogative("Wie viele gibt es?")).toBe(true);
  });

  it("range-checks every numeric role and emits only closed payloads", () => {
    const bad = [
      concept({ role: "distance", surface: "1 m", quantity: { value: 1, unit: "m", bound: "max" } }),
      concept({ role: "travel_time", surface: "181 min", quantity: { value: 181, unit: "min", bound: "max" }, mode: "walk" }),
      concept({ role: "money", surface: "€501", quantity: { value: 501, unit: "EUR", bound: "max" } }),
    ];
    for (const row of bad) expect(mapInterpretation(interpretation([row]), input(row.surface)).intent).toBe("clarify");
    const good = mapInterpretation(interpretation([concept({
      role: "attribute", surface: "invented", attributeKey: "not-a-key", gist: "invented",
    })]), input("invented"));
    expect(good.needs.every((need) => validPayload(need.payload))).toBe(true);
    expect(good.needs[0].payload).toEqual({ kind: "text", text: "invented" });
  });
});
