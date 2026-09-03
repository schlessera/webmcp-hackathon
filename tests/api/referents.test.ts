import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  apiPost,
  createTestRoom,
  startServer,
  type TestRoom,
  type TestServer,
} from "./helpers.ts";

let server: TestServer;
const rooms: TestRoom[] = [];

beforeAll(async () => {
  server = await startServer({ entrypoint: "tests/api/fixtures/referents-server.ts" });
});

afterAll(async () => {
  for (const room of rooms) await room.cleanup();
  await server.stop();
});

async function roomWithArea(): Promise<TestRoom> {
  const room = await createTestRoom(server.baseUrl);
  rooms.push(room);
  await room.pool.query(
    `UPDATE rooms SET area_id = 'berlin-mitte', scope = $2 WHERE id = $1`,
    [room.roomId, {
      scopeId: "scope_referents",
      area: { kind: "circle", center: { lat: 52.5, lng: 13.4 }, radiusM: 5000 },
      transport: ["walk"],
      category: "places",
    }],
  );
  await room.pool.query(
    `UPDATE candidates SET location = CASE name
      WHEN 'Alpha' THEN '{"lat":52.5,"lng":13.4}'::jsonb
      WHEN 'Beta' THEN '{"lat":52.503,"lng":13.4}'::jsonb
      ELSE '{"lat":52.501,"lng":13.4}'::jsonb END
      WHERE room_id = $1`,
    [room.roomId],
  );
  return room;
}

const command = (room: TestRoom, token: string, revision: number, requirementId: string, payload: object) =>
  apiPost<{ ok: boolean; revision: number }>(server.baseUrl, "/api/commands", token, {
    type: "SubmitRequirement",
    input: {
      baseRevision: revision,
      requirementId,
      visibility: "shared",
      hardness: "hard",
      delegation: { mode: "approval_required" },
      payload,
    },
  });

