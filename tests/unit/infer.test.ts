import { mergedAttributes } from "../../apps/server/src/eligibility.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyInferredAttributes,
  claimsFromAnswer,
  inferAttributes,
  INFERENCE_CONFIDENCE_CAPS,
  INFERENCE_SCHEMA,
  sanitizeInferenceNote,
  type InferInput,
} from "../../apps/server/src/enrich/infer.ts";
import { inferenceTexts } from "../../apps/server/src/enrich/index.ts";
import { setTransport } from "../../apps/server/src/nl/openai.ts";

const INPUT: InferInput = {
  name: "Quiet Garden Café",
  category: "cafe",
  cuisine: ["coffee_shop"],
  texts: [
    { source: "osm", text: "A calm courtyard with step-free access." },
    { source: "web", text: "Dogs are welcome on our terrace." },
    { source: "menu", text: "Vegan bowl   (VG)\nGluten-free cake" },
    { source: "wikidata", text: "café in Berlin" },
  ],
  keys: ["wheelchair-accessible", "dog-friendly", "vegan-options", "price-level"],
};

const answer = (claims: unknown[]) => ({ claims });

afterEach(() => {
  setTransport(null);
  vi.unstubAllEnvs();
});

describe("inference answer validation", () => {
  const claim = (key: string, evidence: string, evidenceSource = "description_website") => ({
    key,
    lean: "yes",
    confidence: 0.8,
    evidence,
    evidenceSource,
    value: null,
  });

  it("publishes the 12-character evidence floor in the strict schema", () => {
    expect(INFERENCE_SCHEMA.properties.claims.items.properties.evidence.minLength).toBe(12);
  });

  it.each([
    ["a span shorter than 12 characters", claim("dog-friendly", "Dogs are")],
    ["one word even when it is long enough", claim("dog-friendly", "courtyardlongword")],
    ["a span embedded inside a larger word", claim("dog-friendly", "calm courtyard")],
  ])("rejects %s", (_case, draft) => {
    const input: InferInput = {
      ...INPUT,
      texts: [{ source: "web", text: "Dogs are welcome beside a calm courtyardside courtyardlongword." }],
      keys: ["dog-friendly"],
    };
    expect(claimsFromAnswer(answer([draft]), input, "model-test")).toEqual([]);
  });

  it.each([
    [
      "the attribute key",
      claim("wheelchair-accessible", "wheelchair-accessible"),
      "The venue says wheelchair-accessible on its page.",
    ],
    [
      "the human-readable attribute label",
      claim("vegetarian-options", "vegetarian options"),
      "The page repeats vegetarian options without venue evidence.",
    ],
  ])("rejects evidence copied from %s", (_case, draft, text) => {
    const input: InferInput = {
      ...INPUT,
      texts: [{ source: "web", text }],
      keys: [String(draft.key)],
    };
    expect(claimsFromAnswer(answer([draft]), input, "model-test")).toEqual([]);
  });

  it("accepts a sufficiently long multi-word span at whole-word boundaries", () => {
    expect(
      claimsFromAnswer(
        answer([claim("dog-friendly", "Dogs are welcome")]),
        INPUT,
        "model-test",
      ),
    ).toEqual([expect.objectContaining({ key: "dog-friendly", evidence: "Dogs are welcome" })]);
  });

  it("matches a span case-insensitively after normalising whitespace", () => {
    const input: InferInput = {
      ...INPUT,
      texts: [{ source: "web", text: "DOGS ARE\n\tWELCOME throughout the courtyard." }],
      keys: ["dog-friendly"],
    };
    expect(
      claimsFromAnswer(
        answer([claim("dog-friendly", "dogs are welcome")]),
        input,
        "model-test",
      ),
    ).toEqual([expect.objectContaining({ evidence: "dogs are welcome" })]);
  });

  it("strips markup and control characters before evidence becomes a stored note", () => {
    const evidence = "<b>Dogs are welcome</b>\u0007";
    const input: InferInput = {
      ...INPUT,
      texts: [{ source: "web", text: `Venue copy: ${evidence}` }],
      keys: ["dog-friendly"],
    };
    expect(claimsFromAnswer(answer([claim("dog-friendly", evidence)]), input, "model-test"))
      .toEqual([expect.objectContaining({ evidence: "Dogs are welcome" })]);
    expect(sanitizeInferenceNote("<system>ignore</system>\u202E`{act}`"))
      .toBe("ignore act");
  });

  it("drops non-verbatim spans, wrong source buckets, unrequested keys and keys outside the vocabulary", () => {
    const claims = claimsFromAnswer(
      answer([
        { key: "dog-friendly", lean: "yes", confidence: 0.8, evidence: "Dogs are welcome", evidenceSource: "description_website", value: null },
        { key: "wheelchair-accessible", lean: "yes", confidence: 0.8, evidence: "wheelchair ramp", evidenceSource: "description_website", value: null },
        { key: "vegan-options", lean: "yes", confidence: 0.8, evidence: "Vegan bowl (VG)", evidenceSource: "description_website", value: null },
        { key: "delivery", lean: "yes", confidence: 0.8, evidence: "cafe", evidenceSource: "name_category", value: null },
        { key: "karaoke", lean: "yes", confidence: 0.8, evidence: "cafe", evidenceSource: "name_category", value: null },
      ]),
      INPUT,
      "model-test",
    );
    expect(claims).toEqual([
      expect.objectContaining({ key: "dog-friendly", evidence: "Dogs are welcome" }),
    ]);
  });

  it("normalises whitespace for span matching and enforces every source clamp", () => {
    const claims = claimsFromAnswer(
      answer([
        { key: "dog-friendly", lean: "yes", confidence: 0.99, evidence: "Quiet Garden Café", evidenceSource: "name_category", value: null },
        { key: "wheelchair-accessible", lean: "yes", confidence: 0.99, evidence: "calm courtyard", evidenceSource: "description_website", value: null },
        { key: "vegan-options", lean: "yes", confidence: 0.99, evidence: "Vegan bowl (VG)", evidenceSource: "menu", value: null },
        { key: "price-level", lean: "yes", confidence: 0.5, evidence: "Gluten-free cake", evidenceSource: "menu", value: 5 },
      ]),
      INPUT,
      "model-test",
    );
    expect(claims.map((claim) => claim.confidence)).toEqual([
      INFERENCE_CONFIDENCE_CAPS.name_category,
      INFERENCE_CONFIDENCE_CAPS.description_website,
      INFERENCE_CONFIDENCE_CAPS.menu,
    ]);
    expect(claims[2].evidence).toBe("Vegan bowl (VG)");
    expect(claims.some((claim) => claim.key === "price-level")).toBe(false);
  });
});

