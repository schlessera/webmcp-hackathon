import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TOOL_CONTRACT_VERSION } from "@webmcp-hackathon/contracts";
import {
  apiPost,
  createTestRoom,
  openRealtime,
  startServer,
  type TestRoom,
  type TestServer,
} from "./helpers.ts";

const WsWebSocket = createRequire(
  new URL("../../apps/server/package.json", import.meta.url),
)("ws") as any;

interface Failure {
  ok: false;
  error: { code: string; message: string; recovery: string };
}

let server: TestServer;
let room: TestRoom;
let buildId: string;

beforeAll(async () => {
  server = await startServer();
  room = await createTestRoom(server.baseUrl);
  buildId = ((await (await fetch(`${server.baseUrl}/api/meta`)).json()) as { buildId: string }).buildId;
});

afterAll(async () => {
  await room.cleanup();
  await server.stop();
});

const command = (type: string, input: unknown) =>
  apiPost<Failure>(server.baseUrl, "/api/commands", room.tokens.org, { type, input });

async function firstWsError(message: unknown): Promise<{ code: string; message: string }> {
  const socket = new WsWebSocket(`${server.baseUrl.replace(/^http/, "ws")}/ws`);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const error = new Promise<{ code: string; message: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no websocket error")), 2000);
      socket.on("message", (raw: unknown) => {
        const parsed = JSON.parse(String(raw)) as { type: string; code: string; message: string };
        if (parsed.type !== "error") return;
        clearTimeout(timer);
        resolve(parsed);
      });
    });
    socket.send(JSON.stringify(message));
    return await error;
  } finally {
    socket.terminate();
  }
}

