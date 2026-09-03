import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { STEP_CLASSES, stepClassByKey } from "@webmcp-hackathon/contracts";
import { DATABASE_URL, apiPost, startServer, type TestServer } from "./helpers.ts";

/**
 * Goal-first rooms, server half (UNDERSTANDING-ARCH.md §10, D1).
 *
 * A goal is read into one step before any room exists, and the room that
 * opens from it pools only the places that step is about. Both halves are
 * checked here: the stateless preview, and what creation does with the step.
 */

let offlineServer: TestServer;
let scriptedServer: TestServer;
const pool = new pg.Pool({ connectionString: DATABASE_URL });
const created: string[] = [];

interface PlanStep {
  stepId: string;
  title: string;
  placeClass: { key: string; label: string };
  needs: Array<{ payload: Record<string, unknown>; label: string; gist: string }>;
  when: { start: string; end: string; phrase: string } | null;
}
interface Preview {
  goal: string;
  offline: boolean;
  steps: PlanStep[];
  classes: Array<{ key: string; label: string; count: number }>;
  clarify: unknown;
  meta: { model: string | null; ms: number };
}
interface Created {
  roomId: string;
  goal: string;
  step: { placeClass: { key: string; label: string }; seeded: number };
  invites: Array<{ participantId: string; inviteSecret: string }>;
  dataSource: { poolSize: number };
}

beforeAll(async () => {
  offlineServer = await startServer({ env: { POOL_FILL: "0" } });
  scriptedServer = await startServer({
    entrypoint: "tests/api/fixtures/plans-server.ts",
    env: { POOL_FILL: "0", LLM_PROVIDER: "openai", OPENAI_API_KEY: "scripted-only" },
  });
});

afterAll(async () => {
  for (const roomId of created) {
    for (const table of ["stances", "proposals", "verdicts", "requirements", "adjustments", "arrival_plans", "attestations", "events", "candidates", "invite_secrets"]) {
      await pool.query(`DELETE FROM ${table} WHERE room_id = $1`, [roomId]);
    }
    await pool.query(
      "DELETE FROM participant_tokens WHERE participant_id IN (SELECT id FROM participants WHERE room_id = $1)",
      [roomId],
    );
    await pool.query("DELETE FROM participants WHERE room_id = $1", [roomId]);
    await pool.query("DELETE FROM rooms WHERE id = $1", [roomId]);
  }
  await pool.end();
  await offlineServer.stop();
  await scriptedServer.stop();
});

