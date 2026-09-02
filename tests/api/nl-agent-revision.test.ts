import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Participant } from "../../apps/server/src/auth.ts";
import { runAgent } from "../../apps/server/src/nl/agent.ts";
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

afterEach(() => setTransport(null));

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
