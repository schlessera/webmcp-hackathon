import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { questionKey, type Criterion } from "@webmcp-hackathon/contracts";
import {
  EVALUATE_MATRIX_PROMPT,
  EVALUATE_MATRIX_SCHEMA,
  evaluateMatrix,
  MATRIX_CONFIDENCE_CAPS,
  MAX_MATRIX_CRITERIA,
  MAX_MATRIX_PLACES,
  MAX_TEXT_CHARS_PER_PLACE,
  trimMatrixPlace,
  type EvaluateMatrixInput,
  type EvaluatedInference,
} from "../../apps/server/src/enrich/evaluate.ts";
import {
  applyEnrichmentAttributes,
  harvestRequirementCriteria,
  saveInferences,
} from "../../apps/server/src/enrich/index.ts";
import { setTransport } from "../../apps/server/src/nl/openai.ts";

/** U5/E8: one strict matrix call fills only verbatim, same-place evidence cells and source caps every guess. */

const wifi: Criterion = {
  id: questionKey("free wifi"),
  kind: "question",
  text: "free wifi",
  label: "free wifi",
};
const dog: Criterion = { id: "dog-friendly", kind: "key", key: "dog-friendly", label: "dogs welcome" };

const input = (): EvaluateMatrixInput => ({
  places: [
    {
      candidateId: "alpha",
      osmRef: "node/1",
      name: "Alpha Café",
      category: "cafe",
      texts: [{ source: "web", text: "Guests can use free wireless internet throughout the café.", url: "https://alpha.example/visit" }],
    },
    {
      candidateId: "beta",
      osmRef: "node/2",
      name: "Beta Bistro",
      category: "restaurant",
      texts: [{ source: "web", text: "Dogs are not allowed inside the dining room.", url: "https://beta.example/rules" }],
    },
  ],
  criteria: [wifi, dog],
});

const response = (claims: unknown[]) => ({
  output: [{
    type: "message",
    content: [{ type: "output_text", text: JSON.stringify({ claims }) }],
  }],
});

beforeEach(() => {
  vi.stubEnv("ENRICH_NETWORK", "1");
  vi.stubEnv("INFER", "1");
  vi.stubEnv("OPENAI_API_KEY", "test");
});

afterEach(() => {
  setTransport(null);
  vi.unstubAllEnvs();
});

