import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { TOOL_CONTRACT_VERSION } from "@webmcp-hackathon/contracts";
import type { Participant } from "../../apps/server/src/auth.ts";
import { runAgent } from "../../apps/server/src/nl/agent.ts";
import { setTransport } from "../../apps/server/src/nl/openai.ts";
import {
  apiPost,
  createTestRoom,
  openRealtime,
  startServer,
  type TestRealtime,
  type TestRoom,
  type TestServer,
} from "./helpers.ts";

/**
 * The wire timeline in the page's `{ }` drawer needs three additive server
 * facts: which request a response answers and how long the server took
 * (headers), which request caused a socket frame (actor-only), and whether a
 * command response is an idempotent replay.
 */

interface Envelope {
  ok: boolean;
  revision?: number;
  replayed?: true;
  error?: { code: string };
}

interface EventFrame {
  type: string;
  revision?: number;
  causedBy?: { correlationId: string; command: string };
}

let server: TestServer;
let room: TestRoom;

beforeAll(async () => {
  server = await startServer();
  room = await createTestRoom(server.baseUrl);
});

afterAll(async () => {
  await room.cleanup();
  await server.stop();
});

async function currentRevision(): Promise<number> {
  return Number(
    (await room.pool.query("SELECT revision FROM rooms WHERE id = $1", [room.roomId]))
      .rows[0].revision,
  );
}

async function command(
  token: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ body: Envelope; headers: Headers }> {
  const response = await fetch(`${server.baseUrl}/api/commands`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      "x-tool-contract-version": TOOL_CONTRACT_VERSION,
      ...headers,
    },
    body: JSON.stringify(body),
  });
  return { body: (await response.json()) as Envelope, headers: response.headers };
}

function readyBody(baseRevision: number, state: "ready" | "contributing") {
  return { type: "SetReadyState", input: { baseRevision, state } };
}

async function eventFrameAt(
  realtime: TestRealtime,
  revision: number,
  timeoutMs = 5000,
): Promise<EventFrame | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const frame = realtime
      .frames()
      .map((raw) => JSON.parse(raw) as EventFrame)
      .find((f) => f.type === "event" && f.revision === revision);
    if (frame) return frame;
    if (Date.now() > deadline) return undefined;
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("wire timeline: response headers", () => {
  it("echoes the correlation id and reports server time on /api/commands", async () => {
    const correlation = `corr_${Date.now()}`;
    const { body, headers } = await command(
      room.tokens.org,
      readyBody(await currentRevision(), "ready"),
      { "x-correlation-id": correlation },
    );
    expect(body.ok).toBe(true);
    expect(headers.get("x-correlation-id")).toBe(correlation);
    const serverMs = headers.get("x-server-ms");
    expect(serverMs).toMatch(/^\d+$/);
    expect(Number(serverMs)).toBeLessThan(20_000);
  });

  it("reports server time on /api/sync and echoes no id when the page sent none", async () => {
    const response = await fetch(`${server.baseUrl}/api/sync`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${room.tokens.sarah}`,
        "x-tool-contract-version": TOOL_CONTRACT_VERSION,
      },
      body: JSON.stringify({}),
    });
    expect(response.ok).toBe(true);
    expect(response.headers.get("x-correlation-id")).toBeNull();
    expect(response.headers.get("x-server-ms")).toMatch(/^\d+$/);
  });

  it("bounds the echoed id to 128 characters", async () => {
    const long = "x".repeat(400);
    const response = await fetch(`${server.baseUrl}/api/meta`, {
      headers: { "x-correlation-id": long },
    });
    expect(response.ok).toBe(true);
    expect(response.headers.get("x-correlation-id")).toBe("x".repeat(128));
  });

  it("carries both headers on error responses too", async () => {
    const missing = await fetch(`${server.baseUrl}/api/no-such-route`, {
      headers: { "x-correlation-id": "corr_404" },
    });
    expect(missing.status).toBe(404);
    expect(missing.headers.get("x-correlation-id")).toBe("corr_404");
    expect(missing.headers.get("x-server-ms")).toMatch(/^\d+$/);

    const rejected = await fetch(`${server.baseUrl}/api/session/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-correlation-id": "corr_400" },
      body: JSON.stringify({}),
    });
    expect(rejected.status).toBe(400);
    expect(rejected.headers.get("x-correlation-id")).toBe("corr_400");
    expect(rejected.headers.get("x-server-ms")).toMatch(/^\d+$/);
  });
});

describe("wire timeline: causedBy on event frames", () => {
  it("names the request on the actor's socket and on no peer socket", async () => {
    const actor = await openRealtime(server.baseUrl, room.tokens.sarah);
    const peer = await openRealtime(server.baseUrl, room.tokens.joe);
    try {
      const correlation = `corr_cause_${Date.now()}`;
      const { body } = await command(
        room.tokens.sarah,
        readyBody(await currentRevision(), "ready"),
        { "x-correlation-id": correlation },
      );
      expect(body.ok).toBe(true);
      const revision = body.revision!;

      const own = await eventFrameAt(actor, revision);
      expect(own).toBeDefined();
      expect(own!.causedBy).toEqual({ correlationId: correlation, command: "SetReadyState" });

      // A ready-state change is public, so the peer receives the same
      // revision — and still nothing about who asked for it.
      const theirs = await eventFrameAt(peer, revision);
      expect(theirs).toBeDefined();
      expect(theirs).not.toHaveProperty("causedBy");
    } finally {
      actor.close();
      peer.close();
    }
  });

  it("names nothing when the request carried no id", async () => {
    const actor = await openRealtime(server.baseUrl, room.tokens.sarah);
    try {
      const { body } = await command(
        room.tokens.sarah,
        readyBody(await currentRevision(), "contributing"),
      );
      expect(body.ok).toBe(true);
      const own = await eventFrameAt(actor, body.revision!);
      expect(own).toBeDefined();
      expect(own).not.toHaveProperty("causedBy");
    } finally {
      actor.close();
    }
  });
});

