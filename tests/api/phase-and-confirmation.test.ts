import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  apiPost,
  createTestRoom,
  openRealtime,
  startServer,
  type TestRealtime,
  type TestRoom,
  type TestServer,
} from "./helpers.ts";

/**
 * Lane 2: the two controls the POC previously deferred —
 *  - the UI-minted confirmation nonce behind CommitAgreement and
 *    ConfirmPrivateRequest (INTERACTION-AND-BINDING.md §5.4), and
 *  - per-command phase gating over the full §7.1 machine.
 * Both are exercised over raw HTTP, which is exactly the caller the nonce is
 * there to stop: a participant's own bearer token outside the page.
 */

let server: TestServer;
let room: TestRoom;
let revision = 0;

interface Envelope {
  ok: boolean;
  revision?: number;
  effect?: string;
  phase?: string;
  error?: { code: string; message: string; recovery: string };
  delta?: { events: Array<{ revision: number; type: string; text: string; payload?: unknown }> };
}

interface Context {
  ok: boolean;
  phase: string;
  proposals: Array<{ proposalId: string; candidateId: string; status: string }>;
}

let orgChannel: TestRealtime;
let sarahChannel: TestRealtime;
let proposalId = "";
let stagingRaw = "";
let commitNonce = "";

beforeAll(async () => {
  server = await startServer();
  room = await createTestRoom(server.baseUrl);
  orgChannel = await openRealtime(server.baseUrl, room.tokens.org);
  sarahChannel = await openRealtime(server.baseUrl, room.tokens.sarah);
});
afterAll(async () => {
  orgChannel?.close();
  sarahChannel?.close();
  await room.cleanup();
  await server.stop();
});

const sync = (token: string, sinceRevision?: number) =>
  apiPost<Envelope>(server.baseUrl, "/api/sync", token,
    sinceRevision === undefined ? {} : { sinceRevision });
const command = (token: string, type: string, input: Record<string, unknown>) =>
  apiPost<Envelope>(server.baseUrl, "/api/commands", token, { type, input });
const context = (token: string) =>
  apiPost<Context>(server.baseUrl, "/api/spatial/context", token, {});

const ready = async (key: "org" | "sarah" | "joe", state: string) => {
  const result = await command(room.tokens[key], "SetReadyState", {
    baseRevision: revision,
    state,
  });
  expect(result.body.ok, JSON.stringify(result.body.error)).toBe(true);
  revision = result.body.revision!;
};

describe("phase gating", () => {
  it("a fresh room is gathering, and arrival commands are refused with what IS available", async () => {
    const view = await sync(room.tokens.org);
    expect(view.body.phase).toBe("gathering");

    const { body } = await command(room.tokens.joe, "PlanArrival", {
      baseRevision: revision,
      mode: "walk",
    });
    expect(body.ok).toBe(false);
    expect(body.error!.code).toBe("phase_unavailable");
    expect(body.error!.message).toContain("gathering");
    // Self-correcting: the recovery names the commands the phase does accept.
    expect(body.error!.recovery).toContain("SubmitRequirement");
    expect(body.error!.recovery).not.toContain("PlanArrival");
  });

  it("agreement cannot be staged before a proposal has moved the room to deliberation", async () => {
    const { body } = await command(room.tokens.org, "ConfirmAgreement", {
      baseRevision: revision,
      proposalId: room.proposalId,
    });
    expect(body.ok).toBe(false);
    expect(body.error!.code).toBe("phase_unavailable");
  });

  it("the first proposal enters deliberation and publishes phase_changed", async () => {
    const before = revision;
    const propose = await command(room.tokens.org, "ProposeDestination", {
      baseRevision: revision,
      candidateId: `place_c_${room.roomId.slice("room_test_".length)}`,
    });
    expect(propose.body.ok).toBe(true);
    revision = propose.body.revision!;

    const view = await sync(room.tokens.sarah, before);
    expect(view.body.phase).toBe("deliberation");
    const changed = view.body.delta!.events.find((e) => e.type === "phase_changed");
    expect(changed, "phase transition is not in the projection").toBeDefined();
    expect(changed!.text).toContain("deliberation");

    proposalId = (await context(room.tokens.org)).body.proposals.find(
      (p) => p.candidateId === `place_c_${room.roomId.slice("room_test_".length)}`,
    )!.proposalId;
  });
});

