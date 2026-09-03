import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LOOKUP_DEADLINE_MS,
  mergeExploreCache,
  SpatialStore,
} from "../../apps/web/src/spatial-store.ts";
import type { ExplorePlace } from "../../apps/web/src/spatial-types.ts";

function place(ref: string, lat: number, lng: number): ExplorePlace {
  return { ref, name: ref, category: "place", location: { lat, lng } };
}

describe("explore cache", () => {
  it("keeps at most 3000 places nearest the current viewport", () => {
    const current = new Map<string, ExplorePlace>();
    for (let i = 0; i < 2700; i += 1) {
      const row = place(`old-${i}`, 20 + i / 10_000, 20);
      current.set(row.ref, row);
    }
    const incoming = Array.from({ length: 600 }, (_, i) =>
      place(`current-${i}`, 52.5 + i / 1_000_000, 13.4),
    );

    const merged = mergeExploreCache(current, incoming, [52.49, 13.39, 52.51, 13.41]);

    expect(merged.size).toBe(3000);
    expect([...incoming].every((row) => merged.has(row.ref))).toBe(true);
    expect(merged.has("old-0")).toBe(false);
  });

  it("does not replace the cache when a viewport changes no place data", () => {
    const row = place("same", 52.5, 13.4);
    const current = new Map([[row.ref, row]]);
    expect(mergeExploreCache(current, [{ ...row }], [52.49, 13.39, 52.51, 13.41])).toBe(
      current,
    );
  });

  it("keeps optimistic added state until a real candidate id arrives", () => {
    const row = { ...place("node/1", 52.5, 13.4), added: true };
    const current = new Map([[row.ref, row]]);
    const pending = mergeExploreCache(
      current,
      [place("node/1", 52.5, 13.4)],
      [52.49, 13.39, 52.51, 13.41],
    );
    expect(pending.get("node/1")?.added).toBe(true);

    const reconciled = mergeExploreCache(
      pending,
      [{ ...place("node/1", 52.5, 13.4), candidateId: "pl_demo_032" }],
      [52.49, 13.39, 52.51, 13.41],
    );
    expect(reconciled.get("node/1")).toMatchObject({ candidateId: "pl_demo_032" });
    expect(reconciled.get("node/1")?.added).toBeUndefined();
  });
});

afterEach(() => vi.useRealTimers());

describe("pipeline presentation state", () => {
  const counts = {
    outstanding: { fetch: 0, process: 0 },
    inFlight: { fetch: 0, process: 0 },
    done: 0,
    total: 0,
    paused: null,
  } as const;

  it("applies deltas, removes null stages, replaces resets, and exposes stalls", () => {
    const store = new SpatialStore();
    store.setLookups(["a", "b"], { kind: "place" }, [
      { candidateId: "a", stage: "fetching" },
      { candidateId: "b", stage: "processing" },
    ]);
    store.setPipeline({
      ...counts,
      stalled: ["timed-out"],
      reset: false,
      reason: { kind: "place" },
      stages: [
        { candidateId: "a", stage: null },
        { candidateId: "c", stage: "queued" },
      ],
    });
    expect(store.state.busy).toEqual(["b", "c"]);
    expect(store.state.stages).toEqual({ b: "processing", c: "queued" });
    expect(store.state.stalled).toEqual(["timed-out"]);

    store.setPipeline({
      ...counts,
      stalled: [],
      reset: true,
      stages: [{ candidateId: "only", stage: "fetching" }],
      reason: { kind: "refine" },
    });
    expect(store.state.busy).toEqual(["only"]);
    expect(store.state.stages).toEqual({ only: "fetching" });
    expect(store.state.busyReason).toEqual({ kind: "refine" });
  });

  it("ages out stale rings and records the queued interactive stage", () => {
    vi.useFakeTimers();
    const store = new SpatialStore();
    store.setLookups(["old"], { kind: "place" }, [
      { candidateId: "old", stage: "queued" },
    ]);
    vi.advanceTimersByTime(LOOKUP_DEADLINE_MS);
    expect(store.state.busy).toEqual([]);
    expect(store.state.stages).toEqual({});

    store.noteFacts(["open"], "interactive", {
      stage: "queued",
      done: false,
      steps: [],
      costUsd: null,
    });
    expect(store.state.facts.stage).toBe("queued");
    expect(store.state.interactive.open?.steps[0]?.stage).toBe("queued");
  });
});
