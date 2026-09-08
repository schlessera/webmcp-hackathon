#!/usr/bin/env node
/** Live, read-only evaluation: no database, tools, or room writes. */
import { readFileSync, writeFileSync } from "node:fs";
import type { SpatialContextResult } from "@webmcp-hackathon/contracts";
import { say } from "../apps/server/src/nl/say.ts";
import { config } from "../apps/server/src/config.ts";
import { NlError, resetResponseMetrics, responseMetrics, setTransport } from "../apps/server/src/nl/llm.ts";

if (!config.nlEnabled) throw new Error("Configure the selected provider's API key before running the live evaluation.");
const repeats = Number(process.env.BENCH_REPEATS ?? 3);
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10) throw new Error("BENCH_REPEATS must be 1–10");
const rows = readFileSync("tests/fixtures/nl-composition.jsonl", "utf8").trim().split("\n").map((line) => JSON.parse(line));
// Exercise the production request shaping, parsing and retry policy against
// the real provider, using a bounded standalone transport. The normal server
// transport records admission/usage in PostgreSQL; an evaluation needs no DB.
let requests = 0;
setTransport(async (body, timeoutMs) => {
  if (++requests > rows.length * repeats * 3) throw new Error("Evaluation request cap exceeded");
  const router = config.llmProvider === "openrouter";
  const response = await fetch(router ? "https://openrouter.ai/api/v1/responses" : "https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { authorization: `Bearer ${router ? config.openrouterApiKey : config.openaiApiKey}`, "content-type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
  });
  if (!response.ok) throw new NlError(`Evaluation provider returned HTTP ${response.status}`, response.status);
  return response.json();
});
const context = {
  ok: true, revision: 1, phase: "gathering",
  scope: { transport: ["walk"] }, area: { areaId: "berlin-mitte" },
  facets: [{ key: "cuisine", type: "enum", values: ["italian", "spanish", "vietnamese"].map((value) => ({ value, label: value, count: 1 })) }],
  candidates: [], participants: [], proposals: [], activeNeeds: [],
} as unknown as SpatialContextResult;

// Exact array cardinality, order-independent matching, and partial object
// assertions: labels/gists may vary, but clauses and hardness must not.
function matches(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false;
    const remaining = [...actual];
    return expected.every((item) => {
      const at = remaining.findIndex((candidate) => matches(candidate, item));
      if (at < 0) return false;
      remaining.splice(at, 1);
      return true;
    });
  }
  if (expected && typeof expected === "object") {
    return Boolean(actual && typeof actual === "object" && Object.entries(expected).every(([key, value]) =>
      matches((actual as Record<string, unknown>)[key], value)));
  }
  return Object.is(actual, expected);
}

const results: Array<Record<string, unknown>> = [];
resetResponseMetrics();
for (let run = 1; run <= repeats; run++) {
  for (const row of rows) {
    const started = Date.now();
    try {
      const out = await say(row.text, "shared", context, new Date("2026-09-08T10:00:00Z"));
      const actual = { intent: out.intent, needs: out.needs.map(({ payload, hardness }) => ({ payload, hardness })), clarify: Boolean(out.clarify) };
      const pass = matches(actual, row.expect);
      results.push({ run, id: row.id, pass, ms: Date.now() - started, actual });
      console.log(`${run}/${repeats} ${row.id}: ${pass ? "PASS" : "FAIL"}`);
    } catch (error) {
      results.push({ run, id: row.id, pass: false, ms: Date.now() - started, error: error instanceof Error ? error.message : String(error) });
      console.log(`${run}/${repeats} ${row.id}: ERROR (${error instanceof Error ? error.message : "unknown"})`);
    }
  }
}
const report = {
  date: new Date().toISOString(), model: config.llmRouteModel, provider: config.llmProvider,
  effort: config.llmReasoningEffort, repeats, cases: rows.length,
  requests,
  correct: results.filter((row) => row.pass).length, total: results.length,
  failures: results.filter((row) => row.error).length, usage: responseMetrics(), results,
};
const output = process.env.BENCH_OUTPUT ?? "/tmp/nl-composition-bench.json";
writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ output, correct: report.correct, total: report.total, failures: report.failures, usage: report.usage }));
