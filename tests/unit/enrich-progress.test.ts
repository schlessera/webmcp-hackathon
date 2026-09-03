import { afterEach, describe, expect, it, vi } from "vitest";
import {
  beginLookups,
  currentLookups,
  LOOKUP_COALESCE_MS,
  LOOKUP_DEADLINE_MS,
  onLookupProgress,
  resetProgress,
} from "../../apps/server/src/enrich/progress.ts";

afterEach(() => {
  resetProgress();
  vi.useRealTimers();
});

describe("lookup progress", () => {
  it("emits the first add of a quiet room at once, then coalesces to one frame per 250 ms and sends an empty clear", () => {
    vi.useFakeTimers();
    const frames: unknown[] = [];
    const off = onLookupProgress((roomId, message) => frames.push({ roomId, ...message }));
    try {
      // A lookup that lives 300 ms must be seen as pending: the first add goes
      // out immediately, later changes wait for the window.
      const endA = beginLookups("room_1", ["a", "b"], { kind: "need", label: "step-free access" });
      expect(frames).toEqual([
        { roomId: "room_1", type: "lookups", pending: ["a", "b"], reason: { kind: "need", label: "step-free access" } },
      ]);
      const endB = beginLookups("room_1", ["b", "c"], { kind: "place" });
      endA();
      expect(frames).toHaveLength(1);
      vi.advanceTimersByTime(LOOKUP_COALESCE_MS);
      expect(frames).toHaveLength(2);
      expect(frames[1]).toEqual(
        { roomId: "room_1", type: "lookups", pending: ["b", "c"], reason: { kind: "place" } },
      );

      // Many changes in the next window still yield one frame.
      const endD = beginLookups("room_1", ["d"]);
      endD();
      endB();
      vi.advanceTimersByTime(LOOKUP_COALESCE_MS - 1);
      expect(frames).toHaveLength(2);
      vi.advanceTimersByTime(1);
      expect(frames).toHaveLength(3);
      expect(frames[2]).toEqual({ roomId: "room_1", type: "lookups", pending: [] });
    } finally {
      off();
    }
  });

  it("reference-counts overlapping work and exposes the current snapshot", () => {
    vi.useFakeTimers();
    const endFirst = beginLookups("room_2", ["a"], { kind: "pool" });
    const endSecond = beginLookups("room_2", ["a"]);
    expect(currentLookups("room_2")).toEqual({
      type: "lookups",
      pending: ["a"],
    });
    endFirst();
    expect(currentLookups("room_2")).toEqual({ type: "lookups", pending: ["a"] });
    endSecond();
    expect(currentLookups("room_2")).toEqual({ type: "lookups", pending: [] });
  });

  it("derives a reason only when every outstanding batch agrees", () => {
    vi.useFakeTimers();
    const endNeed = beginLookups("room_3", ["a"], { kind: "need", label: "step-free access" });
    const endOtherNeed = beginLookups("room_3", ["b"], { kind: "need", label: "step-free access" });
    expect(currentLookups("room_3")).toEqual({
      type: "lookups",
      pending: ["a", "b"],
      reason: { kind: "need", label: "step-free access" },
    });
    const endPlace = beginLookups("room_3", ["c"], { kind: "place" });
    expect(currentLookups("room_3")).toEqual({
      type: "lookups",
      pending: ["a", "b", "c"],
    });
    endPlace();
    expect(currentLookups("room_3")).toEqual({
      type: "lookups",
      pending: ["a", "b"],
      reason: { kind: "need", label: "step-free access" },
    });
    endNeed();
    endOtherNeed();
  });

  it("expires a wedged batch and publishes the empty clearing frame", () => {
    vi.useFakeTimers();
    const frames: unknown[] = [];
    const off = onLookupProgress((_roomId, message) => frames.push(message));
    try {
      const end = beginLookups("room_wedged", ["a"], { kind: "place" });
      vi.advanceTimersByTime(LOOKUP_COALESCE_MS);
      expect(frames).toEqual([
        { type: "lookups", pending: ["a"], reason: { kind: "place" } },
      ]);
      vi.advanceTimersByTime(LOOKUP_DEADLINE_MS - LOOKUP_COALESCE_MS);
      expect(currentLookups("room_wedged")).toEqual({ type: "lookups", pending: [] });
      vi.advanceTimersByTime(LOOKUP_COALESCE_MS);
      expect(frames.at(-1)).toEqual({ type: "lookups", pending: [] });
      end();
      expect(currentLookups("room_wedged")).toEqual({ type: "lookups", pending: [] });
    } finally {
      off();
    }
  });
});
