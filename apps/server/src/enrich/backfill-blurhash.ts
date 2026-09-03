import type pg from "pg";
import { blurhashForImage } from "./images.ts";

type BackfillQuery = Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query">;

export interface BlurhashBackfillOptions {
  /** Hard ceiling for one invocation. Continue with `nextCursor`. */
  maxRows?: number;
  batchSize?: number;
  after?: string;
  encode?: (bytes: Uint8Array) => Promise<string>;
}

export interface BlurhashBackfillResult {
  scanned: number;
  generated: number;
  failed: number;
  updated: number;
  truncated: boolean;
  nextCursor?: string;
}

interface ImageBackfillRow {
  osm_ref: string;
  idx: number;
  bytes: Buffer;
}

function boundedInteger(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(value!)));
}

export function blurhashBackfillCursor(osmRef: string, idx: number): string {
  return Buffer.from(JSON.stringify([osmRef, idx])).toString("base64url");
}

function parseCursor(cursor: string | undefined): [string, number] {
  if (!cursor) return ["", -1];
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      !Array.isArray(parsed) || parsed.length !== 2 ||
      typeof parsed[0] !== "string" || !Number.isInteger(parsed[1]) || parsed[1] < 0
    ) throw new Error("invalid shape");
    return [parsed[0], parsed[1]];
  } catch {
    throw new Error("BLURHASH_BACKFILL_AFTER is not a valid cursor");
  }
}

/** Fill only null hashes in bounded cursor batches. Successful rows use a
 * guarded bulk update, so rerunning a completed range performs no writes. */
export async function backfillPlaceImageBlurhashes(
  q: BackfillQuery,
  options: BlurhashBackfillOptions = {},
): Promise<BlurhashBackfillResult> {
  const maxRows = boundedInteger(options.maxRows, 1_000, 10_000);
  const batchSize = boundedInteger(options.batchSize, 50, 500);
  const encode = options.encode ?? blurhashForImage;
  let [afterRef, afterIdx] = parseCursor(options.after);
  let scanned = 0;
  let generated = 0;
  let failed = 0;
  let updated = 0;
  let truncated = false;

  while (scanned < maxRows) {
    const take = Math.min(batchSize, maxRows - scanned);
    const rows = (await q.query(
      `SELECT osm_ref, idx, bytes
         FROM place_images
        WHERE blurhash IS NULL
          AND (osm_ref, idx) > ($1::text, $2::integer)
        ORDER BY osm_ref, idx
        LIMIT $3`,
      [afterRef, afterIdx, take + 1],
    )).rows as ImageBackfillRow[];
    const batch = rows.slice(0, take);
    if (batch.length === 0) break;

    const hashes: Array<{ osmRef: string; idx: number; blurhash: string }> = [];
    for (const row of batch) {
      try {
        hashes.push({
          osmRef: row.osm_ref,
          idx: row.idx,
          blurhash: await encode(row.bytes),
        });
        generated += 1;
      } catch (error) {
        failed += 1;
        console.error(JSON.stringify({
          msg: "place image blurhash backfill failed",
          osmRef: row.osm_ref,
          idx: row.idx,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    }
    if (hashes.length > 0) {
      const result = await q.query(
        `UPDATE place_images AS stored
            SET blurhash = batch.blurhash
           FROM unnest($1::text[], $2::integer[], $3::text[])
             AS batch(osm_ref, idx, blurhash)
          WHERE stored.osm_ref = batch.osm_ref
            AND stored.idx = batch.idx
            AND stored.blurhash IS NULL`,
        [
          hashes.map((row) => row.osmRef),
          hashes.map((row) => row.idx),
          hashes.map((row) => row.blurhash),
        ],
      );
      updated += result.rowCount ?? 0;
    }

    scanned += batch.length;
    afterRef = batch.at(-1)!.osm_ref;
    afterIdx = batch.at(-1)!.idx;
    if (rows.length <= take) break;
    if (scanned >= maxRows) truncated = true;
  }

  return {
    scanned,
    generated,
    failed,
    updated,
    truncated,
    ...(truncated ? { nextCursor: blurhashBackfillCursor(afterRef, afterIdx) } : {}),
  };
}
