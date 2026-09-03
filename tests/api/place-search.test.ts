import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { DATABASE_URL, apiPost, startServer, type TestServer } from "./helpers.ts";

/**
 * The map's find box and its orientation layer, over HTTP: both read the
 * room's own area snapshot in process, and both are behind the room's token.
 */

let server: TestServer;
const database = new pg.Pool({ connectionString: DATABASE_URL });
const created: string[] = [];

async function plainPost(path: string, body: unknown) {
  const response = await fetch(`${server.baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function get(path: string, token?: string) {
  const response = await fetch(`${server.baseUrl}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

interface FoundPlace {
  ref: string;
  name: string;
  category: string;
  location: { lat: number; lng: number };
  candidateId?: string;
}

async function openRoom() {
  const opened = await plainPost("/api/rooms", {
    areaId: "berlin-mitte",
    organizerName: "Alex",
    memberNames: ["Sarah"],
  });
  expect(opened.status).toBe(200);
  const roomId = opened.body.roomId as string;
  created.push(roomId);
  const invites = opened.body.invites as Array<{ displayName: string; inviteSecret: string }>;
  const exchange = async (name: string) =>
    (await plainPost("/api/session/exchange", {
      inviteSecret: invites.find((invite) => invite.displayName === name)!.inviteSecret,
    })).body.participantToken as string;
  return { roomId, organizerToken: await exchange("Alex"), memberToken: await exchange("Sarah") };
}

beforeAll(async () => {
  server = await startServer();
});

afterAll(async () => {
  for (const roomId of created) {
    for (const table of [
      "stances", "proposals", "verdicts", "requirements", "adjustments",
      "arrival_plans", "attestations", "events", "candidates", "invite_secrets",
    ]) {
      await database.query(`DELETE FROM ${table} WHERE room_id = $1`, [roomId]);
    }
    await database.query(
      `DELETE FROM participant_tokens WHERE participant_id IN
         (SELECT id FROM participants WHERE room_id = $1)`,
      [roomId],
    );
    await database.query("DELETE FROM participants WHERE room_id = $1", [roomId]);
    await database.query("DELETE FROM rooms WHERE id = $1", [roomId]);
  }
  await database.end();
  await server.stop();
});

describe("finding a place by name", () => {
  it("needs the room's own token", async () => {
    const { roomId } = await openRoom();
    expect((await get(`/api/rooms/${roomId}/places/search?q=cafe`)).status).toBe(401);
  });

  it("rejects an empty or oversized query rather than scanning for it", async () => {
    const { roomId, memberToken } = await openRoom();
    expect((await get(`/api/rooms/${roomId}/places/search?q=`, memberToken)).status).toBe(400);
    expect((await get(`/api/rooms/${roomId}/places/search`, memberToken)).status).toBe(400);
    const long = "a".repeat(101);
    expect((await get(`/api/rooms/${roomId}/places/search?q=${long}`, memberToken)).status)
      .toBe(400);
  });

  it("answers with places from the room's area, ranked towards where the viewer looks", async () => {
    const { roomId, memberToken } = await openRoom();
    const found = await get(`/api/rooms/${roomId}/places/search?q=cafe`, memberToken);
    expect(found.status).toBe(200);
    const places = found.body.places as FoundPlace[];
    expect(places.length).toBeGreaterThan(0);
    expect(places.length).toBeLessThanOrEqual(8);
    for (const place of places) {
      expect(place.ref).toMatch(/^(node|way|relation)\//);
      expect(place.name.toLowerCase()).toContain("caf");
      expect(place.category.length).toBeGreaterThan(0);
    }

    const near = places[places.length - 1].location;
    const biased = await get(
      `/api/rooms/${roomId}/places/search?q=cafe&near=${near.lat},${near.lng}`,
      memberToken,
    );
    expect(biased.status).toBe(200);
    expect((biased.body.places as FoundPlace[]).length).toBeGreaterThan(0);
  });

  it("names the room's own row when the place found is already in it", async () => {
    const { roomId, organizerToken } = await openRoom();
    const seeded = (
      await database.query(
        "SELECT name FROM candidates WHERE room_id = $1 AND osm_ref IS NOT NULL LIMIT 1",
        [roomId],
      )
    ).rows[0] as { name: string } | undefined;
    expect(seeded).toBeDefined();
    const found = await get(
      `/api/rooms/${roomId}/places/search?q=${encodeURIComponent(seeded!.name)}`,
      organizerToken,
    );
    const match = (found.body.places as FoundPlace[]).find((place) => place.name === seeded!.name);
    expect(match?.candidateId).toBeDefined();
  });

  it("finds a place through an accent and a typo the person did not mean", async () => {
    const { roomId, memberToken } = await openRoom();
    const exact = await get(
      `/api/rooms/${roomId}/places/search?q=${encodeURIComponent("Café Cinema")}`,
      memberToken,
    );
    const target = (exact.body.places as FoundPlace[])[0];
    expect(target?.name).toBe("Café Cinema");

    for (const typed of ["cafe cinema", "cafe cinena"]) {
      const found = await get(
        `/api/rooms/${roomId}/places/search?q=${encodeURIComponent(typed)}`,
        memberToken,
      );
      expect((found.body.places as FoundPlace[]).map((place) => place.ref)).toContain(target.ref);
    }
  });

  it("says nothing rather than something when no place goes by the name", async () => {
    const { roomId, memberToken } = await openRoom();
    const found = await get(
      `/api/rooms/${roomId}/places/search?q=xylophonic%20tabernacle`,
      memberToken,
    );
    expect(found.status).toBe(200);
    expect(found.body.places).toEqual([]);
    expect(found.body.truncated).toBe(false);
  });
});

describe("the landmarks in view", () => {
  it("needs the room's own token and a valid box", async () => {
    const { roomId, memberToken } = await openRoom();
    expect((await get(`/api/rooms/${roomId}/landmarks?bbox=52.51,13.37,52.53,13.41`)).status)
      .toBe(401);
    expect((await get(`/api/rooms/${roomId}/landmarks?bbox=52.53,13.41`, memberToken)).status)
      .toBe(400);
  });

  it("returns the area's landmarks inside the box, and none outside it", async () => {
    const { roomId, memberToken } = await openRoom();
    const box = [52.515, 13.37, 52.53, 13.41] as const;
    const inView = await get(
      `/api/rooms/${roomId}/landmarks?bbox=${box.join(",")}`,
      memberToken,
    );
    expect(inView.status).toBe(200);
    const landmarks = inView.body.landmarks as Array<{
      id: string;
      name: string;
      kind: string;
      kindLabel: string;
      location: { lat: number; lng: number };
    }>;
    expect(landmarks.length).toBeGreaterThan(0);
    expect(landmarks.length).toBeLessThanOrEqual(80);
    for (const landmark of landmarks) {
      expect(landmark.name.length).toBeGreaterThan(0);
      expect(landmark.location.lat).toBeGreaterThanOrEqual(box[0]);
      expect(landmark.location.lat).toBeLessThanOrEqual(box[2]);
      expect(landmark.location.lng).toBeGreaterThanOrEqual(box[1]);
      expect(landmark.location.lng).toBeLessThanOrEqual(box[3]);
    }

    const elsewhere = await get(
      `/api/rooms/${roomId}/landmarks?bbox=-40,-70,-39,-69`,
      memberToken,
    );
    expect(elsewhere.body.landmarks).toEqual([]);
  });
});

describe("another room's map reads", () => {
  it("are not readable with this room's token", async () => {
    const mine = await openRoom();
    const theirs = await openRoom();
    expect((await get(`/api/rooms/${theirs.roomId}/places/search?q=cafe`, mine.memberToken)).status)
      .toBe(404);
    expect(
      (await get(
        `/api/rooms/${theirs.roomId}/landmarks?bbox=52.515,13.37,52.53,13.41`,
        mine.memberToken,
      )).status,
    ).toBe(404);
    // The command bus stays the authority on writes; this only reads.
    const context = await apiPost(server.baseUrl, "/api/spatial/context", mine.memberToken, {});
    expect(context.status).toBe(200);
  });
});
