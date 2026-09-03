import { describe, expect, it } from "vitest";
import { mergeExploreCache } from "../../apps/web/src/spatial-store.ts";
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
