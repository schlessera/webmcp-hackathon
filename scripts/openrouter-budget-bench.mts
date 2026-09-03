#!/usr/bin/env node

/**
 * Narrow live regression benchmark for the OpenRouter output-budget change.
 * It reads the compose database but never writes it, and runs only the frozen
 * 12-place matrix and model-only routing corpus used by the 2026-09-03 report.
 */

import { readFileSync } from "node:fs";
import pg from "pg";
import type { Criterion, SpatialContextResult } from "@webmcp-hackathon/contracts";
import type {
  EvaluateMatrixInput,
  EvaluatedMatrixBatch,
} from "../apps/server/src/enrich/evaluate.ts";

if (!process.env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is required");
const model = process.env.LLM_MODEL || "z-ai/glm-5.3-flash";
process.env.LLM_PROVIDER = "openrouter";
process.env.LLM_MODEL = model;
process.env.LLM_MODEL_ROUTE = process.env.LLM_MODEL_ROUTE || model;
process.env.LLM_MODEL_JUDGE = process.env.LLM_MODEL_JUDGE || model;

const [{ say }, llm, matrix] = await Promise.all([
  import("../apps/server/src/nl/say.ts"),
  import("../apps/server/src/nl/llm.ts"),
  import("../apps/server/src/enrich/evaluate.ts"),
]);

const percentile = (values: number[], fraction: number): number => {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)] ?? 0;
};

const subset = (actual: unknown, expected: unknown): boolean => {
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length &&
      expected.every((item, index) => subset(actual[index], item));
  }
  if (expected && typeof expected === "object") {
    if (!actual || typeof actual !== "object") return false;
    return Object.entries(expected).every(([key, value]) =>
      subset((actual as Record<string, unknown>)[key], value)
    );
  }
  return Object.is(actual, expected);
};

interface CorpusRow {
  id: string;
  text: string;
  context: string;
  preparse: "whole" | "partial" | "none";
  expect: { intent: string; needs: unknown[]; clarify: boolean | null };
}

function routingContext(row: CorpusRow): SpatialContextResult {
  const agreement = row.context === "agreement";
  return {
    ok: true,
    revision: 1,
    phase: "gathering",
    scope: {
      scopeId: "s1",
      area: { kind: "circle", center: { lat: 52.52, lng: 13.4 }, radiusM: 1_500 },
      transport: row.context === "bikeAllowed" ? ["walk", "bike", "car", "transit"] : ["walk"],
      category: "places",
    },
    area: {
      areaId: row.context === "usd" ? "sf-soma" : "berlin-mitte",
      label: row.context === "usd" ? "San Francisco SoMa" : "Berlin Mitte",
      kind: "osm-snapshot",
      source: "fixture",
      dataAsOf: "2026-09-01T00:00:00Z",
      poolSize: 1,
      focusVenues: 1,
    },
    feasibility: {
      state: "feasible",
      eligible: 1,
      likely: 0,
      uncertain: 0,
      unlikely: 0,
      excluded: 0,
    },
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
    facets: row.context === "noCuisineFacet" ? [] : [{
      key: "cuisine",
      label: "cuisine",
      type: "enum",
      counts: { unknown: 0 },
      values: [
        { value: "italian", label: "Italian", count: 1 },
        { value: "spanish", label: "Spanish", count: 1 },
        { value: "vietnamese", label: "Vietnamese", count: 1 },
      ],
    }],
    activeNeeds: [],
    privateEffects: [],
    participants: [{
      participantId: "p_sarah",
      displayName: "Sarah",
      role: "member",
      readyState: "contributing",
      arrived: true,
      present: true,
    }],
    proposals: agreement ? [{
      proposalId: "pr1",
      candidateId: "c_einstein",
      status: "committed",
      stances: [],
      vetoStands: false,
      staging: { ready: true, notReady: [], unaccepted: 0, vetoStands: false },
    }] : [],
    ...(agreement
      ? { agreement: { proposalId: "pr1", candidateId: "c_einstein", status: "committed" } }
      : {}),
  } as SpatialContextResult;
}

