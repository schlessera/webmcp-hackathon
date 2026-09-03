#!/usr/bin/env node

/**
 * Live, labeled refinement judge benchmark plus a 40-call concurrency probe.
 * Every request uses the production LLM adapter and OpenRouter transport.
 *
 * Usage:
 *   OPENROUTER_API_KEY=... node scripts/refine-bench.mts
 */

import type { Criterion } from "@webmcp-hackathon/contracts";
import type { EvaluateMatrixInput } from "../apps/server/src/enrich/evaluate.ts";

if (!process.env.OPENROUTER_API_KEY) {
  throw new Error("OPENROUTER_API_KEY is required");
}
process.env.LLM_PROVIDER = "openrouter";

const [{ parseJson, respond }, matrix] = await Promise.all([
  import("../apps/server/src/nl/llm.ts"),
  import("../apps/server/src/enrich/evaluate.ts"),
]);

type Expected = "yes" | "no" | "abstain";

interface Fixture {
  place: EvaluateMatrixInput["places"][number];
  criterion: Criterion;
  expected: Expected;
}

const criterion = (key: string, label: string): Criterion => ({
  id: key,
  kind: "key",
  key,
  label,
});

/** Fixed direct-evidence cases: four affirmative, four negative, four unknown. */
const fixtures: Fixture[] = [
  {
    place: {
      candidateId: "courtyard-cafe",
      osmRef: "bench/1",
      name: "Courtyard Cafe",
      category: "cafe",
      website: "https://courtyard.example",
      texts: [{ source: "web", url: "https://courtyard.example/visit", text: "Guests may bring dogs into the sheltered courtyard throughout opening hours." }],
    },
    criterion: criterion("dog-friendly", "dogs welcome"),
    expected: "yes",
  },
  {
    place: {
      candidateId: "quiet-bistro",
      osmRef: "bench/2",
      name: "Quiet Bistro",
      category: "restaurant",
      website: "https://quiet.example",
      texts: [{ source: "web", url: "https://quiet.example/rules", text: "Animals are not permitted anywhere inside the restaurant or on its terrace." }],
    },
    criterion: criterion("dog-friendly", "dogs welcome"),
    expected: "no",
  },
  {
    place: {
      candidateId: "step-free-gallery",
      osmRef: "bench/3",
      name: "Step Free Gallery",
      category: "gallery",
      website: "https://stepfree.example",
      texts: [{ source: "web", url: "https://stepfree.example/access", text: "A level entrance and lift provide wheelchair access to every public floor." }],
    },
    criterion: criterion("wheelchair-accessible", "wheelchair accessible"),
    expected: "yes",
  },
  {
    place: {
      candidateId: "stairs-cellar",
      osmRef: "bench/4",
      name: "Stairs Cellar",
      category: "bar",
      website: "https://cellar.example",
      texts: [{ source: "web", url: "https://cellar.example/access", text: "The cellar is reached only by a narrow staircase and has no accessible entrance." }],
    },
    criterion: criterion("wheelchair-accessible", "wheelchair accessible"),
    expected: "no",
  },
  {
    place: {
      candidateId: "garden-table",
      osmRef: "bench/5",
      name: "Garden Table",
      category: "restaurant",
      website: "https://garden.example",
      texts: [{ source: "web", url: "https://garden.example/dine", text: "Our rear garden offers forty outdoor seats beneath weatherproof awnings." }],
    },
    criterion: criterion("outdoor-seating", "outdoor seating"),
    expected: "yes",
  },
  {
    place: {
      candidateId: "indoor-counter",
      osmRef: "bench/6",
      name: "Indoor Counter",
      category: "cafe",
      website: "https://counter.example",
      texts: [{ source: "web", url: "https://counter.example/about", text: "All customer seating is indoors; the venue has no terrace or pavement tables." }],
    },
    criterion: criterion("outdoor-seating", "outdoor seating"),
    expected: "no",
  },
  {
    place: {
      candidateId: "green-kitchen",
      osmRef: "bench/7",
      name: "Green Kitchen",
      category: "restaurant",
      website: "https://green.example",
      texts: [{ source: "menu", url: "https://green.example/menu", text: "A separate vegan menu is available with six fully plant-based main dishes." }],
    },
    criterion: criterion("vegan-options", "vegan options"),
    expected: "yes",
  },
  {
    place: {
      candidateId: "butter-house",
      osmRef: "bench/8",
      name: "Butter House",
      category: "restaurant",
      website: "https://butter.example",
      texts: [{ source: "menu", url: "https://butter.example/menu", text: "Every dish contains dairy or egg, and no vegan substitutions are available." }],
    },
    criterion: criterion("vegan-options", "vegan options"),
    expected: "no",
  },
  {
    place: {
      candidateId: "history-cafe",
      osmRef: "bench/9",
      name: "History Cafe",
      category: "cafe",
      texts: [{ source: "web", url: "https://history.example/story", text: "The cafe opened in a restored railway office and serves locally roasted coffee." }],
    },
    criterion: criterion("wifi", "free Wi-Fi"),
    expected: "abstain",
  },
  {
    place: {
      candidateId: "chef-table",
      osmRef: "bench/10",
      name: "Chef Table",
      category: "restaurant",
      texts: [{ source: "web", url: "https://chef.example/about", text: "The chef changes the seasonal tasting menu every six weeks." }],
    },
    criterion: criterion("delivery", "delivery available"),
    expected: "abstain",
  },
  {
    place: {
      candidateId: "museum-lounge",
      osmRef: "bench/11",
      name: "Museum Lounge",
      category: "cafe",
      texts: [{ source: "web", url: "https://museum.example/lounge", text: "Visitors can view rotating photography exhibitions while enjoying lunch." }],
    },
    criterion: criterion("takeaway", "takeaway available"),
    expected: "abstain",
  },
  {
    place: {
      candidateId: "river-room",
      osmRef: "bench/12",
      name: "River Room",
      category: "restaurant",
      texts: [{ source: "web", url: "https://river.example/story", text: "Large windows look across the river and the kitchen focuses on regional produce." }],
    },
    criterion: criterion("dog-friendly", "dogs welcome"),
    expected: "abstain",
  },
];

