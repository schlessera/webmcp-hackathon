import { describe, expect, it } from "vitest";
import {
  AREAS,
  BOOLEAN_ATTRS,
  POOL_PER_RING,
  areaById,
  dossierFromTags,
  isDecisive,
} from "../../packages/contracts/src/index.ts";
import {
  areaSummaries,
  candidatesForRefs,
  candidatesFor,
  explorePlaces,
  loadSnapshot,
  poolFor,
  topUp,
} from "../../apps/server/src/places.ts";
import { haversineMeters } from "../../apps/server/src/eligibility.ts";

/**
 * The committed area snapshots and the in-process venue engine over them
 * (docs/DATA-QUALITY.md, "Engine decision"). These run against the real
 * files: a stale manifest, a snapshot that drifted from its registry entry,
 * or a fabricated attribute would fail here before it reached a room.
 */

describe.each(AREAS.map((a) => [a.id, a] as const))("snapshot %s", (_id, area) => {
  const snapshot = loadSnapshot(area.id)!;

  it("exists, names its source and licence, and carries the extract timestamp", () => {
    expect(snapshot).not.toBeNull();
    expect(snapshot.manifest.source).toBe("OpenStreetMap");
    expect(snapshot.manifest.license).toMatch(/ODbL/);
    expect(snapshot.manifest.extract.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(snapshot.manifest.coverage.measuredAt).toBe(snapshot.manifest.extract.timestamp);
  });

  it("matches its registry entry", () => {
    expect(snapshot.manifest.center).toEqual(area.center);
    expect(snapshot.manifest.radii).toEqual(area.radii);
    expect(snapshot.manifest.coverage.poolRule).toEqual({ perRing: POOL_PER_RING, radii: area.radii });
    const [s, w, n, e] = area.bbox;
    for (const v of snapshot.venues) {
      expect(v.location.lat).toBeGreaterThanOrEqual(s);
      expect(v.location.lat).toBeLessThanOrEqual(n);
      expect(v.location.lng).toBeGreaterThanOrEqual(w);
      expect(v.location.lng).toBeLessThanOrEqual(e);
      expect(area.amenities).toContain(v.tags.amenity);
      expect(v.name.length).toBeGreaterThan(0);
    }
  });

  it("covers the whole city, not just the focus disc", () => {
    const { city, focus, pool } = snapshot.manifest.coverage;
    expect(city.venues).toBe(snapshot.venues.length);
    expect(focus.venues).toBeLessThan(city.venues);
    expect(pool.venues).toBeLessThanOrEqual(3 * POOL_PER_RING);
    const beyond = snapshot.venues.filter(
      (v) => haversineMeters(area.center, v.location) > area.radii.max,
    );
    expect(beyond.length).toBeGreaterThan(0);
  });

  it("its coverage numbers are what the engine's own definition recomputes", () => {
    const { city } = snapshot.manifest.coverage;
    let decisive = 0;
    for (const v of snapshot.venues) {
      const d = dossierFromTags(v.tags, snapshot.manifest.extract.timestamp);
      for (const { key } of BOOLEAN_ATTRS) {
        if (isDecisive(d.attributes.find((a) => a.key === key)!.status)) decisive += 1;
      }
    }
    expect(city.slots).toBe(snapshot.venues.length * BOOLEAN_ATTRS.length);
    expect(city.decisive).toBe(decisive);
    expect(city.tagCounts.opening_hours).toBe(
      snapshot.venues.filter((v) => v.tags.opening_hours !== undefined).length,
    );
  });

  it("spreads N deterministic places across every ring out to the widening ceiling", () => {
    const pool = poolFor(area, snapshot, area.center);
    const again = poolFor(area, snapshot, area.center);
    expect(pool.map((v) => v.ref)).toEqual(again.map((v) => v.ref));
    expect(pool.length).toBe(3 * POOL_PER_RING);
    const { narrow, wide, max } = area.radii;
    const inner = pool.slice(0, POOL_PER_RING);
    const middle = pool.slice(POOL_PER_RING, 2 * POOL_PER_RING);
    const outer = pool.slice(2 * POOL_PER_RING);
    for (const v of inner) expect(v.distance).toBeLessThanOrEqual(narrow);
    for (const v of middle) {
      expect(v.distance).toBeGreaterThan(narrow);
      expect(v.distance).toBeLessThanOrEqual(wide);
    }
    for (const v of outer) {
      expect(v.distance).toBeGreaterThan(wide);
      expect(v.distance).toBeLessThanOrEqual(max);
    }
    // The old nearest-40 rule collapsed the inner ring into roughly 300 m.
    // Every ring now reaches its outer edge and covers all four quadrants,
    // with almost every choice coming from a distinct 100 m grid cell.
    const bounds = [narrow, wide, max];
    for (const [index, selected] of [inner, middle, outer].entries()) {
      expect(Math.max(...selected.map((venue) => venue.distance))).toBeGreaterThan(
        bounds[index] * 0.9,
      );
      const quadrants = new Set(
        selected.map(
          (venue) =>
            `${venue.location.lat >= area.center.lat ? 1 : 0}${
              venue.location.lng >= area.center.lng ? 1 : 0
            }`,
        ),
      );
      expect(quadrants.size).toBe(4);
      const cells = new Set(
        selected.map((venue) => {
          const x =
            (venue.location.lng - area.center.lng) *
            111_320 *
            Math.cos((area.center.lat * Math.PI) / 180);
          const y = (venue.location.lat - area.center.lat) * 111_320;
          return `${Math.floor(x / 100)},${Math.floor(y / 100)}`;
        }),
      );
      expect(cells.size).toBeGreaterThanOrEqual(35);
    }
    expect(new Set(pool.map((v) => v.ref)).size).toBe(pool.length);
  });

  it("queries the snapshot by bbox with a deterministic cap", () => {
    const bbox: [number, number, number, number] = [
      area.center.lat - 0.004,
      area.center.lng - 0.004,
      area.center.lat + 0.004,
      area.center.lng + 0.004,
    ];
    const result = explorePlaces(area, snapshot, bbox, 7);
    expect(result.places).toHaveLength(7);
    expect(result.truncated).toBe(true);
    expect(result.places.map((place) => place.ref)).toEqual(
      [...result.places.map((place) => place.ref)].sort(),
    );
    for (const place of result.places) {
      expect(place.location.lat).toBeGreaterThanOrEqual(bbox[0]);
      expect(place.location.lng).toBeGreaterThanOrEqual(bbox[1]);
      expect(place.location.lat).toBeLessThanOrEqual(bbox[2]);
      expect(place.location.lng).toBeLessThanOrEqual(bbox[3]);
    }
  });

  it("tops up from the spread rule without returning refs already in the room", () => {
    const existing = new Set(poolFor(area, snapshot, area.center).map((venue) => venue.ref));
    const shifted = { lat: area.center.lat + 0.008, lng: area.center.lng + 0.008 };
    const first = topUp("room_test", area, snapshot, shifted, area.radii.narrow, existing);
    const again = topUp("room_test", area, snapshot, shifted, area.radii.narrow, existing);
    expect(first.length).toBeGreaterThan(0);
    expect(first.length).toBeLessThanOrEqual(POOL_PER_RING);
    expect(first.map((seed) => seed.osmRef)).toEqual(again.map((seed) => seed.osmRef));
    for (const seed of first) {
      expect(existing.has(seed.osmRef!)).toBe(false);
      expect(haversineMeters(shifted, seed.location)).toBeLessThanOrEqual(area.radii.narrow);
    }
  });

  it("names snapshot additions safely for the curated demo room", () => {
    const seed = candidatesForRefs(
      "room_demo",
      snapshot,
      [snapshot.venues[0].ref],
      area.center,
    )![0];
    expect(seed.id).toBe("pl_demo_001");
    expect(seed.id).not.toMatch(/^place_\d+$/);
  });

  it("seeds a room with namespaced ids and nothing invented", () => {
    const set = candidatesFor("room_abcd1234", area, area.center)!;
    expect(set.dataSource).toMatchObject({
      kind: "osm-snapshot",
      areaId: area.id,
      label: area.label,
      poolSize: 3 * POOL_PER_RING,
      extractTimestamp: snapshot.manifest.extract.timestamp,
    });
    expect(set.dataSource.focusVenues).toBe(snapshot.manifest.coverage.focus.venues);
    const ids = set.candidates.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of set.candidates) {
      expect(c.id).toMatch(/^pl_abcd1234_\d{3}$/);
      expect(c.price_level).toBeNull();
      expect(c.walk_min).toBeGreaterThanOrEqual(1);
      const keys = (c.attributes as Array<{ key: string }>).map((a) => a.key);
      expect(keys).toEqual([...BOOLEAN_ATTRS.map((b) => b.key), "cuisine", "price-level", "hours"]);
      for (const a of c.attributes as Array<{ source: string }>) {
        expect(a.source.startsWith("osm:")).toBe(true);
      }
    }
  });
});

describe("area summaries", () => {
  it("lists both areas as available snapshots with measured coverage", () => {
    const areas = areaSummaries();
    expect(areas.map((a) => a.id)).toEqual(["berlin-mitte", "sf-soma"]);
    for (const a of areas) {
      expect(a.available).toBe(true);
      expect(a.kind).toBe("osm-snapshot");
      expect(a.dataAsOf).toMatch(/^\d{4}-/);
      expect(a.coverage?.pool.slots).toBeGreaterThan(0);
    }
  });
  it("the coverage gap the picker shows is real: Berlin is better tagged than SoMa", () => {
    const berlin = areaSummaries().find((a) => a.id === "berlin-mitte")!.coverage!;
    const soma = areaSummaries().find((a) => a.id === "sf-soma")!.coverage!;
    expect(berlin.pool.decisivePct).toBeGreaterThan(soma.pool.decisivePct);
    expect(berlin.focus.decisivePct).toBeGreaterThan(soma.focus.decisivePct);
  });
  it("unknown ids resolve to nothing", () => {
    expect(areaById("nowhere")).toBeUndefined();
  });
});
