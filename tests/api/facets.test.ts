import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  apiPost,
  createTestRoom,
  startServer,
  type TestRoom,
  type TestServer,
} from "./helpers.ts";

/**
 * Lane 2: the facets contract (FACETS.md) over the wire, against the real
 * Berlin Mitte room. What matters here is what each participant's SERIALIZED
 * response does and does not contain.
 */

let server: TestServer;
let room: TestRoom;
let revision = 0;
let suffix = "";

interface Envelope {
  ok: boolean;
  revision?: number;
  effect?: string;
  error?: { code: string; message: string; recovery: string };
  participants?: Array<{
    participantId: string;
    displayName: string;
    role: string;
    readyState: string;
  }>;
  delta?: { events: Array<{ type: string; level: string; text: string; payload?: unknown }> };
}

interface Context {
  ok: boolean;
  total: number;
  matching: number;
  feasibility: { eligible: number };
  candidates: Array<{ candidateId: string; eligibility: string; walkMin: number; priceLevel: number | null }>;
  facets: Array<{
    key: string;
    label: string;
    type: string;
    counts: { yes?: number; no?: number; unknown: number };
    values?: Array<{ value: string; label: string; count: number }>;
  }>;
  activeNeeds: Array<{
    id: string;
    label: string;
    ruledOut: number;
    wouldReturn: number;
    unknown: number;
    active: boolean;
    ownerId: string;
    visibility: string;
  }>;
  privateEffects: Array<{ owner: string; ruledOut: number; topic?: string }>;
  participants: Array<{ participantId: string; displayName: string; role: string; readyState: string }>;
  error?: { code: string; message: string; recovery: string };
}

const sync = (token: string) =>
  apiPost<Envelope>(server.baseUrl, "/api/sync", token, {});
const command = (token: string, type: string, input: Record<string, unknown>) =>
  apiPost<Envelope>(server.baseUrl, "/api/commands", token, { type, input });
const context = (token: string, body: Record<string, unknown> = {}) =>
  apiPost<Context>(server.baseUrl, "/api/spatial/context", token, body);

const VEG = () => `req_veg_${suffix}`;
const LACTOSE = () => `req_lac_${suffix}`;

beforeAll(async () => {
  server = await startServer();
  room = await createTestRoom(server.baseUrl, { berlin: true });
  suffix = room.roomId.replace("room_test_", "");

  const veg = await command(room.tokens.sarah, "SubmitRequirement", {
    baseRevision: revision,
    requirementId: VEG(),
    visibility: "shared",
    hardness: "hard",
    delegation: { mode: "approval_required" },
    payload: { kind: "attribute", key: "vegetarian-options", expect: "verified_true" },
  });
  expect(veg.body.ok).toBe(true);
  revision = veg.body.revision!;

  const lactose = await command(room.tokens.joe, "SubmitRequirement", {
    baseRevision: revision,
    requirementId: LACTOSE(),
    visibility: "application-private",
    hardness: "hard",
    delegation: { mode: "approval_required" },
    scopeHint: { affects: "candidate-eligibility", category: "dietary" },
    payload: { kind: "attribute", key: "lactose-free-options", expect: "verified_true" },
  });
  expect(lactose.body.ok).toBe(true);
  revision = lactose.body.revision!;
});
afterAll(async () => {
  await room.cleanup();
  await server.stop();
});

