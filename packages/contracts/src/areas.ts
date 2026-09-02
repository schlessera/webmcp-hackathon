/**
 * The area registry: the single place that knows an area exists. Geometry
 * and extract provenance only — NO coverage numbers live here. Coverage is
 * measured by `scripts/build-area-snapshot.mjs` from the extract itself and
 * shipped in each area's snapshot manifest, so what the picker shows is what
 * was measured, never what someone typed (docs/DATA-QUALITY.md).
 *
 * Nothing here names a domain: the amenity filter that decides what counts
 * as a "place" for these areas is data on the area, not a branch in the
 * client (CLAUDE.md §1).
 */

export type AreaId = "berlin-mitte" | "sf-soma";

export interface AreaDefinition {
  id: AreaId;
  /** "Berlin Mitte" — the only name the picker shows. */
  label: string;
  city: string;
  countryCode: string;
  /** Opening hours are local to the venue. */
  timezone: string;
  center: { lat: number; lng: number };
  /** The room's starting radius, the widening the demo rehearses, and the
   * outermost ring the pool is drawn from (the engine's widening ceiling). */
  radii: { narrow: number; wide: number; max: number };
  /** south, west, north, east — the whole city, so a room centred anywhere
   * in it has buffer to widen into. The default centre is where the
   * experience focuses; the snapshot is not limited to it. */
  bbox: [number, number, number, number];
  extract: {
    /** Geofabrik region the clip is cut from. */
    region: string;
    url: string;
    /** Minutely diff feed for the region (not consumed at runtime; recorded
     * so the refresh path is documented next to the data it refreshes). */
    updates: string;
  };
  /** OSM `amenity` values that count as a place in this area. */
  amenities: string[];
  /** Currency the price bands are read in. */
  currency: string;
}

const AMENITIES = ["cafe", "restaurant", "bar", "pub", "biergarten", "fast_food"];

export const AREAS: readonly AreaDefinition[] = Object.freeze([
  {
    id: "berlin-mitte",
    label: "Berlin Mitte",
    city: "Berlin",
    countryCode: "DE",
    timezone: "Europe/Berlin",
    // Weidendammer Brücke / Friedrichstraße — the shipped demo centre.
    center: { lat: 52.5219, lng: 13.3899 },
    radii: { narrow: 800, wide: 1400, max: 2000 },
    // Berlin city limits.
    bbox: [52.338, 13.088, 52.675, 13.761],
    extract: {
      region: "europe/germany/berlin",
      url: "https://download.geofabrik.de/europe/germany/berlin-latest.osm.pbf",
      updates: "https://download.geofabrik.de/europe/germany/berlin-updates/",
    },
    amenities: AMENITIES,
    currency: "EUR",
  },
  {
    id: "sf-soma",
    label: "San Francisco SoMa",
    city: "San Francisco",
    countryCode: "US",
    timezone: "America/Los_Angeles",
    // Moscone / Yerba Buena — the only SF centre that measured above 15%
    // decisive attributes (docs/DATA-QUALITY.md, "Coverage").
    center: { lat: 37.7845, lng: -122.401 },
    radii: { narrow: 800, wide: 1400, max: 2000 },
    // San Francisco city limits (peninsula), Treasure Island included.
    bbox: [37.703, -122.515, 37.833, -122.355],
    extract: {
      region: "north-america/us/california/norcal",
      url: "https://download.geofabrik.de/north-america/us/california/norcal-latest.osm.pbf",
      updates: "https://download.geofabrik.de/north-america/us/california/norcal-updates/",
    },
    amenities: AMENITIES,
    currency: "USD",
  },
]);

export function areaById(id: string): AreaDefinition | undefined {
  return AREAS.find((a) => a.id === id);
}

/**
 * What a room starts with: the N nearest places inside the narrow radius,
 * the N nearest in the ring out to the wide radius, and the N nearest in the
 * ring out to the widening ceiling. One number, one rule — stated in the
 * picker, never hidden. A room is a group converging on a place, not a
 * directory; hundreds of stickers bury each other.
 */
export const POOL_PER_RING = 40;
