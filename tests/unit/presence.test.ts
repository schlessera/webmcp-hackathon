import { describe, expect, it } from "vitest";
import {
  markClosed,
  markOpen,
  presentIn,
  setViewing,
  viewingIn,
} from "../../apps/server/src/presence.ts";

/**
 * Who is looking, and at what. Presence is in-memory and per process; the
 * viewing half is what draws a peer's initials behind a place's name.
 */
describe("viewing presence", () => {
  it("records which place a socket has open and clears it on null", () => {
    markOpen("r1", "p_a");
    expect(setViewing("r1", "p_a", "s1", "place_1")).toBe(true);
    expect(viewingIn("r1")).toEqual([{ participantId: "p_a", candidateId: "place_1" }]);
    // Same place again is not a change: no broadcast for it.
    expect(setViewing("r1", "p_a", "s1", "place_1")).toBe(false);
    expect(setViewing("r1", "p_a", "s1", "place_2")).toBe(true);
    expect(setViewing("r1", "p_a", "s1", null)).toBe(true);
    expect(viewingIn("r1")).toEqual([]);
    expect(setViewing("r1", "p_a", "s1", null)).toBe(false);
    markClosed("r1", "p_a", "s1");
  });

  it("two tabs: the room sees the one that spoke last, and a closed tab yields to the other", () => {
    markOpen("r2", "p_b");
    markOpen("r2", "p_b");
    setViewing("r2", "p_b", "sA", "place_1");
    expect(setViewing("r2", "p_b", "sB", "place_2")).toBe(true);
    expect(viewingIn("r2")).toEqual([{ participantId: "p_b", candidateId: "place_2" }]);
    // Tab B closes: the surviving tab's place is what the room sees now.
    expect(markClosed("r2", "p_b", "sB")).toBe(false);
    expect(viewingIn("r2")).toEqual([{ participantId: "p_b", candidateId: "place_1" }]);
    expect(markClosed("r2", "p_b", "sA")).toBe(true);
    expect(viewingIn("r2")).toEqual([]);
    expect(presentIn("r2").size).toBe(0);
  });

  it("rooms do not leak into each other", () => {
    markOpen("r3", "p_c");
    markOpen("r4", "p_c");
    setViewing("r3", "p_c", "s9", "place_3");
    expect(viewingIn("r4")).toEqual([]);
    markClosed("r3", "p_c", "s9");
    markClosed("r4", "p_c");
  });
});
