import pg from "pg";
import { DATABASE_URL, resetApiCacheState } from "./helpers.ts";

async function resetWithFreshPool(): Promise<void> {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
  try {
    await resetApiCacheState(pool);
  } finally {
    await pool.end();
  }
}

/** One reset before the parallel API workers start, plus teardown after every
 * worker has stopped. This preserves deliberate warm-cache state within a
 * suite without letting one completed run contaminate the next one. */
export default async function setupApiCacheState(): Promise<() => Promise<void>> {
  await resetWithFreshPool();
  return resetWithFreshPool;
}
