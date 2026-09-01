import { describe, expect, it } from "vitest";
import { projectEvent, type StoredEvent } from "../../apps/server/src/projection.ts";

/** Lane 1 additions: per-viewer projection of every new domain event type.
 * The projector's default drops unknown types silently, so every event a
 * handler emits must have an explicit case — these tests pin that. */

const base = { revision: 7, actorId: "p_org", visibility: "shared" } as const;
const ev = (overrides: Partial<StoredEvent>): StoredEvent => ({
  ...base,
  type: "unknown",
  payload: {},
  ...overrides,
});

describe("new event projections", () => {
  it("every emitted domain event type projects for its actor (never dropped)", () => {
    const types = [
      "scope_change_proposed", "scope_change_applied", "proposal_created",
      "requirement_toggled",
      "impasse_detected", "adjustment_resolved", "requirement_relaxed",
      "impasse_resolved", "agreement_staged", "agreement_stage_aborted",
      "agreement_committed", "proposal_withdrawn", "arrival_plan_updated",
    ];
    for (const type of types) {
      const projected = projectEvent(
        ev({ type, payload: { actorName: "Alex", targetParticipantId: "p_org" } }),
        "p_org",
      );
      expect(projected, `event type ${type} was dropped by the projector`).not.toBeNull();
    }
  });

  it("a private toggle reaches peers as existence only; a shared one in full", () => {
    const toggled = (visibility: string) =>
      ev({
        type: "requirement_toggled",
        visibility,
        payload: {
          actorName: "Alex",
          requirementId: "req_1",
          active: false,
          summary: "budget ≤ €15 per person",
        },
      });

    const shared = projectEvent(toggled("shared"), "p_sarah")!;
    expect(shared.level).toBe("full");
    expect(shared.text).toContain("Alex");

    const peer = projectEvent(toggled("application-private"), "p_sarah")!;
    expect(peer.level).toBe("existence");
    expect(peer.payload).toBeUndefined();
    expect(peer.text).not.toContain("Alex");
    expect(peer.text).not.toContain("15");

    const owner = projectEvent(toggled("application-private"), "p_org")!;
    expect(owner.level).toBe("full");
    expect(owner.text).toContain("set aside");
  });

  it("adjustment_proposed reaches only its addressee", () => {
    const event = ev({
      type: "adjustment_proposed",
      actorId: null,
      visibility: "application-private",
      payload: {
        targetParticipantId: "p_org",
        adjustmentId: "adj_1",
        kind: "scope_change",
        change: { dimension: "radius_m", from: 800, to: 1400 },
        projectedGain: { newCandidates: 4 },
      },
    });
    const forOrganizer = projectEvent(event, "p_org");
    expect(forOrganizer).not.toBeNull();
    expect(forOrganizer!.level).toBe("full");
    expect(forOrganizer!.text).toContain("800 m to 1400 m");
    expect(projectEvent(event, "p_sarah")).toBeNull();
    expect(projectEvent(event, "p_joe")).toBeNull();
  });

  it("adjustment_resolved is aggregate and ownerless for peers", () => {
    const event = ev({
      type: "adjustment_resolved",
      actorId: "p_joe",
      visibility: "application-private",
      payload: {
        actorName: "Joe",
        targetParticipantId: "p_joe",
        adjustmentId: "adj_1",
        kind: "scope_change",
        decision: "granted",
        newCandidates: 3,
      },
    });
    const peer = projectEvent(event, "p_sarah")!;
    expect(peer.level).toBe("aggregate");
    expect(peer.text).toBe("Search adjusted. 3 new candidates.");
    expect(peer.text).not.toContain("Joe");
    expect(peer.payload).toBeUndefined();

    const own = projectEvent(event, "p_joe")!;
    expect(own.level).toBe("full");
    expect(own.text).toContain("granted");
  });

  it("impasse_detected is neutral for everyone — no owner, no reason", () => {
    const event = ev({
      type: "impasse_detected",
      actorId: null,
      payload: { conflictSize: 1 },
    });
    for (const viewer of ["p_org", "p_sarah", "p_joe"]) {
      const projected = projectEvent(event, viewer)!;
      expect(projected.level).toBe("aggregate");
      expect(projected.text).toContain("No option currently satisfies");
      expect(projected.payload).toBeUndefined();
    }
  });

  it("requirement_relaxed stays aggregate for peers of an application-private owner", () => {
    const event = ev({
      type: "requirement_relaxed",
      actorId: "p_joe",
      visibility: "application-private",
      payload: {
        actorName: "Joe",
        requirementId: "req_9",
        change: { dimension: "per_person_eur", from: 15, to: 25 },
      },
    });
    const peer = projectEvent(event, "p_sarah")!;
    expect(peer.level).toBe("aggregate");
    expect(peer.text).not.toContain("Joe");
    expect(peer.payload).toBeUndefined();
    const own = projectEvent(event, "p_joe")!;
    expect(own.level).toBe("full");
  });

  it("arrival_plan_updated shares the mode but carries no pickup note", () => {
    const event = ev({
      type: "arrival_plan_updated",
      actorId: "p_joe",
      payload: { actorName: "Joe", mode: "car" },
    });
    const peer = projectEvent(event, "p_sarah")!;
    expect(peer.text).toBe("Joe plans to arrive by car.");
    expect(JSON.stringify(peer.payload ?? {})).not.toContain("pickup");
  });
});