describe("wire timeline: idempotent replay marker", () => {
  it("marks the second answer for the same key as a replay and leaves the row alone", async () => {
    const key = `wire_idem_${Date.now()}`;
    const body = readyBody(await currentRevision(), "contributing");
    const first = await command(room.tokens.org, body, { "idempotency-key": key });
    const replay = await command(room.tokens.org, body, { "idempotency-key": key });
    expect(first.body.ok).toBe(true);
    expect(first.body).not.toHaveProperty("replayed");
    expect(replay.body).toEqual({ ...first.body, replayed: true });

    const stored = (
      await room.pool.query(
        `SELECT response FROM command_idempotency
          WHERE participant_id = $1 AND idempotency_key = $2`,
        [room.participantIds.org, key],
      )
    ).rows[0] as { response: Envelope };
    expect(stored.response).not.toHaveProperty("replayed");
  });

  it("does not mark a replayed failure", async () => {
    const key = `wire_idem_fail_${Date.now()}`;
    const stale = readyBody(0, "ready");
    const first = await command(room.tokens.joe, stale, { "idempotency-key": key });
    const replay = await command(room.tokens.joe, stale, { "idempotency-key": key });
    expect(first.body.ok).toBe(false);
    expect(first.body.error?.code).toBe("sync_required");
    expect(replay.body).toEqual(first.body);
  });
});

describe("wire timeline: a plain sync is still shaped as before", () => {
  it("answers /api/sync without any new body field", async () => {
    const sync = await apiPost<{ ok: boolean }>(server.baseUrl, "/api/sync", room.tokens.org, {});
    expect(sync.body.ok).toBe(true);
    expect(sync.raw).not.toContain("causedBy");
    expect(sync.raw).not.toContain("replayed");
  });
});

describe("wire timeline: the agent's tool calls", () => {
  afterEach(() => setTransport(null));

  it("records every call that ran with exactly tool, round, ok and ms", async () => {
    let round = 0;
    setTransport(async () => {
      round += 1;
      if (round === 1) {
        return {
          output: [
            { type: "function_call", call_id: "c1", name: "get_spatial_context", arguments: "{}" },
            { type: "function_call", call_id: "c2", name: "set_ready_state", arguments: JSON.stringify({ state: "ready" }) },
            // R14: a second mutation in one round is deferred, never run.
            { type: "function_call", call_id: "c3", name: "set_ready_state", arguments: JSON.stringify({ state: "contributing" }) },
          ],
        };
      }
      return {
        output: [{ type: "message", content: [{ type: "output_text", text: "You are marked ready." }] }],
      };
    });
    const actor: Participant = {
      id: room.participantIds.org,
      roomId: room.roomId,
      displayName: "Alex",
      role: "organizer",
      readyState: "contributing",
    };

    const outcome = await runAgent(actor, "mark me ready", null);

    expect(outcome.partial).toBeUndefined();
    expect(outcome.meta.rounds).toBe(2);
    // The deferred third call left no step: nothing ran.
    expect(outcome.meta.calls).toHaveLength(2);
    for (const call of outcome.meta.calls) {
      expect(Object.keys(call).sort()).toEqual(["ms", "ok", "round", "tool"]);
      expect(call.ms).toBeGreaterThanOrEqual(0);
    }
    expect(outcome.meta.calls[0]).toMatchObject({ tool: "get_spatial_context", round: 1, ok: true });
    expect(outcome.meta.calls[1]).toMatchObject({ tool: "set_ready_state", round: 1, ok: true });
    expect(JSON.stringify(outcome.meta.calls)).not.toContain("arguments");
  });
});

describe("wire timeline: an agent-private condition's own frame", () => {
  let nlServer: TestServer;
  let nlRoom: TestRoom;

  beforeAll(async () => {
    nlServer = await startServer({
      entrypoint: "tests/api/fixtures/wire-timeline-nl-server.ts",
      env: { OPENAI_API_KEY: "scripted-only" },
    });
    nlRoom = await createTestRoom(nlServer.baseUrl);
  });

  afterAll(async () => {
    await nlRoom.cleanup();
    await nlServer.stop();
  });

  it("reaches the owner's socket with causedBy naming the condition request", async () => {
    const owner = await openRealtime(nlServer.baseUrl, nlRoom.tokens.joe);
    const peer = await openRealtime(nlServer.baseUrl, nlRoom.tokens.sarah);
    try {
      const correlation = `corr_condition_${Date.now()}`;
      const response = await fetch(`${nlServer.baseUrl}/api/nl/condition`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${nlRoom.tokens.joe}`,
          "x-correlation-id": correlation,
        },
        body: JSON.stringify({ text: "nothing with peanuts on the menu" }),
      });
      const body = (await response.json()) as Envelope;
      expect(body.ok).toBe(true);
      expect(response.headers.get("x-correlation-id")).toBe(correlation);

      const own = await eventFrameAt(owner, body.revision!);
      expect(own).toBeDefined();
      expect(own!.causedBy).toEqual({ correlationId: correlation, command: "SubmitRequirement" });

      const theirs = await eventFrameAt(peer, body.revision!);
      expect(theirs).toBeDefined();
      expect(theirs).not.toHaveProperty("causedBy");
    } finally {
      owner.close();
      peer.close();
    }
  });
});
