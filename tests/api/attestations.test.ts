import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  apiPost,
  createTestRoom,
  startServer,
  type TestRoom,
  type TestServer,
} from "./helpers.ts";

/**
 * AttestAttribute on the wire (SPATIAL-PROTOCOL.md §8.1): an attestation
 * over an unknown fact resolves it for the whole room, the ledger names the
 * attester, a contradiction of a verified record fact disputes it, and
 * nothing crosses rooms.
 */

let server: TestServer;
let room: TestRoom;
let other: TestRoom;

interface Envelope { ok: boolean; revision?: number; effect?: string; error?: { code: string; message: string } }
interface Dossier {
  ok: boolean;
  revision?: number;
  candidates: Array<{
    candidateId: string;
    mapRevision: number;
    attributes: Array<{ key: string; status: string; source: string; attestedBy?: string; note?: string }>;
  }>;
}
interface Context {
  ok: boolean;
  candidates: Array<{ candidateId: string; eligibility: string }>;
}

beforeAll(async () => {
  server = await startServer();
  room = await createTestRoom(server.baseUrl, { berlin: true });
  other = await createTestRoom(server.baseUrl, { berlin: true });
});
afterAll(async () => {
  await room.cleanup();
  await other.cleanup();
  await server.stop();
});

const command = (token: string, type: string, input: Record<string, unknown>) =>
  apiPost<Envelope>(server.baseUrl, "/api/commands", token, { type, input });
const inspect = (token: string, id: string) =>
  apiPost<Dossier>(server.baseUrl, "/api/spatial/inspect", token, { candidateIds: [id] });
const context = (token: string) =>
  apiPost<Context>(server.baseUrl, "/api/spatial/context", token, {});

const attr = (d: Dossier, key: string) => d.candidates[0].attributes.find((a) => a.key === key)!;

