import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Participant } from "../../apps/server/src/auth.ts";
import { submitCommand } from "../../apps/server/src/engine.ts";
import { runAgent } from "../../apps/server/src/nl/agent.ts";
import { hold, release } from "../../apps/server/src/nl/holder.ts";
import { setTransport } from "../../apps/server/src/nl/openai.ts";
import { screen } from "../../apps/server/src/nl/screening.ts";
import {
  createTestRoom,
  startServer,
  type TestRoom,
  type TestServer,
} from "./helpers.ts";

let server: TestServer;
let room: TestRoom;

const participantId = (kind: "org" | "sarah" | "joe") =>
  `p_${kind}_${room.roomId.replace("room_test_", "")}`;

beforeAll(async () => {
  server = await startServer();
  room = await createTestRoom(server.baseUrl);
});

afterEach(() => {
  setTransport(null);
  if (room) release(participantId("joe"));
});

afterAll(async () => {
  await room.cleanup();
  await server.stop();
});

describe("R2 in-page agent revision discipline", () => {
  it("feeds a stale mutation back as sync_required without silently replaying it", async () => {
    let releaseModel!: () => void;
    let modelStarted!: () => void;
    const started = new Promise<void>((resolve) => (modelStarted = resolve));
    const released = new Promise<void>((resolve) => (releaseModel = resolve));
    let round = 0;
    let secondInput = "";
    setTransport(async (body) => {
      round += 1;
      if (round === 1) {
        modelStarted();
        await released;
        return {
          output: [
            {
              type: "function_call",
              call_id: "call_stale",
              name: "set_ready_state",
              arguments: JSON.stringify({ state: "ready" }),
            },
          ],
        };
      }
      secondInput = JSON.stringify(body.input);
      return {
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: "The room moved before that change, so nothing was changed.",
              },
            ],
          },
        ],
      };
    });

    const actor: Participant = {
      id: participantId("org"),
      roomId: room.roomId,
      displayName: "Alex",
      role: "organizer",
      readyState: "contributing",
    };
    const sarah: Participant = {
      id: participantId("sarah"),
      roomId: room.roomId,
      displayName: "Sarah",
      role: "member",
      readyState: "contributing",
    };
    const baseRevision = Number(
      (await room.pool.query("SELECT revision FROM rooms WHERE id = $1", [room.roomId])).rows[0]
        .revision,
    );
    const agent = runAgent(actor, "mark me ready", null);
    await started;
    const competing = await submitCommand(sarah, "SetReadyState", {
      baseRevision,
      state: "ready",
    });
    releaseModel();
    expect(competing.ok).toBe(true);

    const outcome = await agent;
    expect(outcome.actions).toHaveLength(1);
    expect(outcome.actions[0]).toMatchObject({ ok: false });
    expect(outcome.actions[0].effect).toContain("sync_required");
    expect(secondInput).toContain("sync_required");

    const organizer = await room.pool.query(
      "SELECT ready_state FROM participants WHERE id = $1",
      [participantId("org")],
    );
    expect(organizer.rows[0].ready_state).toBe("contributing");
  });
});

