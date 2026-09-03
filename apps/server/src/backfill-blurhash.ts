import { pool } from "./db.ts";
import { backfillPlaceImageBlurhashes } from "./enrich/backfill-blurhash.ts";

const maxRows = Number(process.env.BLURHASH_BACKFILL_MAX_ROWS ?? 1_000);
const batchSize = Number(process.env.BLURHASH_BACKFILL_BATCH_SIZE ?? 50);

try {
  const result = await backfillPlaceImageBlurhashes(pool, {
    maxRows,
    batchSize,
    after: process.env.BLURHASH_BACKFILL_AFTER,
  });
  console.info(JSON.stringify({ msg: "place image blurhash backfill complete", ...result }));
} finally {
  await pool.end();
}
