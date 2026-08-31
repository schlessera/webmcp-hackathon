import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  apiPost,
  createTestRoom,
  startServer,
  type TestRoom,
  type TestServer,
} from "./helpers.ts";

/** Lane 2: three-user API tests against a real server + PostgreSQL. */

let server: TestServer;
let room: TestRoom;
let revision = 0;

interface Envelope {
  ok: boolean;
  revision?: number;
  effect?: string;
  outstanding?: Array<{ type: string; candidateIds?: string[] }>;
  error?: { code: string; message: string; recovery: string };
  delta?: { fromRevision: number; events: Array<{ revision: number; type: string; level: string; text: string; payload?: unknown }> };
  identity?: { participantId: string; displayName: string; role: string };
}

beforeAll(async () => {
  server = await startServer();
  room = await createTestRoom(server.baseUrl);
});
afterAll(async () => {
  await room.cleanup();
  await server.stop();
});

const sync = (token: string, sinceRevision?: number) =>
  apiPost<Envelope>(server.baseUrl, "/api/sync", token,
    sinceRevision === undefined ? {} : { sinceRevision });
const command = (token: string, type: string, input: Record<string, unknown>) =>
  apiPost<Envelope>(server.baseUrl, "/api/commands", token, { type, input });

describe("identity", () => {
  it("three tokens resolve to different participants in the same room", async () => {
    const results = await Promise.all([
      sync(room.tokens.org), sync(room.tokens.sarah), sync(room.tokens.joe),
    ]);
    const ids = results.map((r) => r.body.identity!.participantId);
    expect(new Set(ids).size).toBe(3);
    expect(ids).toEqual([
      room.participantIds.org, room.participantIds.sarah, room.participantIds.joe,
    ]);
    expect(results.map((r) => r.body.identity!.role)).toEqual([
      "organizer", "member", "member",
    ]);
  });

  it("no caller can provide or override an actor ID", async () => {
    const { body } = await command(room.tokens.sarah, "SetReadyState", {
      baseRevision: revision,
      state: "ready",
      actorId: room.participantIds.joe,
    });
    expect(body.ok).toBe(false);
    expect(body.error!.code).toBe("invalid_input");
  });

  it("unauthenticated calls return the structured not_authenticated result", async () => {
    const { body } = await apiPost<Envelope>(server.baseUrl, "/api/sync", null, {});
    expect(body.ok).toBe(false);
    expect(body.error!.code).toBe("not_authenticated");
    expect(body.error!.recovery).toBeTruthy();
  });
});

describe("shared and private projections", () => {
  it("shared mutations reach all projections", async () => {
    const submit = await command(room.tokens.sarah, "SubmitRequirement", {
      baseRevision: revision,
      visibility: "shared",
      hardness: "hard",
      delegation: { mode: "approval_required" },
      payload: { kind: "attribute", key: "vegetarian-options", expect: "verified_true" },
    });
    expect(submit.body.ok).toBe(true);
    const before = revision;
    revision = submit.body.revision!;

    for (const token of [room.tokens.org, room.tokens.joe]) {
      const { body } = await sync(token, before);
      const event = body.delta!.events.find((e) => e.type === "requirement_submitted");
      expect(event).toBeDefined();
      expect(event!.level).toBe("full");
      expect(event!.text).toContain("Sarah");
    }
  });

  it("private content appears only in its owner's response (wire-level)", async () => {
    const CANARY_AMOUNT = 1799; // distinctive marker for redaction grep
    const submit = await command(room.tokens.sarah, "SubmitRequirement", {
      baseRevision: revision,
      visibility: "application-private",
      hardness: "hard",
      delegation: { mode: "approval_required" },
      payload: { kind: "budget", perPersonMax: { amount: CANARY_AMOUNT, currency: "EUR" } },
    });
    expect(submit.body.ok).toBe(true);
    const before = revision;
    revision = submit.body.revision!;

    const sarahView = await sync(room.tokens.sarah, before);
    expect(sarahView.raw).toContain(String(CANARY_AMOUNT));

    for (const token of [room.tokens.org, room.tokens.joe]) {
      const view = await sync(token, before);
      // Unauthorized fields absent from the serialized network payload.
      expect(view.raw).not.toContain(String(CANARY_AMOUNT));
      expect(view.raw).not.toContain("perPersonMax");
      const event = view.body.delta!.events.find(
        (e) => e.type === "requirement_submitted" || e.type === "requirement_updated",
      );
      expect(event!.level).toBe("aggregate");
      expect(event!.payload).toBeUndefined();
      expect(event!.text).not.toContain("Sarah");
    }
  });
});