describe("R3 page-held screening invalidation", () => {
  it("screens a changed candidate again after its map revision bumps", async () => {
    const joe: Participant = {
      id: participantId("joe"),
      roomId: room.roomId,
      displayName: "Joe",
      role: "member",
      readyState: "contributing",
    };
    const sarah: Participant = {
      id: participantId("sarah"),
      roomId: room.roomId,
      displayName: "Sarah",
      role: "member",
      readyState: "ready",
    };
    const candidateIds = (
      await room.pool.query("SELECT id, map_revision FROM candidates WHERE room_id = $1 ORDER BY id", [
        room.roomId,
      ])
    ).rows as Array<{ id: string; map_revision: number }>;
    const ids = candidateIds.map((row) => row.id);
    const changedId = ids[0];
    let revision = Number(
      (await room.pool.query("SELECT revision FROM rooms WHERE id = $1", [room.roomId])).rows[0]
        .revision,
    );

    const declared = await submitCommand(joe, "SubmitRequirement", {
      baseRevision: revision,
      requirementId: `req_held_${room.roomId}`,
      visibility: "agent-private",
      hardness: "hard",
      delegation: { mode: "approval_required" },
      scopeHint: { affects: "candidate-eligibility" },
    });
    expect(declared.ok).toBe(true);
    if (!declared.ok) return;
    revision = declared.revision;

    const first = await submitCommand(joe, "EvaluateCandidates", {
      baseRevision: revision,
      verdicts: candidateIds.map((candidate) => ({
        candidateId: candidate.id,
        verdict: "acceptable",
        screenedMapRevision: Number(candidate.map_revision),
      })),
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    revision = first.revision;

    hold(joe.id, joe.roomId, "a condition kept only by the page agent");
    let screeningCalls = 0;
    setTransport(async () => {
      screeningCalls += 1;
      return {
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: JSON.stringify({
                  verdicts: [{ candidateId: changedId, verdict: "acceptable" }],
                }),
              },
            ],
          },
        ],
      };
    });

    const attested = await submitCommand(sarah, "AttestAttribute", {
      baseRevision: revision,
      candidateId: changedId,
      key: "dog-friendly",
      status: "verified_true",
      confidence: 0.8,
      note: "staff confirmed it",
    });
    expect(attested.ok).toBe(true);

    const deadline = Date.now() + 3000;
    let refreshed = false;
    while (Date.now() < deadline) {
      const row = (
        await room.pool.query(
          `SELECT v.verdict, v.screened_map_revision, c.map_revision
             FROM candidates c
             LEFT JOIN verdicts v ON v.room_id = c.room_id
              AND v.candidate_id = c.id AND v.owner_id = $2
            WHERE c.room_id = $1 AND c.id = $3`,
          [room.roomId, joe.id, changedId],
        )
      ).rows[0];
      if (
        row?.verdict === "acceptable" &&
        Number(row.screened_map_revision) === Number(row.map_revision)
      ) {
        refreshed = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(screeningCalls).toBeGreaterThan(0);
    expect(refreshed).toBe(true);
  });

  it("does not stamp a verdict as current when facts change while screening", async () => {
    const joe: Participant = {
      id: participantId("joe"), roomId: room.roomId, displayName: "Joe",
      role: "member", readyState: "contributing",
    };
    const sarah: Participant = {
      id: participantId("sarah"), roomId: room.roomId, displayName: "Sarah",
      role: "member", readyState: "ready",
    };
    const candidateId = (
      await room.pool.query("SELECT id FROM candidates WHERE room_id = $1 ORDER BY id LIMIT 1", [room.roomId])
    ).rows[0].id as string;
    let modelStarted!: () => void;
    let releaseModel!: () => void;
    const started = new Promise<void>((resolve) => (modelStarted = resolve));
    const released = new Promise<void>((resolve) => (releaseModel = resolve));
    setTransport(async () => {
      modelStarted();
      await released;
      return {
        output: [{
          type: "message",
          content: [{
            type: "output_text",
            text: JSON.stringify({ verdicts: [{ candidateId, verdict: "unacceptable" }] }),
          }],
        }],
      };
    });

    const screening = screen(joe, "a private condition", [candidateId]);
    await started;
    const revision = Number(
      (await room.pool.query("SELECT revision FROM rooms WHERE id = $1", [room.roomId])).rows[0].revision,
    );
    const changed = await submitCommand(sarah, "AttestAttribute", {
      baseRevision: revision,
      candidateId,
      key: "outdoor-seating",
      status: "verified_true",
      confidence: 0.9,
      note: "checked while screening was running",
    });
    expect(changed.ok).toBe(true);
    releaseModel();

    const outcome = await screening;
    expect(outcome.screened).toBe(0);
    const row = (
      await room.pool.query(
        `SELECT v.screened_map_revision, c.map_revision
           FROM candidates c
           LEFT JOIN verdicts v ON v.room_id = c.room_id
            AND v.candidate_id = c.id AND v.owner_id = $2
          WHERE c.room_id = $1 AND c.id = $3`,
        [room.roomId, joe.id, candidateId],
      )
    ).rows[0];
    expect(Number(row.screened_map_revision)).toBeLessThan(Number(row.map_revision));
  });

  it("records an explicitly old screened map revision as stale", async () => {
    const joe: Participant = {
      id: participantId("joe"), roomId: room.roomId, displayName: "Joe",
      role: "member", readyState: "contributing",
    };
    const candidate = (
      await room.pool.query(
        "SELECT id, map_revision FROM candidates WHERE room_id = $1 ORDER BY id LIMIT 1",
        [room.roomId],
      )
    ).rows[0] as { id: string; map_revision: number };
    const revision = Number(
      (await room.pool.query("SELECT revision FROM rooms WHERE id = $1", [room.roomId])).rows[0].revision,
    );
    const screenedMapRevision = Number(candidate.map_revision) - 1;
    const result = await submitCommand(joe, "EvaluateCandidates", {
      baseRevision: revision,
      verdicts: [{ candidateId: candidate.id, verdict: "unacceptable", screenedMapRevision }],
    });
    expect(result.ok).toBe(true);
    const stored = (
      await room.pool.query(
        `SELECT screened_map_revision FROM verdicts
          WHERE room_id = $1 AND owner_id = $2 AND candidate_id = $3`,
        [room.roomId, joe.id, candidate.id],
      )
    ).rows[0];
    expect(Number(stored.screened_map_revision)).toBe(screenedMapRevision);
    expect(Number(stored.screened_map_revision)).toBeLessThan(Number(candidate.map_revision));
  });
});