describe("facets ride with the candidate set", () => {
  it("describes what is askable, with a label, a type and a mandatory unknown count", async () => {
    const { body } = await context(room.tokens.org);
    expect(body.ok).toBe(true);
    expect(body.total).toBe(21); // in-scope at 800 m
    expect(body.matching).toBe(body.feasibility.eligible);

    const wheelchair = body.facets.find((f) => f.key === "wheelchair-accessible")!;
    expect(wheelchair.label).toBe("step-free access");
    expect(wheelchair.type).toBe("boolean");
    for (const facet of body.facets) {
      expect(facet.counts.unknown, facet.key).toBeTypeOf("number");
      // No domain or category field for the client to branch on.
      expect(Object.keys(facet)).not.toContain("category");
      expect(Object.keys(facet)).not.toContain("domain");
    }
    expect(body.facets.find((f) => f.key === "cuisine")!.values!.length).toBeGreaterThan(0);
    expect(body.facets.find((f) => f.key === "walk-minutes")!.type).toBe("numeric");
  });

  it("recomputes walking time from the current scope centre and passes a missing price through", async () => {
    const { body } = await context(room.tokens.org);
    for (const c of body.candidates) {
      expect(c.walkMin, c.candidateId).toBeGreaterThanOrEqual(1);
      expect(c.priceLevel === null || typeof c.priceLevel === "number").toBe(true);
    }
  });

  it("carries the room's roster on both read paths", async () => {
    const spatial = await context(room.tokens.sarah);
    expect(spatial.body.participants).toHaveLength(3);
    expect(spatial.body.participants[0].role).toBe("organizer");
    expect(spatial.body.participants.map((p) => p.displayName).sort())
      .toEqual(["Alex", "Joe", "Sarah"]);

    const synced = await sync(room.tokens.sarah);
    expect(synced.body.participants).toHaveLength(3);
    expect(synced.body.participants!.every((p) => p.readyState === "contributing")).toBe(true);
  });
});

describe("needs and private effects across viewers", () => {
  it("gives the owner the need and the peers only its effect", async () => {
    const joe = await context(room.tokens.joe);
    const own = joe.body.activeNeeds.find((n) => n.id === LACTOSE())!;
    expect(own.label).toBe("lactose-free options");
    expect(own.ruledOut).toBe(2);
    expect(own.unknown).toBe(19);
    expect(own.wouldReturn).toBeGreaterThan(0);
    expect(joe.body.privateEffects).toEqual([]);

    for (const token of [room.tokens.org, room.tokens.sarah]) {
      const peer = await context(token);
      expect(peer.body.activeNeeds.map((n) => n.id)).toEqual([VEG()]);
      expect(peer.body.privateEffects).toEqual([
        { owner: room.participantIds.joe, ruledOut: 2, topic: "dietary" },
      ]);
      // The effect is public; the condition is not. (The facets array names
      // lactose-free options as a property of the DATA — it reads identically
      // whether or not anyone stated a need about it.)
      const attributable = JSON.stringify({
        activeNeeds: peer.body.activeNeeds,
        privateEffects: peer.body.privateEffects,
      });
      expect(attributable).not.toContain("lactose");
      expect(attributable).not.toContain(LACTOSE());
    }
  });

  it("labels a shared need from the server's vocabulary, with its deltas", async () => {
    const { body } = await context(room.tokens.org);
    const veg = body.activeNeeds.find((n) => n.id === VEG())!;
    expect(veg.label).toBe("vegetarian options");
    expect(veg.ownerId).toBe(room.participantIds.sarah);
    expect(veg.visibility).toBe("shared");
    expect(veg.active).toBe(true);
    expect(veg.unknown).toBe(9);
  });
});

describe("the press-and-hold preview", () => {
  it("returns the set as if the need were gone, matching its own wouldReturn", async () => {
    const live = await context(room.tokens.joe);
    const need = live.body.activeNeeds.find((n) => n.id === LACTOSE())!;
    const preview = await context(room.tokens.joe, { excludeRequirementId: LACTOSE() });
    expect(preview.body.ok).toBe(true);
    expect(preview.body.matching - live.body.matching).toBe(need.wouldReturn);
    expect(preview.body.activeNeeds.find((n) => n.id === LACTOSE())!.active).toBe(false);
  });

  it("previews a shared need for anyone in the room", async () => {
    const preview = await context(room.tokens.org, { excludeRequirementId: VEG() });
    expect(preview.body.ok).toBe(true);
    expect(preview.body.activeNeeds.find((n) => n.id === VEG())!.active).toBe(false);
  });

  it("refuses a peer's private need exactly as it refuses an unknown one", async () => {
    const foreign = await context(room.tokens.sarah, { excludeRequirementId: LACTOSE() });
    expect(foreign.body.ok).toBe(false);
    expect(foreign.body.error!.code).toBe("not_found");

    const unknown = await context(room.tokens.sarah, { excludeRequirementId: "req_nope" });
    // Identical error: the response may not confirm that a foreign
    // requirement exists (existence oracle).
    expect(unknown.body.error).toEqual(foreign.body.error);
    expect(foreign.raw).not.toContain(room.participantIds.joe);
  });
});