describe("distance referents over participant reads", () => {
  it("finds room-area landmarks and counts a landmark scope need", async () => {
    const room = await roomWithArea();
    const response = await fetch(`${server.baseUrl}/api/landmarks?q=Alexanderplatz`, {
      headers: { authorization: `Bearer ${room.tokens.org}` },
    });
    const found = await response.json() as { ok: boolean; landmarks: Array<{ id: string; kindLabel: string }> };
    expect(found.ok).toBe(true);
    expect(found.landmarks.slice(0, 2)).toMatchObject([
      { id: "landmark_u_alexanderplatz", kindLabel: "station" },
      { id: "landmark_alexanderplatz", kindLabel: "square" },
    ]);

    const submitted = await command(room, room.tokens.org, 0, `${room.roomId}_landmark`, {
      kind: "scope",
      dimension: "radius_m",
      max: 200,
      referent: { kind: "landmark", landmarkId: "landmark_alexanderplatz" },
    });
    expect(submitted.body.ok).toBe(true);
    const context = await apiPost<{
      matching: number;
      activeNeeds: Array<{ label: string; referent?: { label: string; location?: object } }>;
    }>(server.baseUrl, "/api/spatial/context", room.tokens.org, {});
    expect(context.body.matching).toBe(2);
    expect(context.body.activeNeeds[0]).toMatchObject({
      label: "within 200 m of Alexanderplatz",
      referent: { label: "Alexanderplatz", location: { lat: 52.5, lng: 13.4 } },
    });
  });

  it("intersects two scope needs as hard requirements", async () => {
    const room = await roomWithArea();
    const first = await command(room, room.tokens.org, 0, `${room.roomId}_landmark`, {
      kind: "scope", dimension: "radius_m", max: 200,
      referent: { kind: "landmark", landmarkId: "landmark_alexanderplatz" },
    });
    const alphaId = `place_a_${room.roomId.replace("room_test_", "")}`;
    const second = await command(room, room.tokens.sarah, first.body.revision, `${room.roomId}_candidate`, {
      kind: "scope", dimension: "radius_m", max: 50,
      referent: { kind: "candidate", candidateId: alphaId },
    });
    expect(second.body.ok).toBe(true);
    const context = await apiPost<{ matching: number; activeNeeds: unknown[] }>(
      server.baseUrl, "/api/spatial/context", room.tokens.org, {},
    );
    expect(context.body.matching).toBe(1);
    expect(context.body.activeNeeds).toHaveLength(2);
  });

  it("projects a private participant referent only as privacy-safe public text", async () => {
    const room = await roomWithArea();
    const secret = { lat: 52.506543, lng: 13.407654 };
    const origin = await apiPost<{ ok: boolean; revision: number }>(
      server.baseUrl, "/api/commands", room.tokens.sarah,
      { type: "SetOrigin", input: { baseRevision: 0, position: secret, label: "Sarah secret", source: "stated" } },
    );
    const stated = await command(room, room.tokens.sarah, origin.body.revision, `${room.roomId}_private_person`, {
      kind: "scope", dimension: "radius_m", max: 2000,
      referent: { kind: "participant", participantId: room.participantIds.sarah },
    });
    expect(stated.body.ok).toBe(true);

    const owner = await apiPost<{ matching: number }>(
      server.baseUrl, "/api/spatial/context", room.tokens.sarah, {},
    );
    const peer = await apiPost<{
      matching: number;
      feasibility: { uncertain: number; excluded: number };
      activeNeeds: Array<{ label: string; referent: { label: string; location?: object } }>;
    }>(server.baseUrl, "/api/spatial/context", room.tokens.org, {});
    expect(owner.body.matching).toBe(3);
    expect(peer.body.matching).toBe(0);
    expect(peer.body.feasibility).toMatchObject({ uncertain: 3, excluded: 0 });
    expect(peer.body.activeNeeds[0]).toMatchObject({
      label: "within 2000 m of where someone starts from",
      referent: { label: "where someone starts from" },
    });
    expect(peer.body.activeNeeds[0].referent).not.toHaveProperty("location");
    // Whole-payload audit: neither durable coordinate nor private label may
    // hitch a ride in another participant's serialized response.
    expect(peer.raw).not.toContain(String(secret.lat));
    expect(peer.raw).not.toContain(String(secret.lng));
    expect(peer.raw).not.toContain("Sarah secret");
  });

  it("projects the circle a distance need reaches, and only to entitled readers", async () => {
    const room = await roomWithArea();
    const secret = { lat: 52.507111, lng: 13.401222 };
    const origin = await apiPost<{ ok: boolean; revision: number }>(
      server.baseUrl, "/api/commands", room.tokens.sarah,
      { type: "SetOrigin", input: { baseRevision: 0, position: secret, label: "Sarah range", source: "stated" } },
    );
    const metres = await command(room, room.tokens.sarah, origin.body.revision, `${room.roomId}_range_m`, {
      kind: "scope", dimension: "radius_m", max: 500,
    });
    expect(metres.body.ok).toBe(true);
    // A time bound is the same circle: the engine divides by a fixed speed
    // and rounds, so 10 walking minutes reach 10.5 x 75 m.
    const minutes = await command(room, room.tokens.sarah, metres.body.revision, `${room.roomId}_range_min`, {
      kind: "scope", dimension: "walk_min", max: 10,
    });
    expect(minutes.body.ok).toBe(true);

    type NeedsBody = {
      activeNeeds: Array<{
        id: string;
        range?: { radiusM: number; center: { lat: number; lng: number }; participantId?: string };
      }>;
    };
    const owner = await apiPost<NeedsBody>(
      server.baseUrl, "/api/spatial/context", room.tokens.sarah, {},
    );
    const byId = new Map(owner.body.activeNeeds.map((need) => [need.id, need]));
    expect(byId.get(`${room.roomId}_range_m`)!.range).toEqual({
      radiusM: 500,
      center: secret,
      participantId: room.participantIds.sarah,
    });
    expect(byId.get(`${room.roomId}_range_min`)!.range).toMatchObject({ radiusM: 787.5 });

    // A peer who may not see where Sarah starts gets no circle either — the
    // radius alone would give her position away.
    const peer = await apiPost<NeedsBody>(
      server.baseUrl, "/api/spatial/context", room.tokens.org, {},
    );
    for (const need of peer.body.activeNeeds) expect(need.range).toBeUndefined();
    expect(peer.raw).not.toContain(String(secret.lat));
  });
});
