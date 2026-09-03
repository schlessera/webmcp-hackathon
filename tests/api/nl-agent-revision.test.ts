import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Participant } from "../../apps/server/src/auth.ts";
import { submitCommand } from "../../apps/server/src/engine.ts";
import { runAgent } from "../../apps/server/src/nl/agent.ts";
import { hold, release } from "../../apps/server/src/nl/holder.ts";
import { setTransport } from "../../apps/server/src/nl/openai.ts";
import {
  apiPost,
  createTestRoom,
  startServer,
  type TestRoom,
  type TestServer,
} from "./helpers.ts";

let server: TestServer;
let room: TestRoom;

beforeAll(async () => {
  server = await startServer();
  room = await createTestRoom(server.baseUrl);
});

afterEach(() => {
  setTransport(null);
  if (room) release(room.participantIds.joe);
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
      id: room.participantIds.org,
      roomId: room.roomId,
      displayName: "Alex",
      role: "organizer",
      readyState: "contributing",
    };
    const agent = runAgent(actor, "mark me ready", null);
    await started;
    const competing = await apiPost<{ ok: boolean; revision: number }>(
      server.baseUrl,
      "/api/commands",
      room.tokens.sarah,
      {
        type: "SetReadyState",
        input: { baseRevision: 0, state: "ready" },
      },
    );
    expect(competing.body.ok).toBe(true);
    releaseModel();

    const outcome = await agent;
    expect(outcome.actions).toHaveLength(1);
    expect(outcome.actions[0]).toMatchObject({ ok: false });
    expect(outcome.actions[0].effect).toContain("sync_required");
    expect(secondInput).toContain("sync_required");

    const organizer = await room.pool.query(
      "SELECT ready_state FROM participants WHERE id = $1",
      [room.participantIds.org],
    );
    expect(organizer.rows[0].ready_state).toBe("contributing");
  });
});

describe("R3 page-held screening invalidation", () => {
  it("screens a changed candidate again after its map revision bumps", async () => {
    const joe: Participant = {
      id: room.participantIds.joe,
      roomId: room.roomId,
      displayName: "Joe",
      role: "member",
      readyState: "contributing",
    };
    const sarah: Participant = {
      id: room.participantIds.sarah,
      roomId: room.roomId,
      displayName: "Sarah",
      role: "member",
      readyState: "ready",
    };
    const candidateIds = (
      await room.pool.query("SELECT id FROM candidates WHERE room_id = $1 ORDER BY id", [
        room.roomId,
      ])
    ).rows.map((row) => row.id as string);
    const changedId = candidateIds[0];
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
      verdicts: candidateIds.map((candidateId) => ({ candidateId, verdict: "acceptable" })),
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
});