describe("confirmation nonce on CommitAgreement", () => {
  it("stages once everyone is ready and accepting", async () => {
    for (const key of ["org", "sarah", "joe"] as const) {
      const accept = await command(room.tokens[key], "RespondToProposal", {
        baseRevision: revision,
        proposalId,
        disposition: "accept",
        visibility: "shared",
      });
      expect(accept.body.ok).toBe(true);
      revision = accept.body.revision!;
      await ready(key, "ready");
    }
    const stage = await command(room.tokens.org, "ConfirmAgreement", {
      baseRevision: revision,
      proposalId,
    });
    expect(stage.body.ok).toBe(true);
    revision = stage.body.revision!;
    stagingRaw = stage.raw;
  });

  it("the nonce never rides in a command result or a peer's projection", async () => {
    const nonce = await orgChannel.nonce("agreement", proposalId);
    expect(nonce).toHaveLength(48);

    // The staging command's own response is what a WebMCP tool result carries
    // back to the agent that called confirm_agreement.
    expect(stagingRaw).not.toContain(nonce);
    expect(stagingRaw).not.toContain("confirmationNonce");
    // Peers see neither the frame nor the value anywhere on their wire.
    for (const frame of sarahChannel.frames()) {
      expect(frame).not.toContain(nonce);
      expect(frame).not.toContain('"confirmation"');
    }
    const peer = await sync(room.tokens.sarah, 0);
    expect(peer.raw).not.toContain(nonce);
    const peerContext = await context(room.tokens.sarah);
    expect(peerContext.raw).not.toContain(nonce);
    expect(server.logs()).not.toContain(nonce);

    // Put it back for the commit below: reading it here consumed the local copy.
    commitNonce = nonce;
  });

  it("a raw bearer-token commit without a valid nonce is refused", async () => {
    const missing = await command(room.tokens.org, "CommitAgreement", {
      baseRevision: revision,
      proposalId,
    });
    expect(missing.body.ok).toBe(false);
    expect(missing.body.error!.code).toBe("invalid_input");

    for (const value of ["", "0".repeat(48), "not-a-nonce"]) {
      const attempt = await command(room.tokens.org, "CommitAgreement", {
        baseRevision: revision,
        proposalId,
        confirmationNonce: value,
      });
      expect(attempt.body.ok, `accepted nonce "${value}"`).toBe(false);
      expect(attempt.body.error!.code).toBe("consent_required");
      expect(attempt.body.error!.recovery).toContain("page");
    }
    // Nothing moved: the agreement is still staged, waiting for the page.
    expect((await context(room.tokens.org)).body.proposals
      .find((p) => p.proposalId === proposalId)!.status).toBe("staged");
  });

  it("a nonce is single-use, even when the commit it authorized aborted", async () => {
    // Sarah steps back from ready: the precondition no longer holds, so the
    // commit aborts the stage instead of committing — and spends the nonce.
    await ready("sarah", "contributing");
    const aborted = await command(room.tokens.org, "CommitAgreement", {
      baseRevision: revision,
      proposalId,
      confirmationNonce: commitNonce,
    });
    expect(aborted.body.ok).toBe(true);
    revision = aborted.body.revision!;
    expect(aborted.body.effect).toContain("Stage aborted");

    await ready("sarah", "ready");
    const restage = await command(room.tokens.org, "ConfirmAgreement", {
      baseRevision: revision,
      proposalId,
    });
    expect(restage.body.ok).toBe(true);
    revision = restage.body.revision!;

    const replay = await command(room.tokens.org, "CommitAgreement", {
      baseRevision: revision,
      proposalId,
      confirmationNonce: commitNonce,
    });
    expect(replay.body.ok).toBe(false);
    expect(replay.body.error!.code).toBe("consent_required");
  });

  it("re-issues the nonce to a reconnecting page, and to that page only", async () => {
    // A socket that drops between staging and confirming has lost the only
    // copy of its nonce; without re-issue the stage would be unconfirmable.
    const reconnected = await openRealtime(server.baseUrl, room.tokens.org);
    const peer = await openRealtime(server.baseUrl, room.tokens.sarah);
    try {
      commitNonce = await reconnected.nonce("agreement", proposalId);
      expect(commitNonce).toHaveLength(48);
      // A member is not the committer: nothing is staged for them.
      await expect(peer.nonce("agreement", proposalId, 500)).rejects.toThrow(
        /within 500ms/,
      );
      for (const frame of peer.frames()) {
        expect(frame).not.toContain(commitNonce);
      }
    } finally {
      reconnected.close();
      peer.close();
    }
  });

  it("the re-issued nonce commits, and the room enters agreed", async () => {
    const before = revision;
    const commit = await command(room.tokens.org, "CommitAgreement", {
      baseRevision: revision,
      proposalId,
      confirmationNonce: commitNonce,
    });
    expect(commit.body.ok, JSON.stringify(commit.body.error)).toBe(true);
    revision = commit.body.revision!;

    for (const token of Object.values(room.tokens)) {
      const view = await sync(token, before);
      expect(view.body.phase).toBe("agreed");
    }
    const changed = (await sync(room.tokens.joe, before)).body.delta!.events
      .find((e) => e.type === "phase_changed");
    expect(changed!.text).toContain("agreed");
  });
});

describe("commands closed by the decided phases", () => {
  it("negotiation commands are phase_unavailable once agreed", async () => {
    const attempts: Array<[string, Record<string, unknown>]> = [
      ["SubmitRequirement", {
        visibility: "shared", hardness: "hard",
        delegation: { mode: "approval_required" },
        payload: { kind: "attribute", key: "outdoor-seating", expect: "verified_true" },
      }],
      ["RespondToProposal", { proposalId, disposition: "reject", visibility: "shared" }],
      ["ProposeDestination", { candidateId: `place_b_${room.roomId.slice("room_test_".length)}` }],
      ["SetSearchScope", { transport: ["walk"] }],
      ["ConfirmAgreement", { proposalId }],
    ];
    for (const [type, input] of attempts) {
      const { body } = await command(room.tokens.org, type, {
        baseRevision: revision,
        ...input,
      });
      expect(body.ok, `${type} was accepted after agreement`).toBe(false);
      expect(body.error!.code, type).toBe("phase_unavailable");
    }
  });

  it("readiness and arrival planning stay open, and planning enters arrival", async () => {
    await ready("joe", "contributing");
    const plan = await command(room.tokens.joe, "PlanArrival", {
      baseRevision: revision,
      mode: "bike",
    });
    expect(plan.body.ok, JSON.stringify(plan.body.error)).toBe(true);
    revision = plan.body.revision!;
    expect((await context(room.tokens.joe)).body.phase).toBe("arrival");
  });
});
