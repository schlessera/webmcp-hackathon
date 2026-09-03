import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { questionKey } from "@webmcp-hackathon/contracts";
import type { Participant } from "../../apps/server/src/auth.ts";
import { runAgent } from "../../apps/server/src/nl/agent.ts";
import { setTransport } from "../../apps/server/src/nl/openai.ts";
import {
  apiPost,
  createTestRoom,
  startServer,
  type TestRoom,
  type TestServer,
} from "./helpers.ts";

interface Envelope {
  ok: boolean;
  revision?: number;
  effect?: string;
  error?: { code: string; message: string };
}
interface Context {
  ok: boolean;
  candidates: Array<{ candidateId: string; eligibility: string; why?: string }>;
}
interface Dossier {
  ok: boolean;
  candidates: Array<{
    attributes: Array<{
      key: string;
      label?: string;
      status: string;
      source: string;
      confidence: number;
      confirmedByName?: string;
      confirmedByParticipant?: string;
    }>;
  }>;
}

let server: TestServer;
let room: TestRoom;
let other: TestRoom;
let firstId: string;
let otherId: string;
let osmRef: string;

const command = (token: string, type: string, input: Record<string, unknown>) =>
  apiPost<Envelope>(server.baseUrl, "/api/commands", token, { type, input });
const context = (token: string) =>
  apiPost<Context>(server.baseUrl, "/api/spatial/context", token, {});
const inspect = (token: string, candidateId: string) =>
  apiPost<Dossier>(server.baseUrl, "/api/spatial/inspect", token, { candidateIds: [candidateId] });

beforeAll(async () => {
  server = await startServer();
  room = await createTestRoom(server.baseUrl);
  other = await createTestRoom(server.baseUrl);
  firstId = (await room.pool.query(
    "SELECT id FROM candidates WHERE room_id = $1 ORDER BY id LIMIT 1",
    [room.roomId],
  )).rows[0].id as string;
  otherId = (await other.pool.query(
    "SELECT id FROM candidates WHERE room_id = $1 ORDER BY id LIMIT 1",
    [other.roomId],
  )).rows[0].id as string;
  osmRef = `test:confirmed:${room.roomId}`;
  const attributes = JSON.stringify([
    { key: "dog-friendly", status: "unknown", source: "osm:dog", confidence: 0 },
  ]);
  await room.pool.query(
    "UPDATE candidates SET name = 'The Barn', osm_ref = $2, attributes = $3 WHERE id = $1",
    [firstId, osmRef, attributes],
  );
  await other.pool.query(
    "UPDATE candidates SET name = 'The Barn', osm_ref = $2, attributes = $3 WHERE id = $1",
    [otherId, osmRef, attributes],
  );
});

afterEach(() => setTransport(null));
afterAll(async () => {
  await room.pool.query("DELETE FROM confirmed_facts WHERE osm_ref = $1", [osmRef]);
  await room.cleanup();
  await other.cleanup();
  await server.stop();
});