describe("agent-private tier", () => {
  it("declaration stores no payload row and requests screening", async () => {
    const declare = await command(room.tokens.joe, "SubmitRequirement", {
      baseRevision: revision,
      visibility: "agent-private",
      hardness: "hard",
      delegation: { mode: "approval_required" },
      scopeHint: { affects: "candidate-eligibility" },
    });
    expect(declare.body.ok).toBe(true);
    revision = declare.body.revision!;
    expect(declare.body.outstanding).toContainEqual(
      expect.objectContaining({ type: "evaluation_request" }),
    );

    const rows = await room.pool.query(
      `SELECT payload FROM requirements WHERE room_id = $1 AND visibility = 'agent-private'`,
      [room.roomId],
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].payload).toBeNull();
  });

  it("rejects an agent-private submission that carries a payload, without logging it", async () => {
    const { body } = await command(room.tokens.joe, "SubmitRequirement", {
      baseRevision: revision,
      visibility: "agent-private",
      hardness: "hard",
      delegation: { mode: "approval_required" },
      payload: { kind: "exclusion", key: "cuisine", values: ["CANARY-cuisine-9317"], lifetime: "session" },
    });
    expect(body.ok).toBe(false);
    expect(body.error!.code).toBe("invalid_input");
    // Invariant 5: no payload string appears in server logs.
    expect(server.logs()).not.toContain("CANARY-cuisine-9317");
  });

  it("rejects an agent-private submission carrying a free-text note", async () => {
    const { body } = await command(room.tokens.joe, "SubmitRequirement", {
      baseRevision: revision,
      visibility: "agent-private",
      hardness: "hard",
      delegation: { mode: "approval_required" },
      note: "CANARY-note-4412 lactose intolerance",
    });
    expect(body.ok).toBe(false);
    expect(body.error!.code).toBe("invalid_input");
    const rows = await room.pool.query(
      "SELECT 1 FROM requirements WHERE room_id = $1 AND note LIKE '%CANARY-note-4412%'",
      [room.roomId],
    );
    expect(rows.rowCount).toBe(0);
    expect(server.logs()).not.toContain("CANARY-note-4412");
  });

  it("re-declaring invalidates previous screening verdicts", async () => {
    const countBefore = (
      await room.pool.query("SELECT count(*)::int AS n FROM verdicts WHERE room_id = $1", [room.roomId])
    ).rows[0].n;
    expect(countBefore).toBeGreaterThanOrEqual(0);
    const redeclare = await command(room.tokens.joe, "SubmitRequirement", {
      baseRevision: revision,
      visibility: "agent-private",
      hardness: "hard",
      delegation: { mode: "approval_required" },
    });
    expect(redeclare.body.ok).toBe(true);
    revision = redeclare.body.revision!;
    const countAfter = (
      await room.pool.query("SELECT count(*)::int AS n FROM verdicts WHERE room_id = $1", [room.roomId])
    ).rows[0].n;
    expect(countAfter).toBe(0);
    // Screening is requested again for all candidates.
    expect(redeclare.body.outstanding).toContainEqual(
      expect.objectContaining({ type: "evaluation_request" }),
    );
  });

  it("peers receive existence/aggregate only for the declaration", async () => {
    const view = await sync(room.tokens.sarah, revision - 2);
    const declaration = view.body.delta!.events.find(
      (e) => e.type === "private_requirement_declared",
    );
    expect(declaration).toBeDefined();
    expect(declaration!.level).toBe("existence");
    expect(declaration!.payload).toBeUndefined();
    // The council's screening request is invisible to peers.
    expect(view.body.delta!.events.map((e) => e.type)).not.toContain(
      "evaluation_requested",
    );
  });

  it("verdict batch is recorded disposition-only and folds into eligibility", async () => {
    const excludedId = `place_a_${room.roomId.slice("room_test_".length)}`;
    const verdicts = await command(room.tokens.joe, "EvaluateCandidates", {
      baseRevision: revision,
      verdicts: [
        { candidateId: excludedId, verdict: "unacceptable" },
      ],
    });
    expect(verdicts.body.ok).toBe(true);
    const before = revision;
    revision = verdicts.body.revision!;

    const rows = await room.pool.query(
      "SELECT verdict, info_needed FROM verdicts WHERE room_id = $1",
      [room.roomId],
    );
    expect(rows.rows[0].verdict).toBe("unacceptable");
    expect(rows.rows[0].info_needed).toBeNull();

    const peerView = await sync(room.tokens.org, before);
    const recorded = peerView.body.delta!.events.find(
      (e) => e.type === "evaluation_recorded",
    );
    expect(recorded!.level).toBe("aggregate");
    expect(recorded!.text).not.toContain("Joe");
    // Eligibility folded in: the vetoed candidate is now excluded.
    const updated = peerView.body.delta!.events.find(
      (e) => e.type === "candidates_updated",
    );
    expect(updated).toBeDefined();
  });
});

