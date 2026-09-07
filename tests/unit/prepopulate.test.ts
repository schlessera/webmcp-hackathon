import { describe, expect, it } from "vitest";
import { parseOptions, selectVenues } from "../../apps/server/src/prepopulate/options.ts";
import { openCriteria } from "../../apps/server/src/prepopulate/run.ts";
import type { AreaSnapshot } from "../../apps/server/src/places.ts";
import type { Enrichment } from "../../apps/server/src/enrich/index.ts";

describe("prepopulation scope", () => {
  it("requires a region and rejects unsafe or ambiguous limits", () => {
    expect(() => parseOptions([])).toThrow("--area");
    for (const args of [
      ["--area", "elsewhere"], ["--limit", "-1"], ["--limit", "1.5"],
      ["--radius-m", "2001"], ["--concurrency", "0"], ["--concurrency", "9"],
      ["--sources", "search,unknown"], ["--sources", ""], ["--force"],
    ]) expect(() => parseOptions(["--area", "berlin-mitte", ...args])).toThrow();
    expect(parseOptions(["--help"])).toBeNull();
  });

  it("includes non-food places, excludes outside the circle, deduplicates before limiting", () => {
    const options = parseOptions(["--area", "berlin-mitte", "--limit", "2"])!;
    const near = { ref: "node/near", name: "Museum", placeClass: "museum", tags: {}, location: options.area.center };
    const next = { ...near, ref: "node/next", location: { ...near.location, lat: near.location.lat + 0.001 } };
    const snapshot = { venues: [next, near, near, { ...near, ref: "node/far", location: { lat: 0, lng: 0 } }] } as AreaSnapshot;
    expect(selectVenues(snapshot, options).map((venue) => venue.ref)).toEqual(["node/near", "node/next"]);
  });

  it("resumes searches after a local abstention while reusing completed attempts", () => {
    const enrichment = { inferred: {
      wifi: { omitted: true, observedAt: new Date().toISOString() },
      "dog-friendly": { omitted: true, observedAt: new Date().toISOString(), searchDay: "2026-09-07", searchAttempts: 1 },
    } } as Enrichment;
    expect(openCriteria([], enrichment).map((criterion) => criterion.id)).not.toContain("wifi");
    const pending = openCriteria([], enrichment, true).map((criterion) => criterion.id);
    expect(pending).toContain("wifi");
    expect(pending).not.toContain("dog-friendly");
    expect(pending).not.toContain("cuisine");
    expect(openCriteria([{ key: "wifi", status: "verified_false" }]).map((criterion) => criterion.id)).not.toContain("wifi");
  });
});
