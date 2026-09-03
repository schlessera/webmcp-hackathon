import pg from "pg";
import { config } from "./config.ts";

// Twenty clients: background work (pool fill, refinement, warm-up) must never
// starve a request, and no job may hold a client outside a transaction.
export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 20 });

export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