describe("R7 partial NL turns", () => {
  it("returns and persists a completed action when the next model round fails", async () => {
    const actor: Participant = {
      id: participantId("sarah"),
      roomId: room.roomId,
      displayName: "Sarah",
      role: "member",
      readyState: "ready",
    };
    const before = Number(
      (
        await room.pool.query(
          "SELECT count(*)::int AS count FROM nl_agent_actions WHERE participant_id = $1",
          [actor.id],
        )
      ).rows[0].count,
    );
    let round = 0;
    setTransport(async () => {
      round += 1;
      if (round === 1) {
        return {
          output: [
            {
              type: "function_call",
              call_id: "call_completed",
              name: "set_ready_state",
              arguments: JSON.stringify({ state: "contributing" }),
            },
          ],
        };
      }
      throw new Error("scripted model failure");
    });

    const outcome = await runAgent(actor, "keep contributing", null);
    expect(outcome).toMatchObject({ partial: true, failureCategory: "model" });
    expect(outcome.actions).toHaveLength(1);
    expect(outcome.actions[0]).toMatchObject({ tool: "set_ready_state", ok: true });
    expect(outcome.reply).toContain("completed changes");
    const stored = await room.pool.query(
      `SELECT tool, ok, effect FROM nl_agent_actions
        WHERE participant_id = $1 ORDER BY id DESC LIMIT 1`,
      [actor.id],
    );
    expect(stored.rows[0]).toMatchObject({ tool: "set_ready_state", ok: true });
    const after = Number(
      (
        await room.pool.query(
          "SELECT count(*)::int AS count FROM nl_agent_actions WHERE participant_id = $1",
          [actor.id],
        )
      ).rows[0].count,
    );
    expect(after).toBe(before + 1);
    expect(
      (await room.pool.query("SELECT ready_state FROM participants WHERE id = $1", [actor.id]))
        .rows[0].ready_state,
    ).toBe("contributing");
  });
});

describe("R14 NL resource bounds", () => {
  it("applies one total deadline across multiple slow model rounds", async () => {
    const actor: Participant = {
      id: participantId("joe"),
      roomId: room.roomId,
      displayName: "Joe",
      role: "member",
      readyState: "contributing",
    };
    const timeouts: number[] = [];
    let round = 0;
    setTransport(async (_body, timeoutMs) => {
      timeouts.push(timeoutMs);
      round += 1;
      if (round === 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return {
          output: [
            {
              type: "function_call",
              call_id: "call_read",
              name: "get_spatial_context",
              arguments: "{}",
            },
          ],
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
      return { output: [] };
    });

    const started = Date.now();
    const outcome = await runAgent(actor, "what changed", null, { deadlineMs: 220 });
    expect(outcome).toMatchObject({ partial: true, failureCategory: "deadline" });
    expect(Date.now() - started).toBeLessThan(400);
    expect(timeouts).toHaveLength(2);
    expect(timeouts[1]).toBeLessThan(timeouts[0]);
  });

  it("defers a second mutation from the same model batch", async () => {
    const actor: Participant = {
      id: participantId("org"),
      roomId: room.roomId,
      displayName: "Alex",
      role: "organizer",
      readyState: "contributing",
    };
    let round = 0;
    setTransport(async () => {
      round += 1;
      if (round === 1) {
        return {
          output: [
            {
              type: "function_call",
              call_id: "call_first",
              name: "set_ready_state",
              arguments: JSON.stringify({ state: "ready" }),
            },
            {
              type: "function_call",
              call_id: "call_deferred",
              name: "set_ready_state",
              arguments: JSON.stringify({ state: "contributing" }),
            },
          ],
        };
      }
      return {
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "You are marked ready." }],
          },
        ],
      };
    });

    const outcome = await runAgent(actor, "mark me ready, then undo it", null);
    expect(outcome.partial).toBeUndefined();
    expect(outcome.actions).toHaveLength(2);
    expect(outcome.actions[0]).toMatchObject({ ok: true });
    expect(outcome.actions[1]).toMatchObject({ ok: false });
    expect(outcome.actions[1].effect).toContain("Only one mutation");
    expect(
      (await room.pool.query("SELECT ready_state FROM participants WHERE id = $1", [actor.id]))
        .rows[0].ready_state,
    ).toBe("ready");
  });
});
