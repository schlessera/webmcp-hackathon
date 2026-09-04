import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import {
  DATABASE_URL,
  apiPost,
  keepEnrichmentsClean,
  openRealtime,
  startServer,
  type TestRealtime,
  type TestServer,
} from "./helpers.ts";

/**
 * A room that runs more than one step.
 *
 * "Somewhere to eat, then somewhere for drinks nearby" opens a room on the
 * first step. Agreeing on a place there is not the end of the room: it
 * settles that step, re-centres the search on the place the room chose, and
 * opens the next one with its own pool and the needs the goal already stated
 * for it.
 *
 * The invariant this file is really guarding: the step behind stops
 * classifying, and its places stop being candidates, WITHOUT any of it being
 * deleted. A room that predates plans keeps behaving exactly as it did, which
 * the last describe block checks directly.
 */

let server: TestServer;
const pool = new pg.Pool({ connectionString: DATABASE_URL });
const created: string[] = [];

interface Invite {
  participantId: string;
  displayName: string;
  role: string;
  inviteSecret: string;
}
interface StepView {
  stepId: string;
  index: number;
  title: string;
  placeClass: { key: string; label: string };
  relation: { kind: string; afterStepId?: string };
  status: string;
  settled: { candidateId: string; name: string; lat: number; lng: number } | null;
}
interface Created {
  roomId: string;
  areaId: string;
  invites: Invite[];
  steps: StepView[];
  activeStepId: string | null;
  step: { placeClass: { key: string; label: string }; seeded: number };
}
interface Envelope {
  ok: boolean;
  revision?: number;
  effect?: string;
  phase?: string;
  error?: { code: string; message: string; recovery: string };
  delta?: { events: Array<{ revision: number; type: string; text: string }> };
}
interface Context {
  ok: boolean;
  phase: string;
  steps?: StepView[];
  activeStepId?: string | null;
  scope: { scopeId: string; area: { center: { lat: number; lng: number }; radiusM: number } } | null;
  candidates: Array<{ candidateId: string; name: string }>;
  proposals: Array<{ proposalId: string; candidateId: string; status: string }>;
}

let restoreEnrichments: () => Promise<void>;

beforeAll(async () => {
  // Enrichment is keyed by place, not by room: leave the shared table as
  // this file found it, or a neighbour asserting on it breaks by ordering.
  restoreEnrichments = await keepEnrichmentsClean(pool);
  // POOL_FILL off: the pool this test reasons about is the deterministic
  // creation seed, not whatever the background filler adds afterwards.
  server = await startServer({ env: { POOL_FILL: "0" } });
});

afterAll(async () => {
  for (const roomId of created) {
    for (const table of [
      "stances", "proposals", "verdicts", "requirements", "adjustments",
      "arrival_plans", "attestations", "events", "candidates", "invite_secrets",
    ]) {
      await pool.query(`DELETE FROM ${table} WHERE room_id = $1`, [roomId]);
    }
    await pool.query(
      "DELETE FROM participant_tokens WHERE participant_id IN (SELECT id FROM participants WHERE room_id = $1)",
      [roomId],
    );
    await pool.query("DELETE FROM participants WHERE room_id = $1", [roomId]);
    await pool.query("DELETE FROM rooms WHERE id = $1", [roomId]);
  }
  await restoreEnrichments();
  await pool.end();
  await server.stop();
});

