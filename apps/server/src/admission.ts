import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { pool } from "./db.ts";
import { config } from "./config.ts";
import { securityLimit } from "./security.ts";
import { currentWork, withWork, type Workload } from "./work-context.ts";
import { WorkError, type WorkFailure } from "./work-outcome.ts";

export interface ResourceLimit {
  key: string;
  hourly: number;
  daily: number;
  interactiveReserve: number;
  backgroundReserve: number;
}
function percent(name: string, fallback: number): number {
  const n =
    process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isFinite(n) || n < 0 || n > 90)
    throw new Error(`${name} must be between 0 and 90`);
  return n / 100;
}
export function resourceLimit(
  key: string,
  prefix: string,
  hourly: number,
  daily: number,
): ResourceLimit {
  const interactiveReserve = percent(
    `${prefix}_INTERACTIVE_RESERVE_PERCENT`,
    10,
  );
  const backgroundReserve = percent(`${prefix}_BACKGROUND_RESERVE_PERCENT`, 20);
  if (interactiveReserve + backgroundReserve >= 1)
    throw new Error("Resource reservations must leave background capacity");
  return {
    key,
    hourly: securityLimit(`${prefix}_CALLS_PER_HOUR`, hourly),
    daily: securityLimit(`${prefix}_CALLS_PER_DAY`, daily),
    interactiveReserve,
    backgroundReserve,
  };
}
export function modelResource(): ResourceLimit {
  const account =
    config.llmProvider === "openrouter"
      ? config.openrouterApiKey
      : config.openaiApiKey;
  const hash = createHash("sha256").update(account).digest("hex").slice(0, 24);
  return resourceLimit(`model:${config.llmProvider}:${hash}`, "LLM", 600, 2000);
}
export function modelCostReservation(): number {
  const n = Number(process.env.MODEL_CALL_COST_RESERVATION_USD ?? "0.05");
  if (!Number.isFinite(n) || n <= 0)
    throw new Error("MODEL_CALL_COST_RESERVATION_USD must be positive");
  return n;
}
function quota(resource: string, retryAt: Date): WorkError {
  return new WorkError({
    provider: resource.split(":")[0],
    code: "quota",
    deferred: true,
    retryAt: retryAt.toISOString(),
  });
}
interface AdmissionOptions {
  units?: number;
  hold?: boolean;
  reservation?: string;
  provider?: string;
  estimatedCostUsd?: number;
  workload?: Workload;
  runId?: string;
}