describe("permanent confirmed facts", () => {
  let revision = 0;
  let otherRevision = 0;

  it("makes the same place eligible immediately in this and another room", async () => {
    const need = await command(room.tokens.joe, "SubmitRequirement", {
      baseRevision: revision,
      visibility: "shared",
      hardness: "hard",
      delegation: { mode: "approval_required" },
      payload: { kind: "attribute", key: "dog-friendly", expect: "verified_true" },
    });
    expect(need.body.ok).toBe(true);
    revision = need.body.revision!;
    const otherNeed = await command(other.tokens.joe, "SubmitRequirement", {
      baseRevision: otherRevision,
      visibility: "shared",
      hardness: "hard",
      delegation: { mode: "approval_required" },
      payload: { kind: "attribute", key: "dog-friendly", expect: "verified_true" },
    });
    expect(otherNeed.body.ok).toBe(true);
    otherRevision = otherNeed.body.revision!;
    expect((await context(room.tokens.org)).body.candidates.find((c) => c.candidateId === firstId)?.eligibility)
      .toBe("uncertain");
    expect((await context(other.tokens.org)).body.candidates.find((c) => c.candidateId === otherId)?.eligibility)
      .toBe("uncertain");

    const confirmed = await command(room.tokens.sarah, "ConfirmFact", {
      baseRevision: revision,
      candidateId: firstId,
      criterionId: "dog-friendly",
      lean: true,
      note: "asked at the door",
    });
    expect(confirmed.body).toMatchObject({ ok: true });
    revision = confirmed.body.revision!;
    expect((await context(room.tokens.org)).body.candidates.find((c) => c.candidateId === firstId))
      .toMatchObject({ eligibility: "eligible", why: "Sarah confirmed it" });
    expect((await context(other.tokens.org)).body.candidates.find((c) => c.candidateId === otherId))
      .toMatchObject({ eligibility: "eligible", why: "Sarah confirmed it" });
    const fact = (await inspect(room.tokens.joe, firstId)).body.candidates[0].attributes
      .find((attribute) => attribute.key === "dog-friendly");
    expect(fact).toMatchObject({
      status: "verified_true",
      source: "person:confirmed",
      confidence: 0.95,
      confirmedByName: "Sarah",
      confirmedByParticipant: room.participantIds.sarah,
    });
  });

  it("allows only the confirmer or organizer to withdraw, and withdrawal reverses both rooms", async () => {
    const denied = await command(room.tokens.joe, "UnconfirmFact", {
      baseRevision: revision,
      candidateId: firstId,
      criterionId: "dog-friendly",
    });
    expect(denied.body).toMatchObject({ ok: false, error: { code: "not_authorized" } });

    const withdrawn = await command(room.tokens.sarah, "UnconfirmFact", {
      baseRevision: revision,
      candidateId: firstId,
      criterionId: "dog-friendly",
    });
    expect(withdrawn.body.ok).toBe(true);
    revision = withdrawn.body.revision!;
    expect((await context(room.tokens.org)).body.candidates.find((c) => c.candidateId === firstId)?.eligibility)
      .toBe("uncertain");
    expect((await context(other.tokens.org)).body.candidates.find((c) => c.candidateId === otherId)?.eligibility)
      .toBe("uncertain");
  });

  it("stores only a private question hash and never shows its sentence to a peer or another room", async () => {
    const sentence = "Is there a quiet back room for sensory breaks?";
    const criterionId = questionKey(sentence);
    const need = await command(room.tokens.sarah, "SubmitRequirement", {
      baseRevision: revision,
      visibility: "application-private",
      hardness: "hard",
      delegation: { mode: "approval_required" },
      payload: { kind: "text", text: sentence },
    });
    expect(need.body.ok).toBe(true);
    revision = need.body.revision!;
    const confirmed = await command(room.tokens.sarah, "ConfirmFact", {
      baseRevision: revision,
      candidateId: firstId,
      criterionId,
      lean: true,
      note: sentence,
      sourceUrl: `https://example.org/check?q=${encodeURIComponent(sentence)}`,
    });
    expect(confirmed.body.ok).toBe(true);
    revision = confirmed.body.revision!;

    const stored = (await room.pool.query(
      "SELECT * FROM confirmed_facts WHERE osm_ref = $1 AND criterion_id = $2",
      [osmRef, criterionId],
    )).rows[0];
    expect(stored.criterion_id).toBe(criterionId);
    expect(stored.note).toBeNull();
    expect(stored.source_url).toBeNull();
    expect(JSON.stringify(stored)).not.toContain(sentence);

    const owner = JSON.stringify((await inspect(room.tokens.sarah, firstId)).body);
    const peer = JSON.stringify((await inspect(room.tokens.joe, firstId)).body);
    const crossRoom = JSON.stringify((await inspect(other.tokens.joe, otherId)).body);
    expect(owner).toContain(sentence);
    expect(owner).toContain(criterionId);
    expect(peer).not.toContain(sentence);
    expect(peer).not.toContain(criterionId);
    expect(crossRoom).not.toContain(sentence);
    expect(crossRoom).not.toContain(criterionId);

    const sync = await apiPost<{ delta?: { events: Array<{ text: string }> } }>(
      server.baseUrl,
      "/api/sync",
      room.tokens.joe,
      { sinceRevision: need.body.revision },
    );
    expect(JSON.stringify(sync.body.delta)).toContain("confirmed a question at The Barn");
    expect(JSON.stringify(sync.body.delta)).not.toContain(sentence);
  });

  it("routes natural confirmation language to confirm_fact through scripted transport", async () => {
    await room.pool.query("DELETE FROM confirmed_facts WHERE osm_ref = $1 AND criterion_id = 'dog-friendly'", [osmRef]);
    const actor: Participant = {
      id: room.participantIds.sarah,
      roomId: room.roomId,
      displayName: "Sarah",
      role: "member",
      readyState: "contributing",
    };
    let round = 0;
    setTransport(async (body) => {
      round += 1;
      if (round === 1) {
        expect(JSON.stringify(body.tools)).toContain("confirm_fact");
        expect(JSON.stringify(body.input)).toContain("confirm dogs are welcome at The Barn");
        return {
          output: [{
            type: "function_call",
            call_id: "call_confirm",
            name: "confirm_fact",
            arguments: JSON.stringify({
              candidateId: firstId,
              criterionId: "dog-friendly",
              lean: true,
            }),
          }],
        };
      }
      return {
        output: [{
          type: "message",
          content: [{ type: "output_text", text: "Dogs welcome at The Barn is now confirmed." }],
        }],
      };
    });
    const outcome = await runAgent(actor, "confirm dogs are welcome at The Barn", null);
    expect(outcome.actions).toMatchObject([{ tool: "confirm_fact", ok: true }]);
    expect((await room.pool.query(
      "SELECT lean FROM confirmed_facts WHERE osm_ref = $1 AND criterion_id = 'dog-friendly'",
      [osmRef],
    )).rows[0].lean).toBe(true);
  });
});
