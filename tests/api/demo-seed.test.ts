import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";
import { DATABASE_URL } from "./helpers.ts";

const run = promisify(execFile);
const database = new pg.Pool({ connectionString: DATABASE_URL });
const survivorId = `pl_demo_reseed_${process.pid}`;

async function seedDemo(): Promise<void> {
  await run("node", ["apps/server/src/seed.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL },
  });
}

afterAll(async () => {
  await database.query("DELETE FROM candidates WHERE room_id = 'room_demo' AND id = $1", [
    survivorId,
  ]);
  await database.end();
});

describe("demo reseed", () => {
  it("keeps a snapshot place that was brought into room_demo", async () => {
    await seedDemo();
    await database.query(
      `INSERT INTO candidates
         (id, room_id, name, category, price_level, walk_min, location, attributes, hours, osm_ref)
       VALUES ($1, 'room_demo', 'Reseed survivor', 'place', NULL, 4,
         '{"lat":52.5201,"lng":13.4051}', '[]', '[]', $2)`,
      [survivorId, `node/reseed-${process.pid}`],
    );

    await seedDemo();

    const row = await database.query(
      "SELECT id FROM candidates WHERE room_id = 'room_demo' AND id = $1",
      [survivorId],
    );
    expect(row.rows).toEqual([{ id: survivorId }]);
  }, 30_000);
});
