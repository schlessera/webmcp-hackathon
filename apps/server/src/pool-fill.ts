import { POOL_CAP, areaById, type AreaDefinition } from "@webmcp-hackathon/contracts";
import type pg from "pg";
import { insertCandidateSeeds, warmTargetsFor } from "./candidate-write.ts";
import { notifyCommit } from "./commit-notifications.ts";
import { pool as database, withTransaction } from "./db.ts";
import { warmEnrichmentsDone, type RoomLookupTarget } from "./enrich/index.ts";
import { publishFacts } from "./enrich/progress.ts";
import type { ScopeState } from "./eligibility.ts";
import {
  fillPlan,
  loadSnapshot,
  seedsForVenues,
  type AreaSnapshot,
  type LocatedVenue,
} from "./places.ts";

function integerEnv(name: string, fallback: number, minimum: number): number {
  const parsed = Number(process.env[name]);
  return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : fallback;
}

const FILL_ENABLED = process.env.POOL_FILL !== "0";
const FILL_INTERVAL_MS = integerEnv("POOL_FILL_INTERVAL_MS", 400, 0);
const FILL_BATCH = integerEnv("POOL_FILL_BATCH", 50, 1);
const FILL_FAILURE_LIMIT = 5;
const FILL_BACKOFF_CAP_MS = 30_000;
const MAX_WARM_CHAIN_DEPTH = 8;
const BOOT_STAGGER_MS = 25;

export interface CachedPoolPlan {
  scopeId: string;
  total: number;
  venues: LocatedVenue[];
  observedAt: string;
}

interface Job {
  timer?: ReturnType<typeof setTimeout>;
  lockClient?: pg.PoolClient;
  lockReady?: Promise<boolean>;
  rerun: boolean;
  scopeId?: string;
  pending: LocatedVenue[];
  observedAt?: string;
  addedCount: number;
  failures: number;
}

interface BatchResult {
  roomExists: boolean;
  hasMore: boolean;
  scopeChanged?: boolean;
  candidateIds: string[];
  warmTargets: RoomLookupTarget[];
}

interface WarmChain {
  tail: Promise<void>;
  depth: number;
}

const jobs = new Map<string, Job>();
const planCache = new Map<string, CachedPoolPlan>();
const warmChains = new Map<string, WarmChain>();

export function poolTarget(size: number, planTotal: number): number {
  return Math.max(size, Math.min(planTotal, POOL_CAP));
}

export function poolFillActive(roomId: string): boolean {
  return jobs.has(roomId);
}

/** Cache the snapshot scan once per room scope. Existing refs are applied by
 * callers without repeating distance calculation and sorting. */
export function cachedPoolPlan(
  roomId: string,
  scopeId: string,
  area: AreaDefinition,
  snapshot: AreaSnapshot,
  center: { lat: number; lng: number },
  radiusM: number,
): CachedPoolPlan {
  const existing = planCache.get(roomId);
  if (existing?.scopeId === scopeId) return existing;
  const plan = fillPlan(area, snapshot, center, radiusM, [], Number.MAX_SAFE_INTEGER);
  const cached = {
    scopeId,
    total: plan.total,
    venues: plan.batches[0] ?? [],
    observedAt: snapshot.manifest.extract.timestamp,
  };
  planCache.set(roomId, cached);
  return cached;
}

async function acquireJobLock(roomId: string, job: Job): Promise<boolean> {
  if (job.lockClient) return true;
  if (job.lockReady) return job.lockReady;
  job.lockReady = (async () => {
    const client = await database.connect();
    const locked = Boolean((await client.query(
      "SELECT pg_try_advisory_lock(hashtext('pool-fill'), hashtext($1)) AS locked",
      [roomId],
    )).rows[0]?.locked);
    if (!locked) {
      client.release();
      return false;
    }
    job.lockClient = client;
    return true;
  })().finally(() => {
    job.lockReady = undefined;
  });
  return job.lockReady;
}

async function finishJob(roomId: string, job: Job): Promise<void> {
  if (jobs.get(roomId) === job) jobs.delete(roomId);
  if (job.timer) clearTimeout(job.timer);
  const client = job.lockClient;
  job.lockClient = undefined;
  if (client) {
    try {
      await client.query("SELECT pg_advisory_unlock(hashtext('pool-fill'), hashtext($1))", [roomId]);
    } finally {
      client.release();
    }
  }
}

