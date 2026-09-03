import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestRoom,
  startServer,
  type TestRoom,
  type TestServer,
} from "./helpers.ts";

let server: TestServer;
let room: TestRoom;

beforeAll(async () => {
  server = await startServer({
    entrypoint: "tests/api/fixtures/nl-idempotency-server.ts",
    env: { OPENAI_API_KEY: "test" },
  });
  room = await createTestRoom(server.baseUrl);
});

afterAll(async () => {
  await room.cleanup();
  await server.stop();
});

describe("X3 natural-language turn idempotency", () => {
  it("replays one turn for the same participant, key, and body", async () => {
    const key = `nl-turn-${Date.now()}`;
    const send = async () => {
      const response = await fetch(`${server.baseUrl}/api/nl/say`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${room.tokens.org}`,
          "idempotency-key": key,
        },
        body: JSON.stringify({ text: "What is happening?", scope: "shared" }),
      });
      return response.json() as Promise<Record<string, unknown>>;
    };

    const first = await send();
    const replay = await send();
    expect(first).toMatchObject({ ok: true, intent: "ask" });
    expect(replay).toEqual(first);
    const pid = Number(server.logs().match(/NL_SERVER_PID=(\d+)/)?.[1]);
    expect(pid).toBeGreaterThan(0);
    process.kill(pid, "SIGUSR2");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(server.logs()).toContain("NL_TRANSPORT_CALLS=2");
  });
});
