import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import {
  DATABASE_URL,
  keepEnrichmentsClean,
  startServer,
  type TestServer,
} from "./helpers.ts";

/**
 * Invite links: how someone joins a room that already exists.
 *
 * The properties worth guarding are the social ones, not the CRUD:
 *  - an organizer who sent three invitations still has three that work;
 *  - the person who took a link can come back to it, from that browser;
 *  - anyone else is told the link is spent, and told nothing about who has it;
 *  - what a link shows before you join is the goal and who started it, and
 *    nothing that belongs to the room.
 */

let server: TestServer;
const pool = new pg.Pool({ connectionString: DATABASE_URL });
const created: string[] = [];

interface Created {
  roomId: string;
  invites: Array<{ participantId: string; role: string; inviteSecret: string }>;
}

let restoreEnrichments: () => Promise<void>;

beforeAll(async () => {
  // Enrichment is keyed by place, not by room: leave the shared table as
  // this file found it, or a neighbour asserting on it breaks by ordering.
  restoreEnrichments = await keepEnrichmentsClean(pool);
  server = await startServer({ env: { POOL_FILL: "0" } });
});

afterAll(async () => {
  for (const roomId of created) {
    for (const table of [
      "stances", "proposals", "verdicts", "requirements", "adjustments",
      "arrival_plans", "attestations", "events", "candidates",
      "invite_secrets", "room_invites",
    ]) {
      await pool.query(`DELETE FROM ${table} WHERE room_id = $1`, [roomId]);
    }
    await pool.query(
      "DELETE FROM participant_tokens WHERE participant_id IN (SELECT id FROM participants WHERE room_id = $1)",
      [roomId],
    );
    await pool.query("DELETE FROM participants WHERE room_id = $1", [roomId]);
    await pool.query("DELETE FROM rooms WHERE id = $1", [roomId]);
  }
  await restoreEnrichments();
  await pool.end();
  await server.stop();
});

