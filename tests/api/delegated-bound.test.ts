import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  apiPost,
  createTestRoom,
  startServer,
  type TestRoom,
  type TestServer,
} from "./helpers.ts";

/**
 * REDESIGN-HANDOFF gap 5: an outstanding relaxation names the addressee's own
 * delegated ceiling so the consent copy can say "beyond the €30 you
 * delegated". Scope changes carry none — organizer authority has no bound.
 */

let server: TestServer;
let room: TestRoom;
let revision = 0;

interface Envelope {
  ok: boolean;
  revision?: number;
  outstanding?: Array<{
    type: string;
    kind?: string;
    change?: { dimension?: string; to?: number };
    withinDelegatedBound?: boolean;
    delegatedBound?: { dimension: string; max: number };
  }>;
}

beforeAll(async () => {
  server = await startServer();
  room = await createTestRoom(server.baseUrl, { berlin: true });
});
afterAll(async () => {
  await room.cleanup();
  await server.stop();
});

const command = (token: string, type: string, input: Record<string, unknown>) =>
  apiPost<Envelope>(server.baseUrl, "/api/commands", token, { type, input });
const sync = (token: string) => apiPost<Envelope>(server.baseUrl, "/api/sync", token, {});

describe("delegated bound on outstanding adjustments", () => {
  it("a budget relaxation inside a negotiable bound names the number", async () => {
    // €9 rules every place in scope out on its own (the cheapest band is €10),
    // so the council's minimal conflict set is this one need and the drafted
    // way out is its relaxation to the next band.
    const budget = await command(room.tokens.org, "SubmitRequirement", {
      baseRevision: revision,
      visibility: "shared",
      hardness: "hard",
      delegation: { mode: "negotiable", bound: { dimension: "per_person_eur", max: 30 } },
      payload: { kind: "budget", perPersonMax: { amount: 9, currency: "EUR" } },
    });
    expect(budget.body.ok).toBe(true);
    revision = budget.body.revision!;

    const view = await sync(room.tokens.org);
    const requests = view.body.outstanding!.filter((o) => o.type === "adjustment_request");
    const relax = requests.find((r) => r.change?.dimension === "per_person_eur");
    expect(relax, "no budget relaxation was drafted").toBeDefined();
    expect(relax!.change!.to).toBe(10);
    expect(relax!.delegatedBound).toEqual({ dimension: "per_person_eur", max: 30 });
    expect(relax!.withinDelegatedBound).toBe(true);
    // Only a need with a stated bound carries one; scope changes never do.
    for (const r of requests.filter((r) => r !== relax)) {
      expect(r).not.toHaveProperty("delegatedBound");
    }

    // Addressee-only: the bound is the organizer's own, so peers see no request at all.
    const peer = await sync(room.tokens.sarah);
    expect(peer.raw).not.toContain("delegatedBound");
  });
});