describe("batched matrix evaluation", () => {
  it("publishes its strict prompt, schema and limits", () => {
    expect(EVALUATE_MATRIX_PROMPT).toContain("candidateId × criterionId");
    expect(EVALUATE_MATRIX_SCHEMA.properties.claims.maxItems).toBe(96);
    expect(EVALUATE_MATRIX_SCHEMA.properties.claims.items.properties.lean.enum).toContain("abstain");
    expect([MAX_MATRIX_PLACES, MAX_MATRIX_CRITERIA, MAX_TEXT_CHARS_PER_PLACE]).toEqual([12, 8, 6000]);
  });

  it("attributes a place × criterion grid and carries the cited URL", async () => {
    let wire: Record<string, unknown> | undefined;
    setTransport(async (body) => {
      wire = body;
      return response([
        { candidateId: "alpha", criterionId: wifi.id, lean: "yes", confidence: 0.92, evidence: "free wireless internet throughout", sourceIndex: 0 },
        { candidateId: "beta", criterionId: dog.id, lean: "no", confidence: 0.91, evidence: "Dogs are not allowed", sourceIndex: 0 },
        { candidateId: "alpha", criterionId: dog.id, lean: "abstain", confidence: 0, evidence: "", sourceIndex: null },
        { candidateId: "beta", criterionId: wifi.id, lean: "abstain", confidence: 0, evidence: "", sourceIndex: null },
      ]);
    });
    const claims = await evaluateMatrix(input());
    expect(claims).toEqual([
      expect.objectContaining({ candidateId: "alpha", criterionId: wifi.id, key: wifi.id, status: "likely_true", sourceUrl: "https://alpha.example/visit" }),
      expect.objectContaining({ candidateId: "beta", criterionId: dog.id, key: "dog-friendly", status: "likely_false", sourceUrl: "https://beta.example/rules" }),
    ]);
    expect(wire).toMatchObject({
      reasoning: { effort: "none" },
      text: { format: { type: "json_schema", strict: true } },
    });
  });

  it("rejects a paraphrase, a short span, another place's span, and a criterion echo", async () => {
    const sample = input();
    const echoed: Criterion = {
      id: questionKey("quiet rooftop seating after sunset"),
      kind: "question",
      text: "quiet rooftop seating after sunset",
      label: "quiet rooftop seating after sunset",
    };
    sample.criteria.push(echoed);
    sample.places[0].texts[0].text += " Quiet rooftop seating after sunset.";
    setTransport(async () => response([
      { candidateId: "alpha", criterionId: wifi.id, lean: "yes", confidence: 0.8, evidence: "complimentary internet everywhere", sourceIndex: 0 },
      { candidateId: "beta", criterionId: dog.id, lean: "no", confidence: 0.8, evidence: "not allowed", sourceIndex: 0 },
      { candidateId: "beta", criterionId: wifi.id, lean: "yes", confidence: 0.8, evidence: "free wireless internet throughout", sourceIndex: 0 },
      { candidateId: "alpha", criterionId: echoed.id, lean: "yes", confidence: 0.8, evidence: "Quiet rooftop seating after sunset", sourceIndex: 0 },
    ]));
    expect(await evaluateMatrix(sample)).toEqual([]);
  });

  it("clamps venue, domain-search, open-web and name/category evidence", async () => {
    const criteria: Criterion[] = [
      dog,
      { id: "delivery", kind: "key", key: "delivery", label: "delivery" },
      { id: "outdoor-seating", kind: "key", key: "outdoor-seating", label: "outdoor seating" },
      { id: "takeaway", kind: "key", key: "takeaway", label: "takeaway" },
    ];
    const sample: EvaluateMatrixInput = {
      places: [{
        candidateId: "caps",
        osmRef: "node/caps",
        name: "Neighborhood Garden Café",
        category: "restaurant",
        texts: [
          { source: "web", text: "Dogs may join guests in the courtyard." },
          { source: "domain_search", text: "Delivery is available across the local district." },
          { source: "open_web_search", text: "The terrace has outdoor tables under the trees." },
        ],
      }],
      criteria,
    };
    setTransport(async (body) => {
      const sent = JSON.parse((body.input as Array<{ content: string }>)[0].content) as EvaluateMatrixInput;
      const bySource = new Map(sent.places[0].texts.map((text, index) => [text.source, index]));
      return response([
        { candidateId: "caps", criterionId: dog.id, lean: "yes", confidence: 0.99, evidence: "Dogs may join guests", sourceIndex: bySource.get("web") },
        { candidateId: "caps", criterionId: "delivery", lean: "yes", confidence: 0.99, evidence: "Delivery is available across", sourceIndex: bySource.get("domain_search") },
        { candidateId: "caps", criterionId: "outdoor-seating", lean: "yes", confidence: 0.99, evidence: "outdoor tables under the trees", sourceIndex: bySource.get("open_web_search") },
        { candidateId: "caps", criterionId: "takeaway", lean: "yes", confidence: 0.99, evidence: "Neighborhood Garden Café", sourceIndex: -1 },
      ]);
    });
    expect((await evaluateMatrix(sample)).map((claim) => claim.confidence)).toEqual([
      MATRIX_CONFIDENCE_CAPS.venue_site,
      MATRIX_CONFIDENCE_CAPS.domain_search,
      MATRIX_CONFIDENCE_CAPS.open_web_search,
      MATRIX_CONFIDENCE_CAPS.name_category,
    ]);
  });

  it("turns abstain into no stored claim", async () => {
    setTransport(async () => response([
      { candidateId: "alpha", criterionId: wifi.id, lean: "abstain", confidence: 0, evidence: "", sourceIndex: null },
    ]));
    expect(await evaluateMatrix(input())).toEqual([]);
  });

  it("splits after 12 places and merges both responses", async () => {
    let calls = 0;
    setTransport(async (body) => {
      calls += 1;
      const sent = JSON.parse((body.input as Array<{ content: string }>)[0].content) as EvaluateMatrixInput;
      return response(sent.places.map((place) => ({
        candidateId: place.candidateId,
        criterionId: dog.id,
        lean: "yes",
        confidence: 0.5,
        evidence: "Dogs are welcome here",
        sourceIndex: 0,
      })));
    });
    const sample: EvaluateMatrixInput = {
      places: Array.from({ length: 13 }, (_, index) => ({
        candidateId: `p${index}`,
        osmRef: `node/${index}`,
        name: `Place ${index}`,
        category: "cafe",
        texts: [{ source: "web", text: "Dogs are welcome here every day." }],
      })),
      criteria: [dog],
    };
    expect(await evaluateMatrix(sample)).toHaveLength(13);
    expect(calls).toBe(2);
  });

  it("splits after 8 criteria and merges both responses", async () => {
    let calls = 0;
    setTransport(async (body) => {
      calls += 1;
      const sent = JSON.parse((body.input as Array<{ content: string }>)[0].content) as EvaluateMatrixInput;
      return response(sent.criteria.map((criterion) => ({
        candidateId: "p",
        criterionId: criterion.id,
        lean: "yes",
        confidence: 0.5,
        evidence: "Direct supporting words",
        sourceIndex: 0,
      })));
    });
    const criteria = Array.from({ length: 9 }, (_, index): Criterion => ({
      id: `key-${index}`,
      kind: "key",
      key: `key-${index}`,
      label: `criterion ${index}`,
    }));
    expect(await evaluateMatrix({
      places: [{ candidateId: "p", osmRef: "node/p", name: "P", category: "cafe", texts: [{ source: "web", text: "Direct supporting words appear here." }] }],
      criteria,
    })).toHaveLength(9);
    expect(calls).toBe(2);
  });

  it("keeps the longest source last and trims aggregate text to 6,000 characters", () => {
    const place = trimMatrixPlace({
      candidateId: "p",
      osmRef: "node/p",
      name: "P",
      category: "cafe",
      texts: [
        { source: "web", text: "x".repeat(5000) },
        { source: "web", text: "short source" },
        { source: "menu", text: "m".repeat(3000) },
      ],
    });
    expect(place.texts.reduce((sum, item) => sum + item.text.length, 0)).toBe(6000);
    expect(place.texts[0].text).toBe("short source");
    expect(place.texts.at(-1)?.text).toHaveLength(2988);
  });
});