/** Atomic across processes and resources. Connections/locks are released before any network I/O. */
export async function admit(
  resources: ResourceLimit[],
  options: AdmissionOptions = {},
  db: pg.Pool = pool,
): Promise<string> {
  const work = currentWork();
  const workload = options.workload ?? work.workload;
  const runId = options.runId ?? work.runId;
  const units = options.units ?? 1;
  if (!Number.isSafeInteger(units) || units < 1)
    throw new Error("Admission units must be positive");
  if (options.hold && resources.length !== 1)
    throw new Error("A reservation owns one resource");
  const id = randomUUID();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const now = new Date(
      (await client.query("SELECT clock_timestamp() AS now")).rows[0].now,
    );
    for (const resource of [...resources].sort((a, b) =>
      a.key.localeCompare(b.key),
    )) {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 818))",
        [resource.key],
      );
      let own = 0;
      if (options.reservation) {
        const held = (
          await client.query(
            `SELECT remaining FROM resource_reservations WHERE id = $1 AND resource = $2
           AND workload = $3 AND run_id IS NOT DISTINCT FROM $4 AND expires_at > $5 FOR UPDATE`,
            [options.reservation, resource.key, workload, runId ?? null, now],
          )
        ).rows[0];
        own = Math.min(units, Number(held?.remaining ?? 0));
      }
      const held = (
        await client.query(
          `SELECT workload, sum(remaining)::int AS used FROM resource_reservations
         WHERE resource = $1 AND expires_at > $2 GROUP BY workload`,
          [resource.key, now],
        )
      ).rows as Array<{ workload: Workload; used: number }>;
      for (const seconds of [3600, 86400]) {
        const start = new Date(
          Math.floor(now.getTime() / (seconds * 1000)) * seconds * 1000,
        );
        const limit = seconds === 3600 ? resource.hourly : resource.daily;
        const used = (
          await client.query(
            `SELECT workload, used FROM resource_usage WHERE resource = $1 AND window_start = $2
           AND window_seconds = $3`,
            [resource.key, start, seconds],
          )
        ).rows as Array<{ workload: Workload; used: number }>;
        const counts = { interactive: 0, background: 0, prepopulate: 0 };
        for (const row of [...held, ...used])
          counts[row.workload] += Number(row.used);
        counts[workload] += units - own;
        const total =
          counts.interactive + counts.background + counts.prepopulate;
        if (
          total > limit ||
          (workload !== "interactive" &&
            counts.background + counts.prepopulate >
              Math.max(
                1,
                Math.floor(limit * (1 - resource.interactiveReserve)),
              )) ||
          (workload === "prepopulate" &&
            counts.prepopulate >
              Math.max(
                1,
                Math.floor(
                  limit *
                    (1 -
                      resource.interactiveReserve -
                      resource.backgroundReserve),
                ),
              ))
        ) {
          throw quota(resource.key, new Date(start.getTime() + seconds * 1000));
        }
        if (!options.hold)
          await client.query(
            `INSERT INTO resource_usage(resource, window_start, window_seconds, workload, used)
           VALUES ($1,$2,$3,$4,$5) ON CONFLICT (resource,window_start,window_seconds,workload)
           DO UPDATE SET used = resource_usage.used + EXCLUDED.used`,
            [resource.key, start, seconds, workload, units],
          );
      }
      if (own)
        await client.query(
          "UPDATE resource_reservations SET remaining = remaining - $2 WHERE id = $1",
          [options.reservation, own],
        );
    }
    const cost = options.estimatedCostUsd ?? 0;
    if (!Number.isFinite(cost) || cost < 0)
      throw new Error("Cost reservation must be finite and nonnegative");
    if (runId) {
      const run = (
        await client.query(
          "SELECT max_requests, max_cost_usd FROM prepopulation_runs WHERE id = $1 FOR UPDATE",
          [runId],
        )
      ).rows[0];
      if (!run) throw new Error("Unknown prepopulation run");
      const spent = (
        await client.query(
          `SELECT count(*)::int AS requests, coalesce(sum(coalesce(actual_cost_usd, estimated_cost_usd)),0)::float8 AS cost
         FROM provider_attempts WHERE run_id = $1`,
          [runId],
        )
      ).rows[0];
      const reserved = Number(
        (
          await client.query(
            `SELECT coalesce(sum(remaining * unit_cost_usd),0)::float8 AS cost
         FROM resource_reservations WHERE run_id = $1 AND expires_at > $2`,
            [runId, now],
          )
        ).rows[0].cost,
      );
      const heldRequests = Number(
        (
          await client.query(
            "SELECT coalesce(sum(remaining),0)::int AS requests FROM resource_reservations WHERE run_id=$1 AND expires_at>$2",
            [runId, now],
          )
        ).rows[0].requests,
      );
      if (
        (run.max_requests &&
          Number(spent.requests) + heldRequests + (options.hold ? units : 1) >
            Number(run.max_requests)) ||
        (run.max_cost_usd &&
          Number(spent.cost) + reserved + cost * units >
            Number(run.max_cost_usd))
      ) {
        // Run caps require an explicit resume with a larger cap, not a timed automatic retry.
        throw new WorkError({ provider: "run", code: "quota", deferred: true });
      }
    }
    if (options.hold)
      await client.query(
        `INSERT INTO resource_reservations(id,resource,workload,remaining,expires_at,run_id,unit_cost_usd)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          id,
          resources[0].key,
          workload,
          units,
          new Date(now.getTime() + 10 * 60_000),
          runId ?? null,
          cost,
        ],
      );
    else
      await client.query(
        `INSERT INTO provider_attempts(id,run_id,provider,workload,estimated_cost_usd)
       VALUES ($1,$2,$3,$4,$5)`,
        [
          id,
          runId ?? null,
          options.provider ?? resources[0]?.key.split(":")[0] ?? "provider",
          workload,
          cost,
        ],
      );
    await client.query("COMMIT");
    return id;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function settleAttempt(
  id: string,
  result: {
    actualCostUsd?: number;
    httpStatus?: number;
    outcome: "ok" | "empty" | "failed";
    failure?: WorkFailure;
  },
  db: pg.Pool = pool,
): Promise<void> {
  const cost = result.actualCostUsd;
  await db.query(
    `UPDATE provider_attempts SET actual_cost_usd = coalesce($2,actual_cost_usd), http_status = coalesce($3,http_status), outcome = $4,
     failure_code = $5, finished_at = now() WHERE id = $1`,
    [
      id,
      typeof cost === "number" && Number.isFinite(cost) && cost >= 0
        ? cost
        : null,
      result.httpStatus ?? null,
      result.outcome,
      result.failure?.code ?? null,
    ],
  );
}

export async function withModelReservation<T>(
  units: number,
  run: () => Promise<T>,
  db: pg.Pool = pool,
): Promise<T> {
  if (!units || currentWork().modelReservation) return run();
  const id = await admit(
    [modelResource()],
    { units, hold: true, estimatedCostUsd: modelCostReservation() },
    db,
  );
  const renew = setInterval(() => {
    void db
      .query(
        "UPDATE resource_reservations SET expires_at=now()+interval '10 minutes' WHERE id=$1",
        [id],
      )
      .catch(() => undefined);
  }, 60_000);
  renew.unref();
  try {
    return await withWork({ modelReservation: id }, run);
  } finally {
    clearInterval(renew);
    await db.query("DELETE FROM resource_reservations WHERE id = $1", [id]);
  }
}
