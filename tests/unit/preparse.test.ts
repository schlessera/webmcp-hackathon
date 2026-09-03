import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { preparse, type SpatialContextResult } from "@webmcp-hackathon/contracts";
import { say } from "../../apps/server/src/nl/say.ts";
import { setTransport } from "../../apps/server/src/nl/openai.ts";

interface CorpusRow {
  id: string;
  lang: "en" | "de";
  text: string;
  context: string;
  expect: {
    intent?: string;
    needs: Array<Record<string, unknown>> | string[];
    clarify?: boolean | null;
    /** Plan rows only: the step class the goal must land on. */
    placeClass?: string;
  };
  preparse: "whole" | "partial" | "none";
  tags: string[];
}

const corpusPath = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "nl-corpus.jsonl");
const corpus = readFileSync(corpusPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as CorpusRow);
/** Plan rows are goals for a room that does not exist yet: they go through
 * /api/plans/preview, not say(), and tests/unit/plan-preview.test.ts drives
 * them. They still live in the one corpus so the live check reads one file. */
const sayCorpus = corpus.filter((row) => !row.tags.includes("plan"));

function context(row: CorpusRow): SpatialContextResult {
  const usd = row.context === "usd";
  const agreement = row.context === "agreement";
  const bikeAllowed = row.context === "bikeAllowed";
  return {
    ok: true,
    revision: 1,
    phase: "gathering",
    scope: {
      scopeId: "s1",
      area: { kind: "circle", center: { lat: 52.52, lng: 13.4 }, radiusM: 1_500 },
      transport: bikeAllowed ? ["walk", "bike", "car", "transit"] : ["walk"],
      category: "places",
    },
    area: {
      areaId: usd ? "sf-soma" : "berlin-mitte",
      label: usd ? "San Francisco SoMa" : "Berlin Mitte",
      kind: "osm-snapshot",
      source: "fixture",
      dataAsOf: "2026-09-01T00:00:00Z",
      poolSize: 1,
      focusVenues: 1,
    },
    feasibility: { state: "feasible", eligible: 1, likely: 0, uncertain: 0, unlikely: 0, excluded: 0 },
    total: 1,
    matching: 1,
    likely: 0,
    candidates: [{
      candidateId: "c_einstein",
      name: "Café Einstein",
      category: "place",
      location: { lat: 52.52, lng: 13.4 },
      eligibility: "eligible",
      walkMin: 10,
      priceLevel: 2,
    }],
    facets: [],
    activeNeeds: [],
    privateEffects: [],
    participants: [{
      participantId: "p_sarah",
      displayName: "Sarah",
      role: "member",
      readyState: "contributing",
      arrived: true,
      present: true,
      ...(row.context === "noOrigin" ? {} : {}),
    }],
    proposals: agreement ? [{
      proposalId: "pr1",
      candidateId: "c_einstein",
      status: "committed",
      stances: [],
      vetoStands: false,
      staging: { ready: true, notReady: [], unaccepted: 0, vetoStands: false },
    }] : [],
    ...(agreement ? { agreement: { proposalId: "pr1", candidateId: "c_einstein", status: "committed" } } : {}),
  } as SpatialContextResult;
}

beforeEach(() => setTransport(async () => { throw new Error("model transport must not run"); }));
afterEach(() => setTransport(null));

describe("shared pre-parser corpus", () => {
  it("has the required size, language mix, and coverage buckets", () => {
    expect(corpus.length).toBeGreaterThanOrEqual(80);
    expect(corpus.filter((row) => row.lang === "de").length).toBeGreaterThanOrEqual(25);
    const minimums: Record<string, number> = {
      distance: 12,
      travel: 10,
      referent: 12,
      money: 8,
      time: 10,
      attribute: 8,
      kind: 10,
      quality: 8,
      multi: 8,
      "ask-act": 6,
      clarify: 8,
      other: 4,
      plan: 8,
    };
    for (const [tag, minimum] of Object.entries(minimums)) {
      expect(corpus.filter((row) => row.tags.includes(tag)).length, tag).toBeGreaterThanOrEqual(minimum);
    }
  });

  for (const row of sayCorpus.filter((candidate) => candidate.preparse === "whole")) {
    it(`${row.id}: maps the whole sentence without transport`, async () => {
      let calls = 0;
      setTransport(async () => {
        calls += 1;
        throw new Error("model transport must not run");
      });
      const out = await say(row.text, "shared", context(row), new Date("2026-09-03T10:00:00Z"));
      expect(calls).toBe(0);
      expect(out.intent).toBe(row.expect.intent);
      expect(out.needs.map((need) => need.payload)).toMatchObject(
        row.expect.needs as Array<Record<string, unknown>>,
      );
      expect(Boolean(out.clarify)).toBe(Boolean(row.expect.clarify));
    });
  }

  for (const row of sayCorpus.filter((candidate) => candidate.preparse === "partial")) {
    it(`${row.id}: reports consumed spans and leaves the residual words`, () => {
      const parsed = preparse(row.text, { currency: row.context === "usd" ? "USD" : "EUR" });
      expect(parsed.preparsedWhole).toBe(false);
      expect(parsed.consumed.length).toBeGreaterThan(0);
      expect(parsed.remainder.length).toBeGreaterThan(0);
      expect(parsed.remainder.length).toBeLessThan(row.text.length);
      for (const [start, end] of parsed.consumed) {
        expect(start).toBeGreaterThanOrEqual(0);
        expect(end).toBeGreaterThan(start);
        expect(end).toBeLessThanOrEqual(row.text.length);
      }
    });
  }

  for (const row of sayCorpus.filter((candidate) => candidate.preparse === "none")) {
    it(`${row.id}: leaves model-only words for stage A`, () => {
      const parsed = preparse(row.text, { currency: row.context === "usd" ? "USD" : "EUR" });
      expect(parsed.concepts).toEqual([]);
      expect(parsed.consumed).toEqual([]);
      expect(parsed.remainder).toBe(row.text.replace(/[\s,;:.!?()[\]{}]+$/g, "").trim());
      expect(parsed.preparsedWhole).toBe(false);
    });
  }
});