describe("bulk inference persistence", () => {
  it("merges a stored question as cited likely evidence without reader copy", () => {
    const attributes = applyEnrichmentAttributes([], {
      osmRef: "node/1",
      fetchedAt: "2026-09-03T00:00:00.000Z",
      website: null,
      wikidata: null,
      inferred: {
        [wifi.id]: {
          key: wifi.id,
          lean: "yes",
          confidence: 0.95,
          evidence: "Free wireless internet is available",
          source: "infer:test:domain_search",
          observedAt: "2026-09-03T00:00:00.000Z",
          sourceUrl: "https://alpha.example/visit",
        },
      },
      error: null,
    });
    expect(attributes).toEqual([expect.objectContaining({
      key: wifi.id,
      status: "likely_true",
      confidence: 0.6,
      note: "Free wireless internet is available",
      sourceUrl: "https://alpha.example/visit",
    })]);
    expect(attributes[0]).not.toHaveProperty("label");
  });

  it("issues one upsert for a whole batch without persisting question copy", async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const db = {
      query: async (sql: string, values: unknown[]) => {
        calls.push({ sql, values });
        return { rows: [], rowCount: 2 };
      },
    };
    const claim: EvaluatedInference = {
      candidateId: "alpha",
      osmRef: "node/1",
      criterionId: wifi.id,
      key: wifi.id,
      lean: "yes",
      status: "likely_true",
      confidence: 0.55,
      evidence: "free wireless internet throughout",
      source: "infer:test:domain_search",
      sourceIndex: 0,
      observedAt: "2026-09-03T00:00:00.000Z",
      sourceUrl: "https://alpha.example/visit",
      question: wifi.text,
      label: wifi.label,
    };
    await saveInferences(db as never, [
      { osmRef: "node/1", criteria: [wifi], claims: [claim], observedAt: claim.observedAt },
      { osmRef: "node/2", criteria: [dog], claims: [], observedAt: claim.observedAt },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain("FROM unnest");
    expect(calls[0].sql).toContain("ON CONFLICT");
    const payloads = calls[0].values[2] as string[];
    expect(JSON.parse(payloads[0])[wifi.id]).toMatchObject({
      key: wifi.id,
      lean: "yes",
      sourceUrl: "https://alpha.example/visit",
    });
    expect(JSON.parse(payloads[0])[wifi.id]).not.toHaveProperty("question");
    expect(JSON.parse(payloads[0])[wifi.id]).not.toHaveProperty("label");
    expect(JSON.parse(payloads[1])[dog.id]).toMatchObject({ omitted: true });
  });

  it("never harvests an agent-private payload as a model criterion", () => {
    expect(harvestRequirementCriteria([
      { visibility: "agent-private", payload: { kind: "text", text: "held by the agent" } },
      { visibility: "application-private", payload: { kind: "text", text: "server evaluable" } },
      { visibility: "shared", payload: { kind: "text", text: "room visible" } },
    ])).toEqual([
      expect.objectContaining({ kind: "question", label: "server evaluable" }),
      expect.objectContaining({ kind: "question", label: "room visible" }),
    ]);
  });
});
