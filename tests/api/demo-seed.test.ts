import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";
import { haversineMeters } from "../../apps/server/src/eligibility.ts";
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
  it("seeds three distinct fictitious participant origins", async () => {
    await seedDemo();
    const rows = await database.query(
      "SELECT display_name, origin FROM participants WHERE room_id = 'room_demo' ORDER BY id",
    );
    const scope = (await database.query("SELECT scope FROM rooms WHERE id = 'room_demo'"))
      .rows[0].scope as { area: { center: { lat: number; lng: number } } };
    expect(rows.rows.map((row) => row.display_name).sort()).toEqual(["Alain", "Joe", "Sarah"]);
    expect(new Set(rows.rows.map((row) => `${row.origin.lat},${row.origin.lng}`)).size).toBe(3);
    for (const row of rows.rows) {
      expect(row.origin).toMatchObject({ source: "fixture" });
      expect(row.origin.label).toBeTruthy();
      expect(haversineMeters(row.origin, scope.area.center)).toBeLessThanOrEqual(1500);
    }
  }, 30_000);

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
