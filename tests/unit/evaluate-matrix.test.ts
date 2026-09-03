import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { criterionFor, questionKey, type Criterion } from "@webmcp-hackathon/contracts";
import {
  EVALUATE_MATRIX_PROMPT,
  EVALUATE_MATRIX_SCHEMA,
  EXPLICIT_OWN_SITE_CONFIDENCE,
  evaluateMatrix,
  matrixClaimsFromAnswer,
  matrixBatchFromAnswer,
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
import { applyInferredAttributes } from "../../apps/server/src/enrich/infer.ts";
import { classifyAll, type CandidateRow, type RequirementRow } from "../../apps/server/src/eligibility.ts";
import { setTransport } from "../../apps/server/src/nl/openai.ts";

/** U5/E8: one strict matrix call fills only verbatim, same-place evidence cells and source caps every guess. */

const wifi: Criterion = {
  id: questionKey("free wifi"),
  kind: "question",
  text: "free wifi",
  label: "free wifi",
};
const dog: Criterion = { id: "dog-friendly", kind: "key", key: "dog-friendly", label: "dogs welcome" };

function inferenceDb() {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const client = {
    query: async (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values });
      if (sql.includes("SELECT osm_ref, inferred")) {
        return {
          rows: [...(values[0] as string[])]
            .sort()
            .map((osm_ref) => ({ osm_ref, inferred: {} })),
          rowCount: (values[0] as string[]).length,
        };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined,
  };
  return { db: { connect: async () => client }, calls };
}

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
    expect(EVALUATE_MATRIX_SCHEMA.properties.claims.maxItems).toBe(40);
    expect(EVALUATE_MATRIX_SCHEMA.properties.claims.items.properties.lean.enum).toContain("abstain");
    expect(EVALUATE_MATRIX_SCHEMA.properties.claims.items.required).toContain("explicit");
    expect([MAX_MATRIX_PLACES, MAX_MATRIX_CRITERIA, MAX_TEXT_CHARS_PER_PLACE]).toEqual([8, 5, 6000]);
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

  it("drops a duplicate cell even when its first occurrence is rejected", () => {
    expect(matrixClaimsFromAnswer({ claims: [
      {
        candidateId: "alpha", criterionId: wifi.id, lean: "yes", confidence: 0.8,
        evidence: "not a supplied evidence span", sourceIndex: 0, explicit: false,
      },
      {
        candidateId: "alpha", criterionId: wifi.id, lean: "yes", confidence: 0.8,
        evidence: "free wireless internet throughout", sourceIndex: 0, explicit: false,
      },
    ] }, input(), "test")).toEqual([]);
  });

  it("clamps venue, domain-search, open-web and name/category evidence", async () => {
    const criteria: Criterion[] = [
      dog,
      { id: "delivery", kind: "key", key: "delivery", label: "delivery" },
      { id: "outdoor-seating", kind: "key", key: "outdoor-seating", label: "outdoor seating" },
      { id: "takeaway", kind: "key", key: "takeaway", label: "takeaway" },
      { id: "vegan-options", kind: "key", key: "vegan-options", label: "vegan options" },
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
          { source: "menu", text: "Plant-based dishes are marked clearly throughout the menu." },
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
        { candidateId: "caps", criterionId: "vegan-options", lean: "yes", confidence: 0.99, evidence: "Plant-based dishes are marked clearly", sourceIndex: bySource.get("menu") },
      ]);
    });
    expect((await evaluateMatrix(sample)).map((claim) => claim.confidence)).toEqual([
      MATRIX_CONFIDENCE_CAPS.venue_site,
      MATRIX_CONFIDENCE_CAPS.domain_search,
      MATRIX_CONFIDENCE_CAPS.open_web_search,
      MATRIX_CONFIDENCE_CAPS.name_category,
      MATRIX_CONFIDENCE_CAPS.menu,
    ]);
  });

  it("grades only an explicit statement on the recorded venue host as verified", () => {
    const sample = input();
    sample.places[0].website = "https://www.alpha.example/";
    const own = matrixBatchFromAnswer({ claims: [{
      candidateId: "alpha", criterionId: wifi.id, lean: "yes", confidence: 0.2,
      evidence: "free wireless internet throughout", sourceIndex: 0, explicit: true,
    }] }, sample, "test").claims[0];
    expect(own).toMatchObject({
      status: "verified_true",
      confidence: EXPLICIT_OWN_SITE_CONFIDENCE,
      source: "web:alpha.example",
      explicit: true,
    });

    sample.places[0].texts[0].url = "https://other.example/copied";
    const other = matrixBatchFromAnswer({ claims: [{
      candidateId: "alpha", criterionId: wifi.id, lean: "yes", confidence: 0.99,
      evidence: "free wireless internet throughout", sourceIndex: 0, explicit: true,
    }] }, sample, "test").claims[0];
    expect(other).toMatchObject({ status: "likely_true", confidence: 0.6 });
    expect(other.source).toMatch(/^infer:/);
  });

  it("never sends or accepts a time-window criterion", async () => {
    const temporal: Criterion = {
      id: "open:2026-09-04T12:00:00+02:00-2026-09-04T14:00:00+02:00",
      kind: "key",
      key: "open:2026-09-04T12:00:00+02:00-2026-09-04T14:00:00+02:00",
      label: "open tomorrow 12:00 to 14:00",
    };
    const sample = input();
    sample.criteria = [temporal];
    sample.places[0].website = "https://alpha.example/";
    sample.places[0].texts[0].text = "We are open tomorrow from noon until two.";
    const transport = vi.fn(async () => response([]));
    setTransport(transport);
    expect(await evaluateMatrix(sample)).toEqual([]);
    expect(transport).not.toHaveBeenCalled();
    expect(matrixBatchFromAnswer({ claims: [{
      candidateId: "alpha",
      criterionId: temporal.id,
      lean: "yes",
      confidence: 0.99,
      evidence: "open tomorrow from noon until two",
      sourceIndex: 0,
      explicit: true,
    }] }, sample, "test").claims).toEqual([]);
  });

  it("lets an explicit own-site question claim make its text need eligible", () => {
    const key = wifi.id;
    const attributes = applyEnrichmentAttributes([], {
      osmRef: "node/1",
      fetchedAt: "2026-09-03T00:00:00.000Z",
      website: null,
      wikidata: null,
      inferred: {
        [key]: {
          key,
          lean: "yes",
          confidence: 0.72,
          evidence: "Free wireless internet is available",
          source: "web:alpha.example",
          observedAt: "2026-09-03T00:00:00.000Z",
          sourceUrl: "https://alpha.example/visit",
          explicit: true,
        },
      },
      error: null,
    });
    const candidate: CandidateRow = {
      id: "alpha", map_revision: 0, name: "Alpha", category: "cafe",
      price_level: null, walk_min: 1, location: { lat: 0, lng: 0 }, attributes,
    };
    const requirement: RequirementRow = {
      id: "r1", owner_id: "p1", visibility: "shared", hardness: "hard",
      payload: { kind: "text", text: wifi.text }, withdrawn: false,
    };
    expect(classifyAll([candidate], [requirement], [], null)[0].eligibility).toBe("eligible");
  });

  it("carries cuisine values to the model and consumes the value-specific answer", async () => {
    const cuisine = criterionFor({
      kind: "inclusion", key: "cuisine", values: ["italian"], lifetime: "session",
    })!;
    let sentCriterion: Criterion | undefined;
    setTransport(async (body) => {
      const sent = JSON.parse((body.input as Array<{ content: string }>)[0].content) as EvaluateMatrixInput;
      sentCriterion = sent.criteria[0];
      return response([{
        candidateId: "food", criterionId: cuisine.id, lean: "yes", confidence: 0.58,
        evidence: "Traditional Italian dishes are served", sourceIndex: 0, explicit: false,
      }]);
    });
    const [claim] = await evaluateMatrix({
      places: [{
        candidateId: "food", osmRef: "node/food", name: "Food", category: "restaurant",
        texts: [{ source: "web", text: "Traditional Italian dishes are served every evening." }],
      }],
      criteria: [cuisine],
    });
    expect(sentCriterion).toMatchObject({
      values: ["italian"], question: "Does this place serve italian food?",
    });
    expect(claim).toMatchObject({ key: cuisine.id, value: "italian", status: "likely_true" });
    const attributes = applyInferredAttributes([], {
      [cuisine.id]: { ...claim, key: cuisine.id },
    });
    expect(attributes).toEqual([expect.objectContaining({
      key: cuisine.id, value: "italian", status: "likely_true",
    })]);
    const candidate: CandidateRow = {
      id: "food", map_revision: 0, name: "Food", category: "restaurant",
      price_level: null, walk_min: 1, location: { lat: 0, lng: 0 }, attributes,
    };
    const requirement: RequirementRow = {
      id: "r-food", owner_id: "p1", visibility: "shared", hardness: "hard",
      payload: { kind: "inclusion", key: "cuisine", values: ["italian"] }, withdrawn: false,
    };
    expect(classifyAll([candidate], [requirement], [], null)[0]).toMatchObject({
      eligibility: "likely", confidence: 0.58,
    });
  });

  it("turns abstain into no stored claim", async () => {
    setTransport(async () => response([
      { candidateId: "alpha", criterionId: wifi.id, lean: "abstain", confidence: 0, evidence: "", sourceIndex: null },
    ]));
    expect(await evaluateMatrix(input())).toEqual([]);
  });

  it("splits an 8 × 5 bounded matrix on both axes", async () => {
    let calls = 0;
    const shapes: Array<[number, number]> = [];
    setTransport(async (body) => {
      calls += 1;
      const sent = JSON.parse((body.input as Array<{ content: string }>)[0].content) as EvaluateMatrixInput;
      shapes.push([sent.places.length, sent.criteria.length]);
      return response(sent.places.flatMap((place) => sent.criteria.map((criterion) => ({
        candidateId: place.candidateId,
        criterionId: criterion.id,
        lean: "yes",
        confidence: 0.5,
        evidence: "Direct supporting words",
        sourceIndex: 0,
      }))));
    });
    const sample: EvaluateMatrixInput = {
      places: Array.from({ length: 9 }, (_, index) => ({
        candidateId: `p${index}`,
        osmRef: `node/${index}`,
        name: `Place ${index}`,
        category: "cafe",
        texts: [{ source: "web", text: "Direct supporting words appear here." }],
      })),
      criteria: Array.from({ length: 6 }, (_, index): Criterion => ({
        id: `key-${index}`,
        kind: "key",
        key: `key-${index}`,
        label: `criterion ${index}`,
      })),
    };
    expect(await evaluateMatrix(sample)).toHaveLength(54);
    expect(calls).toBe(4);
    expect(shapes).toEqual([[8, 5], [8, 1], [1, 5], [1, 1]]);
  });

  it("does not persist missing cells, but persists an explicit abstention", async () => {
    const sample = input();
    const batch = matrixBatchFromAnswer({ claims: [
      { candidateId: "alpha", criterionId: wifi.id, lean: "yes", confidence: 0.8, evidence: "free wireless internet throughout", sourceIndex: 0 },
      { candidateId: "alpha", criterionId: dog.id, lean: "abstain", confidence: 0, evidence: "", sourceIndex: null },
    ] }, sample, "test", "2026-09-03T00:00:00.000Z");
    const { db, calls } = inferenceDb();
    await saveInferences(db as never, sample.places.map((place) => ({
      osmRef: place.osmRef,
      criteria: sample.criteria,
      claims: batch.claims.filter((claim) => claim.candidateId === place.candidateId),
      answeredCriterionIds: batch.answered
        .filter((cell) => cell.candidateId === place.candidateId)
        .map((cell) => cell.criterionId),
      observedAt: "2026-09-03T00:00:00.000Z",
    })));
    expect(calls.map((call) => call.sql.trim().split(/\s+/)[0])).toEqual([
      "BEGIN",
      "INSERT",
      "SELECT",
      "WITH",
      "COMMIT",
    ]);
    const payloads = calls[3].values[1] as string[];
    expect(payloads).toHaveLength(1);
    expect(JSON.parse(payloads[0])).toMatchObject({
      [wifi.id]: { lean: "yes" },
      [dog.id]: { omitted: true },
    });
  });

  it("writes nothing for transport or parse failures", async () => {
    let persisted = 0;
    setTransport(async () => { throw new Error("transport down"); });
    expect(await evaluateMatrix(input(), async () => { persisted += 1; })).toEqual([]);
    setTransport(async () => ({ output: [{ type: "message", content: [{ type: "output_text", text: "truncated" }] }] }));
    expect(await evaluateMatrix(input(), async () => { persisted += 1; })).toEqual([]);
    expect(persisted).toBe(0);
  });

  it("keeps the first batch persisted when the second batch fails", async () => {
    let calls = 0;
    const persisted: string[] = [];
    setTransport(async (body) => {
      calls += 1;
      if (calls === 2) throw new Error("later batch failed");
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
      places: Array.from({ length: 9 }, (_, index) => ({
        candidateId: `p${index}`,
        osmRef: `node/${index}`,
        name: `Place ${index}`,
        category: "cafe",
        texts: [{ source: "web", text: "Dogs are welcome here every day." }],
      })),
      criteria: [dog],
    };
    const claims = await evaluateMatrix(sample, async (batch) => {
      persisted.push(...batch.claims.map((claim) => claim.candidateId));
    });
    expect(calls).toBe(2);
    expect(persisted).toEqual(Array.from({ length: 8 }, (_, index) => `p${index}`));
    expect(claims).toHaveLength(8);
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

  it("locks and updates a whole batch without persisting question copy", async () => {
    const { db, calls } = inferenceDb();
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
      explicit: false,
    };
    await saveInferences(db as never, [
      { osmRef: "node/2", criteria: [dog], claims: [], answeredCriterionIds: [dog.id], observedAt: claim.observedAt },
      { osmRef: "node/1", criteria: [wifi], claims: [claim], answeredCriterionIds: [wifi.id], observedAt: claim.observedAt },
    ]);
    expect(calls).toHaveLength(5);
    expect(calls[1].sql).toContain("ON CONFLICT (osm_ref) DO NOTHING");
    expect(calls[2].sql).toContain("FOR UPDATE");
    expect(calls[3].sql).toContain("UPDATE enrichments");
    expect(calls[3].values[0]).toEqual(["node/1", "node/2"]);
    const payloads = calls[3].values[1] as string[];
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
  it("never puts a question's sentence on a claim, only its hash", async () => {
    // A claim is what reaches the cross-room enrichments cache, and a question
    // may be application-private, so the sentence must not ride along
    // (CLAUDE.md 5). Authorized copy comes from the viewer's own requirement.
    const question = criterionFor({ kind: "text", text: "is there a quiet room" } as never)!;
    setTransport(async () => response([
      { candidateId: "alpha", criterionId: question.id, lean: "yes", confidence: 0.9, evidence: "free wireless internet throughout", sourceIndex: 0 },
    ]));
    const claims = await evaluateMatrix({ ...input(), criteria: [question] });
    expect(claims).toHaveLength(1);
    expect(claims[0].criterionId).toBe(question.id);
    expect(claims[0]).not.toHaveProperty("question");
    expect(claims[0]).not.toHaveProperty("label");
    expect(JSON.stringify(claims[0])).not.toContain("quiet room");
  });
});