describe("WebSocket validation", () => {
  const validAuth = () => ({
    type: "auth",
    token: room.tokens.org,
    clientBuildId: buildId,
    clientToolContractVersion: TOOL_CONTRACT_VERSION,
  });

  it("requires and checks both client version fields", async () => {
    for (const missing of ["clientBuildId", "clientToolContractVersion"] as const) {
      const auth = validAuth() as Record<string, unknown>;
      delete auth[missing];
      expect((await firstWsError(auth)).code, missing).toBe("invalid_message");
    }
    expect((await firstWsError({ ...validAuth(), clientBuildId: "stale-build" })).code)
      .toBe("upgrade_required");
    expect((await firstWsError({ ...validAuth(), clientToolContractVersion: "0" })).code)
      .toBe("upgrade_required");
  });

  it("rejects malformed and unknown viewing candidates without clearing state", async () => {
    const realtime = await openRealtime(server.baseUrl, room.tokens.org);
    try {
      realtime.send({ type: "viewing", candidateId: `place_a_${room.roomId.slice(-8)}` });
      const viewingDeadline = Date.now() + 3000;
      while (Date.now() < viewingDeadline) {
        const shown = realtime.frames()
          .map((raw) => JSON.parse(raw) as { type: string; viewing?: Array<{ candidateId: string }> })
          .some((frame) => frame.type === "presence" &&
            frame.viewing?.some((item) => item.candidateId === `place_a_${room.roomId.slice(-8)}`));
        if (shown) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      realtime.send({ type: "viewing", candidateId: 42 });
      realtime.send({ type: "viewing", candidateId: "place_missing" });
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const errors = realtime.frames()
          .map((raw) => JSON.parse(raw) as { type: string; code?: string })
          .filter((frame) => frame.type === "error");
        if (errors.length >= 2) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const errors = realtime.frames()
        .map((raw) => JSON.parse(raw) as { type: string; code?: string })
        .filter((frame) => frame.type === "error");
      expect(errors).toHaveLength(2);
      expect(errors.every((frame) => frame.code === "invalid_message")).toBe(true);
      const presence = realtime.frames()
        .map((raw) => JSON.parse(raw) as { type: string; viewing?: Array<{ participantId: string; candidateId: string }> })
        .filter((frame) => frame.type === "presence")
        .at(-1)!;
      expect(presence.viewing).toContainEqual({
        participantId: room.participantIds.org,
        candidateId: `place_a_${room.roomId.slice(-8)}`,
      });
    } finally {
      realtime.close();
    }
  });
});

describe("actionable HTTP validation", () => {
  it("wraps malformed primitives and additional properties on every read route", async () => {
    for (const [path, body] of [
      ["/api/sync", []],
      ["/api/spatial/context", { unexpected: true }],
      ["/api/spatial/inspect", { candidateIds: "place_a" }],
      ["/api/spatial/navigation", { candidateId: 42 }],
    ] as const) {
      const result = await apiPost<Failure>(server.baseUrl, path, room.tokens.org, body);
      expect(result.body.error.code, path).toBe("invalid_input");
      expect(result.body.error.recovery, path).toBeTruthy();
    }
    expect((await command("SetReadyState", {
      baseRevision: 0,
      state: "ready",
      actorId: room.participantIds.joe,
    })).body.error.code).toBe("invalid_input");
  });

  it("returns received and allowed values for invalid enums", async () => {
    const invalidEnums: Array<[string, Record<string, unknown>]> = [
      ["SubmitRequirement", { baseRevision: 0, visibility: "secret", hardness: "hard", delegation: { mode: "locked" }, payload: { kind: "text", text: "x" } }],
      ["SubmitRequirement", { baseRevision: 0, visibility: "shared", hardness: "rigid", delegation: { mode: "locked" }, payload: { kind: "text", text: "x" } }],
      ["SubmitRequirement", { baseRevision: 0, visibility: "shared", hardness: "hard", delegation: { mode: "sometimes" }, payload: { kind: "text", text: "x" } }],
      ["EvaluateCandidates", { baseRevision: 0, verdicts: [{ candidateId: "place_a", verdict: "maybe" }] }],
      ["RespondToProposal", { baseRevision: 0, proposalId: room.proposalId, disposition: "maybe", visibility: "shared" }],
      ["RespondToProposal", { baseRevision: 0, proposalId: room.proposalId, disposition: "accept", visibility: "secret" }],
      ["SetReadyState", { baseRevision: 0, state: "later" }],
      ["SetSearchScope", { baseRevision: 0, transport: ["transit"] }],
      ["PlanArrival", { baseRevision: 0, mode: "transit" }],
      ["AttestAttribute", { baseRevision: 0, candidateId: "place_a", key: "vegan-options", status: "maybe", confidence: 1, note: "checked" }],
      ["ResolvePrivateRequest", { baseRevision: 0, requestId: "request", decision: "maybe" }],
    ];
    for (const [type, input] of invalidEnums) {
      const { body } = await command(type, input);
      expect(body.error.code, type).toBe("invalid_input");
      expect(body.error.message, type).toContain("received");
      expect(body.error.message, type).toContain("allowed values");
    }
    const ready = (await command("SetReadyState", { baseRevision: 0, state: "later" })).body;
    expect(ready.error.message).toContain('"contributing"');
    expect(ready.error.message).toContain('"ready"');
  });

  it("rejects duplicate verdict targets and needs_info without infoNeeded", async () => {
    const duplicate = await command("EvaluateCandidates", {
      baseRevision: 0,
      verdicts: [
        { candidateId: "place_a", verdict: "acceptable" },
        { candidateId: "place_a", verdict: "unacceptable" },
      ],
    });
    expect(duplicate.body.error.code).toBe("invalid_input");
    expect(duplicate.body.error.message).toContain("Duplicate verdict candidateId");

    const missing = await command("EvaluateCandidates", {
      baseRevision: 0,
      verdicts: [{ candidateId: "place_a", verdict: "needs_info" }],
    });
    expect(missing.body.error.code).toBe("invalid_input");
    expect(missing.body.error.message).toContain("infoNeeded");
  });

  it("validates attestation sourceUrl with the loaded URI format", async () => {
    const result = await command("AttestAttribute", {
      baseRevision: 0,
      candidateId: `place_a_${room.roomId.slice(-8)}`,
      key: "vegan-options",
      status: "verified_true",
      confidence: 0.8,
      note: "checked",
      sourceUrl: "not a uri",
    });
    expect(result.body.error.code).toBe("invalid_input");
    expect(result.body.error.message).toContain("sourceUrl");
  });

  it("rejects sync revisions ahead of the room", async () => {
    const result = await apiPost<Failure>(server.baseUrl, "/api/sync", room.tokens.org, {
      sinceRevision: 999_999,
    });
    expect(result.body.error.code).toBe("invalid_input");
    expect(result.body.error.message).toContain("ahead of room revision");
  });

  it("clamps a cursor target to the room head and rejects a cursor already past it", async () => {
    const revision = Number(
      (await room.pool.query("SELECT revision FROM rooms WHERE id = $1", [room.roomId])).rows[0]
        .revision,
    );
    const cursor = (afterRevision: number, targetRevision: number) =>
      `d1.${Buffer.from(JSON.stringify({
        version: 1,
        roomId: room.roomId,
        viewerId: room.participantIds.org,
        fromRevision: afterRevision,
        afterRevision,
        targetRevision,
      })).toString("base64url")}`;

    const clamped = await apiPost<{
      ok: boolean;
      delta?: { throughRevision?: number; truncated: boolean };
    }>(server.baseUrl, "/api/sync", room.tokens.org, {
      cursor: cursor(revision, revision + 100),
    });
    expect(clamped.body.ok).toBe(true);
    expect(clamped.body.delta?.throughRevision).toBe(revision);
    expect(clamped.body.delta?.truncated).toBe(false);

    const ahead = await apiPost<Failure>(server.baseUrl, "/api/sync", room.tokens.org, {
      cursor: cursor(revision + 1, revision + 100),
    });
    expect(ahead.body.error.code).toBe("invalid_input");
    expect(ahead.body.error.message).toContain("ahead of room revision");
  });
});
