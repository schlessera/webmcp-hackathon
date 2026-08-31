import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  apiPost,
  createTestRoom,
  startServer,
  type TestRoom,
  type TestServer,
} from "./helpers.ts";

/**
 * Lane 2: the full demo trajectory against the real Berlin Mitte dataset —
 * requirements -> impasse -> private adjustment -> consent -> recovery ->
 * proposal/veto -> agreement staging/commit -> arrival -> navigation. Wire
 * privacy asserted on raw payloads throughout.
 */

let server: TestServer;
let room: TestRoom;
let revision = 0;

interface Envelope {
  ok: boolean;
  revision?: number;
  effect?: string;
  outstanding?: Array<{
    type: string;
    requestId?: string;
    kind?: string;
    change?: { dimension?: string; from?: number; to?: number };
    projectedGain?: { newCandidates: number };
    staged?: boolean;
  }>;
  error?: { code: string; message: string; recovery: string };
  delta?: {
    fromRevision: number;
    events: Array<{ revision: number; type: string; level: string; text: string; payload?: unknown }>;
  };
}

interface SpatialContext {
  ok: boolean;
  revision: number;
  phase: string;
  scope: { scopeId: string; area: { radiusM: number } } | null;
  feasibility: { state: string; eligible: number };
  candidates: Array<{ candidateId: string; eligibility: string; why: string }>;
  proposals: Array<{ proposalId: string; candidateId: string; status: string; stanceCounts: { accept: number; other: number; reject?: number }; vetoStands: boolean; ownStance?: string }>;
  agreement?: { proposalId: string; candidateId: string; status: string };
  arrival?: { mode: string; pickupNote?: string };
  impasse?: { active: boolean; text: string };
}

const PICKUP_CANARY = "CANARY-pickup-7741 back entrance on Ziegelstrasse";

