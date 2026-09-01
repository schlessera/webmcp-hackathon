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
 * Presence on the wire (REDESIGN-HANDOFF gaps 3 and 6): `arrived` is durable
 * (first sync on any surface), `present` is an open socket right now, and
 * `lastSyncedRevision` is what the caller had seen before this sync.
 */

let server: TestServer;
let room: TestRoom;

interface Roster {
  ok: boolean;
  revision?: number;
  lastSyncedRevision?: number;
  participants?: Array<{ participantId: string; arrived: boolean; present: boolean }>;
}

beforeAll(async () => {
  server = await startServer();
  room = await createTestRoom(server.baseUrl);
});
afterAll(async () => {
  await room.cleanup();
  await server.stop();
});

const sync = (token: string, sinceRevision?: number) =>
  apiPost<Roster>(server.baseUrl, "/api/sync", token,
    sinceRevision === undefined ? {} : { sinceRevision });
const context = (token: string) =>
  apiPost<Roster>(server.baseUrl, "/api/spatial/context", token, {});
const person = (view: Roster, id: string) =>
  view.participants!.find((p) => p.participantId === id)!;

const waitFor = async (check: () => Promise<boolean>, ms = 4000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return check();
};

describe("arrival", () => {
  it("the first sync is the arrival; the others have not arrived yet", async () => {
    const { body } = await sync(room.tokens.org);
    expect(body.lastSyncedRevision).toBe(0);
    expect(person(body, room.participantIds.org).arrived).toBe(true);
    expect(person(body, room.participantIds.sarah).arrived).toBe(false);
    expect(person(body, room.participantIds.joe).arrived).toBe(false);

    // Both read paths agree, and nobody is present without a socket.
    const spatial = await context(room.tokens.org);
    expect(person(spatial.body, room.participantIds.sarah).arrived).toBe(false);
    expect(spatial.body.participants!.every((p) => p.present === false)).toBe(true);
  });

  it("a peer's arrival shows up on everyone's roster and never reverts", async () => {
    await sync(room.tokens.sarah);
    const { body } = await sync(room.tokens.org);
    expect(person(body, room.participantIds.sarah).arrived).toBe(true);
    expect(person(body, room.participantIds.joe).arrived).toBe(false);
  });
});

describe("lastSyncedRevision", () => {
  it("reports the revision the previous sync had seen, before this one stamps it", async () => {
    const first = await sync(room.tokens.joe);
    expect(first.body.lastSyncedRevision).toBe(0);
    const seen = first.body.revision!;

    const moved = await apiPost<{ ok: boolean; revision: number }>(
      server.baseUrl, "/api/commands", room.tokens.org,
      { type: "SetReadyState", input: { baseRevision: seen, state: "ready" } },
    );
    expect(moved.body.ok).toBe(true);
    expect(moved.body.revision).toBeGreaterThan(seen);

    const second = await sync(room.tokens.joe, seen);
    expect(second.body.lastSyncedRevision).toBe(seen);
    expect(second.body.revision).toBe(moved.body.revision);
    const third = await sync(room.tokens.joe);
    expect(third.body.lastSyncedRevision).toBe(moved.body.revision);
  });
});

describe("presence", () => {
  it("an open socket makes a participant present; closing it makes them absent", async () => {
    const org = await openRealtime(server.baseUrl, room.tokens.org);
    try {
      expect(
        await waitFor(async () => person((await sync(room.tokens.sarah)).body, room.participantIds.org).present),
      ).toBe(true);

      const joe = await openRealtime(server.baseUrl, room.tokens.joe);
      // Joe's own socket is told who is here; the organizer's socket hears of Joe.
      expect(
        await waitFor(async () =>
          joe.frames().some((f) => {
            const m = JSON.parse(f) as { type: string; present?: string[] };
            return m.type === "presence" && m.present!.includes(room.participantIds.joe);
          })),
      ).toBe(true);
      expect(
        await waitFor(async () =>
          org.frames().some((f) => {
            const m = JSON.parse(f) as { type: string; present?: string[] };
            return m.type === "presence" && m.present!.includes(room.participantIds.joe);
          })),
      ).toBe(true);
      const both = (await context(room.tokens.sarah)).body;
      expect(person(both, room.participantIds.joe).present).toBe(true);
      expect(person(both, room.participantIds.org).present).toBe(true);
      expect(person(both, room.participantIds.sarah).present).toBe(false);

      joe.close();
      expect(
        await waitFor(async () => !person((await sync(room.tokens.sarah)).body, room.participantIds.joe).present),
      ).toBe(true);
      expect(
        await waitFor(async () =>
          org.frames().filter((f) => (JSON.parse(f) as { type: string }).type === "presence").length >= 3),
      ).toBe(true);
    } finally {
      org.close();
    }
  });
});