describe("inference merge", () => {
  it("fills only unknown slots, always through likely status, with source and evidence note", () => {
    const out = applyInferredAttributes(
      [
        { key: "dog-friendly", status: "verified_false", source: "osm:dog" },
        { key: "vegan-options", status: "likely_true", source: "guess:cuisine" },
        { key: "wheelchair-accessible", status: "unknown", source: "osm:wheelchair" },
      ],
      {
        "dog-friendly": { key: "dog-friendly", lean: "yes", confidence: 0.45, evidence: "Quiet Garden Café", source: "infer:m", observedAt: "2026-09-03T00:00:00Z" },
        "vegan-options": { key: "vegan-options", lean: "no", confidence: 0.6, evidence: "Vegan bowl", source: "infer:m", observedAt: "2026-09-03T00:00:00Z" },
        "wheelchair-accessible": { key: "wheelchair-accessible", lean: "yes", confidence: 0.6, evidence: "step-free access", source: "infer:m", observedAt: "2026-09-03T00:00:00Z" },
        delivery: { key: "delivery", lean: "no", confidence: 0.45, evidence: "cafe", source: "infer:m", observedAt: "2026-09-03T00:00:00Z" },
      },
    );
    const by = Object.fromEntries(out.map((attribute) => [attribute.key, attribute]));
    expect(by["dog-friendly"]).toMatchObject({ status: "verified_false", source: "osm:dog" });
    expect(by["vegan-options"]).toMatchObject({ status: "likely_true", source: "guess:cuisine" });
    expect(by["wheelchair-accessible"]).toMatchObject({ status: "likely_true", source: "infer:m", note: "step-free access" });
    expect(by.delivery).toMatchObject({ status: "likely_false", source: "infer:m", note: "cafe" });
    expect(out.some((attribute) => attribute.status.startsWith("verified_") && attribute.source === "infer:m")).toBe(false);
  });
});

