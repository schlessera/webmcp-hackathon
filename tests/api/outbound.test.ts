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
    entrypoint: "tests/api/fixtures/outbound-server.ts",
    env: {
      ENRICH_NETWORK: "1",
      PROXY: "1",
      PROXY_URL: "http://user:key@127.0.0.1:31112",
    },
  });
  room = await createTestRoom(server.baseUrl);
});

afterAll(async () => {
  await room?.cleanup();
  await server?.stop();
});

describe("outbound diagnostics API", () => {
  it("reports a rotated CONNECT retry and a non-retried target 404", async () => {
    const unauthorized = await fetch(`${server.baseUrl}/api/diag/outbound`);
    expect(unauthorized.status).toBe(401);
    type Body = {
      rows: Array<{
        host: string;
        route: string;
        attempts: number;
        successes: number;
        proxyFailures: Record<string, number>;
        targetStatus: Record<string, number>;
      }>;
    };
    // The fixture starts listening before its scripted diagnostic requests
    // finish. Poll the authenticated view rather than racing startup.
    let row: Body["rows"][number] | undefined;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const response = await fetch(`${server.baseUrl}/api/diag/outbound`, {
        headers: { authorization: `Bearer ${room.tokens.org}` },
      });
      expect(response.status).toBe(200);
      const body = await response.json() as Body;
      row = body.rows.find((entry) =>
        entry.host === "example.org" && entry.route === "proxy" && entry.attempts >= 3
      );
      if (row) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(row).toMatchObject({
      attempts: 3,
      successes: 1,
      proxyFailures: { "proxy-reported-target": 1 },
      targetStatus: { "404": 1 },
    });
  });
});
