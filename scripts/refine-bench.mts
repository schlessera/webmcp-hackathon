#!/usr/bin/env node

/**
 * Live refinement benchmark. It starts the real server on PORT, creates a
 * fresh Berlin room through HTTP, and samples scheduler occupancy every 100 ms.
 *
 * Usage:
 *   PORT=43123 HOST=127.0.0.1 DATABASE_URL=postgres://... \
 *     OPENAI_API_KEY=... node scripts/refine-bench.mts
 */

if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required");

// Room creation normally starts background warming and pool filling. Keep
// both off while the one benchmark room is created; the measured run turns
// enrichment back on explicitly below.
process.env.ENRICH_NETWORK = "0";
process.env.POOL_FILL = "0";
process.env.REFINE = "1";
process.env.INFER = "1";
process.env.SERVE_STATIC = "1";

const [{ createRoom }, db, eligibility, refinement, enrichment, openai, configModule, pipeline, spatial, progress] =
  await Promise.all([
    import("../apps/server/src/rooms.ts"),
    import("../apps/server/src/db.ts"),
    import("../apps/server/src/eligibility.ts"),
    import("../apps/server/src/refine/worker.ts"),
    import("../apps/server/src/enrich/index.ts"),
    import("../apps/server/src/nl/openai.ts"),
    import("../apps/server/src/config.ts"),
    import("../apps/server/src/pipeline/scheduler.ts"),
    import("../apps/server/src/spatial.ts"),
    import("../apps/server/src/enrich/progress.ts"),
  ]);

const { pool } = db;
let serverApp: { close(): Promise<void> } | undefined;
const created = await (async () => {
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
})();
if (!created.ok) throw new Error(created.error);

const roomId = created.roomId;
const ownerId = created.invites[0].participantId;
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

  await pool.query(
    "DELETE FROM candidates WHERE room_id = $1 AND NOT (id = ANY($2))",
    [roomId, frozenIds],
  );
  refinement.resetRefinement();
  openai.resetResponseMetrics();
  await pool.query("DELETE FROM enrichments WHERE osm_ref = ANY($1)", [frozenRefs]);
  const stageCounts: Record<string, number> = {};
  const activeJudgeCandidates = new Set<string>();
  const unsubscribe = pipeline.pipelineScheduler.onEnqueue((item) => {
    stageCounts[item.kind] = (stageCounts[item.kind] ?? 0) + 1;
    if (
      item.kind === "process.judge" && item.priority !== 0 &&
      item.criteria.some((criterion) => criterion.kind === "key" && criterion.key === "dog-friendly")
    ) {
      activeJudgeCandidates.add(item.candidateId);
      if (activeJudgeCandidates.size === frozenIds.length) refinement.stopRefinement(roomId);
    }
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
  const saturationDeadline = Date.now() + 30_000;
  const directBackgroundCap = pipeline.pipelineScheduler.pools.direct.limit -
    pipeline.pipelineScheduler.pools.direct.reserved;
  while (
    pipeline.pipelineScheduler.queue.size === 0 ||
    pipeline.pipelineScheduler.pools.direct.inFlight < directBackgroundCap
  ) {
    if (Date.now() >= saturationDeadline) throw new Error("background sweep did not start");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const backgroundQueueAtOpen = pipeline.pipelineScheduler.queue.size;
  const backgroundInFlightAtOpen = pipeline.pipelineScheduler.accounting().inFlight;
  const openedAt = performance.now();
  let cachedFrameMs: number | undefined;
  let siteFrameMs: number | undefined;
  const unsubscribeFacts = progress.onFacts((candidateRoomId, message) => {
    if (candidateRoomId !== roomId || message.reason !== "interactive") return;
    if (!message.candidateIds.includes(frozenIds[0])) return;
    if (message.stage === "cache" && cachedFrameMs === undefined) {
      cachedFrameMs = performance.now() - openedAt;
    }
    if (message.stage === "site" && siteFrameMs === undefined) {
      siteFrameMs = performance.now() - openedAt;
    }
  });
  const panel = await spatial.inspectCandidates({
    id: ownerId,
    roomId,
    displayName: "Pipeline benchmark",
    role: "organizer",
    readyState: "contributing",
  }, [frozenIds[0]], { intent: "open" });
  const usablePanelMs = performance.now() - openedAt;
  if (!panel.ok || panel.candidates.length !== 1) throw new Error("interactive panel did not open");
  // Live provider tails vary substantially. Eight minutes keeps this a full
  // drain measurement instead of truncating slow but progressing work.
  const deadline = Date.now() + 8 * 60_000;
  for (;;) {
    const accounting = pipeline.pipelineScheduler.accounting().inFlight;
    const inFlight = Object.values(accounting).reduce((sum, value) => sum + value, 0);
    const view = refinement.refinementView(roomId);
    if (
      (stageCounts["process.judge"] ?? 0) > 0 &&
      activeJudgeCandidates.size === frozenIds.length &&
      view.queued === 0 &&
      pipeline.pipelineScheduler.queue.size === 0 &&
      inFlight === 0
    ) break;
    if (Date.now() >= deadline) {
      throw new Error(`pipeline benchmark did not drain: ${JSON.stringify({
        view,
        queue: pipeline.pipelineScheduler.queue.size,
        inFlight: accounting,
      })}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const wallSeconds = (performance.now() - started) / 1_000;
  clearInterval(sampler);
  sample();
  unsubscribe();
  unsubscribeFacts();
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
    activeCandidatesJudged: activeJudgeCandidates.size,
    cellsJudgedPerMinute: Number((judgeCells / wallSeconds * 60).toFixed(2)),
    modelCalls: metrics.calls,
    schemaCalls: metrics.schemaCalls,
    searches: metrics.webSearchRequests,
    inputTokens: metrics.inputTokens,
    outputTokens: metrics.outputTokens,
    costUsd: Number(estimatedCost(metrics).toFixed(6)),
    model: configModule.config.nlFastModel,
    fastTrack: {
      backgroundQueueAtOpen,
      backgroundInFlightAtOpen,
      usablePanelMs: Number(usablePanelMs.toFixed(3)),
      cachedFrameMs: cachedFrameMs === undefined ? null : Number(cachedFrameMs.toFixed(3)),
      siteFrameMs: siteFrameMs === undefined ? null : Number(siteFrameMs.toFixed(3)),
    },
  }, null, 2));
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