async function post(path: string, body: unknown, token?: string) {
  const response = await fetch(`${server.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  return { status: response.status, raw, body: raw ? JSON.parse(raw) : null };
}

async function get(path: string, token?: string) {
  const response = await fetch(`${server.baseUrl}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  const raw = await response.text();
  return { status: response.status, raw, body: raw ? JSON.parse(raw) : null };
}

async function openRoom(): Promise<{ room: Created; token: string }> {
  const { status, body } = await post("/api/rooms", {
    areaId: "berlin-mitte",
    organizerName: "Alex",
    goal: "Dinner tonight somewhere we can all walk to",
    steps: [{ placeClass: "food", title: "Dinner" }],
  });
  expect(status, JSON.stringify(body)).toBe(200);
  const room = body as Created;
  created.push(room.roomId);
  const organizer = room.invites.find((invite) => invite.role === "organizer")!;
  const exchanged = await post("/api/session/exchange", {
    inviteSecret: organizer.inviteSecret,
  });
  return { room, token: exchanged.body.participantToken as string };
}

const device = (tag: string) => `device-${tag}-${"x".repeat(10)}`;

describe("minting and listing", () => {
  it("mints a link that expires in an hour, and lists it as unused", async () => {
    const { token } = await openRoom();
    const minted = await post("/api/invites", {}, token);
    expect(minted.status).toBe(200);
    expect(minted.body.inviteSecret).toMatch(/^[a-f0-9]{32}$/);

    const ttl = new Date(minted.body.expiresAt).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(55 * 60_000);
    expect(ttl).toBeLessThanOrEqual(60 * 60_000);

    const listed = await get("/api/invites", token);
    expect(listed.body.invites).toHaveLength(1);
    expect(listed.body.invites[0].state).toBe("unused");
    expect(listed.body.invites[0].claimedBy).toBeNull();
    // The list is for the room, not the wire: it never carries the secret.
    expect(listed.raw).not.toContain(minted.body.inviteSecret);
  });

  it("refuses to mint or list without a token", async () => {
    expect((await post("/api/invites", {})).status).toBe(401);
    expect((await get("/api/invites")).status).toBe(401);
  });

  it("an earlier link still works after a later one is minted", async () => {
    const { token } = await openRoom();
    const first = await post("/api/invites", {}, token);
    const second = await post("/api/invites", {}, token);

    const joinedSecond = await post(`/api/invites/${second.body.inviteSecret}/claim`, {
      displayName: "Joe",
      deviceId: device("joe"),
    });
    expect(joinedSecond.status).toBe(200);

    // The organizer handed out two invitations. Both are still invitations.
    const joinedFirst = await post(`/api/invites/${first.body.inviteSecret}/claim`, {
      displayName: "Sarah",
      deviceId: device("sarah"),
    });
    expect(joinedFirst.status).toBe(200);
    expect(joinedFirst.body.displayName).toBe("Sarah");
    expect(joinedFirst.body.participantId).not.toBe(joinedSecond.body.participantId);
  });
});

describe("what a link shows before you take it", () => {
  it("names the goal, the organizer, the plan and the area, and nothing else", async () => {
    const { token } = await openRoom();
    const minted = await post("/api/invites", {}, token);

    const { status, body, raw } = await get(
      `/api/invites/${minted.body.inviteSecret}/context`,
    );
    expect(status).toBe(200);
    expect(body.goal).toBe("Dinner tonight somewhere we can all walk to");
    expect(body.organizer.displayName).toBe("Alex");
    expect(body.participantCount).toBe(1);
    expect(body.area.label).toBe("Berlin Mitte");
    expect(body.steps).toEqual([
      { title: "Dinner", placeClass: { label: "somewhere to eat" } },
    ]);
    expect(body.claimable).toBe(true);

    // Nothing that belongs to the room leaves it through a URL.
    for (const leaked of ["participants", "candidates", "roomId", "participantId", "token"]) {
      expect(raw, `${leaked} is visible to someone who has not joined`).not.toContain(leaked);
    }
  });

  it("is 404 for a secret nobody minted", async () => {
    const { status, body } = await get("/api/invites/deadbeefdeadbeef/context");
    expect(status).toBe(404);
    expect(body.error).toBe("unknown_invite");
  });
});

describe("claiming", () => {
  it("adds a participant, moves the room's revision, and logs the join", async () => {
    const { room, token } = await openRoom();
    const minted = await post("/api/invites", {}, token);
    const before = (
      await pool.query("SELECT revision FROM rooms WHERE id = $1", [room.roomId])
    ).rows[0].revision as number;

    const claimed = await post(`/api/invites/${minted.body.inviteSecret}/claim`, {
      displayName: "Sarah",
      deviceId: device("sarah"),
    });
    expect(claimed.status).toBe(200);
    expect(claimed.body.role).toBe("member");
    expect(claimed.body.roomId).toBe(room.roomId);

    const people = await pool.query(
      "SELECT display_name FROM participants WHERE room_id = $1 ORDER BY display_name",
      [room.roomId],
    );
    expect(people.rows.map((row) => row.display_name)).toEqual(["Alex", "Sarah"]);

    const after = (
      await pool.query("SELECT revision FROM rooms WHERE id = $1", [room.roomId])
    ).rows[0].revision as number;
    expect(after).toBe(before + 1);

    const joinedEvent = await pool.query(
      "SELECT type FROM events WHERE room_id = $1 AND type = 'participant_joined'",
      [room.roomId],
    );
    expect(joinedEvent.rows).toHaveLength(1);

    // The token it minted is a working token.
    const sync = await post("/api/sync", {}, claimed.body.participantToken as string);
    expect(sync.status).toBe(200);
    expect(sync.body.ok).toBe(true);

    const listed = await get("/api/invites", token);
    expect(listed.body.invites[0].state).toBe("claimed");
    expect(listed.body.invites[0].claimedBy).toBe("Sarah");
  });

  it("lets the same device come back, with a fresh token for the same person", async () => {
    const { token } = await openRoom();
    const minted = await post("/api/invites", {}, token);
    const deviceId = device("sarah");

    const first = await post(`/api/invites/${minted.body.inviteSecret}/claim`, {
      displayName: "Sarah",
      deviceId,
    });
    const again = await post(`/api/invites/${minted.body.inviteSecret}/claim`, {
      displayName: "Sarah",
      deviceId,
    });
    expect(again.status).toBe(200);
    expect(again.body.participantId).toBe(first.body.participantId);
    expect(again.body.participantToken).not.toBe(first.body.participantToken);

    // Coming back is not joining again.
    const people = await pool.query(
      "SELECT count(*)::int AS n FROM participants WHERE room_id = $1",
      [first.body.roomId],
    );
    expect(people.rows[0].n).toBe(2);
  });

  it("refuses another device, and names nobody in doing so", async () => {
    const { token } = await openRoom();
    const minted = await post("/api/invites", {}, token);
    await post(`/api/invites/${minted.body.inviteSecret}/claim`, {
      displayName: "Sarah",
      deviceId: device("sarah"),
    });

    const stranger = await post(`/api/invites/${minted.body.inviteSecret}/claim`, {
      displayName: "Mallory",
      deviceId: device("mallory"),
    });
    expect(stranger.status).toBe(409);
    expect(stranger.body.error).toBe("invite_in_use");
    expect(stranger.raw).not.toContain("Sarah");
    expect(stranger.raw).not.toContain("Alex");
    expect(stranger.raw).not.toMatch(/p_[0-9a-f]{8}/);
  });

  it("refuses an expired link, and still says what the room was for", async () => {
    const { token } = await openRoom();
    const minted = await post("/api/invites", {}, token);
    await pool.query(
      "UPDATE room_invites SET expires_at = now() - interval '1 minute' WHERE id = $1",
      [minted.body.inviteId],
    );

    const late = await post(`/api/invites/${minted.body.inviteSecret}/claim`, {
      displayName: "Sarah",
      deviceId: device("sarah"),
    });
    expect(late.status).toBe(410);
    expect(late.body.error).toBe("invite_expired");

    const context = await get(`/api/invites/${minted.body.inviteSecret}/context`);
    expect(context.status).toBe(200);
    expect(context.body.claimable).toBe(false);
    expect(context.body.reason).toBe("expired");
  });

  it("needs a name and a device id", async () => {
    const { token } = await openRoom();
    const minted = await post("/api/invites", {}, token);
    const path = `/api/invites/${minted.body.inviteSecret}/claim`;

    expect((await post(path, { deviceId: device("x") })).status).toBe(400);
    expect((await post(path, { displayName: "  ", deviceId: device("x") })).status).toBe(400);
    expect((await post(path, { displayName: "S".repeat(41), deviceId: device("x") })).status).toBe(400);
    expect((await post(path, { displayName: "Sarah" })).status).toBe(400);
    expect((await post(path, { displayName: "Sarah", deviceId: "short" })).status).toBe(400);
  });

  it("is 404 for a secret nobody minted", async () => {
    const { status, body } = await post("/api/invites/deadbeefdeadbeef/claim", {
      displayName: "Sarah",
      deviceId: device("sarah"),
    });
    expect(status).toBe(404);
    expect(body.error).toBe("unknown_invite");
  });
});
