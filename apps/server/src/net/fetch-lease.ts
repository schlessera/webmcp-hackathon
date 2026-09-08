import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { WorkError } from "../work-outcome.ts";

/** Serializes cache misses across processes without holding a DB connection during I/O.
 * The caller rechecks its cache after admission. Different readers may return different shapes. */
export async function withFetchLease<T>(
  db: Pick<pg.Pool, "query">,
  key: string,
  run: () => Promise<T>,
): Promise<T> {
  const hash = createHash("sha256").update(key).digest("hex");
  const owner = randomUUID();
  for (let tries = 0; tries < 60; tries++) {
    const acquired = await db.query(
      `INSERT INTO fetch_leases(cache_key,owner,expires_at)
      VALUES($1,$2,now()+interval '2 minutes') ON CONFLICT(cache_key) DO UPDATE
      SET owner=$2,expires_at=now()+interval '2 minutes' WHERE fetch_leases.expires_at<=now() RETURNING owner`,
      [hash, owner],
    );
    if (acquired.rowCount) {
      try {
        return await run();
      } finally {
        await db.query(
          "DELETE FROM fetch_leases WHERE cache_key=$1 AND owner=$2",
          [hash, owner],
        );
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new WorkError({
    provider: "cache",
    code: "capacity",
    deferred: true,
    retryAt: new Date(Date.now() + 6000).toISOString(),
  });
}
