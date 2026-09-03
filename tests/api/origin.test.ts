import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  apiPost,
  createTestRoom,
  openRealtime,
  startServer,
  type TestRealtime,
  type TestRoom,
  type TestServer,
} from "./helpers.ts";

let server: TestServer;
let room: TestRoom;
let peerSocket: TestRealtime;
let revision = 0;

const secretOrigin = {
  lat: 52.500123,
  lng: 13.400456,
  label: "Private starting point",
};

const command = (token: string, type: string, input: Record<string, unknown>) =>
  apiPost<{ ok: boolean; revision?: number; error?: { code: string } }>(
    server.baseUrl,
    "/api/commands",
    token,
    { type, input },
  );

beforeAll(async () => {
  server = await startServer();
  room = await createTestRoom(server.baseUrl);
  peerSocket = await openRealtime(server.baseUrl, room.tokens.org);
});

afterAll(async () => {
  peerSocket.close();
  await room.cleanup();
  await server.stop();
});

describe("participant origins", () => {
  it("sets only the authenticated participant's own origin", async () => {
    const result = await command(room.tokens.sarah, "SetOrigin", {
      baseRevision: revision,
      position: { lat: secretOrigin.lat, lng: secretOrigin.lng },
      label: secretOrigin.label,
      source: "stated",
    });
    expect(result.body.ok).toBe(true);
    revision = result.body.revision!;

    const rows = await room.pool.query(
      "SELECT id, origin FROM participants WHERE room_id = $1 ORDER BY id",
      [room.roomId],
    );
    expect(rows.rows.find((row) => row.id === room.participantIds.sarah)?.origin)
      .toMatchObject({ ...secretOrigin, source: "stated" });
    expect(rows.rows.find((row) => row.id === room.participantIds.org)?.origin).toBeNull();
    expect(rows.rows.find((row) => row.id === room.participantIds.joe)?.origin).toBeNull();

    const navigation = await apiPost<{
      links: { googleMaps: string; appleMaps: string };
    }>(server.baseUrl, "/api/spatial/navigation", room.tokens.sarah, {
      candidateId: room.proposalId.replace("prop_", "place_a_"),
    });
    expect(navigation.body.links.googleMaps).toContain(
      `origin=${secretOrigin.lat},${secretOrigin.lng}`,
    );
    expect(navigation.body.links.appleMaps).toContain(
      `saddr=${secretOrigin.lat},${secretOrigin.lng}`,
    );

    const targeting = await command(room.tokens.sarah, "SetOrigin", {
      baseRevision: revision,
      position: { lat: 1, lng: 2 },
      source: "stated",
      targetParticipantId: room.participantIds.joe,
    });
    expect(targeting.body).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    const joe = await room.pool.query("SELECT origin FROM participants WHERE id = $1", [
      room.participantIds.joe,
    ]);
    expect(joe.rows[0].origin).toBeNull();
  });

  it("omits another participant's origin from every peer read and realtime frame", async () => {
    const own = await apiPost<{ participants: Array<Record<string, unknown>> }>(
      server.baseUrl,
      "/api/spatial/context",
      room.tokens.sarah,
      {},
    );
    expect(own.body.participants.find((p) => p.participantId === room.participantIds.sarah))
      .toHaveProperty("origin");
    expect(own.body.participants.find((p) => p.participantId === room.participantIds.org))
      .not.toHaveProperty("origin");

    const peerReads = await Promise.all([
      apiPost(server.baseUrl, "/api/sync", room.tokens.org, {}),
      apiPost(server.baseUrl, "/api/sync", room.tokens.org, { sinceRevision: 0 }),
      apiPost(server.baseUrl, "/api/spatial/context", room.tokens.org, {}),
      apiPost(server.baseUrl, "/api/spatial/inspect", room.tokens.org, {
        candidateIds: [room.proposalId.replace("prop_", "place_a_")],
      }),
    ]);
    for (const read of peerReads) {
      expect(read.raw).not.toContain(secretOrigin.label);
      expect(read.raw).not.toContain(String(secretOrigin.lat));
      expect(read.raw).not.toContain(String(secretOrigin.lng));
      expect(read.raw).not.toContain('"origin"');
    }

    const deadline = Date.now() + 5000;
    while (
      !peerSocket.frames().some((frame) => frame.includes("origin_updated")) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const frames = peerSocket.frames().filter((frame) => frame.includes("origin_updated"));
    expect(frames.length).toBeGreaterThan(0);
    const wire = frames.join("\n");
    expect(wire).not.toContain(secretOrigin.label);
    expect(wire).not.toContain(String(secretOrigin.lat));
    expect(wire).not.toContain(String(secretOrigin.lng));
    expect(wire).not.toContain('"origin"');
  });

  it("computes candidate walking time and the walk facet from the viewer's origin", async () => {
    const sarah = await apiPost<{
      candidates: Array<{ walkMin: number }>;
      facets: Array<{ key: string; range?: { min: number; max: number } }>;
    }>(server.baseUrl, "/api/spatial/context", room.tokens.sarah, {});
    const organizer = await apiPost<{
      candidates: Array<{ walkMin: number }>;
      facets: Array<{ key: string; range?: { min: number; max: number } }>;
    }>(server.baseUrl, "/api/spatial/context", room.tokens.org, {});

    expect(sarah.body.candidates[0].walkMin).toBe(1);
    expect(organizer.body.candidates[0].walkMin).toBe(5);
    expect(sarah.body.facets.find((facet) => facet.key === "walk-minutes")?.range)
      .toEqual({ min: 1, max: 1 });
    expect(organizer.body.facets.find((facet) => facet.key === "walk-minutes"))
      .toBeUndefined();
  });
});
