import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { questionKey } from "@webmcp-hackathon/contracts";
import {
  apiPost,
  createTestRoom,
  openRealtime,
  startServer,
  type TestRealtime,
  type TestRoom,
  type TestServer,
} from "./helpers.ts";

const TRANSIENT = "REFINE-TRANSIENT-PAGE-MARKER";

describe("continuous refinement over the API", () => {
  let server: TestServer;
  let room: TestRoom;
  let realtime: TestRealtime;

  beforeAll(async () => {
    server = await startServer({
      entrypoint: "tests/api/fixtures/refine-server.ts",
      env: {
        ENRICH_NETWORK: "1",
        INFER: "1",
        REFINE: "1",
        REFINE_SEARCH_MODE: "split",
        REFINE_TICK_MS: "500",
        REFINE_IDLE_STOP_MS: "200",
        OPENAI_API_KEY: "test",
      },
    });
    room = await createTestRoom(server.baseUrl);
    await room.pool.query("UPDATE rooms SET area_id = 'berlin-mitte' WHERE id = $1", [room.roomId]);
    const candidates = (await room.pool.query(
      "SELECT id, name FROM candidates WHERE room_id = $1 ORDER BY name",
      [room.roomId],
    )).rows as Array<{ id: string; name: string }>;
    for (const [index, candidate] of candidates.entries()) {
      await room.pool.query(
        `UPDATE candidates
            SET osm_ref = $2,
                extras = $3::jsonb,
                attributes = '[]'::jsonb,
                walk_min = $4
          WHERE id = $1`,
        [
          candidate.id,
          `refine/${room.roomId}/${candidate.name.toLowerCase()}`,
          JSON.stringify({ website: `https://${candidate.name.toLowerCase()}.example` }),
          index + 1,
        ],
      );
    }
    await room.pool.query(
      `INSERT INTO requirements
         (id, room_id, owner_id, visibility, hardness, delegation, payload, active)
       VALUES ($1, $2, $3, 'shared', 'hard', '{}', $4, true)`,
      [
        `need_refine_${room.roomId}`,
        room.roomId,
        room.participantIds.org,
        JSON.stringify({ kind: "text", text: "free wifi" }),
      ],
    );
    realtime = await openRealtime(server.baseUrl, room.tokens.org);
  });

  afterAll(async () => {
    realtime?.close();
    await room?.pool.query("DELETE FROM enrichments WHERE osm_ref LIKE $1", [
      `refine/${room.roomId}/%`,
    ]);
    await room?.cleanup();
    await server?.stop();
  });

  it("fills two cited likely facts, abstains on one, and drains the queue", async () => {
    const initial = await context();
    expect(initial.refine).toMatchObject({ active: true, queued: 3, checkedToday: 0 });

    const key = questionKey("free wifi");
    await waitFor(async () => {
      const rows = (await room.pool.query(
        "SELECT inferred FROM enrichments WHERE osm_ref LIKE $1",
        [`refine/${room.roomId}/%`],
      )).rows as Array<{ inferred: Record<string, { lean?: string }> }>;
      return rows.filter((row) => row.inferred?.[key]?.lean === "yes").length === 2;
    });

    const rows = (await room.pool.query(
      `SELECT e.osm_ref, e.inferred, row_to_json(e)::text AS serialized
         FROM enrichments e WHERE e.osm_ref LIKE $1 ORDER BY e.osm_ref`,
      [`refine/${room.roomId}/%`],
    )).rows as Array<{
      osm_ref: string;
      inferred: Record<string, Record<string, unknown>>;
      serialized: string;
    }>;
    expect(rows.filter((row) => row.inferred[key]?.lean === "yes")).toHaveLength(2);
    for (const row of rows.filter((candidate) => !candidate.osm_ref.endsWith("/gamma"))) {
      expect(row.inferred[key]).toMatchObject({
        lean: "yes",
        sourceUrl: expect.stringMatching(/^https:\/\/(alpha|beta)\.example\/connectivity$/),
      });
    }
    expect(rows.find((row) => row.osm_ref.endsWith("/gamma"))?.inferred[key])
      .toMatchObject({ omitted: true });
    for (const row of rows) expect(row.serialized).not.toContain(TRANSIENT);

    await waitFor(async () => (await context()).refine.queued === 0, 8_000);
    expect((await context()).refine).toMatchObject({ queued: 0, checkedToday: 3 });
    const lookupFrames = realtime.frames().map((raw) => JSON.parse(raw) as {
      type: string;
      pending?: string[];
      reason?: { kind?: string; label?: string };
    }).filter((frame) => frame.type === "lookups" && Boolean(frame.pending?.length));
    expect(lookupFrames.some((frame) => frame.reason?.kind === "refine")).toBe(true);
    expect(lookupFrames.some((frame) => frame.reason?.label === "free wifi")).toBe(true);

    realtime.close();
    await waitFor(async () => !(await context()).refine.active, 2_000);
    expect((await context()).refine.active).toBe(false);
  });

  async function context(): Promise<{
    refine: { active: boolean; queued: number; checkedToday: number };
  }> {
    const response = await apiPost<{
      refine: { active: boolean; queued: number; checkedToday: number };
    }>(server.baseUrl, "/api/spatial/context", room.tokens.org, {});
    return response.body;
  }
});

