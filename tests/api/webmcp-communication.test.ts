import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TOOL_CONTRACT_VERSION, type InspectCandidatesResponse, type SpatialContextResult, type SuccessEnvelope, type SyncSessionResult } from "@webmcp-hackathon/contracts";
import { apiPost, createTestRoom, startServer, type TestRoom, type TestServer } from "./helpers.ts";
import { ContextPager, inspectResult } from "@webmcp-hackathon/contracts";

let server: TestServer;
let room: TestRoom;
beforeAll(async () => { server = await startServer(); });
beforeEach(async () => { room = await createTestRoom(server.baseUrl); });
afterEach(async () => { await room?.cleanup(); });
afterAll(async () => { await server?.stop(); });

const read = async <T>(path: string, input = {}, token = room.tokens.org) =>
  (await apiPost<T>(server.baseUrl, path, token, input)).body;
const command = (type: string, input: Record<string, unknown>) => read<SuccessEnvelope>("/api/commands", { type, input });

describe("WebMCP read, change, explain and undo", () => {
  it("reads session state without stamping arrival or advancing another tab's sync watermark", async () => {
    await room.pool.query("UPDATE participants SET arrived_at = NULL, last_synced_revision = 0 WHERE id = $1", [room.participantIds.org]);
    const before = (await room.pool.query("SELECT arrived_at, last_synced_revision FROM participants WHERE id = $1", [room.participantIds.org])).rows[0];
    const sync = await read<SyncSessionResult>("/api/sync", { passive: true });
    expect(sync.ok).toBe(true);
    expect(sync.identity.participantId).toBe(room.participantIds.org);
    expect(sync.toolContractVersion).toBe(TOOL_CONTRACT_VERSION);
    const after = (await room.pool.query("SELECT arrived_at, last_synced_revision FROM participants WHERE id = $1", [room.participantIds.org])).rows[0];
    expect(after).toEqual(before);
  });

  it("keeps pending private screening and room state unchanged across repeated passive reads", async () => {
    const declared = await command("SubmitRequirement", {
      baseRevision: 0, visibility: "agent-private", hardness: "hard", delegation: { mode: "locked" },
    });
    expect(declared.ok).toBe(true);
    expect(declared.outstanding.some((item) => item.type === "evaluation_request")).toBe(true);
    await room.pool.query("UPDATE participants SET arrived_at = NULL, last_synced_revision = 0 WHERE room_id = $1", [room.roomId]);
    const candidateIds = (await room.pool.query("SELECT id FROM candidates WHERE room_id = $1 ORDER BY id", [room.roomId])).rows.map((row) => row.id);
    const state = async () => (await room.pool.query(`
      SELECT
        (SELECT to_jsonb(r) FROM rooms r WHERE id = $1) AS room,
        (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM participants p WHERE room_id = $1) AS participants,
        (SELECT jsonb_agg(to_jsonb(e) ORDER BY revision) FROM events e WHERE room_id = $1) AS events,
        (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM requirements r WHERE room_id = $1) AS requirements,
        (SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM candidates c WHERE room_id = $1) AS candidates,
        (SELECT jsonb_agg(to_jsonb(v) ORDER BY owner_id, candidate_id) FROM verdicts v WHERE room_id = $1) AS verdicts
    `, [room.roomId])).rows[0];
    const before = await state();
    const reads = [
      { path: "/api/sync", input: { passive: true } },
      { path: "/api/sync", input: { passive: true, sinceRevision: 0 } },
      { path: "/api/spatial/context", input: {} },
      { path: "/api/spatial/inspect", input: { candidateIds, intent: "read" } },
    ];
    for (const { path, input } of reads) {
      // Repeating a read must not answer outstanding work, mutate evidence,
      // append events or advance the page's participant bookkeeping.
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await read<SuccessEnvelope>(path, input);
        expect(result.ok, path).toBe(true);
        expect(result.revision, path).toBe(declared.revision);
        expect(await state(), path).toEqual(before);
      }
    }
    const session = await read<SyncSessionResult>("/api/sync", { passive: true });
    expect(session.outstanding).toContainEqual(expect.objectContaining({ type: "evaluation_request", candidateIds }));
  });

  it("returns applied settings and the need ID, preserves uncertain candidates, and supports undo from tool data", async () => {
    const initial = await read<SpatialContextResult>("/api/spatial/context");
    const rows = initial.candidates.slice(0, 3);
    expect(rows).toHaveLength(3);
    // Give this fixture decisive positive, missing, and decisive negative evidence.
    for (const [index, candidate] of rows.entries()) {
      const attributes = index === 1 ? [] : [{ key: "vegetarian-options", status: index === 0 ? "verified_true" : "verified_false", source: "osm:fixture", observedAt: "2026-08-31T00:00:00Z", confidence: 1 }];
      await room.pool.query("UPDATE candidates SET attributes = $2 WHERE id = $1", [candidate.candidateId, JSON.stringify(attributes)]);
    }
    const added = await command("SubmitRequirement", {
      baseRevision: initial.revision, visibility: "shared", hardness: "hard",
      delegation: { mode: "locked" }, payload: { kind: "attribute", key: "vegetarian-options", expect: "verified_true" },
    });
    expect(added.ok).toBe(true);
    expect(added.receipt).toMatchObject({ entity: "requirement", operation: "created", requirement: { active: true, visibility: "shared", hardness: "hard", payload: { key: "vegetarian-options" } } });
    const requirementId = added.receipt!.id;
    const updated = await read<SpatialContextResult>("/api/spatial/context");
    const page = new ContextPager().read(room.tokens.org, {}, updated);
    if (!page.ok) throw new Error(page.error.message);
    expect(page.activeNeeds).toContainEqual(expect.objectContaining({ requirementId, ownerId: room.participantIds.org, active: true }));
    expect(page.candidates.find((c) => c.candidateId === rows[0].candidateId)?.why).toContain("vegetarian options");
    expect(page.candidates.find((c) => c.candidateId === rows[1].candidateId)?.eligibility).toBe("uncertain");
    expect(added.feasibility).toEqual(updated.feasibility);

    const detailInput = { candidateIds: rows.map((c) => c.candidateId), keys: ["vegetarian-options"] };
    const details = inspectResult(await read<InspectCandidatesResponse>("/api/spatial/inspect", { candidateIds: detailInput.candidateIds, intent: "read" }), detailInput);
    if (!details.ok) throw new Error(details.error.message);
    expect(details.candidates[0].attributes[0]).toMatchObject({ key: "vegetarian-options", source: "osm:fixture", status: "verified_true" });
    expect(details.candidates[1].needs).toContainEqual(expect.objectContaining({ requirementId, verdict: "unknown" }));

    const removed = await command("WithdrawRequirement", { baseRevision: updated.revision, requirementId });
    expect(removed.receipt).toEqual({ entity: "requirement", id: requirementId, operation: "withdrawn" });
    const final = await read<SpatialContextResult>("/api/spatial/context");
    expect(final.activeNeeds.some((need) => need.id === requirementId)).toBe(false);
  });

  it("reports server normalization and keeps private content out of other participants' summaries", async () => {
    const sync = await read<SyncSessionResult>("/api/sync", { passive: true });
    const result = await command("SubmitRequirement", {
      baseRevision: sync.revision, visibility: "application-private", hardness: "soft", delegation: { mode: "negotiable" },
      payload: { kind: "attribute", key: "wheelchair-accessible", expect: "verified_true" }, note: "Private explanation",
    });
    expect(result.receipt?.requirement).toMatchObject({ hardness: "hard", delegation: { mode: "locked" } });
    const peer = await read<SpatialContextResult>("/api/spatial/context", {}, room.tokens.sarah);
    const peerPage = new ContextPager().read(room.tokens.sarah, {}, peer);
    expect(JSON.stringify(peerPage)).not.toContain(result.receipt!.id);
    expect(JSON.stringify(peerPage)).not.toContain("Private explanation");
    expect(JSON.stringify(peerPage)).not.toContain("wheelchair-accessible");
  });
});
