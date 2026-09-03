import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiPost, createTestRoom, startServer, type TestRoom, type TestServer } from "./helpers.ts";

let server: TestServer;
let room: TestRoom;
let otherRoom: TestRoom;
let candidateId: string;
let warmCandidateId: string;
let flagCandidateId: string;
let osmRef: string;
let warmOsmRef: string;
let flagOsmRef: string;

beforeAll(async () => {
  server = await startServer({
    entrypoint: "tests/api/fixtures/images-server.ts",
    env: { ENRICH_NETWORK: "1", INFER: "0", OPENAI_API_KEY: "test-key" },
  });
  room = await createTestRoom(server.baseUrl);
  otherRoom = await createTestRoom(server.baseUrl);
  candidateId = `place_a_${room.roomId.slice("room_test_".length)}`;
  warmCandidateId = `place_b_${room.roomId.slice("room_test_".length)}`;
  flagCandidateId = `place_c_${room.roomId.slice("room_test_".length)}`;
  osmRef = `node/image-${room.roomId}`;
  warmOsmRef = `node/warm-image-${room.roomId}`;
  flagOsmRef = `node/flag-image-${room.roomId}`;
  await room.pool.query("DELETE FROM place_image_verdicts WHERE url_hash = $1", [
    createHash("sha256").update("https://93.184.216.34/photo.png").digest("hex"),
  ]);
  await room.pool.query(
    "UPDATE candidates SET osm_ref = $2, extras = $3::jsonb WHERE id = $1",
    [candidateId, osmRef, JSON.stringify({ website: "https://93.184.216.34/cold" })],
  );
  await room.pool.query(
    "UPDATE candidates SET osm_ref = $2, extras = $3::jsonb WHERE id = $1",
    [flagCandidateId, flagOsmRef, JSON.stringify({ website: "https://93.184.216.34/flag" })],
  );
  await room.pool.query(
    "UPDATE candidates SET osm_ref = $2, extras = $3::jsonb WHERE id = $1",
    [warmCandidateId, warmOsmRef, JSON.stringify({ website: "https://93.184.216.34/warm" })],
  );
  await room.pool.query(
    `INSERT INTO enrichments
       (osm_ref, fetched_at, expires_at, website,
        website_status, website_fetched_at, website_expires_at,
        image_fetched_at, image_expires_at)
     VALUES ($1, now(), now() + interval '7 days', $2, 'ok', now(),
             now() + interval '7 days', now() - interval '8 days', now() - interval '1 day')`,
    [warmOsmRef, JSON.stringify({
      url: "https://93.184.216.34/warm",
      host: "93.184.216.34",
      fetchedAt: new Date().toISOString(),
      types: [],
    })],
  );
});

afterAll(async () => {
  await room.pool.query("DELETE FROM place_images WHERE osm_ref = ANY($1)", [[osmRef, warmOsmRef, flagOsmRef]]);
  await room.pool.query("DELETE FROM enrichments WHERE osm_ref = ANY($1)", [[osmRef, warmOsmRef, flagOsmRef]]);
  await room.pool.query("DELETE FROM place_image_verdicts WHERE url_hash = $1", [
    createHash("sha256").update("https://93.184.216.34/photo.png").digest("hex"),
  ]);
  await room.cleanup();
  await otherRoom.cleanup();
  await server.stop();
});

describe("place images API", () => {
  it("lists a local image in the dossier and serves authenticated WebP with a strong ETag", async () => {
    const inspect = await apiPost<{
      ok: boolean;
      candidates: Array<{ images?: Array<{ url: string; source: string }> }>;
    }>(server.baseUrl, "/api/spatial/inspect", room.tokens.org, { candidateIds: [candidateId] });
    expect(inspect.body.ok).toBe(true);
    expect(inspect.body.candidates[0].images).toEqual([
      expect.objectContaining({
        url: `/api/places/${osmRef}/images/0`,
        source: "web:93.184.216.34",
      }),
    ]);
    expect(server.logs().match(/image-fixture model-call/g) ?? []).toHaveLength(1);

    const stored = (
      await room.pool.query("SELECT website FROM enrichments WHERE osm_ref = $1", [osmRef])
    ).rows[0].website;
    expect(stored).not.toHaveProperty("imageCandidates");

    const context = await apiPost<{
      candidates: Array<{ candidateId: string; imageCount?: number }>;
    }>(server.baseUrl, "/api/spatial/context", room.tokens.org, {});
    expect(context.body.candidates.find((candidate) => candidate.candidateId === candidateId)?.imageCount).toBe(1);

    const url = `${server.baseUrl}${inspect.body.candidates[0].images![0].url}`;
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${room.tokens.sarah}` },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("image/webp");
    expect(response.headers.get("cache-control")).toBe("public, max-age=86400");
    const etag = response.headers.get("etag");
    expect(etag).toMatch(/^"[A-Za-z0-9_-]+"$/);
    expect(Buffer.from(await response.arrayBuffer()).subarray(8, 12).toString()).toBe("WEBP");

    const unchanged = await fetch(url, {
      headers: {
        // Images carry no room state: a valid participant from another room
        // can use the same immutable cache route.
        authorization: `Bearer ${otherRoom.tokens.joe}`,
        "if-none-match": etag!,
      },
    });
    expect(unchanged.status).toBe(304);
    expect(await unchanged.text()).toBe("");

    expect((await fetch(url)).status).toBe(401);
  });

  it("stores nothing when the homepage's only declared image is a flag", async () => {
    const inspect = await apiPost<{
      ok: boolean;
      candidates: Array<{ images?: unknown[] }>;
    }>(server.baseUrl, "/api/spatial/inspect", room.tokens.org, {
      candidateIds: [flagCandidateId],
    });
    expect(inspect.body.ok).toBe(true);
    expect(inspect.body.candidates[0].images).toBeUndefined();
    expect((await room.pool.query(
      "SELECT count(*)::int AS count FROM place_images WHERE osm_ref = $1",
      [flagOsmRef],
    )).rows[0].count).toBe(0);
    expect(server.logs()).not.toContain("image-get /flag-en.png");
  });

  it("uses an accepted verdict and the live local copy without a second model call or download", async () => {
    await room.pool.query(
      "UPDATE enrichments SET image_fetched_at = now() - interval '8 days', image_expires_at = now() - interval '1 second' WHERE osm_ref = $1",
      [osmRef],
    );
    const before = server.logs();
    const inspect = await apiPost<{
      ok: boolean;
      candidates: Array<{ images?: unknown[] }>;
    }>(server.baseUrl, "/api/spatial/inspect", room.tokens.org, {
      candidateIds: [candidateId],
    });
    expect(inspect.body.candidates[0].images).toHaveLength(1);
    const after = server.logs().slice(before.length);
    expect(after).not.toContain("image-fixture model-call");
    expect(after).not.toContain("image-fixture image-get");
  });

  it("harvests a warm site's homepage once per image refresh TTL", async () => {
    const inspect = () => apiPost<{
      ok: boolean;
      candidates: Array<{ images?: Array<{ url: string; source: string }> }>;
    }>(server.baseUrl, "/api/spatial/inspect", room.tokens.org, {
      candidateIds: [warmCandidateId],
    });

    const first = await inspect();
    expect(first.body.candidates[0].images).toEqual([
      expect.objectContaining({
        url: `/api/places/${warmOsmRef}/images/0`,
        source: "web:93.184.216.34",
      }),
    ]);
    await inspect();
    expect(server.logs().match(/image-fixture homepage-get \/warm/g) ?? []).toHaveLength(1);
  });
});
