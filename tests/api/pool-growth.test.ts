import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { POOL_CAP } from "@webmcp-hackathon/contracts";
import { POOL_SEED_SIZE } from "../../apps/server/src/places.ts";
import { haversineMeters } from "../../apps/server/src/eligibility.ts";
import {
  DATABASE_URL,
  apiPost,
  openRealtime,
  startServer,
  type TestServer,
} from "./helpers.ts";

let server: TestServer;
const database = new pg.Pool({ connectionString: DATABASE_URL });
const created: string[] = [];

interface Context {
  revision: number;
  area: { poolSize: number };
  pool: {
    size: number;
    cap: number;
    explorable: boolean;
    filling: boolean;
    target: number;
  };
  scope: { area: { center: { lat: number; lng: number }; radiusM: number } };
  candidates: Array<{
    candidateId: string;
    ref?: string;
    location: { lat: number; lng: number };
    eligibility: string;
    why?: string;
  }>;
}

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

async function context(token: string): Promise<Context> {
  return (await apiPost<Context>(
    server.baseUrl,
    "/api/spatial/context",
    token,
    {},
  )).body;
}

async function pollFor<T>(read: () => Promise<T> | T, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 6_000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() >= deadline) throw new Error("pool did not converge before the deadline");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
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
  expect((opened.body.dataSource as { poolSize: number }).poolSize).toBe(POOL_SEED_SIZE);
  const invites = opened.body.invites as Array<{
    displayName: string;
    inviteSecret: string;
  }>;
  return {
    roomId,
    organizerToken: await exchange(
      invites.find((invite) => invite.displayName === "Alex")!.inviteSecret,
    ),
    memberToken: await exchange(
      invites.find((invite) => invite.displayName === "Sarah")!.inviteSecret,
    ),
  };
}

