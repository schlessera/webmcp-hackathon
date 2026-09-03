import { describe, expect, it } from "vitest";
import {
  AREAS,
  BOOLEAN_ATTRS,
  PLACE_CLASSES,
  POOL_CAP,
  POOL_PER_RING,
  STEP_CLASSES,
  areaById,
  defaultStepClass,
  dossierFromTags,
  isDecisive,
  placeClassFromTags,
  stepClassByKey,
  stepClassFor,
  unknownStepClassMembers,
} from "../../packages/contracts/src/index.ts";
import {
  areaClassCounts,
  areaSummaries,
  candidatesForRefs,
  candidatesFor,
  explorePlaces,
  fillPlan,
  loadSnapshot,
  POOL_SEED_SIZE,
  roomPoolClasses,
  seedFor,
  seedsForVenues,
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
      expect(PLACE_CLASSES).toContain(v.placeClass ?? placeClassFromTags(v.tags));
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

  it("seeds 60 deterministic places spread across the narrow scope circle", () => {
    const seed = seedFor(area, area.center, area.radii.narrow);
    const again = seedFor(area, area.center, area.radii.narrow);
    expect(seed.map((venue) => venue.ref)).toEqual(again.map((venue) => venue.ref));
    expect(seed).toHaveLength(POOL_SEED_SIZE);
    expect(seed.every((venue) => venue.distance <= area.radii.narrow)).toBe(true);
    expect(Math.max(...seed.map((venue) => venue.distance))).toBeGreaterThan(
      area.radii.narrow * 0.9,
    );
    const quadrants = new Set(
      seed.map(
        (venue) =>
          `${venue.location.lat >= area.center.lat ? 1 : 0}${
            venue.location.lng >= area.center.lng ? 1 : 0
          }`,
      ),
    );
    expect(quadrants.size).toBe(4);
    const cells = new Set(
      seed.map((venue) => {
        const x =
          (venue.location.lng - area.center.lng) *
          111_320 *
          Math.cos((area.center.lat * Math.PI) / 180);
        const y = (venue.location.lat - area.center.lat) * 111_320;
        return `${Math.floor(x / 100)},${Math.floor(y / 100)}`;
      }),
    );
    expect(cells.size).toBeGreaterThanOrEqual(55);
    expect(new Set(seed.map((venue) => venue.ref)).size).toBe(seed.length);
  });

  it("plans every missing scope venue deterministically in nearest-first batches", () => {
    const baseline = fillPlan(area, snapshot, area.center, area.radii.narrow, [], 7);
    const baselineRefs = baseline.batches.flat().map((venue) => venue.ref);
    const existing = new Set([baselineRefs[0], baselineRefs[5], baselineRefs[12]]);
    const first = fillPlan(area, snapshot, area.center, area.radii.narrow, existing, 7);
    const again = fillPlan(area, snapshot, area.center, area.radii.narrow, existing, 7);
    expect(first).toEqual(again);
    expect(first.total).toBe(baseline.total);
    expect(first.batches.every((batch) => batch.length > 0 && batch.length <= 7)).toBe(true);
    const flattened = first.batches.flat();
    expect(flattened).toHaveLength(baseline.total - existing.size);
    expect(flattened.every((venue) => !existing.has(venue.ref))).toBe(true);
    for (let index = 1; index < flattened.length; index += 1) {
      const previous = flattened[index - 1];
      const current = flattened[index];
      expect(
        previous.distance < current.distance ||
          (previous.distance === current.distance && previous.ref < current.ref),
      ).toBe(true);
    }
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
    const existing = new Set(seedFor(area, area.center, area.radii.narrow).map((venue) => venue.ref));
    const shifted = { lat: area.center.lat + 0.008, lng: area.center.lng + 0.008 };
    const first = topUp("room_test", area, snapshot, shifted, area.radii.narrow, existing);
    const again = topUp("room_test", area, snapshot, shifted, area.radii.narrow, existing);
    expect(first.length).toBeGreaterThan(0);
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
      poolSize: POOL_SEED_SIZE,
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

  it("seeds a room from a legacy snapshot without new place fields", () => {
    const { placeClasses: _placeClasses, ...legacyManifest } = snapshot.manifest;
    const legacySnapshot = {
      manifest: legacyManifest,
      venues: [
        {
          ref: "node/legacy-cafe",
          name: "Legacy cafe",
          location: area.center,
          tags: { amenity: "cafe" },
        },
        {
          ref: "node/legacy-park",
          name: "Legacy park",
          location: { lat: area.center.lat + 0.0001, lng: area.center.lng },
          tags: { leisure: "park" },
        },
      ],
    };

    const plan = fillPlan(area, legacySnapshot, area.center, 100, [], 10);
    expect(plan.batches.flat().map((venue) => venue.ref)).toEqual(["node/legacy-cafe"]);
    const seeds = seedsForVenues(
      "room_legacy",
      plan.batches.flat(),
      legacySnapshot.manifest.extract.timestamp,
    );
    expect(seeds).toHaveLength(1);
    expect(seeds[0].category).toBe("cafe");

    const read = explorePlaces(
      area,
      legacySnapshot,
      [area.center.lat - 1, area.center.lng - 1, area.center.lat + 1, area.center.lng + 1],
      10,
    );
    expect(read.places.map((place) => place.category).sort()).toEqual(["cafe", "park"]);
  });
});

describe("area summaries", () => {
  it("keeps the existing six food classes as each room's pool", () => {
    for (const area of AREAS) {
      expect(area.placeClasses).toEqual([
        "cafe", "restaurant", "bar", "pub", "biergarten", "fast_food",
      ]);
    }
  });
  it("uses the expanded additive room cap", () => {
    expect(POOL_CAP).toBe(2500);
  });
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

/**
 * Step classes (UNDERSTANDING-ARCH.md §10, D1): what a room is about decides
 * what may enter its pool. The table is data, and `food` must stay exactly
 * the six classes every room pooled before goals existed.
 */
describe("step classes", () => {
  it("names only place classes a snapshot can hold", () => {
    expect(unknownStepClassMembers()).toEqual([]);
    for (const stepClass of STEP_CLASSES) {
      expect(stepClass.key).toMatch(/^[a-z]+$/);
      expect(stepClass.label.length).toBeGreaterThan(0);
      expect(stepClass.members.length).toBeGreaterThan(0);
    }
    expect(new Set(STEP_CLASSES.map((row) => row.key)).size).toBe(STEP_CLASSES.length);
  });

  it("keeps the default class equal to the area's own room classes", () => {
    for (const area of AREAS) {
      expect([...defaultStepClass().members].sort()).toEqual([...area.placeClasses].sort());
      expect(roomPoolClasses(area)).toEqual(area.placeClasses);
      expect(roomPoolClasses(area, "food")).toEqual(defaultStepClass().members);
      // An unknown category never empties a pool; it keeps the area's list.
      expect(roomPoolClasses(area, "spaceport")).toEqual(area.placeClasses);
    }
  });

  it("finds the first class a place class belongs to", () => {
    expect(stepClassFor("cinema")?.key).toBe("cinema");
    expect(stepClassFor("restaurant")?.key).toBe("food");
    // Overlap is by design and resolves in table order.
    expect(stepClassFor("bar")?.key).toBe("food");
    expect(stepClassFor("nowhere")).toBeUndefined();
  });
});

describe.each(AREAS.map((a) => [a.id, a] as const))("step-class pool %s", (_id, area) => {
  it("seeds only places of the step's classes", () => {
    const cinema = stepClassByKey("cinema")!;
    const seed = seedFor(area, area.center, area.radii.max, cinema.members);
    expect(seed.length).toBeGreaterThan(0);
    for (const venue of seed) {
      expect(venue.placeClass ?? placeClassFromTags(venue.tags)).toBe("cinema");
    }
    const set = candidatesFor("room_cinema01", area, area.center, cinema.members)!;
    for (const candidate of set.candidates) expect(candidate.category).toBe("cinema");
  });

  it("reports every class it can seed, and only classes with places", () => {
    const counts = areaClassCounts(area.id);
    expect(counts.length).toBeGreaterThan(1);
    for (const row of counts) {
      expect(stepClassByKey(row.key)!.label).toBe(row.label);
      const seed = seedFor(area, area.center, area.radii.narrow, stepClassByKey(row.key)!.members);
      expect(row.count).toBeGreaterThan(0);
      expect(seed.length).toBe(Math.min(row.count, POOL_SEED_SIZE));
    }
    expect(areaSummaries().find((row) => row.id === area.id)!.classes).toEqual(counts);
  });
});
