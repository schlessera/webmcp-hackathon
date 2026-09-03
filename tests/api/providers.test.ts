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
      // Sized to this batch's category count, not to the provider maximum.
      limit: 600,
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

describe("listing matching over a real-shaped fixture", () => {
  let server: TestServer;
  let room: TestRoom;
  const named = [
    // name in the map            // title the provider returns
    ["Cafe Nenom", "Café Nénom"],                    // diacritics only
    ["Gentle", "Gentle Restaurant"],                 // class-word suffix
    ["Schnitzelei", "Schnitzelei Mitte"],            // district suffix
    ["Weinstube Sued", "Weinstube Süd GmbH"],        // sharp-s form and legal form
    ["Ryce", "RYCE - Kitchen & Sushi Bar"],          // only the domain identifies it
    ["Kopenhagen", "Kopenhagen"],                    // same name, different site
  ] as const;

  beforeAll(async () => {
    server = await startServer();
    room = await createTestRoom(server.baseUrl);
    const rows = (await room.pool.query(
      "SELECT id, name FROM candidates WHERE room_id = $1", [room.roomId],
    )).rows as Array<{ id: string; name: string }>;
    // Reuse the three seeded rows and add the rest, all at one coordinate.
    for (const [index, [mapName]] of named.entries()) {
      const id = rows[index]?.id ?? `place_x${index}_${room.roomId}`;
      if (rows[index]) {
        await room.pool.query(
          `UPDATE candidates SET name = $2, osm_ref = $3, location = '{"lat":52.5,"lng":13.4}'::jsonb,
                  extras = $4::jsonb, attributes = '[]'::jsonb WHERE id = $1`,
          [id, mapName, `node/match-${index}`, JSON.stringify(
            mapName === "Ryce" ? { website: "https://ryce.example/" }
              : mapName === "Kopenhagen" ? { website: "https://kopenhagen-mine.example/" }
              : {},
          )],
        );
      } else {
        await room.pool.query(
          `INSERT INTO candidates (id, room_id, name, category, price_level, walk_min, location, attributes, osm_ref, extras)
           VALUES ($1, $2, $3, 'cafe', 2, 5, '{"lat":52.5,"lng":13.4}', '[]'::jsonb, $4, $5::jsonb)`,
          [id, room.roomId, mapName, `node/match-${index}`, JSON.stringify(
            mapName === "Ryce" ? { website: "https://ryce.example/" }
              : mapName === "Kopenhagen" ? { website: "https://kopenhagen-mine.example/" }
              : {},
          )],
        );
      }
    }
    await room.pool.query(
      `UPDATE rooms SET scope = $2::jsonb, scope_seq = 1 WHERE id = $1`,
      [room.roomId, JSON.stringify({
        scopeId: "match_scope_1",
        area: { kind: "circle", center: { lat: 52.5, lng: 13.4 }, radiusM: 800 },
        transport: ["walk"],
        category: "food",
      })],
    );
    process.env.ENRICH_NETWORK = "1";
    process.env.DATAFORSEO_LOGIN = "scripted-login";
    process.env.DATAFORSEO_PASSWORD = "scripted-password";
    delete process.env.LISTINGS;
    setListingFetch(async () => Response.json({
      tasks: [{
        status_code: 20_000,
        cost: 0.0142,
        result: [{
          items: named.map(([, title], index) => ({
            type: "business_listing",
            title,
            latitude: 52.5,
            longitude: 13.4,
            check_url: `https://www.google.com/maps?cid=90${index}`,
            ...(title.startsWith("RYCE") ? { domain: "ryce.example" } : {}),
            // Same name, a different site, 0 m away: the veto must refuse it.
            ...(title === "Kopenhagen" ? { domain: "kopenhagen-other.example" } : {}),
            attributes: { available_attributes: { amenities: ["has_wi_fi"] } },
          })),
        }],
      }],
    }));
  });

  afterAll(async () => {
    setListingFetch(null);
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await room?.pool.query(
      "DELETE FROM enrichments WHERE osm_ref LIKE 'node/match-%'",
    );
    await room?.cleanup();
    await server?.stop();
  });

  it("matches through diacritics, class and district suffixes, and the domain", async () => {
    const result = await refreshRoomListings(room.pool, room.roomId);
    expect(result).not.toBeNull();
    const byName = new Map((await room.pool.query(
      "SELECT name, osm_ref FROM candidates WHERE room_id = $1 AND osm_ref LIKE 'node/match-%'",
      [room.roomId],
    )).rows.map((row: { name: string; osm_ref: string }) => [row.name, row.osm_ref]));
    const matched = new Set(result!.matchedOsmRefs);
    expect(matched).toContain(byName.get("Cafe Nenom"));
    expect(matched).toContain(byName.get("Gentle"));
    expect(matched).toContain(byName.get("Schnitzelei"));
    expect(matched).toContain(byName.get("Weinstube Sued"));
    // Name similarity is far below threshold; only the shared domain identifies it.
    expect(matched).toContain(byName.get("Ryce"));
    // Identical name at zero metres, but the sites contradict each other.
    expect(matched).not.toContain(byName.get("Kopenhagen"));
    expect(result!.diagnostics).toEqual({
      matched: 5,
      unmatchedByReason: { distance: 0, name: 0, domain: 1, category: 0 },
    });
  });
});