async function preparePlan(roomId: string, job: Job): Promise<boolean> {
  const room = (await database.query(
    "SELECT area_id, scope FROM rooms WHERE id = $1",
    [roomId],
  )).rows[0] as { area_id: string | null; scope: ScopeState | null } | undefined;
  if (!room) return false;
  const area = room.area_id ? areaById(room.area_id) : undefined;
  const snapshot = area ? loadSnapshot(area.id) : null;
  const circle = room.scope?.area;
  if (!area || !snapshot || circle?.kind !== "circle" || !room.scope?.scopeId) {
    job.scopeId = room.scope?.scopeId;
    job.pending = [];
    return true;
  }
  if (job.scopeId === room.scope.scopeId && !job.rerun) return true;
  const refs = new Set((await database.query(
    "SELECT osm_ref FROM candidates WHERE room_id = $1 AND osm_ref IS NOT NULL",
    [roomId],
  )).rows.map((row) => row.osm_ref as string));
  const plan = cachedPoolPlan(
    roomId,
    room.scope.scopeId,
    area,
    snapshot,
    circle.center,
    circle.radiusM,
  );
  job.scopeId = plan.scopeId;
  job.pending = plan.venues.filter((venue) => !refs.has(venue.ref));
  job.observedAt = plan.observedAt;
  job.rerun = false;
  return true;
}

/** Only the lock, headroom read, duplicate check, numbering and insert live in
 * this transaction. Snapshot I/O, the large candidate read and fill planning
 * all happened unlocked. */
async function insertNextBatch(roomId: string, job: Job): Promise<BatchResult> {
  if (!(await preparePlan(roomId, job))) {
    return { roomExists: false, hasMore: false, candidateIds: [], warmTargets: [] };
  }
  if (!job.scopeId || job.pending.length === 0 || !job.observedAt) {
    return { roomExists: true, hasMore: false, candidateIds: [], warmTargets: [] };
  }
  const selected = job.pending.splice(0, FILL_BATCH);
  return withTransaction(async (client) => {
    const room = (await client.query(
      "SELECT scope FROM rooms WHERE id = $1 FOR UPDATE",
      [roomId],
    )).rows[0] as { scope: ScopeState | null } | undefined;
    if (!room) {
      return { roomExists: false, hasMore: false, candidateIds: [], warmTargets: [] };
    }
    if (room.scope?.scopeId !== job.scopeId) {
      return {
        roomExists: true,
        hasMore: true,
        scopeChanged: true,
        candidateIds: [],
        warmTargets: [],
      };
    }
    const stats = (await client.query(
      `SELECT count(*)::int AS count,
              COALESCE(max((substring(id from '([0-9]+)$'))::int), 0)::int AS max_suffix
         FROM candidates WHERE room_id = $1`,
      [roomId],
    )).rows[0] as { count: number; max_suffix: number };
    const headroom = Math.max(0, POOL_CAP - Number(stats.count));
    if (headroom === 0) {
      job.pending = [];
      return { roomExists: true, hasMore: false, candidateIds: [], warmTargets: [] };
    }
    const selectedRefs = selected.map((venue) => venue.ref);
    const present = new Set((await client.query(
      "SELECT osm_ref FROM candidates WHERE room_id = $1 AND osm_ref = ANY($2)",
      [roomId, selectedRefs],
    )).rows.map((row) => row.osm_ref as string));
    const venues = selected.filter((venue) => !present.has(venue.ref)).slice(0, headroom);
    const seeds = seedsForVenues(
      roomId,
      venues,
      job.observedAt!,
      Number(stats.max_suffix) + 1,
    );
    await insertCandidateSeeds(client, roomId, seeds);
    return {
      roomExists: true,
      hasMore: job.pending.length > 0 && Number(stats.count) + seeds.length < POOL_CAP,
      candidateIds: seeds.map((seed) => seed.id),
      warmTargets: warmTargetsFor(seeds),
    };
  });
}

