import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BUDGETS, TOOL_CONTRACT_VERSION } from "@webmcp-hackathon/contracts";
import {
  apiPost,
  createTestRoom,
  openRealtime,
  startServer,
  type TestRoom,
  type TestServer,
} from "./helpers.ts";

interface Delta {
  fromRevision: number;
  events: Array<{ revision: number; type: string }>;
  truncated: boolean;
  cursor?: string;
  throughRevision?: number;
  resyncRequired?: "backlog_too_large";
}

interface Envelope {
  ok: boolean;
  revision?: number;
  error?: { code: string };
  delta?: Delta;
}

let server: TestServer;
let room: TestRoom;
let largeRoom: TestRoom;
let budgetRoom: TestRoom;

beforeAll(async () => {
  server = await startServer();
  room = await createTestRoom(server.baseUrl);
  largeRoom = await createTestRoom(server.baseUrl);
  budgetRoom = await createTestRoom(server.baseUrl);
});

afterAll(async () => {
  await room.cleanup();
  await largeRoom.cleanup();
  await budgetRoom.cleanup();
  await server.stop();
});

async function commandWithKey(
  token: string,
  key: string,
  body: Record<string, unknown>,
): Promise<Envelope> {
  const response = await fetch(`${server.baseUrl}/api/commands`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      "x-tool-contract-version": TOOL_CONTRACT_VERSION,
      "idempotency-key": key,
    },
    body: JSON.stringify(body),
  });
  return response.json() as Promise<Envelope>;
}

async function collectDelta(
  token: string,
  first: Delta,
): Promise<{ pages: Delta[]; revisions: number[] }> {
  const pages = [first];
  while (pages.at(-1)!.truncated) {
    const cursor = pages.at(-1)!.cursor;
    expect(cursor).toBeTruthy();
    const next = await apiPost<Envelope>(
      server.baseUrl,
      "/api/sync",
      token,
      { cursor },
    );
    expect(next.body.ok).toBe(true);
    pages.push(next.body.delta!);
  }
  return {
    pages,
    revisions: pages.flatMap((page) => page.events.map((event) => event.revision)),
  };
}