describe("a real ref-bearing Berlin pool", () => {
  let server: TestServer;
  let room: TestRoom;
  let sent: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    server = await startServer();
    room = await createTestRoom(server.baseUrl, { berlin: true, withOsmRefs: true });
    process.env.ENRICH_NETWORK = "1";
    process.env.DATAFORSEO_LOGIN = "scripted-login";
    process.env.DATAFORSEO_PASSWORD = "scripted-password";
    delete process.env.LISTINGS;
    setListingFetch(async (_url, init) => {
      const body = (JSON.parse(String(init?.body)) as Array<Record<string, unknown>>)[0];
      sent.push(body);
      const categories = (body.categories ?? []) as string[];
      // Answer only the batch that asks for restaurants, and only for two of
      // the pool's real places, so the miss reasons are all exercised at once.
      const items = categories.includes("restaurant")
        ? [
            {
              type: "business_listing", title: "Grill Royal",
              latitude: 52.5225633, longitude: 13.3884395,
              check_url: "https://www.google.com/maps?cid=201",
              attributes: { available_attributes: { crowd: ["welcomes_dogs"] } },
            },
            {
              type: "business_listing", title: "Peter Pane Friedrichstrasse",
              latitude: 52.5208138, longitude: 13.3884622,
              url: "https://peterpane.example/", domain: "peterpane.example",
              check_url: "https://www.google.com/maps?cid=202",
              attributes: { unavailable_attributes: { amenities: ["has_wi_fi"] } },
            },
          ]
        : [];
      return Response.json({ tasks: [{ status_code: 20_000, cost: 0.012 + 0.00036 * items.length, result: [{ items }] }] });
    });
  });

  afterAll(async () => {
    setListingFetch(null);
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await room?.pool.query(
      `DELETE FROM enrichments WHERE osm_ref IN (
         SELECT osm_ref FROM candidates WHERE room_id = $1 AND osm_ref IS NOT NULL)`,
      [room.roomId],
    );
    await room?.cleanup();
    await server?.stop();
  });

  it("joins on the pool's real osm_refs and reports every miss reason", async () => {
    const refs = (await room.pool.query(
      "SELECT count(*)::int AS n FROM candidates WHERE room_id = $1 AND osm_ref IS NOT NULL",
      [room.roomId],
    )).rows[0] as { n: number };
    // The opt-in is what makes this pool joinable at all.
    expect(refs.n).toBe(31);

    const result = await refreshRoomListings(room.pool, room.roomId);
    expect(result).not.toBeNull();

    // Every class this pool holds fits inside the request cap, so nothing is
    // missed for want of asking.
    expect(result!.diagnostics.unmatchedByReason.category).toBe(0);
    expect(result!.diagnostics.matched).toBe(2);
    const total = result!.diagnostics.matched +
      Object.values(result!.diagnostics.unmatchedByReason).reduce((sum, n) => sum + n, 0);
    expect(total).toBe(refs.n);

    // The claims landed against the fixture's own OSM refs, not synthetic ones.
    const stored = (await room.pool.query(
      `SELECT c.name, e.listing->>'sourceUrl' AS source_url
         FROM enrichments e JOIN candidates c ON c.osm_ref = e.osm_ref
        WHERE c.room_id = $1 ORDER BY c.name`,
      [room.roomId],
    )).rows as Array<{ name: string; source_url: string }>;
    expect(stored.map((row) => row.name)).toEqual(["Grill Royal", "Peter Pane"]);
    expect(stored[0].source_url).toBe("https://www.google.com/maps?cid=201");
    // A branch suffix on the listing side still joins to the map's short name.
    expect(stored[1].source_url).toBe("https://www.google.com/maps?cid=202");
  });

  it("sizes each request's limit to its category batch, never above the maximum", () => {
    expect(sent.length).toBeGreaterThan(1);
    for (const body of sent) {
      const categories = (body.categories ?? []) as string[];
      expect(body.limit).toBe(Math.max(31, categories.length * 100));
      expect(body.limit as number).toBeLessThanOrEqual(1_000);
      // The scope radius is 800 m, below the provider's one-kilometre floor.
      expect(body.location_coordinate).toBe("52.5219000,13.3899000,1");
    }
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
      // The tick line is written after the tick finishes, so waiting only for
      // the rows leaves the assertions racing it.
      if (count === 2 && server.logs().includes('"searchProvider":"parallel"')) break;
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
