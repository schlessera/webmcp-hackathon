#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import type { SpatialContextResult } from "@webmcp-hackathon/contracts";

const provider = (process.env.PROBE_PROVIDER || "openrouter") as "openrouter" | "openai";
const model = process.env.PROBE_MODEL || "z-ai/glm-5.3-flash";
const capOverride = process.env.PROBE_CAP ? Number(process.env.PROBE_CAP) : null;
const reasoningOverride = process.env.PROBE_REASONING || null;
const only = process.env.PROBE_ONLY ? process.env.PROBE_ONLY.split(",") : null;
const repeats = Number(process.env.PROBE_REPEATS || 1);
const out = process.env.PROBE_OUT || ".route-probe.out.json";

process.env.LLM_PROVIDER = provider;
process.env.LLM_MODEL = model;
process.env.LLM_MODEL_ROUTE = model;

const [{ say }, llm] = await Promise.all([
  import("./apps/server/src/nl/say.ts"),
  import("./apps/server/src/nl/llm.ts"),
]);

const wire: Array<Record<string, unknown>> = [];
const url = provider === "openrouter"
  ? "https://openrouter.ai/api/v1/responses"
  : "https://api.openai.com/v1/responses";
const apiKey = provider === "openrouter" ? process.env.OPENROUTER_API_KEY! : process.env.OPENAI_API_KEY!;

llm.setTransport(async (body, timeoutMs) => {
  const sent: Record<string, unknown> = { ...body };
  if (capOverride !== null) sent.max_output_tokens = capOverride;
  if (reasoningOverride === "delete") delete sent.reasoning;
  else if (reasoningOverride) sent.reasoning = JSON.parse(reasoningOverride);
  if (process.env.PROBE_PIN) {
    sent.provider = { ...(sent.provider as Record<string, unknown> ?? {}), only: process.env.PROBE_PIN.split(",") };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        ...(provider === "openrouter"
          ? { "HTTP-Referer": "https://github.com/schlessera/webmcp-hackathon", "X-OpenRouter-Title": "Spokes" }
          : {}),
      },
      body: JSON.stringify(sent),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      wire.push({ httpStatus: response.status, detail: text.slice(0, 500), ms: Date.now() - started });
      const err = new Error(`${provider} ${response.status}: ${text.slice(0, 300)}`) as Error & { status: number };
      err.status = response.status;
      throw err;
    }
    const raw = JSON.parse(text) as Record<string, unknown>;
    const outputs = (raw.output as Array<Record<string, unknown>> | undefined) ?? [];
    wire.push({
      httpStatus: 200,
      ms: Date.now() - started,
      requestCap: sent.max_output_tokens,
      requestReasoning: sent.reasoning ?? null,
      status: raw.status,
      incomplete: raw.incomplete_details ?? null,
      responseId: raw.id ?? null,
      responseModel: raw.model ?? null,
      usage: raw.usage ?? null,
      itemTypes: outputs.map((item) => item.type),
      messageText: outputs
        .filter((item) => item.type === "message")
        .flatMap((item) => ((item.content as Array<Record<string, unknown>>) ?? []))
        .filter((part) => part.type === "output_text")
        .map((part) => String(part.text)).join("\n").slice(0, 1200),
    });
    return raw;
  } finally {
    clearTimeout(timer);
  }
});

interface CorpusRow {
  id: string; text: string; context: string;
  preparse: "whole" | "partial" | "none";
  expect: { intent: string; needs: unknown[]; clarify: boolean | null };
}

const subset = (actual: unknown, expected: unknown): boolean => {
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length &&
      expected.every((item, index) => subset((actual as unknown[])[index], item));
  }
  if (expected && typeof expected === "object") {
    if (!actual || typeof actual !== "object") return false;
    return Object.entries(expected).every(([key, value]) =>
      subset((actual as Record<string, unknown>)[key], value));
  }
  return Object.is(actual, expected);
};

