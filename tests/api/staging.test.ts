import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  apiPost,
  createTestRoom,
  openRealtime,
  startServer,
  type TestRoom,
  type TestServer,
} from "./helpers.ts";

/**
 * Staging as the page experiences it (D1): accepting a place marks a person
 * ready, every proposal carries what staging still waits on, and a peer's
 * private accept stays a count, never a name. Plus the viewing half of
 * presence: which place a socket has open rides on the presence frame.
 */

let server: TestServer;
let room: TestRoom;
let revision = 0;
let proposalId = "";
const place = (letter: string) => `place_${letter}_${room.roomId.slice("room_test_".length)}`;

interface Context {
  ok: boolean;
  revision?: number;
  participants?: Array<{ participantId: string; readyState: string }>;
  proposals?: Array<{
    proposalId: string;
    candidateId: string;
    status: string;
    staging: { ready: boolean; notReady: string[]; unaccepted: number; vetoStands: boolean };
  }>;
}

beforeAll(async () => {
  server = await startServer();
  room = await createTestRoom(server.baseUrl);
  revision = (await apiPost<{ revision: number }>(server.baseUrl, "/api/sync", room.tokens.org, {})).body.revision;
});
afterAll(async () => {
  await room.cleanup();
  await server.stop();
});

const command = async (token: string, type: string, input: Record<string, unknown>) => {
  const result = await apiPost<{ ok: boolean; revision?: number; error?: { code: string; message: string } }>(
    server.baseUrl, "/api/commands", token, { type, input: { baseRevision: revision, ...input } },
  );
  if (result.body.ok && result.body.revision !== undefined) revision = result.body.revision;
  return result.body;
};
const context = async (token: string) =>
  (await apiPost<Context>(server.baseUrl, "/api/spatial/context", token, {})).body;
const proposal = (view: Context) => view.proposals!.find((p) => p.proposalId === proposalId)!;
const ready = (view: Context, id: string) =>
  view.participants!.find((p) => p.participantId === id)!.readyState === "ready";

describe("accepting marks you ready", () => {
  it("a fresh proposal waits on everyone, by name for readiness", async () => {
    // The helper seeds one open proposal on Alpha; a second one on Beta is
    // what moves the room into deliberation, where staging is legal.
    proposalId = room.proposalId;
    const propose = await command(room.tokens.org, "ProposeDestination", { candidateId: place("b") });
    expect(propose.ok).toBe(true);
    const view = await context(room.tokens.org);
    const s = proposal(view).staging;
    expect(s.ready).toBe(false);
    expect(s.notReady.sort()).toEqual(
      [room.participantIds.org, room.participantIds.sarah, room.participantIds.joe].sort(),
    );
    expect(s.unaccepted).toBe(3);
    expect(s.vetoStands).toBe(false);
  });

  it("an accept flips the accepter to ready and publishes ready_state_changed", async () => {
    const accept = await command(room.tokens.sarah, "RespondToProposal", {
      proposalId, disposition: "accept", visibility: "shared",
    });
    expect(accept.ok).toBe(true);
    const view = await context(room.tokens.org);
    expect(ready(view, room.participantIds.sarah)).toBe(true);
    expect(ready(view, room.participantIds.org)).toBe(false);
    const s = proposal(view).staging;
    expect(s.notReady).not.toContain(room.participantIds.sarah);
    expect(s.unaccepted).toBe(2);

    const sync = await apiPost<{ delta: { events: Array<{ type: string }> } }>(
      server.baseUrl, "/api/sync", room.tokens.joe, { sinceRevision: revision - 2 },
    );
    expect(sync.body.delta.events.map((e) => e.type)).toContain("ready_state_changed");
  });

  it("a private accept counts down without being named", async () => {
    const accept = await command(room.tokens.joe, "RespondToProposal", {
      proposalId, disposition: "accept", visibility: "application-private",
    });
    expect(accept.ok).toBe(true);
    const peer = proposal(await context(room.tokens.sarah));
    expect(peer.staging.unaccepted).toBe(1);
    expect(peer.staging.notReady).toEqual([room.participantIds.org]);
    // The stance itself stays silent to a peer; only the count moved.
    expect((peer as unknown as { stances: Array<{ participantId: string; stance: string }> }).stances
      .find((s) => s.participantId === room.participantIds.joe)!.stance).toBe("none");
  });

  it("a veto is a blocker on its own, and the last accept makes it stageable", async () => {
    const veto = await command(room.tokens.org, "RespondToProposal", {
      proposalId, disposition: "reject", visibility: "shared",
    });
    expect(veto.ok).toBe(true);
    let s = proposal(await context(room.tokens.org)).staging;
    expect(s.vetoStands).toBe(true);
    expect(s.ready).toBe(false);
    // A veto is not an accept: the organizer is still not ready.
    expect(s.notReady).toEqual([room.participantIds.org]);

    const accept = await command(room.tokens.org, "RespondToProposal", {
      proposalId, disposition: "accept", visibility: "shared",
    });
    expect(accept.ok).toBe(true);
    const view = await context(room.tokens.org);
    s = proposal(view).staging;
    expect(s).toEqual({ ready: true, notReady: [], unaccepted: 0, vetoStands: false });
    expect(proposal(view).status).toBe("open");

    const stage = await command(room.tokens.org, "ConfirmAgreement", { proposalId });
    expect(stage.ok).toBe(true);
    expect(proposal(await context(room.tokens.org)).status).toBe("staged");
  });

  it("stepping back from ready is still a person's own call", async () => {
    const back = await command(room.tokens.sarah, "SetReadyState", { state: "contributing" });
    expect(back.ok).toBe(true);
    expect(ready(await context(room.tokens.org), room.participantIds.sarah)).toBe(false);
  });
});

describe("viewing presence", () => {
  it("a socket's open place reaches the room on the presence frame and clears with the socket", async () => {
    const org = await openRealtime(server.baseUrl, room.tokens.org);
    const sarah = await openRealtime(server.baseUrl, room.tokens.sarah);
    try {
      sarah.send({ type: "viewing", candidateId: place("b") });
      const seen = await waitFor(() =>
        org.frames().some((f) => {
          const m = JSON.parse(f) as { type: string; viewing?: Array<{ participantId: string; candidateId: string }> };
          return (
            m.type === "presence" &&
            (m.viewing ?? []).some(
              (v) => v.participantId === room.participantIds.sarah && v.candidateId === place("b"),
            )
          );
        }),
      );
      expect(seen).toBe(true);
      // The same place again is not a presence change. The interactive open
      // may still finish in this window and publish its terminal facts frame.
      const presenceCount = () => org.frames().filter((frame) =>
        (JSON.parse(frame) as { type?: string }).type === "presence"
      ).length;
      const before = presenceCount();
      sarah.send({ type: "viewing", candidateId: place("b") });
      await new Promise((r) => setTimeout(r, 150));
      expect(presenceCount()).toBe(before);

      sarah.close();
      const cleared = await waitFor(() => {
        const last = org
          .frames()
          .map((f) => JSON.parse(f) as { type: string; viewing?: unknown[]; present?: string[] })
          .filter((m) => m.type === "presence")
          .at(-1);
        return last !== undefined && !last.present!.includes(room.participantIds.sarah) && last.viewing!.length === 0;
      });
      expect(cleared).toBe(true);
    } finally {
      org.close();
    }
  });
});

const waitFor = async (check: () => boolean, ms = 4000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return check();
};
