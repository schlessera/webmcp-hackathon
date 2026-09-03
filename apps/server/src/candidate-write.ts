import type pg from "pg";
import type { CandidateSeed } from "./places.ts";

/** Continue a room's numeric candidate suffix while preserving creation ids. */
export function numberCandidateSeeds(
  roomId: string,
  seeds: CandidateSeed[],
  existingIds: string[],
): void {
  const prefix = `pl_${roomId.replace(/^room_/, "")}_`;
  let next = existingIds.reduce((highest, id) => {
    if (!id.startsWith(prefix)) return highest;
    const suffix = id.slice(prefix.length);
    return /^\d+$/.test(suffix) ? Math.max(highest, Number(suffix)) : highest;
  }, 0) + 1;
  for (const seed of seeds) {
    seed.id = `${prefix}${String(next++).padStart(3, "0")}`;
  }
}

/** Insert one candidate batch with one statement and keep provenance counts
 * aligned with the actual room pool. Callers must already hold the room lock. */
export async function insertCandidateSeeds(
  client: pg.PoolClient,
  roomId: string,
  seeds: CandidateSeed[],
): Promise<void> {
  if (seeds.length === 0) return;
  const values: unknown[] = [];
  const rows = seeds.map((seed, index) => {
    const offset = index * 11;
    values.push(
      seed.id,
      roomId,
      seed.name,
      seed.category,
      seed.price_level,
      seed.walk_min,
      JSON.stringify(seed.location),
      JSON.stringify(seed.attributes),
      JSON.stringify(seed.hours),
      seed.osmRef ?? null,
      JSON.stringify(seed.extras ?? {}),
    );
    return `(${Array.from({ length: 11 }, (_, i) => `$${offset + i + 1}`).join(", ")})`;
  });
  await client.query(
    `INSERT INTO candidates
       (id, room_id, name, category, price_level, walk_min, location, attributes, hours, osm_ref, extras)
     VALUES ${rows.join(", ")}`,
    values,
  );
  await client.query(
    `UPDATE rooms
        SET data_source = CASE WHEN data_source IS NULL THEN NULL
          ELSE jsonb_set(data_source, '{poolSize}',
            to_jsonb((SELECT count(*)::int FROM candidates WHERE room_id = $1))) END
      WHERE id = $1`,
    [roomId],
  );
}