describe("setting a need aside", () => {
  let beforeToggle = 0;

  it("stops it ruling anything out while keeping its row", async () => {
    const before = await context(room.tokens.joe);
    beforeToggle = revision;
    const toggle = await command(room.tokens.joe, "SetRequirementActive", {
      baseRevision: revision,
      requirementId: LACTOSE(),
      active: false,
    });
    expect(toggle.body.ok).toBe(true);
    revision = toggle.body.revision!;

    const after = await context(room.tokens.joe);
    const row = after.body.activeNeeds.find((n) => n.id === LACTOSE())!;
    expect(row.active).toBe(false);
    expect(row.wouldReturn).toBe(0);
    expect(after.body.matching).toBeGreaterThan(before.body.matching);

    // A need with no effect has no effect to report to the room.
    const peer = await context(room.tokens.sarah);
    expect(peer.body.privateEffects).toEqual([]);
  });

  it("tells peers that a private need moved, and nothing else", async () => {
    const view = await apiPost<Envelope>(server.baseUrl, "/api/sync", room.tokens.sarah, {
      sinceRevision: beforeToggle,
    });
    const event = view.body.delta!.events.find((e) => e.type === "requirement_toggled")!;
    expect(event.level).toBe("existence");
    expect(event.payload).toBeUndefined();
    expect(event.text).not.toContain("Joe");
    expect(view.raw).not.toContain("lactose");
  });

  it("is idempotent: setting the same state again changes no revision", async () => {
    const again = await command(room.tokens.joe, "SetRequirementActive", {
      baseRevision: revision,
      requirementId: LACTOSE(),
      active: false,
    });
    expect(again.body.ok).toBe(true);
    expect(again.body.revision).toBe(revision);
  });

  it("is owner-only, and says no more than not_found about someone else's", async () => {
    const foreign = await command(room.tokens.sarah, "SetRequirementActive", {
      baseRevision: revision,
      requirementId: LACTOSE(),
      active: true,
    });
    expect(foreign.body.ok).toBe(false);
    expect(foreign.body.error!.code).toBe("not_found");

    const unknown = await command(room.tokens.sarah, "SetRequirementActive", {
      baseRevision: revision,
      requirementId: "req_nope",
      active: true,
    });
    expect(unknown.body.error).toEqual(foreign.body.error);
  });

  it("brings the need back with its effect intact", async () => {
    const back = await command(room.tokens.joe, "SetRequirementActive", {
      baseRevision: revision,
      requirementId: LACTOSE(),
      active: true,
    });
    expect(back.body.ok).toBe(true);
    revision = back.body.revision!;

    const peer = await context(room.tokens.sarah);
    expect(peer.body.privateEffects).toEqual([
      { owner: room.participantIds.joe, ruledOut: 2, topic: "dietary" },
    ]);
  });
});

describe("free-text needs", () => {
  it("are accepted, rule nothing out, and leave every place unverified", async () => {
    const submit = await command(room.tokens.org, "SubmitRequirement", {
      baseRevision: revision,
      requirementId: `req_txt_${suffix}`,
      visibility: "shared",
      hardness: "hard",
      delegation: { mode: "approval_required" },
      payload: { kind: "text", text: "somewhere we can hear each other" },
    });
    expect(submit.body.ok).toBe(true);
    revision = submit.body.revision!;

    const { body } = await context(room.tokens.org);
    const need = body.activeNeeds.find((n) => n.id === `req_txt_${suffix}`)!;
    expect(need.label).toBe("somewhere we can hear each other");
    expect(need.ruledOut).toBe(0);
    expect(need.unknown).toBe(body.total);
    // Nothing has been checked against it, so nothing can still be matching.
    expect(body.matching).toBe(0);
  });
});