describe("combined continuous refinement over the API", () => {
  let server: TestServer;
  let room: TestRoom;
  let realtime: TestRealtime;

  beforeAll(async () => {
    server = await startServer({
      entrypoint: "tests/api/fixtures/refine-server.ts",
      env: {
        ENRICH_NETWORK: "1",
        INFER: "1",
        REFINE: "1",
        REFINE_SEARCH_MODE: "combined",
        REFINE_TICK_MS: "500",
        REFINE_IDLE_STOP_MS: "200",
        OPENAI_API_KEY: "test",
      },
    });
    room = await createTestRoom(server.baseUrl);
    await room.pool.query("UPDATE rooms SET area_id = 'berlin-mitte' WHERE id = $1", [room.roomId]);
    const candidates = (await room.pool.query(
      "SELECT id, name FROM candidates WHERE room_id = $1 ORDER BY name",
      [room.roomId],
    )).rows as Array<{ id: string; name: string }>;
    for (const [index, candidate] of candidates.entries()) {
      await room.pool.query(
        `UPDATE candidates
            SET osm_ref = $2,
                extras = $3::jsonb,
                attributes = '[]'::jsonb,
                walk_min = $4
          WHERE id = $1`,
        [
          candidate.id,
          `refine-combined/${room.roomId}/${candidate.name.toLowerCase()}`,
          JSON.stringify({ website: `https://${candidate.name.toLowerCase()}.example` }),
          index + 1,
        ],
      );
    }
    await room.pool.query(
      `INSERT INTO requirements
         (id, room_id, owner_id, visibility, hardness, delegation, payload, active)
       VALUES ($1, $2, $3, 'shared', 'hard', '{}', $4, true)`,
      [
        `need_refine_combined_${room.roomId}`,
        room.roomId,
        room.participantIds.org,
        JSON.stringify({ kind: "text", text: "free wifi" }),
      ],
    );
    realtime = await openRealtime(server.baseUrl, room.tokens.org);
  });

  afterAll(async () => {
    realtime?.close();
    await room?.pool.query("DELETE FROM enrichments WHERE osm_ref LIKE $1", [
      `refine-combined/${room.roomId}/%`,
    ]);
    await room?.cleanup();
    await server?.stop();
  });

  it("stores cited claims with exactly one combined call per unresolved place", async () => {
    const key = questionKey("free wifi");
    await waitFor(async () => {
      const rows = (await room.pool.query(
        "SELECT inferred FROM enrichments WHERE osm_ref LIKE $1",
        [`refine-combined/${room.roomId}/%`],
      )).rows as Array<{ inferred: Record<string, { lean?: string }> }>;
      return rows.filter((row) => row.inferred?.[key]?.lean === "yes").length === 2;
    });
    const rows = (await room.pool.query(
      "SELECT inferred FROM enrichments WHERE osm_ref LIKE $1 ORDER BY osm_ref",
      [`refine-combined/${room.roomId}/%`],
    )).rows as Array<{ inferred: Record<string, Record<string, unknown>> }>;
    expect(rows.filter((row) => row.inferred[key]?.lean === "yes")).toHaveLength(2);
    for (const row of rows.filter((candidate) => candidate.inferred[key]?.lean === "yes")) {
      expect(row.inferred[key]).toMatchObject({
        sourceUrl: expect.stringMatching(/^https:\/\/(alpha|beta)\.example\/connectivity$/),
      });
    }
    await waitFor(() => (server.logs().match(/combined refinement call/g) ?? []).length === 3);
    expect(server.logs().match(/combined refinement call/g)).toHaveLength(3);
  });
});

async function waitFor(check: () => Promise<boolean> | boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect(await check()).toBe(true);
}
