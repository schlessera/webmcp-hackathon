import { describe, expect, it } from "vitest";
import { AREAS } from "../../packages/contracts/src/index.ts";
import { loadSnapshot, type AreaSnapshot, type SnapshotVenue } from "../../apps/server/src/places.ts";
import {
  normalizeName,
  searchSnapshot,
  withinOneEdit,
} from "../../apps/server/src/place-search.ts";
import { landmarksInView } from "../../apps/server/src/landmarks.ts";

/**
 * Finding a place by the name a person remembers (apps/server/src/place-search.ts).
 * The ranking rules are checked against a made-up snapshot, where the answer is
 * a matter of arithmetic; the committed snapshots then have to behave the same
 * way for a real name typed the way people type it.
 */

function venue(ref: string, name: string, extra: Partial<SnapshotVenue> = {}): SnapshotVenue {
  return {
    ref,
    name,
    location: { lat: 52.52, lng: 13.4 },
    placeClass: "cafe",
    tags: { amenity: "cafe", name },
    ...extra,
  };
}

function snapshotOf(venues: SnapshotVenue[]): AreaSnapshot {
  return { manifest: { extract: { timestamp: "2026-08-31T00:00:00Z" } }, venues } as
    unknown as AreaSnapshot;
}

const names = (snapshot: AreaSnapshot, query: string, near?: { lat: number; lng: number }) =>
  searchSnapshot(snapshot, query, near ? { near } : {}).venues.map((v) => v.name);

describe("normalizeName", () => {
  it("drops accents, case and punctuation, and collapses separators", () => {
    expect(normalizeName("Café Cinema")).toBe("cafe cinema");
    expect(normalizeName("  ZOLLPACKHOF—Biergarten  ")).toBe("zollpackhof biergarten");
    expect(normalizeName("St. Oberholz")).toBe("st oberholz");
  });

  it("keeps digits, which are part of many names", () => {
    expect(normalizeName("Bar 25")).toBe("bar 25");
  });
});

describe("withinOneEdit", () => {
  it("accepts one substitution, insertion or deletion, and nothing further", () => {
    expect(withinOneEdit("cafe", "cafe")).toBe(true);
    expect(withinOneEdit("cafe", "cafr")).toBe(true);
    expect(withinOneEdit("cafe", "caffe")).toBe(true);
    expect(withinOneEdit("caffe", "cafe")).toBe(true);
    expect(withinOneEdit("cafe", "cofr")).toBe(false);
    expect(withinOneEdit("cafe", "caffee")).toBe(false);
  });
});

describe("searchSnapshot ranking", () => {
  const snapshot = snapshotOf([
    venue("node/1", "Cinema"),
    venue("node/2", "Café Cinema"),
    venue("node/3", "Cinema Paradiso"),
    venue("node/4", "The Old Cinema Hall"),
  ]);

  it("puts an exact name first, then a name that starts with what was typed", () => {
    expect(names(snapshot, "cinema")).toEqual([
      "Cinema",
      "Cinema Paradiso",
      "Café Cinema",
      "The Old Cinema Hall",
    ]);
  });

  it("matches every typed word at a word start, in any order", () => {
    expect(names(snapshot, "cin cafe")).toEqual(["Café Cinema"]);
  });

  it("matches through an accent the typist did not enter", () => {
    expect(names(snapshot, "cafe cinema")).toEqual(["Café Cinema"]);
  });

  it("forgives one wrong letter, ranking the shortest name first among equals", () => {
    expect(names(snapshot, "cinena")).toEqual([
      "Cinema",
      "Café Cinema",
      "Cinema Paradiso",
      "The Old Cinema Hall",
    ]);
    expect(names(snapshot, "paradiso")).toEqual(["Cinema Paradiso"]);
  });

  it("puts a correctly spelled match above one that needed a letter forgiven", () => {
    const mixed = snapshotOf([
      venue("node/1", "Cinena Bar"),
      venue("node/2", "Cinema"),
    ]);
    expect(names(mixed, "cinema")).toEqual(["Cinema", "Cinena Bar"]);
  });

  it("returns nothing for a name no place here goes by", () => {
    expect(names(snapshot, "tabernacle")).toEqual([]);
    expect(names(snapshot, "   ")).toEqual([]);
  });

  it("breaks ties towards where the viewer is looking", () => {
    const spread = snapshotOf([
      venue("node/1", "Cinema", { location: { lat: 52.60, lng: 13.4 } }),
      venue("node/2", "Cinema", { location: { lat: 52.50, lng: 13.4 } }),
    ]);
    expect(searchSnapshot(spread, "cinema", { near: { lat: 52.50, lng: 13.4 } })
      .venues.map((v) => v.ref)).toEqual(["node/2", "node/1"]);
    expect(searchSnapshot(spread, "cinema", { near: { lat: 52.61, lng: 13.4 } })
      .venues.map((v) => v.ref)).toEqual(["node/1", "node/2"]);
  });

  it("finds a place by an alternate name, under a place that carries it outright", () => {
    const aliased = snapshotOf([
      venue("node/1", "Berghain", { tags: { name: "Berghain", alt_name: "Ostgut" } }),
      venue("node/2", "Ostgut"),
    ]);
    expect(names(aliased, "ostgut")).toEqual(["Ostgut", "Berghain"]);
  });

  it("caps the answer and says when more matched", () => {
    const many = snapshotOf(
      Array.from({ length: 12 }, (_, i) => venue(`node/${i}`, `Cinema ${i}`)),
    );
    const result = searchSnapshot(many, "cinema", { limit: 5 });
    expect(result.venues).toHaveLength(5);
    expect(result.truncated).toBe(true);
    expect(searchSnapshot(many, "cinema", { limit: 20 }).truncated).toBe(false);
  });

  it("never matches on a category, a tag or an address", () => {
    const tagged = snapshotOf([
      venue("node/1", "Zur Linde", {
        tags: {
          amenity: "restaurant",
          name: "Zur Linde",
          cuisine: "vietnamese",
          "addr:street": "Torstraße",
        },
      }),
    ]);
    expect(names(tagged, "vietnamese")).toEqual([]);
    expect(names(tagged, "restaurant")).toEqual([]);
    expect(names(tagged, "torstrasse")).toEqual([]);
  });
});