async function post(server: TestServer, path: string, body: unknown) {
  const response = await fetch(`${server.baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as never };
}

async function exchange(server: TestServer, inviteSecret: string): Promise<string> {
  const { body } = await post(server, "/api/session/exchange", { inviteSecret });
  return (body as { participantToken: string }).participantToken;
}

describe("POST /api/plans/preview", () => {
  it("rejects an unknown area and a goal outside 1-300 characters", async () => {
    expect((await post(offlineServer, "/api/plans/preview", { areaId: "atlantis", goal: "lunch" })).status).toBe(400);
    expect((await post(offlineServer, "/api/plans/preview", { areaId: "berlin-mitte", goal: "   " })).status).toBe(400);
    expect((await post(offlineServer, "/api/plans/preview", { areaId: "berlin-mitte", goal: "x".repeat(301) })).status).toBe(400);
  });

  it("answers with one default step and the area's classes when no model is configured", async () => {
    const { status, body } = await post(offlineServer, "/api/plans/preview", {
      areaId: "berlin-mitte",
      goal: "go for a walk with the dogs",
    });
    expect(status).toBe(200);
    const preview = body as Preview;
    expect(preview.offline).toBe(true);
    expect(preview.goal).toBe("go for a walk with the dogs");
    expect(preview.steps).toEqual([{
      stepId: "s1",
      title: "somewhere to eat",
      placeClass: { key: "food", label: "somewhere to eat" },
      needs: [],
      when: null,
    }]);
    expect(preview.clarify).toBeNull();
    expect(preview.meta.model).toBeNull();
    // The class list is what Start shows before a goal is typed.
    const known = new Set(STEP_CLASSES.map((row) => row.key));
    expect(preview.classes.length).toBeGreaterThan(1);
    for (const row of preview.classes) {
      expect(known.has(row.key)).toBe(true);
      expect(row.count).toBeGreaterThan(0);
      expect(row.label).toBe(stepClassByKey(row.key)!.label);
    }
  });

  it("reads a goal into a step class and pending needs", async () => {
    const { status, body } = await post(scriptedServer, "/api/plans/preview", {
      areaId: "berlin-mitte",
      goal: "go for a walk with the dogs",
    });
    expect(status).toBe(200);
    const preview = body as Preview;
    expect(preview.offline).toBe(false);
    expect(preview.steps).toHaveLength(1);
    expect(preview.steps[0]).toMatchObject({
      stepId: "s1",
      title: "a park",
      placeClass: { key: "park", label: "a park" },
      when: null,
    });
    expect(preview.steps[0].needs).toEqual([{
      payload: { kind: "attribute", key: "dog-friendly", expect: "verified_true" },
      label: "dogs welcome",
      gist: "dogs welcome",
    }]);
    // Nothing is stored: the preview is a read.
    const rooms = await pool.query("SELECT count(*)::int AS n FROM rooms WHERE goal = $1", [
      "go for a walk with the dogs",
    ]);
    expect(rooms.rows[0].n).toBe(0);
  });
});

describe("POST /api/rooms with a goal and a step", () => {
  it("keeps the goal, pools the step's classes, and seeds its needs as rows", async () => {
    const { status, body } = await post(offlineServer, "/api/rooms", {
      areaId: "berlin-mitte",
      organizerName: "Alex",
      memberNames: ["Sarah"],
      goal: "catch the new film tonight",
      step: {
        placeClass: "cinema",
        needs: [
          { payload: { kind: "attribute", key: "wheelchair-accessible", expect: "verified_true" }, label: "step-free access", gist: "step free" },
          { payload: { kind: "nonsense" }, label: "bad", gist: "bad" },
          "not an object",
        ],
      },
    });
    expect(status).toBe(200);
    const room = body as Created;
    created.push(room.roomId);
    expect(room.goal).toBe("catch the new film tonight");
    expect(room.step).toEqual({
      placeClass: { key: "cinema", label: "a cinema" },
      seeded: 1,
    });

    const stored = await pool.query("SELECT goal, scope FROM rooms WHERE id = $1", [room.roomId]);
    expect(stored.rows[0].goal).toBe("catch the new film tonight");
    expect(stored.rows[0].scope.category).toBe("cinema");
    const event = await pool.query(
      "SELECT payload FROM events WHERE room_id = $1 AND type = 'session_created'",
      [room.roomId],
    );
    expect(event.rows[0].payload.goal).toBe("catch the new film tonight");

    // Every seeded place is a member of the step's class, and only that.
    const members = new Set(stepClassByKey("cinema")!.members as readonly string[]);
    const candidates = await pool.query(
      "SELECT category FROM candidates WHERE room_id = $1",
      [room.roomId],
    );
    expect(candidates.rows.length).toBeGreaterThan(0);
    for (const row of candidates.rows) expect(members.has(row.category)).toBe(true);

    // The seeded need is an ordinary row: owned by the organizer, shared.
    const token = await exchange(offlineServer, room.invites[0].inviteSecret);
    const context = await apiPost<{
      ok: boolean;
      goal?: string;
      activeNeeds: Array<{ id: string; label: string; ownerId: string; visibility: string }>;
    }>(offlineServer.baseUrl, "/api/spatial/context", token, {});
    expect(context.body.ok).toBe(true);
    // The page titles the room with the goal it reads from the context.
    expect(context.body.goal).toBe("catch the new film tonight");
    expect(context.body.activeNeeds).toHaveLength(1);
    expect(context.body.activeNeeds[0]).toMatchObject({
      ownerId: room.invites[0].participantId,
      visibility: "shared",
    });
    expect(context.body.activeNeeds[0].label.length).toBeGreaterThan(0);
  });

  it("rejects a step class the table does not know", async () => {
    const { status, body } = await post(offlineServer, "/api/rooms", {
      areaId: "berlin-mitte",
      organizerName: "Alex",
      memberNames: [],
      step: { placeClass: "spaceport" },
    });
    expect(status).toBe(400);
    expect((body as { error: string }).error).toMatch(/placeClass/);
  });

  it("opens the room it always did when no step is given", async () => {
    const withoutStep = await post(offlineServer, "/api/rooms", {
      areaId: "berlin-mitte",
      organizerName: "Kim",
      memberNames: [],
    });
    const withFood = await post(offlineServer, "/api/rooms", {
      areaId: "berlin-mitte",
      organizerName: "Kim",
      memberNames: [],
      step: { placeClass: "food" },
    });
    expect(withoutStep.status).toBe(200);
    expect(withFood.status).toBe(200);
    const plain = withoutStep.body as Created;
    const food = withFood.body as Created;
    created.push(plain.roomId, food.roomId);
    expect(plain.goal).toBe("Somewhere in Berlin Mitte");
    expect(plain.step).toEqual({ placeClass: { key: "food", label: "somewhere to eat" }, seeded: 0 });

    const refs = async (roomId: string) =>
      (await pool.query(
        "SELECT osm_ref FROM candidates WHERE room_id = $1 ORDER BY id",
        [roomId],
      )).rows.map((row) => row.osm_ref as string);
    // Naming the default class explicitly changes nothing about the pool.
    expect(await refs(plain.roomId)).toEqual(await refs(food.roomId));
    expect((await refs(plain.roomId)).length).toBe(plain.dataSource.poolSize);
  });
});