const percentile = (values: number[], fraction: number): number => {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)] ?? 0;
};

interface BenchmarkRow {
  label: string;
  model: string;
  accuracy: number;
  unclear: number;
  p50Ms: number;
  p90Ms: number;
  costUsd: number;
  completed: number;
}

async function judgeOne(model: string, fixture: Fixture): Promise<{
  actual: Expected | "invalid";
  ms: number;
  costUsd: number;
}> {
  const input: EvaluateMatrixInput = {
    places: [fixture.place],
    criteria: [fixture.criterion],
  };
  const reply = await respond({
    model,
    instructions: matrix.EVALUATE_MATRIX_PROMPT,
    input: [{ role: "user", content: JSON.stringify(input) }],
    schema: { name: "venue_criterion_matrix", schema: matrix.EVALUATE_MATRIX_SCHEMA },
    reasoning: "none",
    maxOutputTokens: 1_500,
    timeoutMs: 90_000,
  });
  const answer = parseJson<{ claims?: unknown }>(reply.text);
  const batch = matrix.matrixBatchFromAnswer(answer, input, model);
  const claim = batch.claims.find((candidate) =>
    candidate.candidateId === fixture.place.candidateId &&
    candidate.criterionId === fixture.criterion.id
  );
  const answered = batch.answered.some((candidate) =>
    candidate.candidateId === fixture.place.candidateId &&
    candidate.criterionId === fixture.criterion.id
  );
  return {
    actual: claim?.lean ?? (answered ? "abstain" : "invalid"),
    ms: reply.ms,
    costUsd: reply.usage.costUsd ?? 0,
  };
}

async function benchmark(label: string, model: string): Promise<BenchmarkRow> {
  const settled = await Promise.allSettled(fixtures.map((fixture) => judgeOne(model, fixture)));
  let correct = 0;
  let unclear = 0;
  const latencies: number[] = [];
  let costUsd = 0;
  settled.forEach((result, index) => {
    if (result.status === "rejected") return;
    latencies.push(result.value.ms);
    costUsd += result.value.costUsd;
    if (result.value.actual === fixtures[index].expected) correct += 1;
    if (result.value.actual === "abstain" || result.value.actual === "invalid") unclear += 1;
  });
  return {
    label,
    model,
    accuracy: correct / fixtures.length,
    unclear: unclear / fixtures.length,
    p50Ms: percentile(latencies, 0.5),
    p90Ms: percentile(latencies, 0.9),
    costUsd,
    completed: latencies.length,
  };
}

interface ConcurrencyResult {
  attempted: number;
  completed: number;
  valid: number;
  rateLimited: number;
  otherErrors: number;
  p50Ms: number;
  p90Ms: number;
  maxMs: number;
  costUsd: number;
}

async function concurrencyProbe(model: string): Promise<ConcurrencyResult> {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["ok"],
    properties: { ok: { type: "boolean", const: true } },
  } as const;
  const settled = await Promise.allSettled(Array.from({ length: 40 }, (_, index) => respond({
    model,
    instructions: "Return the required JSON object with ok=true. Output nothing else.",
    input: [{ role: "user", content: `Concurrency probe ${index + 1}` }],
    schema: { name: "concurrency_probe", schema },
    reasoning: "none",
    maxOutputTokens: 550,
    timeoutMs: 90_000,
  })));
  const fulfilled = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  const rejected = settled.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
  const latencies = fulfilled.map((reply) => reply.ms);
  const isRateLimit = (error: unknown) =>
    typeof error === "object" && error !== null && "status" in error && error.status === 429;
  return {
    attempted: settled.length,
    completed: fulfilled.length,
    valid: fulfilled.filter((reply) => parseJson<{ ok?: unknown }>(reply.text)?.ok === true).length,
    rateLimited: rejected.filter(isRateLimit).length,
    otherErrors: rejected.filter((error) => !isRateLimit(error)).length,
    p50Ms: percentile(latencies, 0.5),
    p90Ms: percentile(latencies, 0.9),
    maxMs: Math.max(0, ...latencies),
    costUsd: fulfilled.reduce((total, reply) => total + (reply.usage.costUsd ?? 0), 0),
  };
}

const rows = [
  await benchmark("Luna comparison", "openai/gpt-5.6-luna"),
  await benchmark("GLM production", "z-ai/glm-5.3-flash"),
];
const concurrency = await concurrencyProbe("z-ai/glm-5.3-flash");

console.log("model\tcompleted\taccuracy\tunclear\tp50\tp90\tcost/tick");
for (const row of rows) {
  console.log([
    row.model,
    `${row.completed}/${fixtures.length}`,
    `${(row.accuracy * 100).toFixed(1)}%`,
    `${(row.unclear * 100).toFixed(1)}%`,
    `${(row.p50Ms / 1_000).toFixed(2)}s`,
    `${(row.p90Ms / 1_000).toFixed(2)}s`,
    `$${row.costUsd.toFixed(6)}`,
  ].join("\t"));
}
console.log(`concurrency\t${JSON.stringify(concurrency)}`);
console.error(JSON.stringify({ fixtureCount: fixtures.length, rows, concurrency }));
