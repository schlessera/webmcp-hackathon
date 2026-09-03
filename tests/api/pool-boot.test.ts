import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";
import { DATABASE_URL, apiPost, startServer, type TestServer } from "./helpers.ts";

/**
 * The boot deadlock, pinned.
 *
 * Every fill job used to hold a dedicated pool client for its whole life as
 * the holder of a session-scoped advisory lock. Twenty-nine rooms resuming at
 * boot took every client in the pool, each batch then queued for a client that
 * would never be returned, and every request that touched the database hung —
 * the app could not even exchange an invite. The fix made the lock
 * transaction-scoped inside the batch.
 *
 * This test recreates the shape that broke: many area rooms with unfinished
 * fills, all resuming at once, while a real request needs the database.
 */

const database = new pg.Pool({ connectionString: DATABASE_URL });
const seeded: string[] = [];
const ROOMS = 26;
const ANSWER_WITHIN_MS = 5_000;

afterAll(async () => {
  if (seeded.length > 0) {
    await database.query("DELETE FROM candidates WHERE room_id = ANY($1)", [seeded]);
    await database.query("DELETE FROM participants WHERE room_id = ANY($1)", [seeded]);
    await database.query("DELETE FROM rooms WHERE id = ANY($1)", [seeded]);
  }
  await database.end();
});

describe("resuming many pool fills at boot", () => {
  it("still answers an invite exchange and a context read", async () => {
    // Build the rooms with filling off, so every one of them is left
    // incomplete and they all resume together on the next boot.
    const paused = await startServer({ env: { POOL_FILL: "0" } });
    let booted: TestServer | undefined;
    let inviteSecret = "";
    try {
      const created = await (await fetch(`${paused.baseUrl}/api/rooms`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          areaId: "berlin-mitte",
          organizerName: "Boot",
          memberNames: [],
        }),
      })).json() as { roomId: string; invites: Array<{ inviteSecret: string }> };
      seeded.push(created.roomId);
      inviteSecret = created.invites[0].inviteSecret;

      // Room creation is rate limited per address and reloads the whole
      // snapshot, so the crowd is copied from the real row instead. Each copy
      // carries the same area and scope, which is all a fill job reads.
      for (let index = 1; index < ROOMS; index += 1) {
        const id = `${created.roomId}_boot${String(index).padStart(2, "0")}`;
        await database.query(
          `INSERT INTO rooms (id, goal, phase, domain, revision, policy, scope, scope_seq, area_id)
           SELECT $2, goal, phase, domain, revision, policy, scope, scope_seq, area_id
             FROM rooms WHERE id = $1`,
          [created.roomId, id],
        );
        seeded.push(id);
      }
      const areaRooms = Number((await database.query(
        "SELECT count(*)::int AS count FROM rooms WHERE id = ANY($1) AND area_id IS NOT NULL",
        [seeded],
      )).rows[0].count);
      expect(areaRooms).toBe(ROOMS);
    } finally {
      await paused.stop();
    }

    // Boot with filling on. Every seeded room resumes; the request below has
    // to get a database client anyway.
    booted = await startServer({
      env: { POOL_FILL_INTERVAL_MS: "10", POOL_FILL_BATCH: "50" },
    });
    try {
      expect(inviteSecret).not.toBe("");
      const startedAt = Date.now();
      const exchanged = await withDeadline(
        fetch(`${booted.baseUrl}/api/session/exchange`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ inviteSecret }),
        }),
        ANSWER_WITHIN_MS,
        "invite exchange",
      );
      expect(exchanged.status).toBe(200);
      const token = ((await exchanged.json()) as { participantToken: string }).participantToken;

      const context = await withDeadline(
        apiPost<{ pool: { size: number } }>(
          booted.baseUrl,
          "/api/spatial/context",
          token,
          {},
        ),
        ANSWER_WITHIN_MS,
        "context read",
      );
      expect(context.body.pool.size).toBeGreaterThan(0);
      // Both answered while every seeded room was filling.
      expect(Date.now() - startedAt).toBeLessThan(ANSWER_WITHIN_MS * 2);
    } finally {
      await booted.stop();
    }
  }, 60_000);
});

async function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${what} did not answer within ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