describe("R1 cursor-based catch-up", () => {
  it("pages a sync before the WebMCP budget instead of deleting delivered events", async () => {
    await budgetRoom.pool.query(
      `INSERT INTO events (room_id, revision, type, actor_id, visibility, payload)
       SELECT $1, n, 'ready_state_changed', $2, 'shared',
              jsonb_build_object('actorName', 'Alex', 'state', 'ready',
                                 'detail', repeat('bounded detail ', 100))
         FROM generate_series(1, 10) AS n`,
      [budgetRoom.roomId, budgetRoom.participantIds.org],
    );
    await budgetRoom.pool.query("UPDATE rooms SET revision = 10 WHERE id = $1", [
      budgetRoom.roomId,
    ]);

    const sync = await apiPost<Envelope>(
      server.baseUrl,
      "/api/sync",
      budgetRoom.tokens.org,
      { sinceRevision: 0 },
    );
    expect(sync.raw.length).toBeLessThanOrEqual(BUDGETS.syncResultMax);
    expect(sync.body.delta?.truncated).toBe(true);
    expect(sync.body.delta?.cursor).toBeTruthy();
    expect(sync.body.delta!.events.length).toBeLessThan(10);
    expect(sync.body.delta!.throughRevision).toBe(
      sync.body.delta!.events.at(-1)!.revision,
    );
  });

  it("pages every authorized event once and advances across omitted private events", async () => {
    const values: unknown[] = [];
    for (let revision = 1; revision <= 30; revision += 1) {
      const omitted = revision % 4 === 0;
      values.push(
        room.roomId,
        revision,
        omitted ? "evaluation_requested" : "ready_state_changed",
        omitted ? null : room.participantIds.org,
        omitted ? "application-private" : "shared",
        JSON.stringify(
          omitted
            ? {
                targetParticipantId: room.participantIds.sarah,
                candidateIds: [`place_${revision}`],
              }
            : { actorName: "Alex", state: revision % 2 ? "ready" : "contributing" },
        ),
      );
    }
    const rows = Array.from({ length: 30 }, (_, index) => {
      const base = index * 6;
      return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6})`;
    }).join(",");
    await room.pool.query(
      `INSERT INTO events (room_id, revision, type, actor_id, visibility, payload)
       VALUES ${rows}`,
      values,
    );
    await room.pool.query("UPDATE rooms SET revision = 30 WHERE id = $1", [room.roomId]);

    const first = await apiPost<Envelope>(
      server.baseUrl,
      "/api/sync",
      room.tokens.joe,
      { sinceRevision: 0 },
    );
    expect(first.body.delta!.truncated).toBe(true);
    expect(first.body.delta!.throughRevision).toBeLessThan(30);
    const stamped = await room.pool.query(
      "SELECT last_synced_revision FROM participants WHERE id = $1",
      [room.participantIds.joe],
    );
    expect(Number(stamped.rows[0].last_synced_revision)).toBe(
      first.body.delta!.throughRevision,
    );

    const collected = await collectDelta(room.tokens.joe, first.body.delta!);
    const expected = Array.from({ length: 30 }, (_, i) => i + 1).filter(
      (revision) => revision % 4 !== 0,
    );
    expect(collected.revisions).toEqual(expected);
    expect(new Set(collected.revisions).size).toBe(expected.length);
    expect(collected.pages.at(-1)!.throughRevision).toBe(30);
  });

  it("lets a sync_required delta continue completely before retry", async () => {
    const stale = await apiPost<Envelope>(
      server.baseUrl,
      "/api/commands",
      room.tokens.joe,
      {
        type: "SetReadyState",
        input: { baseRevision: 0, state: "ready" },
      },
    );
    expect(stale.body.error?.code).toBe("sync_required");
    expect(stale.body.delta?.truncated).toBe(true);
    const collected = await collectDelta(room.tokens.joe, stale.body.delta!);
    expect(collected.pages.at(-1)!.throughRevision).toBe(30);
    expect(new Set(collected.revisions).size).toBe(collected.revisions.length);
  });

  it("signals an oversized backlog instead of dropping it", async () => {
    await largeRoom.pool.query(
      `INSERT INTO events (room_id, revision, type, actor_id, visibility, payload)
       SELECT $1, n, 'ready_state_changed', $2, 'shared',
              jsonb_build_object('actorName', 'Alex', 'state', 'ready')
         FROM generate_series(1, 1001) AS n`,
      [largeRoom.roomId, largeRoom.participantIds.org],
    );
    await largeRoom.pool.query("UPDATE rooms SET revision = 1001 WHERE id = $1", [
      largeRoom.roomId,
    ]);
    const sync = await apiPost<Envelope>(
      server.baseUrl,
      "/api/sync",
      largeRoom.tokens.joe,
      { sinceRevision: 0 },
    );
    expect(sync.body.delta).toMatchObject({
      events: [],
      truncated: false,
      throughRevision: 0,
      resyncRequired: "backlog_too_large",
    });
    expect(sync.body.delta).not.toHaveProperty("cursor");
  });
});

describe("R6 mutation idempotency", () => {
  it("replays the original response and rejects key reuse for another body", async () => {
    const current = Number(
      (await room.pool.query("SELECT revision FROM rooms WHERE id = $1", [room.roomId]))
        .rows[0].revision,
    );
    const body = {
      type: "SubmitRequirement",
      input: {
        baseRevision: current,
        visibility: "shared",
        hardness: "soft",
        delegation: { mode: "soft" },
        payload: { kind: "text", text: "quiet enough to talk" },
        note: "quiet enough to talk",
      },
    };
    const key = `idem_${Date.now()}`;
    const beforeEvents = Number(
      (await room.pool.query("SELECT count(*)::int AS n FROM events WHERE room_id = $1", [room.roomId]))
        .rows[0].n,
    );
    const first = await commandWithKey(room.tokens.org, key, body);
    const eventsAfterFirst = Number(
      (await room.pool.query("SELECT count(*)::int AS n FROM events WHERE room_id = $1", [room.roomId]))
        .rows[0].n,
    );
    const replay = await commandWithKey(room.tokens.org, key, body);
    expect(first.ok).toBe(true);
    expect(replay).toEqual(first);

    const afterEvents = Number(
      (await room.pool.query("SELECT count(*)::int AS n FROM events WHERE room_id = $1", [room.roomId]))
        .rows[0].n,
    );
    expect(afterEvents).toBeGreaterThan(beforeEvents);
    expect(afterEvents).toBe(eventsAfterFirst);
    expect(
      Number(
        (
          await room.pool.query(
            "SELECT count(*)::int AS n FROM requirements WHERE room_id = $1 AND note = $2",
            [room.roomId, "quiet enough to talk"],
          )
        ).rows[0].n,
      ),
    ).toBe(1);
    expect(
      Number(
        (await room.pool.query("SELECT revision FROM rooms WHERE id = $1", [room.roomId]))
          .rows[0].revision,
      ),
    ).toBe(first.revision);

    const mismatch = await commandWithKey(room.tokens.org, key, {
      type: "SetReadyState",
      input: { baseRevision: first.revision, state: "ready" },
    });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.error?.code).toBe("invalid_input");

    const stored = await room.pool.query(
      `SELECT extract(epoch FROM (expires_at - now())) AS ttl
         FROM command_idempotency
        WHERE participant_id = $1 AND idempotency_key = $2`,
      [room.participantIds.org, key],
    );
    expect(Number(stored.rows[0].ttl)).toBeGreaterThan(9 * 60);
    expect(Number(stored.rows[0].ttl)).toBeLessThanOrEqual(10 * 60);
  });

  it("stores and replays a completed failure outcome", async () => {
    const key = `idem_failure_${Date.now()}`;
    const staleBody = {
      type: "SetReadyState",
      input: { baseRevision: 0, state: "ready" },
    };
    const first = await commandWithKey(room.tokens.sarah, key, staleBody);
    const replay = await commandWithKey(room.tokens.sarah, key, staleBody);
    expect(first.ok).toBe(false);
    expect(first.error?.code).toBe("sync_required");
    expect(replay).toEqual(first);
  });
});

describe("R10 realtime ordering metadata", () => {
  it("delivers committed frames in revision order with a continuous fromRevision", async () => {
    const channel = await openRealtime(server.baseUrl, room.tokens.joe);
    try {
      let current = Number(
        (await room.pool.query("SELECT revision FROM rooms WHERE id = $1", [room.roomId]))
          .rows[0].revision,
      );
      const first = await apiPost<Envelope>(
        server.baseUrl,
        "/api/commands",
        room.tokens.sarah,
        {
          type: "SetReadyState",
          input: { baseRevision: current, state: "ready" },
        },
      );
      expect(first.body.ok).toBe(true);
      current = first.body.revision!;
      const second = await apiPost<Envelope>(
        server.baseUrl,
        "/api/commands",
        room.tokens.joe,
        {
          type: "SetReadyState",
          input: { baseRevision: current, state: "ready" },
        },
      );
      expect(second.body.ok).toBe(true);

      const deadline = Date.now() + 3000;
      let frames: Array<{ revision: number; fromRevision: number }> = [];
      while (Date.now() < deadline) {
        frames = channel
          .frames()
          .map((raw) => JSON.parse(raw) as Record<string, unknown>)
          .filter((frame) => frame.type === "event")
          .map((frame) => ({
            revision: Number(frame.revision),
            fromRevision: Number(frame.fromRevision),
          }))
          .filter((frame) => frame.revision >= current);
        if (frames.some((frame) => frame.revision === second.body.revision)) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const relevant = frames.filter(
        (frame) =>
          frame.revision === first.body.revision ||
          frame.revision === second.body.revision,
      );
      expect(relevant.map((frame) => frame.revision)).toEqual([
        first.body.revision,
        second.body.revision,
      ]);
      expect(relevant[0].fromRevision).toBe(first.body.revision! - 1);
      expect(relevant[1].fromRevision).toBe(first.body.revision);
    } finally {
      channel.close();
    }
  });
});
