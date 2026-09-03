import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestRoom, startServer, type TestRoom, type TestServer } from "./helpers.ts";

let server: TestServer;
let room: TestRoom;

beforeAll(async () => {
  server = await startServer({
    entrypoint: "tests/api/fixtures/nl-clarify-server.ts",
    env: { OPENAI_API_KEY: "scripted-only" },
  });
  room = await createTestRoom(server.baseUrl);
});

afterAll(async () => {
  await room.cleanup();
  await server.stop();
});

async function say(text: string, key?: string) {
  const response = await fetch(`${server.baseUrl}/api/nl/say`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${room.tokens.org}`,
      ...(key ? { "idempotency-key": key } : {}),
    },
    body: JSON.stringify({ text, scope: "shared" }),
  });
  return response.json() as Promise<Record<string, any>>;
}

describe("model-free natural-language clarification API", () => {
  it.each([
    ["places that are at most 500m away from me", { kind: "scope", dimension: "radius_m", max: 500 }],
    ["max 500m distance", { kind: "scope", dimension: "radius_m", max: 500 }],
    ["within 500 m", { kind: "scope", dimension: "radius_m", max: 500 }],
    ["max 500 m vom Alexanderplatz", { kind: "scope", dimension: "radius_m", max: 500, referent: { kind: "landmark", landmarkId: "landmark_alexanderplatz" } }],
    ["nah am Bahnhof Friedrichstraße", { kind: "scope", dimension: "walk_min", max: 10, referent: { kind: "landmark", landmarkId: "landmark_friedrichstrasse" } }],
    ["not more than 20 min by bike", { kind: "scope", dimension: "travel_min", max: 20, mode: "bike" }],
  ])("maps %s without transport", async (text, payload) => {
    const result = await say(text);
    expect(result).toMatchObject({ ok: true, intent: "need", needs: [{ payload }] });
    expect(result.meta.route.model).toBeNull();
  });

  it("returns the concrete clarify contract for a number without a unit", async () => {
    const result = await say("under 20");
    expect(result).toMatchObject({
      ok: true,
      intent: "clarify",
      needs: [],
      clarify: {
        question: "20 what?",
        allowFreeText: true,
        said: "under 20",
        choices: [
          { id: "c1", label: "€20 per person", needs: [{ payload: { kind: "budget" } }] },
          { id: "c2", label: "20 min walk", needs: [{ payload: { kind: "scope", dimension: "walk_min" } }] },
        ],
      },
    });
  });

  it("returns an understood need immediately while asking only about the remainder", async () => {
    const result = await say("within 500 m and under 20");
    expect(result.intent).toBe("clarify");
    expect(result.needs).toMatchObject([{ payload: { kind: "scope", dimension: "radius_m", max: 500 } }]);
    expect(result.clarify.question).toBe("20 what?");
  });

  it("replays the same model-free clarify turn for one idempotency key", async () => {
    const key = `clarify-${Date.now()}`;
    const first = await say("under 20", key);
    const replay = await say("under 20", key);
    expect(replay).toEqual(first);
  });
});
