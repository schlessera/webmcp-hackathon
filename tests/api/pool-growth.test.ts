import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { POOL_CAP, POOL_PER_RING } from "@webmcp-hackathon/contracts";
import { haversineMeters } from "../../apps/server/src/eligibility.ts";
import {
  DATABASE_URL,
  apiPost,
  startServer,
  type TestServer,
} from "./helpers.ts";

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

async function exchange(inviteSecret: string): Promise<string> {
  const response = await plainPost("/api/session/exchange", { inviteSecret });
  return response.body.participantToken as string;
}

async function get(path: string, token?: string) {
  const response = await fetch(`${server.baseUrl}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
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

describe("room pool growth and viewport exploration", () => {
  it("explores, adds for any participant, projects the shared act, tops up, and enforces the cap", async () => {
    const opened = await plainPost("/api/rooms", {
      areaId: "berlin-mitte",
      organizerName: "Alex",
      memberNames: ["Sarah"],
    });
    expect(opened.status).toBe(200);
    const roomId = opened.body.roomId as string;
    created.push(roomId);
    const invites = opened.body.invites as Array<{
      displayName: string;
      inviteSecret: string;
    }>;
    const organizerToken = await exchange(invites.find((invite) => invite.displayName === "Alex")!.inviteSecret);
    const memberToken = await exchange(invites.find((invite) => invite.displayName === "Sarah")!.inviteSecret);

    const first = await apiPost<{
      revision: number;
      area: { poolSize: number };
      pool: { size: number; cap: number; explorable: boolean };
      scope: { area: { center: { lat: number; lng: number }; radiusM: number } };
      candidates: Array<{ candidateId: string; ref?: string }>;
    }>(server.baseUrl, "/api/spatial/context", organizerToken, {});
    expect(first.body.pool).toEqual({
      size: 3 * POOL_PER_RING,
      cap: POOL_CAP,
      explorable: true,
    });
    expect(first.body.area.poolSize).toBe(first.body.pool.size);

    const center = first.body.scope.area.center;
    const bbox = [
      center.lat - 0.02,
      center.lng - 0.02,
      center.lat + 0.02,
      center.lng + 0.02,
    ].join(",");
    expect((await get(`/api/rooms/${roomId}/places?bbox=${bbox}`)).status).toBe(401);
    const explored = await get(`/api/rooms/${roomId}/places?bbox=${bbox}`, memberToken);
    expect(explored.status).toBe(200);
    const places = explored.body.places as Array<{
      ref: string;
      name: string;
      location: { lat: number; lng: number };
      candidateId?: string;
    }>;
    expect(places.some((place) => place.candidateId)).toBe(true);
    const novel = places
      .filter(
        (place) =>
          !place.candidateId &&
          haversineMeters(center, place.location) > first.body.scope.area.radiusM,
      )
      .slice(0, 3);
    expect(novel).toHaveLength(3);

    const added = await apiPost<{ ok: boolean; revision: number }>(
      server.baseUrl,
      "/api/commands",
      memberToken,
      {
        type: "AddCandidates",
        input: { baseRevision: first.body.revision, refs: novel.map((place) => place.ref) },
      },
    );
    expect(added.body.ok).toBe(true);

    const afterAdd = await apiPost<{
      revision: number;
      area: { poolSize: number };
      pool: { size: number };
      candidates: Array<{ candidateId: string; ref?: string }>;
    }>(server.baseUrl, "/api/spatial/context", organizerToken, {});
    expect(afterAdd.body.pool.size).toBe(3 * POOL_PER_RING + 3);
    expect(afterAdd.body.area.poolSize).toBe(afterAdd.body.pool.size);
    for (const place of novel) {
      const candidate = afterAdd.body.candidates.find((row) => row.ref === place.ref);
      expect(candidate?.candidateId).toMatch(/^pl_[a-f0-9]+_\d{3}$/);
    }

    const peerSync = await apiPost<{
      delta: { events: Array<{ type: string; level: string; text: string; payload?: unknown }> };
    }>(server.baseUrl, "/api/sync", organizerToken, { sinceRevision: 0 });
    const peerAdded = peerSync.body.delta.events.find((event) => event.type === "candidates_added")!;
    expect(peerAdded).toMatchObject({
      level: "existence",
      text: "Sarah brought 3 places in.",
    });
    expect(peerAdded.payload).toBeUndefined();

    const actorSync = await apiPost<{
      delta: { events: Array<{ type: string; level: string; payload?: { names?: string[] } }> };
    }>(server.baseUrl, "/api/sync", memberToken, { sinceRevision: 0 });
    const actorAdded = actorSync.body.delta.events.find((event) => event.type === "candidates_added")!;
    expect(actorAdded.level).toBe("full");
    expect(actorAdded.payload?.names).toEqual(novel.map((place) => place.name));
    const reconciled = await database.query(
      `SELECT payload FROM events
        WHERE room_id = $1 AND type = 'candidates_updated'
        ORDER BY revision DESC LIMIT 1`,
      [roomId],
    );
    expect(reconciled.rows[0].payload.newlyExcluded).toBe(0);

    const unknown = await apiPost<{ ok: boolean; error?: { code: string } }>(
      server.baseUrl,
      "/api/commands",
      organizerToken,
      {
        type: "AddCandidates",
        input: { baseRevision: afterAdd.body.revision, refs: ["node/not-a-real-place"] },
      },
    );
    expect(unknown.body).toMatchObject({ ok: false, error: { code: "not_found" } });

    const shifted = { lat: center.lat + 0.008, lng: center.lng + 0.008 };
    const moved = await apiPost<{ ok: boolean; revision: number }>(
      server.baseUrl,
      "/api/commands",
      organizerToken,
      {
        type: "SetSearchScope",
        input: {
          baseRevision: afterAdd.body.revision,
          area: { kind: "circle", center: shifted, radiusM: first.body.scope.area.radiusM },
        },
      },
    );
    expect(moved.body.ok).toBe(true);
    const afterMove = await apiPost<{
      revision: number;
      pool: { size: number };
      area: { poolSize: number };
      scope: { area: { center: { lat: number; lng: number } } };
      candidates: Array<{ ref?: string; location: { lat: number; lng: number } }>;
    }>(server.baseUrl, "/api/spatial/context", organizerToken, {});
    expect(afterMove.body.pool.size).toBeGreaterThan(afterAdd.body.pool.size);
    expect(afterMove.body.area.poolSize).toBe(afterMove.body.pool.size);
    expect(afterMove.body.scope.area.center).toEqual(shifted);
    const refsBeforeMove = new Set(afterAdd.body.candidates.map((candidate) => candidate.ref));
    const topUpRows = afterMove.body.candidates.filter(
      (candidate) => candidate.ref && !refsBeforeMove.has(candidate.ref),
    );
    expect(topUpRows.length).toBeGreaterThan(0);
    for (const candidate of topUpRows) {
      expect(haversineMeters(shifted, candidate.location)).toBeLessThanOrEqual(
        first.body.scope.area.radiusM,
      );
    }

    const fill = POOL_CAP - afterMove.body.pool.size;
    if (fill > 0) {
      await database.query(
        `INSERT INTO candidates
           (id, room_id, name, category, price_level, walk_min, location, attributes, hours)
         SELECT $2 || generate_series, $1, seed.name, seed.category, seed.price_level,
                seed.walk_min, seed.location, seed.attributes, seed.hours
           FROM (SELECT * FROM candidates WHERE room_id = $1 LIMIT 1) seed
           CROSS JOIN generate_series(1, $3)`,
        [roomId, `cap_${roomId}_`, fill],
      );
    }
    const atCap = await apiPost<{ pool: { size: number }; revision: number }>(
      server.baseUrl,
      "/api/spatial/context",
      organizerToken,
      {},
    );
    expect(atCap.body.pool.size).toBe(POOL_CAP);
    const another = places.find((place) =>
      !afterMove.body.candidates.some((candidate) => candidate.ref === place.ref)
    );
    expect(another).toBeDefined();
    const capped = await apiPost<{ ok: boolean; error?: { code: string; message: string } }>(
      server.baseUrl,
      "/api/commands",
      organizerToken,
      {
        type: "AddCandidates",
        input: { baseRevision: atCap.body.revision, refs: [another!.ref] },
      },
    );
    expect(capped.body).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(capped.body.error?.message).toContain(String(POOL_CAP));

    const tooLarge = await get(
      `/api/rooms/${roomId}/places?bbox=${center.lat - 0.05},${center.lng - 0.05},${center.lat + 0.05},${center.lng + 0.05}`,
      organizerToken,
    );
    expect(tooLarge.status).toBe(400);
  }, 30_000);
});
