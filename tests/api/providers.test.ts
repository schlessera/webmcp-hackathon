import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { questionKey } from "@webmcp-hackathon/contracts";
import {
  refreshRoomListings,
} from "../../apps/server/src/enrich/index.ts";
import { setListingFetch } from "../../apps/server/src/enrich/listings.ts";
import {
  apiPost,
  createTestRoom,
  openRealtime,
  startServer,
  type TestRealtime,
  type TestRoom,
  type TestServer,
} from "./helpers.ts";

const oldEnv = {
  ENRICH_NETWORK: process.env.ENRICH_NETWORK,
  DATAFORSEO_LOGIN: process.env.DATAFORSEO_LOGIN,
  DATAFORSEO_PASSWORD: process.env.DATAFORSEO_PASSWORD,
  LISTINGS: process.env.LISTINGS,
};

describe("listing provider over API projections", () => {
  let server: TestServer;
  let room: TestRoom;
  let alphaId = "";
  let betaId = "";
  let calls = 0;
  const bodies: unknown[] = [];

  beforeAll(async () => {
    server = await startServer();
    room = await createTestRoom(server.baseUrl);
    const candidates = (await room.pool.query(
      "SELECT id, name FROM candidates WHERE room_id = $1 ORDER BY name",
      [room.roomId],
    )).rows as Array<{ id: string; name: string }>;
    alphaId = candidates.find((row) => row.name === "Alpha")!.id;
    betaId = candidates.find((row) => row.name === "Beta")!.id;
    await room.pool.query(
      `UPDATE rooms SET scope = $2::jsonb, scope_seq = 1 WHERE id = $1`,
      [room.roomId, JSON.stringify({
        scopeId: "scope_1",
        area: { kind: "circle", center: { lat: 52.5, lng: 13.4 }, radiusM: 800 },
        transport: ["walk"],
        category: "food",
      })],
    );
    await room.pool.query(
      `UPDATE candidates
          SET osm_ref = CASE name WHEN 'Alpha' THEN 'node/list-alpha' WHEN 'Beta' THEN 'node/list-beta' END,
              location = CASE name
                WHEN 'Alpha' THEN '{"lat":52.5,"lng":13.4}'::jsonb
                WHEN 'Beta' THEN '{"lat":52.5004,"lng":13.4}'::jsonb
                ELSE location END,
              extras = '{}'::jsonb,
              attributes = '[]'::jsonb
        WHERE room_id = $1 AND name IN ('Alpha', 'Beta')`,
      [room.roomId],
    );
    process.env.ENRICH_NETWORK = "1";
    process.env.DATAFORSEO_LOGIN = "scripted-login";
    process.env.DATAFORSEO_PASSWORD = "scripted-password";
    delete process.env.LISTINGS;
    setListingFetch(async (_url, init) => {
      calls += 1;
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({
        status_code: 20_000,
        cost: 0.01272,
        tasks: [{
          status_code: 20_000,
          cost: 0.01272,
          result: [{
            items: [
              {
                type: "business_listing",
                title: "Alpha",
                latitude: 52.5001,
                longitude: 13.4,
                url: "https://alpha-listing.example/",
                domain: "alpha-listing.example",
                check_url: "https://www.google.com/maps?cid=101",
                attributes: {
                  available_attributes: { amenities: ["has_wi_fi"] },
                  unavailable_attributes: { crowd: ["welcomes_dogs"] },
                },
                work_time: {
                  work_hours: {
                    timetable: {
                      monday: [{ open: { hour: 9, minute: 0 }, close: { hour: 18, minute: 0 } }],
                    },
                  },
                },
                rating: { value: 4.7, votes_count: 42, rating_max: 5 },
              },
              {
                type: "business_listing",
                title: "Beta",
                latitude: 52.5004,
                longitude: 13.4,
                check_url: "https://www.google.com/maps?cid=102",
                attributes: {
                  unavailable_attributes: { amenities: ["has_wi_fi"] },
                },
              },
            ],
          }],
        }],
      });
    });
  });

  afterAll(async () => {
    setListingFetch(null);
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await room?.pool.query("DELETE FROM enrichments WHERE osm_ref IN ('node/list-alpha', 'node/list-beta')");
    await room?.cleanup();
    await server?.stop();
  });

  it("projects cited likely true and false rows and discovers a missing website", async () => {
    const result = await refreshRoomListings(room.pool, room.roomId);
    expect(result).toMatchObject({ returnedItems: 2, costUsd: 0.01272 });
    expect(calls).toBe(1);
    expect(bodies[0]).toEqual([expect.objectContaining({
      location_coordinate: "52.5000000,13.4000000,1",
      limit: 1_000,
    })]);

    const inspected = await apiPost<{
      ok: boolean;
      candidates: Array<{
        candidateId: string;
        attributes: Array<Record<string, unknown>>;
        links?: Array<Record<string, unknown>>;
        rating?: Record<string, unknown>;
      }>;
    }>(server.baseUrl, "/api/spatial/inspect", room.tokens.org, {
      candidateIds: [alphaId, betaId],
    });
    expect(inspected.body.ok).toBe(true);
    const alpha = inspected.body.candidates.find((candidate) => candidate.candidateId === alphaId)!;
    const beta = inspected.body.candidates.find((candidate) => candidate.candidateId === betaId)!;
    expect(alpha.attributes.find((attribute) => attribute.key === "wifi")).toMatchObject({
      status: "likely_true",
      confidence: 0.65,
      source: "listing:google",
      sourceUrl: "https://www.google.com/maps?cid=101",
    });
    expect(alpha.attributes.find((attribute) => attribute.key === "dog-friendly")).toMatchObject({
      status: "likely_false",
      confidence: 0.65,
      source: "listing:google",
    });
    expect(alpha.links).toContainEqual(expect.objectContaining({
      kind: "website",
      url: "https://alpha-listing.example/",
      source: "listing:google",
    }));
    expect(alpha.rating).toMatchObject({ value: 4.7, label: "on Google", source: "listing:google" });
    expect(beta.attributes.find((attribute) => attribute.key === "wifi")).toMatchObject({
      status: "likely_false",
      sourceUrl: "https://www.google.com/maps?cid=102",
    });
  });

  it("enforces one fetch per room per day and grants one on scope change", async () => {
    expect(await refreshRoomListings(room.pool, room.roomId)).toBeNull();
    expect(calls).toBe(1);
    await room.pool.query(
      `UPDATE rooms SET scope = jsonb_set(scope, '{scopeId}', '"scope_2"') WHERE id = $1`,
      [room.roomId],
    );
    expect(await refreshRoomListings(room.pool, room.roomId)).not.toBeNull();
    expect(calls).toBe(2);
    process.env.LISTINGS = "0";
    expect(await refreshRoomListings(room.pool, room.roomId)).toBeNull();
    expect(calls).toBe(2);
    delete process.env.LISTINGS;
  });
});

