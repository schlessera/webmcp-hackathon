import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { DATABASE_URL, apiPost, startServer, type TestServer } from "./helpers.ts";
import { POOL_SEED_SIZE } from "../../apps/server/src/places.ts";

/**
 * The area picker's server half: GET /api/areas reports what was measured,
 * POST /api/rooms opens a room on the area snapshot, and the room that comes
 * out is an ordinary room — same auth, same spatial context, same
 * eligibility — with honest provenance and no invented facts.
 */

let server: TestServer;
const pool = new pg.Pool({ connectionString: DATABASE_URL });
const created: string[] = [];

interface Invite { participantId: string; displayName: string; role: string; inviteSecret: string }
interface Created { roomId: string; areaId: string; invites: Invite[]; dataSource: { kind: string; poolSize: number } }

beforeAll(async () => {
  server = await startServer({ env: { POOL_FILL: "0" } });
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
  await server.stop();
});

async function post(path: string, body: unknown) {
  const response = await fetch(`${server.baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function exchange(inviteSecret: string): Promise<string> {
  const { body } = await post("/api/session/exchange", { inviteSecret });
  return body.participantToken as string;
}

describe("GET /api/areas", () => {
  it("lists both areas with measured coverage and an extract timestamp", async () => {
    const response = await fetch(`${server.baseUrl}/api/areas`);
    expect(response.status).toBe(200);
    const { areas } = (await response.json()) as {
      areas: Array<{ id: string; available: boolean; dataAsOf: string; coverage: { pool: { slots: number; decisive: number } } }>;
    };
    expect(areas.map((a) => a.id)).toEqual(["berlin-mitte", "sf-soma"]);
    for (const a of areas) {
      expect(a.available).toBe(true);
      expect(a.dataAsOf).toMatch(/^\d{4}-/);
      expect(a.coverage.pool.decisive).toBeLessThanOrEqual(a.coverage.pool.slots);
    }
  });
});

describe("POST /api/rooms", () => {
  it("rejects an unknown area and empty names", async () => {
    expect((await post("/api/rooms", { areaId: "atlantis", organizerName: "A", memberNames: [] })).status).toBe(400);
    expect((await post("/api/rooms", { areaId: "sf-soma", organizerName: "  ", memberNames: [] })).status).toBe(400);
    expect((await post("/api/rooms", { areaId: "sf-soma", organizerName: "A", memberNames: [""] })).status).toBe(400);
    expect((await post("/api/rooms", { areaId: "sf-soma", organizerName: "A", memberNames: [], center: { lat: 0, lng: 0 } })).status).toBe(400);
  });

  it("opens a San Francisco room on the snapshot, with honest provenance and no invented facts", async () => {
    const { status, body } = await post("/api/rooms", {
      areaId: "sf-soma",
      organizerName: "Alex",
      memberNames: ["Sarah", "Joe"],
    });
    expect(status).toBe(200);
    const room = body as Created;
    created.push(room.roomId);
    expect(room.invites).toHaveLength(3);
    expect(room.invites[0]).toMatchObject({ displayName: "Alex", role: "organizer" });
    expect(room.dataSource).toMatchObject({ kind: "osm-snapshot", poolSize: POOL_SEED_SIZE });

    const token = await exchange(room.invites[0].inviteSecret);
    expect(token).toBeTruthy();
    const context = await apiPost<{
      ok: boolean;
      area?: { areaId: string; label: string; kind: string; dataAsOf: string; poolSize: number; focusVenues: number };
      total: number;
      candidates: Array<{ candidateId: string; eligibility: string; priceLevel: number | null }>;
      scope: { area: { radiusM: number; center: { lat: number } } };
    }>(server.baseUrl, "/api/spatial/context", token, {});
    expect(context.body.ok).toBe(true);
    expect(context.body.area).toMatchObject({
      areaId: "sf-soma",
      label: "San Francisco SoMa",
      kind: "osm-snapshot",
      poolSize: POOL_SEED_SIZE,
    });
    expect(context.body.area!.focusVenues).toBeGreaterThan(POOL_SEED_SIZE);
    expect(context.body.scope.area.radiusM).toBe(800);
    expect(context.body.scope.area.center.lat).toBeCloseTo(37.7845, 3);
    expect(context.body.candidates).toHaveLength(POOL_SEED_SIZE);
    expect(context.body.total).toBe(POOL_SEED_SIZE);
    for (const c of context.body.candidates) expect(c.priceLevel).toBeNull();
    const origins = await pool.query(
      "SELECT origin FROM participants WHERE room_id = $1 ORDER BY id",
      [room.roomId],
    );
    expect(origins.rows).toHaveLength(3);
    for (const row of origins.rows) {
      expect(row.origin).toMatchObject({
        lat: context.body.scope.area.center.lat,
        lng: context.body.scope.area.center.lng,
        label: "the area centre",
        source: "fixture",
      });
    }

    const inspect = await apiPost<{
      ok: boolean;
      candidates: Array<{ attributes: Array<{ key: string; status: string; source: string }>; hours: unknown[] }>;
    }>(server.baseUrl, "/api/spatial/inspect", token, {
      candidateIds: [context.body.candidates[0].candidateId],
    });
    expect(inspect.body.ok).toBe(true);
    const attrs = inspect.body.candidates[0].attributes;
    expect(attrs.map((a) => a.key)).toContain("hours");
    for (const a of attrs) expect(a.source.startsWith("osm:")).toBe(true);
    // Links the record carries come through with server labels and osm:*
    // sources even with the lookup network off (ENRICH_NETWORK=0); a shared
    // cache may add web:* ones from a live server on the same database.
    const withLinks = await apiPost<{
      revision: number;
      candidates: Array<{ candidateId: string; links?: Array<{ kind: string; label: string; url: string; source: string }> }>;
    }>(server.baseUrl, "/api/spatial/inspect", token, {
      candidateIds: context.body.candidates.slice(0, 3).map((c) => c.candidateId),
    });
    const anyLinks = withLinks.body.candidates.flatMap((c) => c.links ?? []);
    expect(anyLinks.some((l) => l.source.startsWith("osm:"))).toBe(true);
    for (const l of anyLinks) {
      expect(l.url).toMatch(/^https?:\/\//);
      expect(l.source).toMatch(/^(osm|web|wikidata):/);
      expect(l.label.length).toBeGreaterThan(0);
    }
    // A budget need over a room with no price bands rules nothing out: every
    // in-scope place is uncertain, none is excluded (attribute honesty).
    const budget = await apiPost<{ ok: boolean }>(server.baseUrl, "/api/commands", token, {
      type: "SubmitRequirement",
      input: {
        // Inspection may publish newly available shared enrichment before the
        // command. Carry its current revision instead of assuming room create
        // is the last writer in a parallel API lane.
        baseRevision: withLinks.body.revision,
        requirementId: `req_budget_${room.roomId.replace("room_", "")}`,
        visibility: "shared",
        hardness: "hard",
        delegation: { mode: "approval_required" },
        payload: { kind: "budget", perPersonMax: { amount: 15, currency: "EUR" } },
      },
    });
    expect(budget.body, JSON.stringify(budget.body)).toMatchObject({ ok: true });
    const after = await apiPost<{ matching: number; feasibility: { excluded: number; uncertain: number } }>(
      server.baseUrl, "/api/spatial/context", token, {},
    );
    expect(after.body.matching).toBe(0);
    expect(after.body.feasibility.uncertain).toBe(POOL_SEED_SIZE);
  });

  it("opens a Berlin room on the snapshot too, distinct from room_demo", async () => {
    const { status, body } = await post("/api/rooms", {
      areaId: "berlin-mitte",
      organizerName: "Kim",
      memberNames: [],
    });
    expect(status).toBe(200);
    const room = body as Created;
    created.push(room.roomId);
    expect(room.roomId).not.toBe("room_demo");
    const token = await exchange(room.invites[0].inviteSecret);
    const context = await apiPost<{ area?: { kind: string; label: string }; candidates: Array<{ candidateId: string }> }>(
      server.baseUrl, "/api/spatial/context", token, {},
    );
    expect(context.body.area).toMatchObject({ kind: "osm-snapshot", label: "Berlin Mitte" });
    for (const c of context.body.candidates) expect(c.candidateId).not.toMatch(/^place_\d+$/);
  });
});
