import { pool } from "./db.ts";
import { recleanStoredText } from "./enrich/reclean.ts";

const maxRowsPerTable = Number(process.env.TEXT_RECLEAN_MAX_ROWS ?? 10_000);
const batchSize = Number(process.env.TEXT_RECLEAN_BATCH_SIZE ?? 250);

try {
  const result = await recleanStoredText(pool, {
    maxRowsPerTable,
    batchSize,
    afterOsmRef: process.env.TEXT_RECLEAN_AFTER_OSM_REF,
    afterUrlHash: process.env.TEXT_RECLEAN_AFTER_URL_HASH,
  });
  console.info(JSON.stringify({ msg: "text re-clean complete", ...result }));
} finally {
  await pool.end();
}