function routingContext(row: CorpusRow): SpatialContextResult {
  const agreement = row.context === "agreement";
  return {
    ok: true, revision: 1, phase: "gathering",
    scope: { scopeId: "s1", area: { kind: "circle", center: { lat: 52.52, lng: 13.4 }, radiusM: 1_500 },
      transport: row.context === "bikeAllowed" ? ["walk", "bike", "car", "transit"] : ["walk"], category: "places" },
    area: { areaId: row.context === "usd" ? "sf-soma" : "berlin-mitte",
      label: row.context === "usd" ? "San Francisco SoMa" : "Berlin Mitte",
      kind: "osm-snapshot", source: "fixture", dataAsOf: "2026-09-01T00:00:00Z", poolSize: 1, focusVenues: 1 },
    feasibility: { state: "feasible", eligible: 1, likely: 0, uncertain: 0, unlikely: 0, excluded: 0 },
    total: 1, matching: 1, likely: 0,
    candidates: [{ candidateId: "c_einstein", name: "Café Einstein", category: "place",
      location: { lat: 52.52, lng: 13.4 }, eligibility: "eligible", walkMin: 10, priceLevel: 2 }],
    facets: row.context === "noCuisineFacet" ? [] : [{ key: "cuisine", label: "cuisine", type: "enum",
      counts: { unknown: 0 }, values: [
        { value: "italian", label: "Italian", count: 1 },
        { value: "spanish", label: "Spanish", count: 1 },
        { value: "vietnamese", label: "Vietnamese", count: 1 }] }],
    activeNeeds: [], privateEffects: [],
    participants: [{ participantId: "p_sarah", displayName: "Sarah", role: "member",
      readyState: "contributing", arrived: true, present: true }],
    proposals: agreement ? [{ proposalId: "pr1", candidateId: "c_einstein", status: "committed",
      stances: [], vetoStands: false, staging: { ready: true, notReady: [], unaccepted: 0, vetoStands: false } }] : [],
    ...(agreement ? { agreement: { proposalId: "pr1", candidateId: "c_einstein", status: "committed" } } : {}),
  } as unknown as SpatialContextResult;
}

const rows = readFileSync("tests/fixtures/nl-corpus.jsonl", "utf8").trim().split("\n")
  .map((line) => JSON.parse(line) as CorpusRow)
  .filter((row) => row.preparse === "none")
  .filter((row) => !only || only.includes(row.id));

llm.resetResponseMetrics();
const results: Array<Record<string, unknown>> = [];
let correct = 0, unclear = 0, failures = 0;
for (let pass = 0; pass < repeats; pass += 1) {
  for (const row of rows) {
    const before = wire.length;
    try {
      const result = await say(row.text, "shared", routingContext(row), new Date("2026-09-03T10:00:00Z"));
      const passed = result.intent === row.expect.intent &&
        subset(result.needs.map((need) => need.payload), row.expect.needs) &&
        Boolean(result.clarify) === Boolean(row.expect.clarify);
      if (passed) correct += 1;
      if (result.intent === "unclear") unclear += 1;
      results.push({ id: row.id, run: pass, text: row.text, ok: passed,
        expectIntent: row.expect.intent, gotIntent: result.intent,
        needs: result.needs.map((need) => need.payload), ms: result.meta.ms,
        wire: wire.slice(before) });
    } catch (error) {
      failures += 1;
      results.push({ id: row.id, run: pass, text: row.text, ok: false, error: String(error).slice(0, 300), wire: wire.slice(before) });
    }
  }
}
const usage = llm.responseMetrics();
const total = rows.length * repeats;
const summary = { provider, model, capOverride, reasoningOverride, rows: total, correct,
  accuracy: correct / total, unclear, failures, usage };
writeFileSync(out, JSON.stringify({ summary, results }, null, 2));
console.log(JSON.stringify(summary));
