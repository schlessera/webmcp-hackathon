import { afterEach, describe, expect, it, vi } from "vitest";
import {
  beginLookups,
  currentLookups,
  LOOKUP_COALESCE_MS,
  onLookupProgress,
  resetProgress,
} from "../../apps/server/src/enrich/progress.ts";

afterEach(() => {
  resetProgress();
  vi.useRealTimers();
});

describe("lookup progress", () => {
  it("coalesces changes to at most one frame per 250 ms and sends an empty clear", () => {
    vi.useFakeTimers();
    const frames: unknown[] = [];
    const off = onLookupProgress((roomId, message) => frames.push({ roomId, ...message }));
    try {
      const endA = beginLookups("room_1", ["a", "b"], { kind: "need", label: "step-free access" });
      const endB = beginLookups("room_1", ["b", "c"], { kind: "place" });
      endA();
      expect(frames).toEqual([]);
      vi.advanceTimersByTime(LOOKUP_COALESCE_MS);
      expect(frames).toEqual([
        { roomId: "room_1", type: "lookups", pending: ["b", "c"], reason: { kind: "place" } },
      ]);

      // Many changes in the next window still yield one frame.
      const endD = beginLookups("room_1", ["d"]);
      endD();
      endB();
      vi.advanceTimersByTime(LOOKUP_COALESCE_MS - 1);
      expect(frames).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(frames).toHaveLength(2);
      expect(frames[1]).toEqual({ roomId: "room_1", type: "lookups", pending: [] });
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
      reason: { kind: "pool" },
    });
    endFirst();
    expect(currentLookups("room_2").pending).toEqual(["a"]);
    endSecond();
    expect(currentLookups("room_2")).toEqual({ type: "lookups", pending: [] });
  });
});
