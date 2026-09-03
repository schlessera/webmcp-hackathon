import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiPost, createTestRoom, startServer, type TestRoom, type TestServer } from "./helpers.ts";

let server: TestServer;
let room: TestRoom;
let otherRoom: TestRoom;
let candidateId: string;
let osmRef: string;

beforeAll(async () => {
  server = await startServer({
    entrypoint: "tests/api/fixtures/images-server.ts",
    env: { ENRICH_NETWORK: "1", INFER: "0" },
  });
  room = await createTestRoom(server.baseUrl);
  otherRoom = await createTestRoom(server.baseUrl);
  candidateId = `place_a_${room.roomId.slice("room_test_".length)}`;
  osmRef = `node/image-${room.roomId}`;
  await room.pool.query(
    "UPDATE candidates SET osm_ref = $2, extras = $3::jsonb WHERE id = $1",
    [candidateId, osmRef, JSON.stringify({ website: "https://93.184.216.34/place" })],
  );
});

afterAll(async () => {
  await room.pool.query("DELETE FROM place_images WHERE osm_ref = $1", [osmRef]);
  await room.pool.query("DELETE FROM enrichments WHERE osm_ref = $1", [osmRef]);
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
        source: "website",
      }),
    ]);

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
});