function enqueueWarm(roomId: string, targets: RoomLookupTarget[]): void {
  if (targets.length === 0) return;
  const chain = warmChains.get(roomId) ?? { tail: Promise.resolve(), depth: 0 };
  if (chain.depth >= MAX_WARM_CHAIN_DEPTH) return;
  chain.depth += 1;
  const next = chain.tail
    .then(() => warmEnrichmentsDone(database, roomId, targets))
    .catch(() => {})
    .finally(() => {
      chain.depth -= 1;
      if (chain.depth === 0 && chain.tail === next) warmChains.delete(roomId);
    });
  chain.tail = next;
  warmChains.set(roomId, chain);
}

async function publishCompletion(roomId: string, count: number): Promise<void> {
  if (count <= 0) return;
  const revision = await withTransaction(async (client) => {
    const room = (await client.query(
      "SELECT revision FROM rooms WHERE id = $1 FOR UPDATE",
      [roomId],
    )).rows[0] as { revision: number } | undefined;
    if (!room) return undefined;
    const next = Number(room.revision) + 1;
    await client.query(
      `INSERT INTO events (room_id, revision, type, actor_id, visibility, payload)
       VALUES ($1, $2, 'candidates_added', NULL, 'shared', $3)`,
      [roomId, next, JSON.stringify({ source: "pool", count })],
    );
    await client.query("UPDATE rooms SET revision = $2 WHERE id = $1", [roomId, next]);
    return next;
  });
  if (revision !== undefined) {
    notifyCommit({ roomId, revision, storedRevisions: [revision], confirmations: [] });
  }
}

export function poolFillRetryDelay(failures: number): number {
  return Math.min(FILL_BACKOFF_CAP_MS, FILL_INTERVAL_MS * 2 ** Math.max(0, failures - 1));
}

function schedule(roomId: string, job: Job, delay = FILL_INTERVAL_MS): void {
  job.timer = setTimeout(() => {
    job.timer = undefined;
    void run(roomId, job);
  }, delay);
  job.timer.unref?.();
}

async function run(roomId: string, job: Job): Promise<void> {
  if (jobs.get(roomId) !== job) return;
  try {
    if (!(await acquireJobLock(roomId, job))) {
      await finishJob(roomId, job);
      return;
    }
    const result = await insertNextBatch(roomId, job);
    if (result.scopeChanged) {
      job.scopeId = undefined;
      job.pending = [];
      job.rerun = true;
    }
    if (result.candidateIds.length > 0) {
      job.addedCount += result.candidateIds.length;
      publishFacts(roomId, {
        type: "facts",
        candidateIds: result.candidateIds,
        reason: "pool",
      });
      enqueueWarm(roomId, result.warmTargets);
    }
    job.failures = 0;
    if (!result.roomExists) {
      await finishJob(roomId, job);
      return;
    }
    if (!result.hasMore && !job.rerun) {
      await publishCompletion(roomId, job.addedCount);
      await finishJob(roomId, job);
      return;
    }
    schedule(roomId, job);
  } catch (error) {
    job.failures += 1;
    job.scopeId = undefined;
    job.pending = [];
    console.error("pool fill failed:", error);
    if (job.failures >= FILL_FAILURE_LIMIT) {
      await finishJob(roomId, job);
      return;
    }
    if (jobs.get(roomId) === job) schedule(roomId, job, poolFillRetryDelay(job.failures));
  }
}

/** Start or retain the sole fill loop for a room. Scope-changing callers set
 * rerun so a change landing beside the final old-scope batch cannot be lost. */
export function startPoolFill(roomId: string, scopeChanged = false): void {
  if (!FILL_ENABLED) return;
  const existing = jobs.get(roomId);
  if (existing) {
    if (scopeChanged) existing.rerun = true;
    return;
  }
  const job: Job = {
    rerun: true,
    pending: [],
    addedCount: 0,
    failures: 0,
  };
  jobs.set(roomId, job);
  schedule(roomId, job);
}

/** Resume incomplete area-backed rooms without waiting for a context read.
 * Starts are staggered so process boot does not scan every room at once. */
export async function resumePoolFills(): Promise<void> {
  if (!FILL_ENABLED) return;
  const rows = (await database.query(
    "SELECT id FROM rooms WHERE area_id IS NOT NULL ORDER BY id",
  )).rows as Array<{ id: string }>;
  rows.forEach((row, index) => {
    const timer = setTimeout(() => startPoolFill(row.id), index * BOOT_STAGGER_MS);
    timer.unref?.();
  });
}