describe.each(AREAS.map((a) => [a.id] as const))("committed snapshot %s", (areaId) => {
  const snapshot = loadSnapshot(areaId)!;

  it("finds a real place by its own name", () => {
    const first = snapshot.venues.find((v) => v.name.length > 6)!;
    const found = searchSnapshot(snapshot, first.name, { near: first.location });
    expect(found.venues.map((v) => v.ref)).toContain(first.ref);
  });

  it("finds it from a prefix, and from a prefix with one letter wrong", () => {
    const target = snapshot.venues.find((v) => /^[A-Za-z]{8,}$/.test(v.name))!;
    const prefix = target.name.slice(0, 6);
    expect(
      searchSnapshot(snapshot, prefix, { near: target.location, limit: 20 })
        .venues.map((v) => v.name),
    ).toContain(target.name);
    const typo = `${prefix.slice(0, -1)}${prefix.at(-1) === "z" ? "y" : "z"}`;
    expect(
      searchSnapshot(snapshot, typo, { near: target.location, limit: 20 })
        .venues.map((v) => v.name),
    ).toContain(target.name);
  });

  it("answers a whole-snapshot query well inside a frame", () => {
    searchSnapshot(snapshot, "warm up the index");
    const started = performance.now();
    for (let i = 0; i < 10; i += 1) searchSnapshot(snapshot, "cafe berlin");
    expect((performance.now() - started) / 10).toBeLessThan(16);
  });
});

describe("landmarksInView", () => {
  const area = AREAS[0];
  const [south, west, north, east] = area.bbox;

  it("returns the landmarks inside the box, nearest its middle first", () => {
    const found = landmarksInView(area.id, [south, west, north, east], 10);
    expect(found.length).toBeGreaterThan(0);
    for (const landmark of found) {
      expect(landmark.location.lat).toBeGreaterThanOrEqual(south);
      expect(landmark.location.lat).toBeLessThanOrEqual(north);
      expect(landmark.location.lng).toBeGreaterThanOrEqual(west);
      expect(landmark.location.lng).toBeLessThanOrEqual(east);
      expect(landmark.kindLabel.length).toBeGreaterThan(0);
    }
  });

  it("leaves out station entrances and single stops, which orient nobody", () => {
    const found = landmarksInView(area.id, [south, west, north, east], 500);
    expect(found.some((l) => l.kind === "subway_entrance" || l.kind === "stop")).toBe(false);
  });

  it("returns nothing for a box the area does not cover", () => {
    expect(landmarksInView(area.id, [-40, -70, -39, -69])).toEqual([]);
  });
});