async function routingBenchmark() {
  const rows = readFileSync("tests/fixtures/nl-corpus.jsonl", "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as CorpusRow)
    .filter((row) => row.preparse === "none");
  llm.resetResponseMetrics();
  let correct = 0;
  let unclear = 0;
  let failures = 0;
  const latencies: number[] = [];
  const misses: string[] = [];
  for (const row of rows) {
    try {
      const out = await say(
        row.text,
        "shared",
        routingContext(row),
        new Date("2026-09-03T10:00:00Z"),
      );
      latencies.push(out.meta.ms);
      if (out.intent === "unclear") unclear += 1;
      const pass = out.intent === row.expect.intent &&
        subset(out.needs.map((need) => need.payload), row.expect.needs) &&
        Boolean(out.clarify) === Boolean(row.expect.clarify);
      if (pass) correct += 1;
      else misses.push(`${row.id}:${out.intent}`);
    } catch (error) {
      failures += 1;
      misses.push(`${row.id}:ERROR:${error instanceof Error ? error.message.slice(0, 100) : "unknown"}`);
    }
  }
  const usage = llm.responseMetrics();
  return {
    rows: rows.length,
    correct,
    accuracy: correct / rows.length,
    unclear,
    failures,
    p50Ms: percentile(latencies, 0.5),
    p90Ms: percentile(latencies, 0.9),
    usage,
    misses,
  };
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ??
    "postgres://webmcp:webmcp@127.0.0.1:5432/webmcp",
  max: 2,
});

async function frozenMatrixInput(): Promise<EvaluateMatrixInput> {
  const criterionRows = (await pool.query(`
    SELECT DISTINCT payload->>'key' AS key
      FROM requirements
     WHERE room_id = 'room_demo'
       AND active AND NOT withdrawn
       AND payload->>'kind' = 'attribute'
     ORDER BY key
  `)).rows as Array<{ key: string }>;
  const criteria: Criterion[] = criterionRows.map(({ key }) => ({
    id: key,
    kind: "key",
    key,
    label: key.replaceAll("-", " "),
  }));
  const placeRows = (await pool.query(`
    SELECT * FROM (
      SELECT DISTINCT ON (COALESCE(c.extras->>'website', e.website->>'url'))
             c.id AS "candidateId", c.osm_ref AS "osmRef", c.name, c.category,
             COALESCE(c.extras->>'website', e.website->>'url') AS website,
             p.url, p.text
        FROM candidates c
        JOIN enrichments e ON e.osm_ref = c.osm_ref
        JOIN page_cache p ON p.url = COALESCE(c.extras->>'website', e.website->>'url')
       WHERE c.room_id = 'room_demo'
         AND p.text IS NOT NULL AND length(p.text) >= 500
       ORDER BY COALESCE(c.extras->>'website', e.website->>'url'), c.id
    ) frozen
    ORDER BY "candidateId"
    LIMIT 12
  `)).rows as Array<{
    candidateId: string;
    osmRef: string;
    name: string;
    category: string;
    website: string;
    url: string;
    text: string;
  }>;
  if (criteria.length !== 2 || placeRows.length !== 12) {
    throw new Error(`compose DB did not supply the frozen 12x2 matrix (places=${placeRows.length}, criteria=${criteria.length})`);
  }
  return {
    criteria,
    places: placeRows.map((row) => ({
      candidateId: row.candidateId,
      osmRef: row.osmRef,
      name: row.name,
      category: row.category,
      website: row.website,
      texts: [{ source: "web", url: row.url, text: row.text }],
    })),
  };
}

async function matrixBenchmark() {
  const input = await frozenMatrixInput();
  const latencies: number[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let validatedClaims = 0;
  let answeredCells = 0;
  let incompleteCalls = 0;
  let failedCalls = 0;
  let transportRetries = 0;
  for (const place of input.places) {
    llm.resetResponseMetrics();
    const batches: EvaluatedMatrixBatch[] = [];
    const started = Date.now();
    try {
      const claims = await matrix.evaluateMatrix(
        { places: [place], criteria: input.criteria },
        async (batch) => { batches.push(batch); },
      );
      validatedClaims += claims.length;
    } catch {
      failedCalls += 1;
    }
    latencies.push(Date.now() - started);
    const usage = llm.responseMetrics();
    inputTokens += usage.inputTokens;
    outputTokens += usage.outputTokens;
    costUsd += usage.costUsd;
    transportRetries += Math.max(0, usage.calls - 1);
    const answered = batches.reduce((total, batch) => total + batch.answered.length, 0);
    answeredCells += answered;
    if (answered !== input.criteria.length) incompleteCalls += 1;
  }
  const cells = input.places.length * input.criteria.length;
  return {
    places: input.places.length,
    criteria: input.criteria.map((item) => item.id),
    calls: input.places.length,
    cells,
    validatedClaims,
    abstains: answeredCells - validatedClaims,
    invalidOrIncompleteCells: cells - answeredCells,
    incompleteCalls,
    failedCalls,
    transportRetries,
    p50Ms: percentile(latencies, 0.5),
    p90Ms: percentile(latencies, 0.9),
    inputTokens,
    outputTokens,
    costUsd,
  };
}

try {
  const matrixResult = await matrixBenchmark();
  const routing = await routingBenchmark();
  console.log(JSON.stringify({ provider: "openrouter", model, matrix: matrixResult, routing }));
} finally {
  await pool.end();
}
