#!/usr/bin/env node

/**
 * Live four-way refinement benchmark. It creates one real Berlin Mitte room,
 * freezes the first twelve eligible places, clears only those refs between
 * variants, and prints comparable one-tick yield/cost rows.
 *
 * Usage:
 *   DATABASE_URL=postgres://... OPENAI_API_KEY=... node scripts/refine-bench.mts
 */

if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required");

// Room creation normally starts background warming and pool filling. Keep
// both off while the one benchmark room is created; the measured tick turns
// enrichment back on explicitly below.
process.env.ENRICH_NETWORK = "0";
process.env.POOL_FILL = "0";
process.env.REFINE = "1";
process.env.INFER = "1";

const [{ createRoom }, db, eligibility, refinement, enrichment, openai, configModule] =
  await Promise.all([
    import("../apps/server/src/rooms.ts"),
    import("../apps/server/src/db.ts"),
    import("../apps/server/src/eligibility.ts"),
    import("../apps/server/src/refine/worker.ts"),
    import("../apps/server/src/enrich/index.ts"),
    import("../apps/server/src/nl/openai.ts"),
    import("../apps/server/src/config.ts"),
  ]);

const { pool } = db;
const created = await createRoom({
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

  for (const variant of variants) {
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
    const model = configModule.config.nlFastModel;
    const rates = model === "gpt-5.6-terra"
      ? { input: 2, output: 12 }
      : model === "gpt-5.6-sol"
        ? { input: 4, output: 20 }
        : { input: 0.2, output: 1.2 };
    const cost = metrics.webSearchRequests * 0.01 +
      (metrics.inputTokens * rates.input + metrics.outputTokens * rates.output) / 1_000_000;
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
  await pool.end();
}
