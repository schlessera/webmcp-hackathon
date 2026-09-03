#!/usr/bin/env node

/**
 * Live refinement benchmark. The default mode runs the historical three tick
 * variants. With PIPELINE=1 it starts the real server on PORT, creates a fresh
 * Berlin room through HTTP, and samples scheduler occupancy every 100 ms.
 *
 * Usage:
 *   DATABASE_URL=postgres://... OPENAI_API_KEY=... node scripts/refine-bench.mts
 *   PIPELINE=1 PORT=43123 HOST=127.0.0.1 DATABASE_URL=postgres://... \
 *     OPENAI_API_KEY=... node scripts/refine-bench.mts
 */

if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required");

// Room creation normally starts background warming and pool filling. Keep
// both off while the one benchmark room is created; the measured tick turns
// enrichment back on explicitly below.
process.env.ENRICH_NETWORK = "0";
process.env.POOL_FILL = "0";
process.env.REFINE = "1";
process.env.INFER = "1";
process.env.SERVE_STATIC = "1";

const pipelineMode = process.env.PIPELINE === "1";

const [{ createRoom }, db, eligibility, refinement, enrichment, openai, configModule, pipeline] =
  await Promise.all([
    import("../apps/server/src/rooms.ts"),
    import("../apps/server/src/db.ts"),
    import("../apps/server/src/eligibility.ts"),
    import("../apps/server/src/refine/worker.ts"),
    import("../apps/server/src/enrich/index.ts"),
    import("../apps/server/src/nl/openai.ts"),
    import("../apps/server/src/config.ts"),
    import("../apps/server/src/pipeline/scheduler.ts"),
  ]);

const { pool } = db;
let serverApp: { close(): Promise<void> } | undefined;
const created = pipelineMode
  ? await (async () => {
      const server = await import("../apps/server/src/server.ts");
      serverApp = server.app;
      const response = await fetch(`http://${configModule.config.host}:${configModule.config.port}/api/rooms`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          areaId: "berlin-mitte",
          organizerName: "Pipeline benchmark",
          memberNames: [],
        }),
      });
      if (!response.ok) throw new Error(`room creation returned HTTP ${response.status}`);
      const body = await response.json() as Record<string, unknown>;
      return { ok: true as const, ...body } as Awaited<ReturnType<typeof createRoom>>;
    })()
  : await createRoom({
      areaId: "berlin-mitte",
      organizerName: "Refinement benchmark",
      memberNames: [],
    });
if (!created.ok) throw new Error(created.error);

const roomId = created.roomId;
const ownerId = created.invites[0].participantId;
const variants = [
  // The query shaper is gone: the privacy ruling forbids every word it added,
  // so a "shaped" row would have run the same query as "plain" under a
  // different label. What still differs is the domain rule and the search mode.
  { name: "baseline", searchMode: "split", domainRule: "domain-first" },
  { name: "A", searchMode: "split", domainRule: "open-web-first" },
  { name: "C", searchMode: "combined", domainRule: "open-web-first" },
] as const;

interface Row {
  variant: string;
  modelCalls: number;
  searches: number;
  claims: number;
  sourced: number;
  wallSeconds: number;
  cost: number;
  inputTokens: number;
  outputTokens: number;
}

type PoolName = keyof ReturnType<typeof pipeline.pipelineScheduler.accounting>["inFlight"];

function modelRates() {
  const model = configModule.config.nlFastModel;
  return model === "gpt-5.6-terra"
    ? { input: 2, output: 12 }
    : model === "gpt-5.6-sol"
      ? { input: 4, output: 20 }
      : { input: 0.2, output: 1.2 };
}

