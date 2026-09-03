import { POOL_CAP, areaById } from "@webmcp-hackathon/contracts";
import {
  insertCandidateSeeds,
  numberCandidateSeeds,
  warmTargetsFor,
} from "./candidate-write.ts";
import { notifyCommit } from "./commit-notifications.ts";
import { pool as database, withTransaction } from "./db.ts";
import { warmEnrichmentsDone, type RoomLookupTarget } from "./enrich/index.ts";
import { publishFacts } from "./enrich/progress.ts";
import type { ScopeState } from "./eligibility.ts";
import { fillPlan, loadSnapshot, seedsForVenues } from "./places.ts";

function integerEnv(name: string, fallback: number, minimum: number): number {
  const parsed = Number(process.env[name]);
  return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : fallback;
}

const FILL_ENABLED = process.env.POOL_FILL !== "0";
const FILL_INTERVAL_MS = integerEnv("POOL_FILL_INTERVAL_MS", 400, 0);
const FILL_BATCH = integerEnv("POOL_FILL_BATCH", 50, 1);

interface Job {
  timer?: ReturnType<typeof setTimeout>;
  /** A scope/read requested another derivation while this job was active. */
  rerun: boolean;
  /** Batches warm one after another, so the whole room still only ever holds
   * WARM_CONCURRENCY outbound fetches open rather than four per batch. */
  warming: Promise<void>;
}

interface BatchResult {
  roomExists: boolean;
  hasMore: boolean;
  revision?: number;
  candidateIds: string[];
  /** Places in this batch with somewhere to look, for the warm-up chain. */
  warmTargets: RoomLookupTarget[];
}

const jobs = new Map<string, Job>();

async function insertNextBatch(roomId: string): Promise<BatchResult> {
  return withTransaction(async (client) => {
    // This is the command engine's candidate-write lock. Scope changes,
    // participant additions, and pool batches therefore serialize on one row.
    const room = (
      await client.query(
        "SELECT revision, area_id, scope FROM rooms WHERE id = $1 FOR UPDATE",
        [roomId],
      )
    ).rows[0] as {
      revision: number;
      area_id: string | null;
      scope: ScopeState | null;
    } | undefined;
    if (!room) {
      return { roomExists: false, hasMore: false, candidateIds: [], warmTargets: [] };
    }

    const area = room.area_id ? areaById(room.area_id) : undefined;
    const snapshot = area ? loadSnapshot(area.id) : null;
    const circle = room.scope?.area;
    if (!area || !snapshot || circle?.kind !== "circle") {
      return { roomExists: true, hasMore: false, candidateIds: [], warmTargets: [] };
    }

    const existingRows = (
      await client.query(
        "SELECT id, osm_ref FROM candidates WHERE room_id = $1 ORDER BY id",
        [roomId],
      )
    ).rows as Array<{ id: string; osm_ref: string | null }>;
    const headroom = Math.max(0, POOL_CAP - existingRows.length);
    if (headroom === 0) {
      return { roomExists: true, hasMore: false, candidateIds: [], warmTargets: [] };
    }
    const existingRefs = existingRows.flatMap((row) => row.osm_ref ? [row.osm_ref] : []);
    const plan = fillPlan(
      area,
      snapshot,
      circle.center,
      circle.radiusM,
      existingRefs,
      FILL_BATCH,
    );
    const venues = (plan.batches[0] ?? []).slice(0, headroom);
    if (venues.length === 0) {
      return { roomExists: true, hasMore: false, candidateIds: [], warmTargets: [] };
    }

    const seeds = seedsForVenues(
      roomId,
      venues,
      snapshot.manifest.extract.timestamp,
    );
    numberCandidateSeeds(roomId, seeds, existingRows.map((row) => row.id));
    await insertCandidateSeeds(client, roomId, seeds);

    const revision = Number(room.revision) + 1;
    await client.query(
      `INSERT INTO events (room_id, revision, type, actor_id, visibility, payload)
       VALUES ($1, $2, 'candidates_added', NULL, 'shared', $3)`,
      [roomId, revision, JSON.stringify({ source: "pool", count: seeds.length })],
    );
    await client.query("UPDATE rooms SET revision = $2 WHERE id = $1", [roomId, revision]);
    const remaining = plan.batches.reduce((count, batch) => count + batch.length, 0);
    return {
      roomExists: true,
      hasMore: remaining > seeds.length && existingRows.length + seeds.length < POOL_CAP,
      revision,
      candidateIds: seeds.map((seed) => seed.id),
      warmTargets: warmTargetsFor(seeds),
    };
  });
}

function schedule(roomId: string, job: Job): void {
  job.timer = setTimeout(() => {
    void run(roomId, job);
  }, FILL_INTERVAL_MS);
  job.timer.unref?.();
}

async function run(roomId: string, job: Job): Promise<void> {
  if (jobs.get(roomId) !== job) return;
  job.rerun = false;
  try {
    const result = await insertNextBatch(roomId);
    if (result.revision !== undefined && result.candidateIds.length > 0) {
      notifyCommit({
        roomId,
        revision: result.revision,
        storedRevisions: [result.revision],
        confirmations: [],
      });
      publishFacts(roomId, {
        type: "facts",
        candidateIds: result.candidateIds,
        reason: "pool",
      });
      // The cheap leg only: fetch each new place's own site so its dossier is
      // not empty the moment it lands. Inference is the refine worker's job.
      job.warming = job.warming.then(() =>
        warmEnrichmentsDone(database, roomId, result.warmTargets),
      );
    }
    if (!result.roomExists || (!result.hasMore && !job.rerun)) {
      jobs.delete(roomId);
      return;
    }
  } catch (error) {
    console.error("pool fill failed:", error);
  }
  if (jobs.get(roomId) === job) schedule(roomId, job);
}

/** Start (or retain) the sole in-process fill loop for a room. Its next tick
 * always derives work from persisted scope and candidate refs, so starting it
 * after a restart is enough to resume an incomplete room. */
export function startPoolFill(roomId: string): void {
  if (!FILL_ENABLED) return;
  const existing = jobs.get(roomId);
  if (existing) {
    existing.rerun = true;
    return;
  }
  const job: Job = { rerun: false, warming: Promise.resolve() };
  jobs.set(roomId, job);
  schedule(roomId, job);
}