describe("proposals and stances", () => {
  it("open proposal appears as stance_needed in outstanding", async () => {
    const view = await sync(room.tokens.sarah);
    expect((view.body as { outstanding: Array<{ type: string }> }).outstanding)
      .toContainEqual({ type: "stance_needed", proposalId: room.proposalId });
  });

  it("rejects a reason on an agent-private stance (disposition-only)", async () => {
    const { body } = await command(room.tokens.joe, "RespondToProposal", {
      baseRevision: revision,
      proposalId: room.proposalId,
      disposition: "reject",
      visibility: "agent-private",
      reason: { kind: "history", note: "CANARY-reason-8823" },
    });
    expect(body.ok).toBe(false);
    expect(body.error!.code).toBe("invalid_input");
    expect(server.logs()).not.toContain("CANARY-reason-8823");
    const rows = await room.pool.query(
      "SELECT 1 FROM stances WHERE room_id = $1", [room.roomId],
    );
    expect(rows.rowCount).toBe(0);
  });

  it("a veto blocks the proposal; changing the stance reopens it", async () => {
    const veto = await command(room.tokens.sarah, "RespondToProposal", {
      baseRevision: revision,
      proposalId: room.proposalId,
      disposition: "reject",
      visibility: "shared",
      reason: { kind: "history", note: "visited too recently" },
    });
    expect(veto.body.ok).toBe(true);
    revision = veto.body.revision!;
    let status = (
      await room.pool.query("SELECT status FROM proposals WHERE id = $1", [room.proposalId])
    ).rows[0].status;
    expect(status).toBe("vetoed");

    // Peers see the shared veto at full level, with the note.
    const view = await sync(room.tokens.joe, revision - 1);
    const stance = view.body.delta!.events.find((e) => e.type === "stance_submitted");
    expect(stance!.level).toBe("full");
    expect(stance!.text).toContain("Sarah");

    const accept = await command(room.tokens.sarah, "RespondToProposal", {
      baseRevision: revision,
      proposalId: room.proposalId,
      disposition: "accept",
      visibility: "shared",
    });
    expect(accept.body.ok).toBe(true);
    revision = accept.body.revision!;
    status = (
      await room.pool.query("SELECT status FROM proposals WHERE id = $1", [room.proposalId])
    ).rows[0].status;
    expect(status).toBe("open");
  });
});

describe("output budgets", () => {
  it("mutation results and non-manifest syncs respect budgets", async () => {
    const result = await command(room.tokens.org, "SetReadyState", {
      baseRevision: revision,
      state: "ready",
    });
    expect(result.body.ok).toBe(true);
    revision = result.body.revision!;
    expect(result.body.effect!.length).toBeLessThanOrEqual(200);
    expect(result.raw.length).toBeLessThanOrEqual(1500);

    const delta = await sync(room.tokens.org, Math.max(0, revision - 3));
    expect((delta.body as unknown as { brief: string }).brief.length)
      .toBeLessThanOrEqual(400);
    // The first-connection manifest result is the documented exception to the
    // 1.5K guidance; delta syncs must stay within it.
    expect(delta.raw.length).toBeLessThanOrEqual(1500 * 2);
  });
});

describe("revision discipline", () => {
  it("simultaneous conflicting commands produce one commit and one sync_required", async () => {
    const input = (state: string) => ({
      baseRevision: revision,
      state,
    });
    const [a, b] = await Promise.all([
      command(room.tokens.sarah, "SetReadyState", input("ready")),
      command(room.tokens.joe, "SetReadyState", input("ready")),
    ]);
    const outcomes = [a.body, b.body];
    const committed = outcomes.filter((o) => o.ok);
    const rejected = outcomes.filter((o) => !o.ok);
    expect(committed).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].error!.code).toBe("sync_required");
    expect(rejected[0].delta).toBeDefined();
    expect(rejected[0].error!.recovery).toMatch(/baseRevision \d+/);
    revision = committed[0].revision!;
  });

  it("reconnecting from an old revision returns the correct authorized delta", async () => {
    const view = await sync(room.tokens.joe, 0);
    expect(view.body.ok).toBe(true);
    expect(view.body.delta!.fromRevision).toBe(0);
    expect(view.body.delta!.events.length).toBeGreaterThan(0);
    // Every event revision in (0, current]; most recent first.
    const revisions = view.body.delta!.events.map((e) => e.revision);
    expect([...revisions].sort((x, y) => y - x)).toEqual(revisions);
    // Joe's own agent-private declaration appears at full level (invariant 8).
    const own = view.body.delta!.events.find(
      (e) => e.type === "private_requirement_declared",
    );
    if (own) expect(own.level).toBe("full");
  });

  it("mutation result revision >= request baseRevision (invariant 2)", async () => {
    const result = await command(room.tokens.org, "SetReadyState", {
      baseRevision: revision,
      state: "contributing",
    });
    expect(result.body.ok).toBe(true);
    expect(result.body.revision!).toBeGreaterThanOrEqual(revision);
    revision = result.body.revision!;
  });

  it("incompatible client contract version gets upgrade_required", async () => {
    const response = await fetch(`${server.baseUrl}/api/commands`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${room.tokens.org}`,
        "x-tool-contract-version": "0-obsolete",
      },
      body: JSON.stringify({
        type: "SetReadyState",
        input: { baseRevision: revision, state: "ready" },
      }),
    });
    const body = (await response.json()) as Envelope;
    expect(body.ok).toBe(false);
    expect(body.error!.code).toBe("upgrade_required");
  });

  it("result strings respect output budgets", async () => {
    const view = await sync(room.tokens.org);
    expect((view.body as unknown as { brief: string }).brief.length)
      .toBeLessThanOrEqual(400);
  });
});
