import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiPost, createTestRoom, startServer, type TestRoom, type TestServer } from "./helpers.ts";

/** E2 over HTTP: a pizza record can satisfy Italian without exposing wire vocabulary. */
describe("cuisine criteria over the API", () => {
  let server: TestServer;
  let room: TestRoom;

  beforeAll(async () => {
    server = await startServer();
    room = await createTestRoom(server.baseUrl);
    await room.pool.query(
      "UPDATE candidates SET attributes = $1 WHERE room_id = $2 AND name = 'Alpha'",
      [JSON.stringify([{ key: "cuisine", status: "verified_true", value: "pizza" }]), room.roomId],
    );
  });

  afterAll(async () => {
    await room.cleanup();
    await server.stop();
  });

  it("reads Italian as eligible from pizza with reader-facing evidence", async () => {
    const submitted = await apiPost<{ ok: boolean; revision: number }>(server.baseUrl, "/api/commands", room.tokens.org, {
      type: "SubmitRequirement",
      input: {
        baseRevision: 0,
        visibility: "shared",
        hardness: "hard",
        delegation: { mode: "approval_required" },
        payload: { kind: "inclusion", key: "cuisine", values: ["Italian"], lifetime: "session" },
      },
    });
    expect(submitted.body.ok).toBe(true);

    const context = await apiPost<{
      ok: boolean;
      candidates: Array<{ name: string; eligibility: string; why: string }>;
    }>(server.baseUrl, "/api/spatial/context", room.tokens.org, {});
    const alpha = context.body.candidates.find((candidate) => candidate.name === "Alpha")!;
    expect(alpha).toMatchObject({ eligibility: "eligible", why: "serves pizza, which is usually Italian" });
    expect(alpha.why).not.toMatch(/cuisine|verified_true|likely_true|q:/i);
  });
});
