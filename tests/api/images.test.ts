import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Participant } from "../../apps/server/src/auth.ts";
import { runAgent } from "../../apps/server/src/nl/agent.ts";
import { setTransport } from "../../apps/server/src/nl/openai.ts";
import {
  apiPost,
  createTestRoom,
  openRealtime,
  startServer,
  type TestRoom,
  type TestServer,
} from "./helpers.ts";

let server: TestServer;
let room: TestRoom;
let otherRoom: TestRoom;
let candidateId: string;
let warmCandidateId: string;
let flagCandidateId: string;
let osmRef: string;
let warmOsmRef: string;
let flagOsmRef: string;
let lowCandidateId: string;
let lowOsmRef: string;

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
  lowCandidateId = (await otherRoom.pool.query(
    "SELECT id FROM candidates WHERE room_id = $1 AND name = 'Alpha'",
    [otherRoom.roomId],
  )).rows[0].id;
  lowOsmRef = `node/page-low-${otherRoom.roomId}`;
  await room.pool.query("DELETE FROM place_image_verdicts WHERE url_hash = ANY($1)", [[
    "https://93.184.216.34/photo.png",
    "https://93.184.216.34/page-photo.png",
    "https://93.184.216.34/low-photo.png",
  ].map((url) => createHash("sha256").update(url).digest("hex"))]);
  await room.pool.query(
    "UPDATE candidates SET osm_ref = $2, extras = $3::jsonb WHERE id = $1",
    [candidateId, osmRef, JSON.stringify({ website: "https://93.184.216.34/cold" })],
  );
  await otherRoom.pool.query(
    "UPDATE candidates SET name = 'Page Low', osm_ref = $2, extras = $3::jsonb WHERE id = $1",
    [lowCandidateId, lowOsmRef, JSON.stringify({ website: "https://93.184.216.34/page-low" })],
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

afterEach(() => setTransport(null));

afterAll(async () => {
  const refs = [osmRef, warmOsmRef, flagOsmRef, lowOsmRef];
  await room.pool.query("DELETE FROM place_images WHERE osm_ref = ANY($1)", [refs]);
  await room.pool.query("DELETE FROM enrichments WHERE osm_ref = ANY($1)", [refs]);
  await room.pool.query("DELETE FROM place_image_verdicts WHERE url_hash = ANY($1)", [[
    "https://93.184.216.34/photo.png",
    "https://93.184.216.34/page-photo.png",
    "https://93.184.216.34/low-photo.png",
  ].map((url) => createHash("sha256").update(url).digest("hex"))]);
  await room.cleanup();
  await otherRoom.cleanup();
  await server.stop();
});

describe("place images API", () => {
  it("lists a local image in the dossier and serves authenticated WebP with a strong ETag", async () => {
    const realtime = await openRealtime(server.baseUrl, room.tokens.org);
    const inspect = await apiPost<{
      ok: boolean;
      candidates: Array<{ images?: Array<{
        url: string;
        width: number;
        height: number;
        blurhash?: string;
        source: string;
      }> }>;
    }>(server.baseUrl, "/api/spatial/inspect", room.tokens.org, { candidateIds: [candidateId] });
    expect(inspect.body.ok).toBe(true);
    expect(inspect.body.candidates[0].images).toEqual([
      expect.objectContaining({
        url: `/api/places/${osmRef}/images/0`,
        width: 640,
        height: 480,
        blurhash: expect.any(String),
        source: "web:93.184.216.34",
      }),
    ]);
    expect(server.logs().match(/image-fixture model-call/g) ?? []).toHaveLength(1);
    await expect.poll(() => realtime.frames().some((raw) => {
      const frame = JSON.parse(raw) as { type?: string; candidateIds?: string[] };
      return frame.type === "facts" && frame.candidateIds?.includes(candidateId);
    })).toBe(true);
    realtime.close();

    const stored = (
      await room.pool.query("SELECT website FROM enrichments WHERE osm_ref = $1", [osmRef])
    ).rows[0].website;
    expect(stored).not.toHaveProperty("imageCandidates");

    const context = await apiPost<{
      candidates: Array<{
        candidateId: string;
        imageCount?: number;
        image?: { url: string; width: number; height: number; blurhash: string };
      }>;
    }>(server.baseUrl, "/api/spatial/context", room.tokens.org, {});
    const summary = context.body.candidates.find((candidate) => candidate.candidateId === candidateId);
    expect(summary).toMatchObject({
      imageCount: 1,
      image: {
        url: `/api/places/${osmRef}/images/0`,
        width: 640,
        height: 480,
        blurhash: inspect.body.candidates[0].images![0].blurhash,
      },
    });
    const noImage = context.body.candidates.find((candidate) =>
      candidate.candidateId === warmCandidateId
    );
    expect(noImage).not.toHaveProperty("image");

    const savedHash = inspect.body.candidates[0].images![0].blurhash!;
    await room.pool.query("UPDATE place_images SET blurhash = NULL WHERE osm_ref = $1", [osmRef]);
    const nullHashContext = await apiPost<{
      candidates: Array<{ candidateId: string; imageCount?: number; image?: unknown }>;
    }>(server.baseUrl, "/api/spatial/context", room.tokens.org, {});
    const nullHashSummary = nullHashContext.body.candidates.find((candidate) =>
      candidate.candidateId === candidateId
    );
    expect(nullHashSummary).toMatchObject({ imageCount: 1 });
    expect(nullHashSummary).not.toHaveProperty("image");
    await room.pool.query(
      "UPDATE place_images SET blurhash = $2 WHERE osm_ref = $1",
      [osmRef, savedHash],
    );

    let agentSnapshot = "";
    setTransport(async (body) => {
      agentSnapshot = String((body.input as Array<{ content?: unknown }>)[0]?.content ?? "");
      return {
        output: [{ type: "message", content: [{ type: "output_text", text: "One place has a photo." }] }],
      };
    });
    const actor: Participant = {
      id: room.participantIds.org,
      roomId: room.roomId,
      displayName: "Alex",
      role: "organizer",
      readyState: "contributing",
    };
    await runAgent(actor, "Which places have photos?", null);
    const snapshot = JSON.parse(agentSnapshot.slice(agentSnapshot.indexOf("{") )) as {
      places: Array<{ candidateId: string; imageCount: number; image?: unknown }>;
    };
    expect(snapshot.places.find((place) => place.candidateId === candidateId)).toMatchObject({
      imageCount: 1,
    });
    expect(snapshot.places.every((place) => !("image" in place))).toBe(true);

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
        source: "web:page-image:93.184.216.34",
      }),
    ]);
    await inspect();
    expect(server.logs().match(/image-fixture homepage-get \/warm/g) ?? []).toHaveLength(1);
  });

  it("rejects a classifier-only page image at 0.65 and lists no dossier image", async () => {
    const inspect = await apiPost<{
      ok: boolean;
      candidates: Array<{ images?: unknown[] }>;
    }>(server.baseUrl, "/api/spatial/inspect", otherRoom.tokens.org, {
      candidateIds: [lowCandidateId],
    });
    expect(inspect.body.ok).toBe(true);
    expect(inspect.body.candidates[0].images).toBeUndefined();
    expect((await otherRoom.pool.query(
      "SELECT count(*)::int AS count FROM place_images WHERE osm_ref = $1",
      [lowOsmRef],
    )).rows[0].count).toBe(0);
  });
});