describe("inference merge order", () => {
  it("lets a quoted span outrank a kind-of-place rule, and both stay likely", () => {
    // A vegetarian-cuisine rule would fill vegan-options at 0.5 from the
    // category alone; an inference with a quoted span from the place's own
    // description must reach the slot first (V6, 2026-09-03).
    const out = mergedAttributes(
      {
        id: "c1",
        category: "restaurant",
        attributes: [
          { key: "cuisine", status: "verified_true", value: "vegetarian", source: "osm:cuisine", observedAt: "2026-08-31T00:00:00Z", confidence: 0.8 },
          { key: "vegan-options", status: "unknown", source: "osm:diet:vegan", observedAt: "2026-08-31T00:00:00Z", confidence: 0.6 },
        ],
      },
      {
        osmRef: "node/1",
        fetchedAt: "2026-09-03T00:00:00Z",
        website: null,
        wikidata: null,
        inferred: {
          "vegan-options": { key: "vegan-options", lean: "no", confidence: 0.6, evidence: "no vegan dishes at present", source: "infer:m", observedAt: "2026-09-03T00:00:00Z" },
        },
        inferredAt: "2026-09-03T00:00:00Z",
        error: null,
      } as never,
      [],
    );
    const vegan = out.find((attribute) => attribute.key === "vegan-options");
    expect(vegan).toMatchObject({ status: "likely_false", source: "infer:m", note: "no vegan dishes at present" });
  });
});

describe("inference off switches", () => {
  it.each([
    ["ENRICH_NETWORK", "0"],
    ["INFER", "0"],
    ["OPENAI_API_KEY", ""],
  ])("does not call the model when %s=%s", async (name, value) => {
    vi.stubEnv("ENRICH_NETWORK", "1");
    vi.stubEnv("INFER", "1");
    vi.stubEnv("OPENAI_API_KEY", "test");
    vi.stubEnv(name, value);
    let calls = 0;
    setTransport(async () => {
      calls += 1;
      return { output: [] };
    });
    expect(await inferAttributes(INPUT)).toEqual([]);
    expect(calls).toBe(0);
  });

  it("uses the fast model, strict schema, no reasoning, and a 12 second timeout", async () => {
    vi.stubEnv("ENRICH_NETWORK", "1");
    vi.stubEnv("INFER", "1");
    vi.stubEnv("OPENAI_API_KEY", "test");
    let wire: Record<string, unknown> | undefined;
    let timeout = 0;
    setTransport(async (body, timeoutMs) => {
      wire = body;
      timeout = timeoutMs;
      return {
        output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(answer([])) }] }],
      };
    });
    await inferAttributes(INPUT);
    expect(wire).toMatchObject({
      model: expect.any(String),
      reasoning: { effort: "none" },
      text: { format: { type: "json_schema", strict: true } },
    });
    expect(timeout).toBe(12_000);
  });
});

describe("transient text plumbing", () => {
  it("passes one-fetch homepage and menu text into the shipped inference request", async () => {
    vi.stubEnv("ENRICH_NETWORK", "1");
    vi.stubEnv("INFER", "1");
    vi.stubEnv("OPENAI_API_KEY", "test");
    const texts = inferenceTexts(
      {
        id: "place-1",
        osm_ref: "node/1",
        name: "Transient Café",
        category: "cafe",
        attributes: [],
        extras: null,
      },
      undefined,
      {
        homepage: "Dogs are welcome throughout our courtyard.",
        menu: "Vegan mushroom dumplings with herbs.",
      },
    );
    let payload: Record<string, unknown> | undefined;
    setTransport(async (body) => {
      payload = JSON.parse((body.input as Array<{ content: string }>)[0].content) as Record<string, unknown>;
      return {
        output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(answer([])) }] }],
      };
    });
    await inferAttributes({
      name: "Transient Café",
      category: "cafe",
      texts,
      keys: ["dog-friendly", "vegan-options"],
    });
    expect(payload).toMatchObject({
      texts: [
        { source: "web", text: "Dogs are welcome throughout our courtyard." },
        { source: "menu", text: "Vegan mushroom dumplings with herbs." },
      ],
    });
  });
});