function estimatedCost(metrics: ReturnType<typeof openai.responseMetrics>): number {
  const rates = modelRates();
  return metrics.webSearchRequests * 0.01 +
    (metrics.inputTokens * rates.input + metrics.outputTokens * rates.output) / 1_000_000;
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

const rows: Row[] = [];
let frozenIds: string[] = [];
let frozenRefs: string[] = [];

try {
  await pool.query(
    `INSERT INTO requirements
       (id, room_id, owner_id, visibility, hardness, delegation, payload, active)
     VALUES ($1, $2, $3, 'shared', 'hard', '{}', $4, true)`,
    [
      `need_refine_bench_${roomId}`,
      roomId,
      ownerId,
      JSON.stringify({
        kind: "attribute",
        key: "dog-friendly",
        expect: "verified_true",
      }),
    ],
  );

  process.env.ENRICH_NETWORK = "1";
  enrichment.setEnrichFetch(null);
  const inputs = await eligibility.loadEligibilityInputs(pool, roomId);
  const frozen = refinement.buildRefinementQueue(
    inputs,
    { evaluated: new Map(), providerChecked: new Set() },
    roomId,
  ).slice(0, 12);
  if (frozen.length !== 12) {
    throw new Error(`expected 12 eligible places, found ${frozen.length}`);
  }
  frozenIds = frozen.map((item) => item.candidate.id);
  frozenRefs = frozen.map((item) => item.candidate.osm_ref!).filter(Boolean);
  console.error(`room=${roomId} frozen=${frozenIds.join(",")}`);

  if (pipelineMode) {
    await pool.query(
      "DELETE FROM candidates WHERE room_id = $1 AND NOT (id = ANY($2))",
      [roomId, frozenIds],
    );
    refinement.resetRefinement();
    openai.resetResponseMetrics();
    await pool.query("DELETE FROM enrichments WHERE osm_ref = ANY($1)", [frozenRefs]);
    const stageCounts: Record<string, number> = {};
    const unsubscribe = pipeline.pipelineScheduler.onEnqueue((item) => {
      stageCounts[item.kind] = (stageCounts[item.kind] ?? 0) + 1;
    });
    const samples = Object.fromEntries(
      Object.keys(pipeline.pipelineScheduler.pools).map((name) => [name, [] as number[]]),
    ) as Record<PoolName, number[]>;
    const sample = () => {
      const occupancy = pipeline.pipelineScheduler.accounting().inFlight;
      for (const name of Object.keys(samples) as PoolName[]) samples[name].push(occupancy[name]);
    };
    sample();
    const sampler = setInterval(sample, 100);
    const started = performance.now();
    refinement.startRefinement(roomId);
    const deadline = Date.now() + 5 * 60_000;
    for (;;) {
      const accounting = pipeline.pipelineScheduler.accounting().inFlight;
      const inFlight = Object.values(accounting).reduce((sum, value) => sum + value, 0);
      const view = refinement.refinementView(roomId);
      if (
        (stageCounts["process.judge"] ?? 0) > 0 &&
        view.queued === 0 &&
        pipeline.pipelineScheduler.queue.size === 0 &&
        inFlight === 0
      ) break;
      if (Date.now() >= deadline) throw new Error("pipeline benchmark did not drain within five minutes");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const wallSeconds = (performance.now() - started) / 1_000;
    clearInterval(sampler);
    sample();
    unsubscribe();
    refinement.stopRefinement(roomId);
    const metrics = openai.responseMetrics();
    const judgeCells = stageCounts["process.judge"] ?? 0;
    const occupancy = Object.fromEntries((Object.keys(samples) as PoolName[]).map((name) => {
      const values = samples[name];
      return [name, {
        mean: Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(3)),
        p95: percentile(values, 0.95),
        samples: values.length,
      }];
    }));
    console.log(JSON.stringify({
      mode: "pipeline-live",
      roomId,
      server: `http://${configModule.config.host}:${configModule.config.port}`,
      sampleIntervalMs: 100,
      wallSeconds: Number(wallSeconds.toFixed(3)),
      stageCounts,
      occupancy,
      cellsJudged: judgeCells,
      cellsJudgedPerMinute: Number((judgeCells / wallSeconds * 60).toFixed(2)),
      modelCalls: metrics.calls,
      schemaCalls: metrics.schemaCalls,
      searches: metrics.webSearchRequests,
      inputTokens: metrics.inputTokens,
      outputTokens: metrics.outputTokens,
      costUsd: Number(estimatedCost(metrics).toFixed(6)),
      model: configModule.config.nlFastModel,
    }, null, 2));
  }

  for (const variant of pipelineMode ? [] : variants) {
    refinement.resetRefinement();
    openai.resetResponseMetrics();
    await pool.query("DELETE FROM enrichments WHERE osm_ref = ANY($1)", [frozenRefs]);
    const started = performance.now();
    await refinement.runRefinementTick(roomId, Date.now(), {
      frozenCandidateIds: frozenIds,
      searchMode: variant.searchMode,
      domainRule: variant.domainRule,
    });
    const wallSeconds = (performance.now() - started) / 1_000;
    const metrics = openai.responseMetrics();
    const stored = (await pool.query(
      "SELECT inferred FROM enrichments WHERE osm_ref = ANY($1)",
      [frozenRefs],
    )).rows as Array<{ inferred: Record<string, Record<string, unknown>> }>;
    const claims = stored.flatMap((row) => Object.values(row.inferred ?? {}))
      .filter((claim) => claim.lean === "yes" || claim.lean === "no");
    const sourced = claims.filter((claim) => typeof claim.sourceUrl === "string").length;
    const cost = estimatedCost(metrics);
    rows.push({
      variant: variant.name,
      // Keep the round-1 metric definition: matrix calls are reported apart
      // from per-place web searches, including combined search rows.
      modelCalls: metrics.schemaCalls.venue_criterion_matrix ?? 0,
      searches: metrics.webSearchRequests,
      claims: claims.length,
      sourced,
      wallSeconds,
      cost,
      inputTokens: metrics.inputTokens,
      outputTokens: metrics.outputTokens,
    });
  }

  if (!pipelineMode) {
    console.log("variant\tmodel calls\tsearches\tvalidated claims\tclaims with sourceUrl\twall-clock\testimated cost");
    for (const row of rows) {
      console.log([
        row.variant,
        row.modelCalls,
        row.searches,
        row.claims,
        row.sourced,
        `${row.wallSeconds.toFixed(1)}s`,
        `$${row.cost.toFixed(4)}`,
      ].join("\t"));
    }
    console.error(JSON.stringify({ model: configModule.config.nlFastModel, rows }));
  }
} finally {
  refinement.resetRefinement();
  if (frozenRefs.length) {
    await pool.query("DELETE FROM enrichments WHERE osm_ref = ANY($1)", [frozenRefs]);
  }
  for (const table of [
    "stances",
    "proposals",
    "verdicts",
    "requirements",
    "adjustments",
    "arrival_plans",
    "attestations",
    "events",
    "candidates",
    "invite_secrets",
  ]) {
    await pool.query(`DELETE FROM ${table} WHERE room_id = $1`, [roomId]);
  }
  await pool.query("DELETE FROM participants WHERE room_id = $1", [roomId]);
  await pool.query("DELETE FROM rooms WHERE id = $1", [roomId]);
  await serverApp?.close();
  await pool.end();
}