describe("AttestAttribute", () => {
  // Grill Royal (place_1): lactose-free unknown, wheelchair verified_false in the record.
  const grill = () => `place_1_${room.roomId.replace("room_test_", "")}`;
  let rev = 0;

  it("rejects an unknown place and a non-boolean key", async () => {
    const bad = await command(room.tokens.sarah, "AttestAttribute", {
      baseRevision: rev, candidateId: "place_nope", key: "dog-friendly",
      status: "verified_true", confidence: 0.9, note: "x",
    });
    expect(bad.body.ok).toBe(false);
    expect(bad.body.error?.code).toBe("not_found");
    const price = await command(room.tokens.sarah, "AttestAttribute", {
      baseRevision: rev, candidateId: grill(), key: "price-level",
      status: "verified_true", confidence: 0.9, note: "x",
    });
    expect(price.body.ok).toBe(false);
    expect(price.body.error?.code).toBe("invalid_input");
  });

  it("resolves an unknown fact for the room, named and noted", async () => {
    const before = await inspect(room.tokens.joe, grill());
    expect(attr(before.body, "lactose-free-options").status).toBe("unknown");

    const done = await command(room.tokens.sarah, "AttestAttribute", {
      baseRevision: rev, candidateId: grill(), key: "lactose-free-options",
      status: "verified_true", confidence: 0.85, note: "asked at the counter", sourceUrl: "https://example.org/menu",
    });
    expect(done.body, JSON.stringify(done.body)).toMatchObject({ ok: true });
    expect(done.body.effect).toMatch(/Attested lactose-free options: yes for Grill Royal/);
    rev = done.body.revision!;

    // Every viewer sees the same merged fact, with provenance.
    for (const token of [room.tokens.joe, room.tokens.org, room.tokens.sarah]) {
      const after = await inspect(token, grill());
      expect(attr(after.body, "lactose-free-options")).toMatchObject({
        status: "verified_true",
        source: `agent:${room.participantIds.sarah}`,
        attestedBy: room.participantIds.sarah,
        note: "asked at the counter",
      });
    }
    // The record itself is untouched.
    const stored = await room.pool.query("SELECT attributes FROM candidates WHERE id = $1", [grill()]);
    const raw = (stored.rows[0].attributes as Array<{ key: string; status: string }>).find(
      (a) => a.key === "lactose-free-options",
    )!;
    expect(raw.status).toBe("unknown");
  });

  it("the classifier rules on it: a lactose-free need now passes Grill Royal", async () => {
    const need = await command(room.tokens.joe, "SubmitRequirement", {
      baseRevision: rev,
      requirementId: `req_lac_${room.roomId.replace("room_test_", "")}`,
      visibility: "shared", hardness: "hard",
      delegation: { mode: "approval_required" },
      payload: { kind: "attribute", key: "lactose-free-options", expect: "verified_true" },
    });
    expect(need.body.ok).toBe(true);
    rev = need.body.revision!;
    const ctx = await context(room.tokens.org);
    expect(ctx.body.candidates.find((c) => c.candidateId === grill())!.eligibility).toBe("eligible");
  });

  it("contradicting a verified record fact disputes it instead of overwriting", async () => {
    const done = await command(room.tokens.joe, "AttestAttribute", {
      baseRevision: rev, candidateId: grill(), key: "wheelchair-accessible",
      status: "verified_true", confidence: 0.6, note: "there is a ramp at the side",
    });
    expect(done.body.ok).toBe(true);
    rev = done.body.revision!;
    const after = await inspect(room.tokens.org, grill());
    const w = attr(after.body, "wheelchair-accessible");
    expect(w.status).toBe("unknown");
    expect(w.source).toMatch(/^disputed:osm:wheelchair\|agent:/);
    expect(w.attestedBy).toBe(room.participantIds.joe);
  });

  it("the feed names the attester; nothing crosses rooms", async () => {
    const sync = await apiPost<{ ok: boolean; delta?: { events: Array<{ type: string; text: string }> } }>(
      server.baseUrl, "/api/sync", room.tokens.org, { sinceRevision: 0 },
    );
    const lines = sync.body.delta!.events.filter((e) => e.type === "attribute_attested").map((e) => e.text);
    expect(lines).toContain("Sarah checked lactose-free options at Grill Royal: yes.");
    expect(lines).toContain("Joe checked step-free access at Grill Royal: yes.");

    const elsewhere = await inspect(other.tokens.org, `place_1_${other.roomId.replace("room_test_", "")}`);
    expect(attr(elsewhere.body, "lactose-free-options").status).toBe("unknown");
  });

  it("invalidates private screening whenever an attestation bumps mapRevision", async () => {
    const declared = await command(room.tokens.joe, "SubmitRequirement", {
      baseRevision: rev,
      requirementId: `req_private_${room.roomId.replace("room_test_", "")}`,
      visibility: "agent-private",
      hardness: "hard",
      delegation: { mode: "approval_required" },
      scopeHint: { affects: "candidate-eligibility" },
    });
    expect(declared.body.ok).toBe(true);
    rev = declared.body.revision!;

    // Resolve the whole pool first so the post-bump request is specifically
    // for the changed place rather than sharing a ten-item page with older
    // missing verdicts.
    const candidates = (
      await room.pool.query("SELECT id, map_revision FROM candidates WHERE room_id = $1 ORDER BY id", [
        room.roomId,
      ])
    ).rows as Array<{ id: string; map_revision: number }>;
    for (let offset = 0; offset < candidates.length; offset += 10) {
      const screened = await command(room.tokens.joe, "EvaluateCandidates", {
        baseRevision: rev,
        verdicts: candidates.slice(offset, offset + 10).map((candidate) => ({
          candidateId: candidate.id,
          verdict: candidate.id === grill() ? "unacceptable" : "acceptable",
          screenedMapRevision: Number(candidate.map_revision),
        })),
      });
      expect(screened.body.ok).toBe(true);
      rev = screened.body.revision!;
    }
    expect(
      (await context(room.tokens.joe)).body.candidates.find((c) => c.candidateId === grill())
        ?.eligibility,
    ).toBe("excluded");
    const beforeMapRevision = (await inspect(room.tokens.joe, grill())).body.candidates[0]
      .mapRevision;

    const changed = await command(room.tokens.sarah, "AttestAttribute", {
      baseRevision: rev,
      candidateId: grill(),
      key: "dog-friendly",
      status: "verified_true",
      confidence: 0.8,
      note: "staff confirmed it",
    });
    expect(changed.body.ok).toBe(true);
    rev = changed.body.revision!;

    const after = await inspect(room.tokens.joe, grill());
    expect(after.body.candidates[0].mapRevision).toBe(beforeMapRevision + 1);
    expect(
      (await context(room.tokens.joe)).body.candidates.find((c) => c.candidateId === grill())
        ?.eligibility,
    ).toBe("uncertain");

    const sync = await apiPost<{
      ok: boolean;
      outstanding: Array<{ type: string; candidateIds?: string[] }>;
    }>(server.baseUrl, "/api/sync", room.tokens.joe, {});
    expect(
      sync.body.outstanding.find((item) => item.type === "evaluation_request")?.candidateIds,
    ).toContain(grill());

    const fresh = await command(room.tokens.joe, "EvaluateCandidates", {
      baseRevision: rev,
      verdicts: [{
        candidateId: grill(),
        verdict: "acceptable",
        screenedMapRevision: after.body.candidates[0].mapRevision,
      }],
    });
    expect(fresh.body.ok).toBe(true);
    rev = fresh.body.revision!;
    expect(
      (await context(room.tokens.joe)).body.candidates.find((c) => c.candidateId === grill())
        ?.eligibility,
    ).toBe("eligible");
  });
});
