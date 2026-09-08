import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import type pg from "pg";
import { loadSnapshot } from "../places.ts";
import { parseOptions, selectVenues } from "./options.ts";

/** Requeue uncertain historical search markers; retain omissions, validated
 * claims, explicit matrix abstentions and all successfully fetched material. */
export async function repairWindow(
  db: pg.Pool,
  refs: string[],
  from: string,
  to: string,
  apply = false,
) {
  const start = Date.parse(from),
    end = Date.parse(to);
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    end <= start ||
    end - start > 86400_000
  )
    throw new Error("Repair requires a valid window of at most 24 hours");
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const rows = (
      await client.query(
        `SELECT osm_ref,inferred,website_error,website_fetched_at FROM enrichments
      WHERE osm_ref=ANY($1::text[]) ORDER BY osm_ref FOR UPDATE`,
        [refs],
      )
    ).rows;
    const backed = new Set(
      (
        await client.query(
          `SELECT osm_ref,criterion_id FROM matrix_cache WHERE osm_ref=ANY($1::text[])
      AND answered AND evaluated_at BETWEEN $2 AND $3`,
          [refs, new Date(start), new Date(end)],
        )
      ).rows.map((r) => `${r.osm_ref}\0${r.criterion_id}`),
    );
    let markers = 0,
      websiteRefusals = 0;
    for (const row of rows) {
      const inferred = { ...row.inferred };
      let changed = false;
      for (const [key, raw] of Object.entries(inferred)) {
        const value = raw as {
          omitted?: boolean;
          observedAt?: string;
          searchDay?: string;
          searchAttempts?: number;
        };
        const at = Date.parse(value.observedAt ?? "");
        if (
          value.omitted &&
          value.searchDay &&
          at >= start &&
          at <= end &&
          !backed.has(`${row.osm_ref}\0${key}`)
        ) {
          delete value.searchDay;
          delete value.searchAttempts;
          markers++;
          changed = true;
        }
      }
      const fetched = new Date(row.website_fetched_at).getTime();
      const quota =
        fetched >= start &&
        fetched <= end &&
        /outbound budget reached|model budget reached|capacity reached/i.test(
          row.website_error ?? "",
        );
      if (quota) websiteRefusals++;
      if (apply && changed)
        await client.query(
          "UPDATE enrichments SET inferred=$2 WHERE osm_ref=$1",
          [row.osm_ref, JSON.stringify(inferred)],
        );
      if (apply && quota)
        await client.query(
          `UPDATE enrichments SET website_status='never',website_expires_at=NULL,
        website_error=NULL,error=NULL WHERE osm_ref=$1`,
          [row.osm_ref],
        );
    }
    await client.query(apply ? "COMMIT" : "ROLLBACK");
    return {
      applied: apply,
      selected: refs.length,
      uncertainSearchMarkers: markers,
      localWebsiteRefusals: websiteRefusals,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
export async function runStatus(db: pg.Pool, id: string) {
  const run = (
    await db.query(
      `SELECT id,status,options,max_requests,max_cost_usd,created_at,updated_at,retry_at,
    lease_expires_at FROM prepopulation_runs WHERE id=$1`,
      [id],
    )
  ).rows[0];
  if (!run) throw new Error("Unknown run ID");
  const stages = (
    await db.query(
      `SELECT stage,status,count(*)::int AS places,sum(attempts)::int AS attempts,
    min(retry_at) AS retry_at FROM prepopulation_stages WHERE run_id=$1 GROUP BY stage,status ORDER BY stage,status`,
      [id],
    )
  ).rows;
  const providers = (
    await db.query(
      `SELECT provider,outcome,provider_status,count(*)::int AS attempts,
    coalesce(sum(actual_cost_usd),0)::float8 AS reported_cost_usd,
    coalesce(sum(coalesce(actual_cost_usd,estimated_cost_usd)),0)::float8 AS reserved_cost_usd,
    count(*) FILTER(WHERE actual_cost_usd IS NULL)::int AS unreconciled,
    percentile_cont(0.5) WITHIN GROUP(ORDER BY extract(epoch FROM finished_at-started_at)*1000) AS p50_ms,
    percentile_cont(0.95) WITHIN GROUP(ORDER BY extract(epoch FROM finished_at-started_at)*1000) AS p95_ms
    FROM provider_attempts WHERE run_id=$1 GROUP BY provider,outcome,provider_status ORDER BY provider,outcome,provider_status`,
      [id],
    )
  ).rows;
  return { run, stages, providers };
}
/** Keep run audit records; prune only expired coordination and unowned request history. */
export async function pruneOperationalState(db: pg.Pool) {
  await db.query(
    "DELETE FROM resource_usage WHERE window_start < now()-interval '2 days'",
  );
  await db.query("DELETE FROM resource_reservations WHERE expires_at <= now()");
  await db.query("DELETE FROM fetch_leases WHERE expires_at <= now()");
  await db.query(
    "DELETE FROM source_tiles WHERE expires_at < now()-interval '7 days'",
  );
  await db.query(
    "DELETE FROM provider_attempts WHERE run_id IS NULL AND started_at<now()-interval '30 days'",
  );
  await db.query(
    "DELETE FROM listing_batches WHERE expires_at<now()-interval '30 days'",
  );
}
async function main() {
  const { values } = parseArgs({
    options: {
      run: { type: "string" },
      area: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      apply: { type: "boolean" },
      prune: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      "--run ID: report status and provider accounting\n--area ID --from ISO --to ISO [--apply]: audit/repair historical local refusals and unsupported search markers\n--prune: remove expired operational state",
    );
    return;
  }
  const { pool } = await import("../db.ts");
  try {
    if (values.run)
      console.log(JSON.stringify(await runStatus(pool, values.run), null, 2));
    else if (values.prune) {
      await pruneOperationalState(pool);
      console.log(JSON.stringify({ pruned: true }));
    } else {
      if (!values.area || !values.from || !values.to)
        throw new Error("Provide --run, --prune or --area/--from/--to");
      const options = parseOptions(["--area", values.area])!;
      const snapshot = loadSnapshot(values.area);
      if (!snapshot) throw new Error("Missing area snapshot");
      console.log(
        JSON.stringify(
          await repairWindow(
            pool,
            selectVenues(snapshot, options).map((v) => v.ref),
            values.from,
            values.to,
            values.apply ?? false,
          ),
        ),
      );
    }
  } finally {
    await pool.end();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