async function post(path: string, body: unknown) {
  const response = await fetch(`${server.baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as never };
}

async function openTwoStepRoom(): Promise<{
  room: Created;
  token: string;
  channel: TestRealtime;
}> {
  const { status, body } = await post("/api/rooms", {
    areaId: "berlin-mitte",
    organizerName: "Alex",
    goal: "Somewhere to eat, then somewhere for drinks nearby",
    steps: [
      {
        placeClass: "food",
        title: "Dinner",
        needs: [{ payload: { kind: "attribute", key: "outdoor-seating", expect: "verified_true" } }],
      },
      {
        placeClass: "drinks",
        title: "Drinks after",
        needs: [{ payload: { kind: "attribute", key: "wheelchair-accessible", expect: "verified_true" } }],
      },
    ],
  });
  expect(status, JSON.stringify(body)).toBe(200);
  const room = body as Created;
  created.push(room.roomId);
  const organizer = room.invites.find((invite) => invite.role === "organizer")!;
  const exchanged = await post("/api/session/exchange", {
    inviteSecret: organizer.inviteSecret,
  });
  const token = (exchanged.body as { participantToken: string }).participantToken;
  const channel = await openRealtime(server.baseUrl, token);
  return { room, token, channel };
}

const command = (token: string, type: string, input: Record<string, unknown>) =>
  apiPost<Envelope>(server.baseUrl, "/api/commands", token, { type, input });
const context = (token: string) =>
  apiPost<Context>(server.baseUrl, "/api/spatial/context", token, {});
const sync = (token: string, sinceRevision?: number) =>
  apiPost<Envelope>(server.baseUrl, "/api/sync", token,
    sinceRevision === undefined ? {} : { sinceRevision });

describe("a room opened on a plan", () => {
  let room: Created;
  let token = "";
  let channel: TestRealtime;

  beforeAll(async () => {
    ({ room, token, channel } = await openTwoStepRoom());
  });
  afterAll(() => channel?.close());

  it("records both steps, runs the first, and holds the second", () => {
    expect(room.steps).toHaveLength(2);
    expect(room.activeStepId).toBe("s1");

    const [first, second] = room.steps;
    expect(first.stepId).toBe("s1");
    expect(first.index).toBe(1);
    expect(first.status).toBe("active");
    expect(first.relation).toEqual({ kind: "first" });
    expect(first.settled).toBeNull();

    expect(second.stepId).toBe("s2");
    expect(second.index).toBe(2);
    expect(second.status).toBe("pending");
    // A later step is searched around where the one before it settled. That
    // is the whole meaning of "then" for a group that has to walk there.
    expect(second.relation).toEqual({ kind: "then", afterStepId: "s1" });
    expect(second.settled).toBeNull();
  });

  it("only the first step's places are in the pool, and only its needs are live", async () => {
    const rows = await pool.query(
      "SELECT step_id, count(*)::int AS n FROM candidates WHERE room_id = $1 GROUP BY step_id",
      [room.roomId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].step_id).toBe("s1");

    // The first step's need was applied at creation; the second step's was not.
    expect(room.step.seeded).toBe(1);
    const needs = await pool.query(
      "SELECT step_id, active FROM requirements WHERE room_id = $1 AND NOT withdrawn",
      [room.roomId],
    );
    expect(needs.rows).toHaveLength(1);
    expect(needs.rows[0].step_id).toBe("s1");
    expect(needs.rows[0].active).toBe(true);
  });

  it("puts the plan on the wire with the active step named", async () => {
    const { body } = await context(token);
    expect(body.steps).toHaveLength(2);
    expect(body.activeStepId).toBe("s1");
    // The label the client renders is server data; no client branches on the
    // key (CLAUDE.md §1).
    expect(body.steps![1].placeClass.label).toBe("somewhere for drinks");
  });

  it("agreeing on a place settles the step and opens the next one", async () => {
    const before = await context(token);
    const target = before.body.candidates[0];
    expect(target, "the first step opened with no places").toBeDefined();
    const scopeBefore = before.body.scope!.area.center;

    let revision = (await sync(token)).body.revision!;
    // Staging needs everyone ready, and the organizer is on their own here.
    const readied = await command(token, "SetReadyState", {
      baseRevision: revision,
      state: "ready",
    });
    expect(readied.body.ok, JSON.stringify(readied.body.error)).toBe(true);
    revision = readied.body.revision!;

    const propose = await command(token, "ProposeDestination", {
      baseRevision: revision,
      candidateId: target.candidateId,
    });
    expect(propose.body.ok, JSON.stringify(propose.body.error)).toBe(true);
    revision = propose.body.revision!;

    const proposalId = (await context(token)).body.proposals.find(
      (proposal) => proposal.candidateId === target.candidateId,
    )!.proposalId;

    const accepted = await command(token, "RespondToProposal", {
      baseRevision: revision,
      proposalId,
      disposition: "accept",
      visibility: "shared",
    });
    expect(accepted.body.ok, JSON.stringify(accepted.body.error)).toBe(true);
    revision = accepted.body.revision!;

    const stage = await command(token, "ConfirmAgreement", {
      baseRevision: revision,
      proposalId,
    });
    expect(stage.body.ok, JSON.stringify(stage.body.error)).toBe(true);
    revision = stage.body.revision!;

    const nonce = await channel.nonce("agreement", proposalId);
    const commitAt = revision;
    const commit = await command(token, "CommitAgreement", {
      baseRevision: revision,
      proposalId,
      confirmationNonce: nonce,
    });
    expect(commit.body.ok, JSON.stringify(commit.body.error)).toBe(true);
    // The commit says what happens next, not that the room is over.
    expect(commit.body.effect).toContain("somewhere for drinks");

    const after = await context(token);
    expect(after.body.activeStepId).toBe("s2");
    expect(after.body.steps![0].status).toBe("settled");
    expect(after.body.steps![0].settled!.candidateId).toBe(target.candidateId);
    expect(after.body.steps![0].settled!.name).toBe(target.name);
    expect(after.body.steps![1].status).toBe("active");

    // The room is gathering again: it has somewhere new to converge on.
    expect(after.body.phase).toBe("gathering");

    // The search follows the decision (CLAUDE.md §8, the explicit-action
    // exception): the circle is now around the place the room agreed on.
    const scopeAfter = after.body.scope!.area.center;
    expect(scopeAfter).not.toEqual(scopeBefore);
    expect(scopeAfter.lat).toBeCloseTo(after.body.steps![0].settled!.lat, 6);

    // The feed says so in words, with absolute counts (CLAUDE.md §10).
    const delta = await sync(token, commitAt);
    const advanced = delta.body.delta!.events.find((event) => event.type === "step_advanced");
    expect(advanced, "the advance is not in the projection").toBeDefined();
    expect(advanced!.text).toContain("Step 2 of 2");
    expect(advanced!.text).toContain(target.name);

    // Opening the step submitted its needs, which moved the room past the
    // revision the commit itself earned. The commit has to report the head
    // the caller must build on, or their next command answers sync_required.
    const head = (await sync(token)).body.revision!;
    expect(commit.body.revision).toBe(head);
    const next = await command(token, "SetReadyState", {
      baseRevision: commit.body.revision!,
      state: "contributing",
    });
    expect(next.body.ok, JSON.stringify(next.body.error)).toBe(true);

    // And the step no longer owes anything, because it was actually applied.
    const stored = await pool.query("SELECT steps FROM rooms WHERE id = $1", [room.roomId]);
    const steps = stored.rows[0].steps as Array<{ stepId: string; pendingNeeds: unknown[] }>;
    expect(steps.find((step) => step.stepId === "s2")!.pendingNeeds).toEqual([]);
  });

  it("the settled step's places leave the pool without being deleted", async () => {
    const { body } = await context(token);
    const live = new Set(body.candidates.map((candidate) => candidate.candidateId));

    const rows = await pool.query(
      "SELECT step_id, count(*)::int AS n FROM candidates WHERE room_id = $1 GROUP BY step_id ORDER BY step_id",
      [room.roomId],
    );
    // Both steps' rows are still on disk: the first step keeps its history,
    // its enrichment and the place it settled on.
    expect(rows.rows.map((row) => row.step_id)).toEqual(["s1", "s2"]);

    const firstStepIds = (
      await pool.query("SELECT id FROM candidates WHERE room_id = $1 AND step_id = 's1'", [room.roomId])
    ).rows.map((row) => row.id as string);
    for (const id of firstStepIds) {
      expect(live.has(id), `${id} belongs to the settled step and is still a candidate`).toBe(false);
    }
    expect(live.size).toBeGreaterThan(0);
  });

  it("places added after the advance join the step the room is on", async () => {
    // A row with no step is live for EVERY step, so a background fill or a
    // participant addition that forgot the rule would quietly put step 1's
    // places back in step 2's pool.
    const orphans = await pool.query(
      "SELECT count(*)::int AS n FROM candidates WHERE room_id = $1 AND step_id IS NULL",
      [room.roomId],
    );
    expect(orphans.rows[0].n).toBe(0);
  });

  it("a place from the settled step can no longer be proposed", async () => {
    const stale = (
      await pool.query(
        "SELECT id FROM candidates WHERE room_id = $1 AND step_id = 's1' ORDER BY id LIMIT 1",
        [room.roomId],
      )
    ).rows[0] as { id: string };
    const revision = (await sync(token)).body.revision!;
    const { body } = await command(token, "ProposeDestination", {
      baseRevision: revision,
      candidateId: stale.id,
    });
    // Committing it would settle THIS step with a place from the last one,
    // and centre everything after it on the wrong point.
    expect(body.ok).toBe(false);
    expect(body.error!.code).toBe("not_found");
  });

  it("a need from the settled step cannot be switched back on", async () => {
    const settledNeed = (
      await pool.query(
        "SELECT id FROM requirements WHERE room_id = $1 AND step_id = 's1'",
        [room.roomId],
      )
    ).rows[0] as { id: string } | undefined;
    expect(settledNeed).toBeDefined();

    const revision = (await sync(token)).body.revision!;
    const { body } = await command(token, "SetRequirementActive", {
      baseRevision: revision,
      requirementId: settledNeed!.id,
      active: true,
    });
    expect(body.ok).toBe(false);
    expect(body.error!.code).toBe("phase_unavailable");
    expect(body.error!.message).toContain("already settled");

    const after = await pool.query(
      "SELECT active FROM requirements WHERE id = $1",
      [settledNeed!.id],
    );
    expect(after.rows[0].active).toBe(false);
  });

  it("the settled step's needs stop classifying, and the new step's arrive", async () => {
    const rows = await pool.query(
      "SELECT step_id, active, payload FROM requirements WHERE room_id = $1 AND NOT withdrawn ORDER BY step_id",
      [room.roomId],
    );
    expect(rows.rows).toHaveLength(2);
    const [first, second] = rows.rows;
    expect(first.step_id).toBe("s1");
    expect(first.active).toBe(false);
    expect(second.step_id).toBe("s2");
    expect(second.active).toBe(true);
    expect(second.payload.key).toBe("wheelchair-accessible");
  });
});

describe("a room opened without a plan", () => {
  it("has no steps, no active step, and unstepped places — exactly as before", async () => {
    const { status, body } = await post("/api/rooms", {
      areaId: "berlin-mitte",
      organizerName: "Alex",
      goal: "Dinner tonight somewhere we can all walk to",
      step: { placeClass: "food" },
    });
    expect(status).toBe(200);
    const room = body as Created;
    created.push(room.roomId);

    expect(room.steps).toEqual([]);
    expect(room.activeStepId).toBeNull();

    const rows = await pool.query(
      "SELECT DISTINCT step_id FROM candidates WHERE room_id = $1",
      [room.roomId],
    );
    expect(rows.rows).toEqual([{ step_id: null }]);

    const organizer = room.invites.find((invite) => invite.role === "organizer")!;
    const exchanged = await post("/api/session/exchange", {
      inviteSecret: organizer.inviteSecret,
    });
    const token = (exchanged.body as { participantToken: string }).participantToken;
    const { body: view } = await context(token);
    // Absent, not empty: a client that never learned about steps reads the
    // context it always read.
    expect(view.steps).toBeUndefined();
    expect(view.candidates.length).toBeGreaterThan(0);
  });
});

describe("POST /api/rooms validation", () => {
  it("answers 400 for a malformed entry rather than failing inside", async () => {
    for (const steps of [[null], [[]], [42], [{ placeClass: 7 }]]) {
      const { status } = await post("/api/rooms", {
        areaId: "berlin-mitte",
        organizerName: "Alex",
        steps,
      });
      expect(status, JSON.stringify(steps)).toBe(400);
    }
  });

  it("refuses a steps value that is not a list, rather than quietly ignoring it", async () => {
    const { status } = await post("/api/rooms", {
      areaId: "berlin-mitte",
      organizerName: "Alex",
      steps: "food",
    });
    // Dropping it would answer 200 to someone who asked for something else.
    expect(status).toBe(400);
  });

  it("refuses an unknown step class and an over-long plan", async () => {
    const unknown = await post("/api/rooms", {
      areaId: "berlin-mitte",
      organizerName: "Alex",
      steps: [{ placeClass: "teleportation-pad" }],
    });
    expect(unknown.status).toBe(400);

    const tooMany = await post("/api/rooms", {
      areaId: "berlin-mitte",
      organizerName: "Alex",
      steps: [
        { placeClass: "food" }, { placeClass: "drinks" },
        { placeClass: "cafe" }, { placeClass: "park" },
      ],
    });
    expect(tooMany.status).toBe(400);
  });
});