beforeAll(async () => {
  server = await startServer();
  room = await createTestRoom(server.baseUrl, { berlin: true });
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
const context = (token: string) =>
  apiPost<SpatialContext>(server.baseUrl, "/api/spatial/context", token, {});

let adjustmentId = "";
let radiusTo = 0;
let vetoProposalId = "";
let agreedProposalId = "";
let agreedCandidateId = "";

describe("requirements build up to a detected impasse", () => {
  it("starts feasible: the full venue set inside the 800 m scope", async () => {
    const view = await context(room.tokens.org);
    expect(view.body.ok).toBe(true);
    expect(view.body.candidates).toHaveLength(31);
    expect(view.body.feasibility.eligible).toBeGreaterThan(3);
    expect(view.body.scope!.area.radiusM).toBe(800);
    expect(view.body.impasse).toBeUndefined();
  });

  it("Sarah's shared vegetarian requirement recomputes eligibility", async () => {
    const submit = await command(room.tokens.sarah, "SubmitRequirement", {
      baseRevision: revision,
      visibility: "shared",
      hardness: "hard",
      delegation: { mode: "approval_required" },
      payload: { kind: "attribute", key: "vegetarian-options", expect: "verified_true" },
    });
    expect(submit.body.ok).toBe(true);
    revision = submit.body.revision!;
  });

  it("Joe's application-private lactose requirement triggers the impasse (no verified option in scope)", async () => {
    const before = revision;
    const submit = await command(room.tokens.joe, "SubmitRequirement", {
      baseRevision: revision,
      visibility: "application-private",
      hardness: "hard",
      delegation: { mode: "approval_required" },
      payload: { kind: "attribute", key: "lactose-free-options", expect: "verified_true" },
    });
    expect(submit.body.ok).toBe(true);
    revision = submit.body.revision!;

    // Everyone sees the neutral impasse notice; nobody is named as blocking.
    for (const token of [room.tokens.org, room.tokens.sarah]) {
      const view = await sync(token, before);
      const impasse = view.body.delta!.events.find((e) => e.type === "impasse_detected");
      expect(impasse).toBeDefined();
      expect(impasse!.text).toContain("No option currently satisfies");
      expect(impasse!.text).not.toContain("Joe");
      expect(view.raw).not.toContain("lactose");
    }
  });

  it("the radius adjustment is outstanding for the organizer only", async () => {
    const orgView = await sync(room.tokens.org);
    const request = orgView.body.outstanding!.find((o) => o.type === "adjustment_request");
    expect(request).toBeDefined();
    expect(request!.kind).toBe("scope_change");
    expect(request!.change!.dimension).toBe("radius_m");
    expect(request!.change!.from).toBe(800);
    expect(request!.projectedGain!.newCandidates).toBeGreaterThanOrEqual(3);
    expect(request!.staged).toBe(false);
    adjustmentId = request!.requestId!;
    radiusTo = request!.change!.to!;

    for (const token of [room.tokens.sarah, room.tokens.joe]) {
      const view = await sync(token);
      expect(
        view.body.outstanding!.filter((o) => o.type === "adjustment_request"),
      ).toHaveLength(0);
      // The adjustment's identity never serializes into a peer payload.
      expect(view.raw).not.toContain(adjustmentId);
    }
  });

  it("further requirements land while the impasse stands, without re-detection", async () => {
    const before = revision;
    const exclusion = await command(room.tokens.org, "SubmitRequirement", {
      baseRevision: revision,
      visibility: "shared",
      hardness: "hard",
      delegation: { mode: "approval_required" },
      payload: { kind: "exclusion", key: "cuisine", values: ["italian"], lifetime: "session" },
    });
    expect(exclusion.body.ok).toBe(true);
    revision = exclusion.body.revision!;
    const budget = await command(room.tokens.org, "SubmitRequirement", {
      baseRevision: revision,
      visibility: "shared",
      hardness: "hard",
      delegation: { mode: "approval_required" },
      payload: { kind: "budget", perPersonMax: { amount: 15, currency: "EUR" } },
    });
    expect(budget.body.ok).toBe(true);
    revision = budget.body.revision!;

    const view = await sync(room.tokens.sarah, before);
    expect(
      view.body.delta!.events.filter((e) => e.type === "impasse_detected"),
    ).toHaveLength(0);
    const spatial = await context(room.tokens.sarah);
    expect(spatial.body.impasse?.active).toBe(true);
    expect(spatial.body.feasibility.eligible).toBe(0);
  });
});

describe("private adjustment, consent, recovery", () => {
  it("a foreign participant cannot resolve the organizer's request (existence-oracle safe)", async () => {
    const { body } = await command(room.tokens.joe, "ResolvePrivateRequest", {
      baseRevision: revision,
      requestId: adjustmentId,
      decision: "grant",
    });
    expect(body.ok).toBe(false);
    expect(body.error!.code).toBe("not_found");
  });

  it("granting outside the delegated bound stages instead of applying", async () => {
    const grant = await command(room.tokens.org, "ResolvePrivateRequest", {
      baseRevision: revision,
      requestId: adjustmentId,
      decision: "grant",
    });
    expect(grant.body.ok).toBe(true);
    revision = grant.body.revision!;
    expect(grant.body.effect).toContain("confirm on the page");

    // Scope unchanged until the in-page confirmation.
    const spatial = await context(room.tokens.org);
    expect(spatial.body.scope!.area.radiusM).toBe(800);
    const outstanding = await sync(room.tokens.org);
    const request = outstanding.body.outstanding!.find((o) => o.type === "adjustment_request");
    expect(request!.staged).toBe(true);
  });

  it("the in-page confirmation applies the scope change and resolves the impasse", async () => {
    const before = revision;
    const confirm = await command(room.tokens.org, "ConfirmPrivateRequest", {
      baseRevision: revision,
      requestId: adjustmentId,
    });
    expect(confirm.body.ok).toBe(true);
    revision = confirm.body.revision!;

    const spatial = await context(room.tokens.org);
    expect(spatial.body.scope!.area.radiusM).toBe(radiusTo);
    expect(spatial.body.impasse).toBeUndefined();
    expect(spatial.body.feasibility.eligible).toBeGreaterThanOrEqual(3);

    // Peers see the shared scope change and ownerless aggregates — never the
    // adjustment id or who granted it.
    for (const token of [room.tokens.sarah, room.tokens.joe]) {
      const view = await sync(token, before);
      const types = view.body.delta!.events.map((e) => e.type);
      expect(types).toContain("scope_change_applied");
      expect(types).toContain("impasse_resolved");
      const resolved = view.body.delta!.events.find((e) => e.type === "adjustment_resolved");
      expect(resolved!.level).toBe("aggregate");
      expect(resolved!.text).not.toContain("Alex");
      expect(view.raw).not.toContain(adjustmentId);
    }
  });
});

describe("proposal, veto, agreement, arrival", () => {
  it("proposing and vetoing an in-scope candidate", async () => {
    const spatial = await context(room.tokens.joe);
    const eligible = spatial.body.candidates.filter((c) => c.eligibility === "eligible");
    expect(eligible.length).toBeGreaterThanOrEqual(3);
    const target = eligible[eligible.length - 1].candidateId;

    const propose = await command(room.tokens.joe, "ProposeDestination", {
      baseRevision: revision,
      candidateId: target,
    });
    expect(propose.body.ok).toBe(true);
    revision = propose.body.revision!;
    vetoProposalId = (await context(room.tokens.joe)).body.proposals
      .find((p) => p.candidateId === target)!.proposalId;

    const veto = await command(room.tokens.sarah, "RespondToProposal", {
      baseRevision: revision,
      proposalId: vetoProposalId,
      disposition: "reject",
      visibility: "shared",
      reason: { kind: "history", note: "visited too recently" },
    });
    expect(veto.body.ok).toBe(true);
    revision = veto.body.revision!;

    const after = await context(room.tokens.org);
    expect(after.body.proposals.find((p) => p.proposalId === vetoProposalId)!.status).toBe("vetoed");
  });

  it("agreement cannot stage against a veto or unready participants", async () => {
    const spatial = await context(room.tokens.org);
    const eligible = spatial.body.candidates.filter((c) => c.eligibility === "eligible");
    agreedCandidateId = eligible[0].candidateId;
    const propose = await command(room.tokens.org, "ProposeDestination", {
      baseRevision: revision,
      candidateId: agreedCandidateId,
    });
    expect(propose.body.ok).toBe(true);
    revision = propose.body.revision!;
    agreedProposalId = (await context(room.tokens.org)).body.proposals
      .find((p) => p.candidateId === agreedCandidateId)!.proposalId;

    const premature = await command(room.tokens.org, "ConfirmAgreement", {
      baseRevision: revision,
      proposalId: agreedProposalId,
    });
    expect(premature.body.ok).toBe(false);
    expect(premature.body.error!.code).toBe("consent_required");
  });

  it("stanceCounts count only own + shared stances; no raw reject count", async () => {
    const privateAccept = await command(room.tokens.joe, "RespondToProposal", {
      baseRevision: revision,
      proposalId: agreedProposalId,
      disposition: "accept",
      visibility: "application-private",
    });
    expect(privateAccept.body.ok).toBe(true);
    revision = privateAccept.body.revision!;

    const own = (await context(room.tokens.joe)).body.proposals
      .find((p) => p.proposalId === agreedProposalId)!;
    expect(own.stanceCounts.accept).toBe(1);
    expect(own.ownStance).toBe("accept");

    const peer = (await context(room.tokens.sarah)).body.proposals
      .find((p) => p.proposalId === agreedProposalId)!;
    // Joe's application-private stance is invisible to peers, and no reject
    // count exists to subtract against — only the veto boolean.
    expect(peer.stanceCounts.accept).toBe(0);
    expect(peer.stanceCounts.reject).toBeUndefined();
    expect(peer.vetoStands).toBe(false);
    const vetoed = (await context(room.tokens.sarah)).body.proposals
      .find((p) => p.proposalId === vetoProposalId)!;
    expect(vetoed.vetoStands).toBe(true);
  });

  it("all accept + ready, organizer stages, page commit moves to arrival", async () => {
    for (const key of ["org", "sarah", "joe"] as const) {
      const accept = await command(room.tokens[key], "RespondToProposal", {
        baseRevision: revision,
        proposalId: agreedProposalId,
        disposition: "accept",
        visibility: "shared",
      });
      expect(accept.body.ok).toBe(true);
      revision = accept.body.revision!;
      const ready = await command(room.tokens[key], "SetReadyState", {
        baseRevision: revision,
        state: "ready",
      });
      expect(ready.body.ok).toBe(true);
      revision = ready.body.revision!;
    }

    const stage = await command(room.tokens.org, "ConfirmAgreement", {
      baseRevision: revision,
      proposalId: agreedProposalId,
    });
    expect(stage.body.ok).toBe(true);
    revision = stage.body.revision!;
    expect((await context(room.tokens.org)).body.agreement!.status).toBe("staged");

    const commit = await command(room.tokens.org, "CommitAgreement", {
      baseRevision: revision,
      proposalId: agreedProposalId,
    });
    expect(commit.body.ok).toBe(true);
    revision = commit.body.revision!;

    const after = await context(room.tokens.sarah);
    expect(after.body.phase).toBe("arrival");
    expect(after.body.agreement!.status).toBe("committed");
    expect(after.body.agreement!.candidateId).toBe(agreedCandidateId);
  });

  it("committed is absorbing: no stance, proposal, or second commit can touch it", async () => {
    // A member cannot veto the committed destination away (audit finding 1).
    const veto = await command(room.tokens.joe, "RespondToProposal", {
      baseRevision: revision,
      proposalId: agreedProposalId,
      disposition: "reject",
      visibility: "shared",
    });
    expect(veto.body.ok).toBe(false);
    expect(veto.body.error!.code).toBe("phase_unavailable");

    const spatial = await context(room.tokens.org);
    expect(spatial.body.agreement!.status).toBe("committed");
    expect(spatial.body.agreement!.candidateId).toBe(agreedCandidateId);
    // Competing proposals were retired at commit; nothing else is stageable.
    for (const p of spatial.body.proposals) {
      if (p.proposalId !== agreedProposalId) {
        expect(p.status).toBe("withdrawn");
      }
    }

    const propose = await command(room.tokens.joe, "ProposeDestination", {
      baseRevision: revision,
      candidateId: spatial.body.candidates[0].candidateId,
    });
    expect(propose.body.ok).toBe(false);
    expect(propose.body.error!.code).toBe("phase_unavailable");

    const recommit = await command(room.tokens.org, "CommitAgreement", {
      baseRevision: revision,
      proposalId: agreedProposalId,
    });
    expect(recommit.body.ok).toBe(false);
    expect(recommit.body.error!.code).toBe("phase_unavailable");
  });

  it("protected-category attributes are forced hard + locked server-side", async () => {
    const submit = await command(room.tokens.org, "SubmitRequirement", {
      baseRevision: revision,
      visibility: "shared",
      hardness: "soft",
      delegation: { mode: "negotiable", bound: { dimension: "radius_m", max: 2000 } },
      payload: { kind: "attribute", key: "wheelchair-accessible", expect: "verified_true" },
    });
    expect(submit.body.ok).toBe(true);
    revision = submit.body.revision!;
    const row = (
      await room.pool.query(
        `SELECT hardness, delegation FROM requirements
          WHERE room_id = $1 AND payload->>'key' = 'wheelchair-accessible'`,
        [room.roomId],
      )
    ).rows[0];
    expect(row.hardness).toBe("hard");
    expect(row.delegation.mode).toBe("locked");
  });

  it("arrival plans stay per-participant; pickup notes never leak", async () => {
    const plan = await command(room.tokens.joe, "PlanArrival", {
      baseRevision: revision,
      mode: "car",
      pickupNote: PICKUP_CANARY,
    });
    expect(plan.body.ok).toBe(true);
    const before = revision;
    revision = plan.body.revision!;

    const own = await context(room.tokens.joe);
    expect(own.body.arrival!.mode).toBe("car");
    expect(own.body.arrival!.pickupNote).toBe(PICKUP_CANARY);

    for (const token of [room.tokens.org, room.tokens.sarah]) {
      const spatial = await context(token);
      expect(spatial.raw).not.toContain("CANARY-pickup-7741");
      const view = await sync(token, before);
      expect(view.raw).not.toContain("CANARY-pickup-7741");
      const event = view.body.delta!.events.find((e) => e.type === "arrival_plan_updated");
      expect(event!.text).toContain("Joe");
      expect(event!.text).toContain("car");
    }
    expect(server.logs()).not.toContain("CANARY-pickup-7741");
  });

  it("navigation handoff links come from held coordinates", async () => {
    const nav = await apiPost<{
      ok: boolean;
      target: { candidateId: string; name: string; location: { lat: number; lng: number } };
      links: { geo: string; googleMaps: string; appleMaps: string };
    }>(server.baseUrl, "/api/spatial/navigation", room.tokens.joe, {});
    expect(nav.body.ok).toBe(true);
    expect(nav.body.target.candidateId).toBe(agreedCandidateId);
    const { lat, lng } = nav.body.target.location;
    expect(nav.body.links.googleMaps).toBe(
      `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`,
    );
    expect(nav.body.links.geo).toContain(`geo:${lat},${lng}`);
    expect(nav.body.links.appleMaps).toContain(`daddr=${lat},${lng}`);
  });

  it("PlanArrival before commitment is phase-gated (regression: fresh room)", async () => {
    const second = await createTestRoom(server.baseUrl, { berlin: true });
    try {
      const { body } = await apiPost<Envelope>(server.baseUrl, "/api/commands", second.tokens.joe, {
        type: "PlanArrival",
        input: { baseRevision: 0, mode: "walk" },
      });
      expect(body.ok).toBe(false);
      expect(body.error!.code).toBe("phase_unavailable");
      expect(body.error!.recovery).toBeTruthy();
    } finally {
      await second.cleanup();
    }
  });

  it("dossier inspection returns four-state attributes; unknown ids are not_found", async () => {
    const inspect = await apiPost<{
      ok: boolean;
      candidates: Array<{ candidateId: string; attributes: Array<{ key: string; status: string }> }>;
    }>(server.baseUrl, "/api/spatial/inspect", room.tokens.sarah, {
      candidateIds: [agreedCandidateId],
    });
    expect(inspect.body.ok).toBe(true);
    const statuses = new Set(
      inspect.body.candidates[0].attributes.map((a) => a.status),
    );
    for (const s of statuses) {
      expect(["verified_true", "verified_false", "unverified", "unknown"]).toContain(s);
    }

    const missing = await apiPost<Envelope>(
      server.baseUrl, "/api/spatial/inspect", room.tokens.sarah,
      { candidateIds: ["place_nope"] },
    );
    expect(missing.body.ok).toBe(false);
    expect(missing.body.error!.code).toBe("not_found");
  });
});