describe("Parallel provider switch over the refinement API", () => {
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
        REFINE_TICK_MS: "300",
        REFINE_IDLE_STOP_MS: "200",
        OPENAI_API_KEY: "test",
        PARALLEL_API_KEY: "test",
        SEARCH_PROVIDER: "parallel",
        LISTINGS: "0",
      },
    });
    room = await createTestRoom(server.baseUrl);
    await room.pool.query("UPDATE rooms SET area_id = 'berlin-mitte' WHERE id = $1", [room.roomId]);
    const candidates = (await room.pool.query(
      "SELECT id, name FROM candidates WHERE room_id = $1 ORDER BY name",
      [room.roomId],
    )).rows as Array<{ id: string; name: string }>;
    for (const candidate of candidates) {
      await room.pool.query(
        `UPDATE candidates SET osm_ref = $2, extras = $3::jsonb, attributes = '[]'::jsonb WHERE id = $1`,
        [
          candidate.id,
          `parallel/${room.roomId}/${candidate.name.toLowerCase()}`,
          JSON.stringify({ website: `https://${candidate.name.toLowerCase()}.example` }),
        ],
      );
    }
    await room.pool.query(
      `INSERT INTO requirements
         (id, room_id, owner_id, visibility, hardness, delegation, payload, active)
       VALUES ($1, $2, $3, 'shared', 'hard', '{}', $4, true)`,
      [
        `need_parallel_${room.roomId}`,
        room.roomId,
        room.participantIds.org,
        JSON.stringify({ kind: "text", text: "free wifi" }),
      ],
    );
    realtime = await openRealtime(server.baseUrl, room.tokens.org);
  });

  afterAll(async () => {
    realtime?.close();
    await room?.pool.query("DELETE FROM enrichments WHERE osm_ref LIKE $1", [`parallel/${room.roomId}/%`]);
    await room?.cleanup();
    await server?.stop();
  });

  it("uses Parallel fast discovery and its fetched-page span", async () => {
    const key = questionKey("free wifi");
    const deadline = Date.now() + 8_000;
    for (;;) {
      const count = Number((await room.pool.query(
        `SELECT count(*) FROM enrichments
          WHERE osm_ref LIKE $1 AND inferred->$2->>'lean' = 'yes'`,
        [`parallel/${room.roomId}/%`, key],
      )).rows[0].count);
      if (count === 2) break;
      if (Date.now() >= deadline) throw new Error(`Parallel refinement did not settle:\n${server.logs()}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const logs = server.logs();
    expect(logs).toContain("parallel-search-request");
    expect(logs).toContain('"mode":"fast"');
    expect(logs).not.toContain("web-search-request");
    expect(logs).toContain('"searchProvider":"parallel"');
    expect(logs).toContain('"searches":3');
    expect(logs).toContain('"costUsd":0.003');
  });
});