beforeAll(async () => {
  server = await startServer({
    env: { POOL_FILL_INTERVAL_MS: "75", POOL_FILL_BATCH: "50" },
  });
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

describe("whole-area pool growth", () => {
  it("restarts an incomplete fill from persisted scope and refs on the next read", async () => {
    const paused = await startServer({ env: { POOL_FILL: "0" } });
    let resumed: TestServer | undefined;
    try {
      const response = await fetch(`${paused.baseUrl}/api/rooms`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          areaId: "berlin-mitte",
          organizerName: "Restart",
          memberNames: [],
        }),
      });
      const opened = await response.json() as {
        roomId: string;
        invites: Array<{ inviteSecret: string }>;
      };
      created.push(opened.roomId);
      const exchanged = await fetch(`${paused.baseUrl}/api/session/exchange`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ inviteSecret: opened.invites[0].inviteSecret }),
      });
      const token = ((await exchanged.json()) as { participantToken: string }).participantToken;
      const before = (await apiPost<Context>(
        paused.baseUrl,
        "/api/spatial/context",
        token,
        {},
      )).body;
      expect(before.pool).toMatchObject({
        size: POOL_SEED_SIZE,
        target: 343,
        filling: true,
      });
      await paused.stop();

      resumed = await startServer({
        env: { POOL_FILL_INTERVAL_MS: "10", POOL_FILL_BATCH: "50" },
      });
      const complete = await pollFor(
        async () => (await apiPost<Context>(
          resumed!.baseUrl,
          "/api/spatial/context",
          token,
          {},
        )).body,
        (value) => value.pool.size === value.pool.target && !value.pool.filling,
      );
      expect(complete.pool.size).toBe(343);
    } finally {
      if (resumed) await resumed.stop();
      else await paused.stop();
    }
  }, 20_000);

  it("fills a fresh scope incrementally, emits pool frames, compresses, and fills a widening", async () => {
    const { organizerToken } = await openRoom();
    const realtime = await openRealtime(server.baseUrl, organizerToken);

    const gzip = await fetch(`${server.baseUrl}/api/spatial/context`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${organizerToken}`,
        "content-type": "application/json",
        "accept-encoding": "gzip",
      },
      body: "{}",
    });
    expect(gzip.status).toBe(200);
    expect(gzip.headers.get("content-encoding")).toBe("gzip");
    const initial = await gzip.json() as Context;
    expect(initial.pool.cap).toBe(POOL_CAP);
    expect(initial.pool.explorable).toBe(true);
    expect(initial.pool.target).toBe(343);
    expect(initial.pool.size).toBeGreaterThanOrEqual(POOL_SEED_SIZE);
    expect(initial.pool.size).toBeLessThanOrEqual(initial.pool.target);

    const filled = await pollFor(
      () => context(organizerToken),
      (value) => value.pool.size === value.pool.target && !value.pool.filling,
    );
    expect(filled.pool).toMatchObject({ size: 343, target: 343, filling: false });
    expect(filled.area.poolSize).toBe(filled.pool.size);
    expect(filled.candidates).toHaveLength(filled.pool.target);
    for (const candidate of filled.candidates) {
      if (candidate.eligibility === "eligible") expect(candidate).not.toHaveProperty("why");
      else expect(candidate.why?.length).toBeLessThanOrEqual(60);
    }

    const frames = await pollFor(
      () => realtime.frames().map((raw) => JSON.parse(raw) as Record<string, unknown>),
      (messages) => messages.some(
        (message) => message.type === "facts" && message.reason === "pool",
      ),
    );
    expect(frames.some((message) => {
      if (message.type !== "event") return false;
      return (message.events as Array<{ level: string; text: string }>).some(
        (event) => event.level === "existence" &&
          /^\d+ more places on the map\.$/.test(event.text),
      );
    })).toBe(true);

    const beforeRefs = new Set(
      filled.candidates.flatMap((candidate) => candidate.ref ? [candidate.ref] : []),
    );
    const widened = await apiPost<{ ok: boolean; revision: number }>(
      server.baseUrl,
      "/api/commands",
      organizerToken,
      {
        type: "SetSearchScope",
        input: {
          baseRevision: filled.revision,
          area: {
            kind: "circle",
            center: filled.scope.area.center,
            radiusM: 1400,
          },
        },
      },
    );
    expect(widened.body.ok).toBe(true);
    const afterWiden = await pollFor(
      () => context(organizerToken),
      (value) => value.pool.target > filled.pool.target &&
        value.pool.size === value.pool.target && !value.pool.filling,
    );
    expect(afterWiden.pool.target).toBeGreaterThan(filled.pool.target);
    for (const ref of beforeRefs) {
      expect(afterWiden.candidates.some((candidate) => candidate.ref === ref)).toBe(true);
    }
    realtime.close();
  }, 20_000);

  it("warms every batch the fill adds, one batch at a time", async () => {
    const warm = await startServer({
      entrypoint: "tests/api/fixtures/live-network-server.ts",
      env: {
        ENRICH_NETWORK: "1",
        INFER: "0",
        // Small batches: the first one past the seed is all this needs, and
        // a warm-up server that fetches for the whole circle would starve the
        // suites running beside it.
        POOL_FILL_INTERVAL_MS: "20",
        POOL_FILL_BATCH: "5",
      },
    });
    try {
      const opened = await fetch(`${warm.baseUrl}/api/rooms`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          areaId: "berlin-mitte",
          organizerName: "Warm",
          memberNames: [],
        }),
      });
      const room = await opened.json() as {
        roomId: string;
        invites: Array<{ inviteSecret: string }>;
      };
      created.push(room.roomId);
      const exchanged = await fetch(`${warm.baseUrl}/api/session/exchange`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ inviteSecret: room.invites[0].inviteSecret }),
      });
      const token = ((await exchanged.json()) as { participantToken: string }).participantToken;
      const realtime = await openRealtime(warm.baseUrl, token);
      try {
        // The seed is numbered 001-060, so anything past it belongs to a
        // batch the fill added — that is the place we need warmed.
        const filled = /_(\d{3})$/;
        const fromFill = (id: string) => {
          const match = filled.exec(id);
          return match !== null && Number(match[1]) > POOL_SEED_SIZE;
        };
        await pollFor(
          () => realtime.frames().map((raw) => JSON.parse(raw) as {
            type: string;
            pending?: string[];
            reason?: { kind: string };
          }),
          (frames) => frames.some(
            (frame) =>
              frame.type === "lookups" &&
              frame.reason?.kind === "pool" &&
              (frame.pending ?? []).some(fromFill),
          ),
        );
      } finally {
        realtime.close();
      }
    } finally {
      await warm.stop();
    }
  }, 30_000);

  it("keeps participant additions actor-driven and enforces the expanded cap", async () => {
    const { roomId, organizerToken, memberToken } = await openRoom();
    const filled = await pollFor(
      () => context(organizerToken),
      (value) => value.pool.size === value.pool.target && !value.pool.filling,
    );
    const center = filled.scope.area.center;
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
    const novel = places
      .filter((place) =>
        !place.candidateId &&
        haversineMeters(center, place.location) > filled.scope.area.radiusM
      )
      .slice(0, 3);
    expect(novel).toHaveLength(3);

    const added = await apiPost<{ ok: boolean; revision: number }>(
      server.baseUrl,
      "/api/commands",
      memberToken,
      {
        type: "AddCandidates",
        input: { baseRevision: filled.revision, refs: novel.map((place) => place.ref) },
      },
    );
    expect(added.body.ok).toBe(true);
    const afterAdd = await context(organizerToken);
    expect(afterAdd.pool.size).toBe(filled.pool.size + 3);
    expect(afterAdd.pool.target).toBe(filled.pool.target);
    expect(afterAdd.pool.filling).toBe(false);
    expect(afterAdd.area.poolSize).toBe(afterAdd.pool.size);
    for (const place of novel) {
      const candidate = afterAdd.candidates.find((row) => row.ref === place.ref);
      expect(candidate?.candidateId).toMatch(/^pl_[a-f0-9]+_\d{3}$/);
    }

    const peerSync = await apiPost<{
      delta: { events: Array<{ type: string; level: string; text: string; payload?: unknown }> };
    }>(server.baseUrl, "/api/sync", organizerToken, { sinceRevision: 0 });
    const peerAdded = peerSync.body.delta.events.find(
      (event) => event.type === "candidates_added" && event.text.includes("Sarah"),
    )!;
    expect(peerAdded).toMatchObject({
      level: "existence",
      text: "Sarah brought 3 places in.",
    });
    expect(peerAdded.payload).toBeUndefined();

    const actorSync = await apiPost<{
      delta: { events: Array<{ type: string; level: string; text: string; payload?: { names?: string[] } }> };
    }>(server.baseUrl, "/api/sync", memberToken, { sinceRevision: 0 });
    const actorAdded = actorSync.body.delta.events.find(
      (event) => event.type === "candidates_added" && event.text.startsWith("You brought"),
    )!;
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
        input: { baseRevision: afterAdd.revision, refs: ["node/not-a-real-place"] },
      },
    );
    expect(unknown.body).toMatchObject({ ok: false, error: { code: "not_found" } });

    const fill = POOL_CAP - afterAdd.pool.size;
    await database.query(
      `INSERT INTO candidates
         (id, room_id, name, category, price_level, walk_min, location, attributes, hours)
       SELECT $2 || generate_series, $1, seed.name, seed.category, seed.price_level,
              seed.walk_min, seed.location, seed.attributes, seed.hours
         FROM (SELECT * FROM candidates WHERE room_id = $1 LIMIT 1) seed
         CROSS JOIN generate_series(1, $3)`,
      [roomId, `cap_${roomId}_`, fill],
    );
    const atCap = await context(organizerToken);
    expect(atCap.pool).toMatchObject({ size: POOL_CAP, cap: POOL_CAP, filling: false });
    const another = places.find((place) =>
      !afterAdd.candidates.some((candidate) => candidate.ref === place.ref)
    );
    expect(another).toBeDefined();
    const capped = await apiPost<{ ok: boolean; error?: { code: string; message: string } }>(
      server.baseUrl,
      "/api/commands",
      organizerToken,
      {
        type: "AddCandidates",
        input: { baseRevision: atCap.revision, refs: [another!.ref] },
      },
    );
    expect(capped.body).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(capped.body.error?.message).toContain(String(POOL_CAP));

    const tooLarge = await get(
      `/api/rooms/${roomId}/places?bbox=${center.lat - 0.05},${center.lng - 0.05},${center.lat + 0.05},${center.lng + 0.05}`,
      organizerToken,
    );
    expect(tooLarge.status).toBe(400);
  }, 20_000);
});
