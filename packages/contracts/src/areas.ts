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
  /** Demo fiction used to give seeded participants distinct starting points.
   * A real client reads the device's geolocation instead. */
  fixtureOrigins: Array<{ label: string; lat: number; lng: number }>;
  /** The room's starting scope radius, the wider scope the demo rehearses,
   * and the engine's maximum supported widening. Every snapshot venue inside
   * the current scope circle is added incrementally, up to POOL_CAP. */
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
    fixtureOrigins: [
      { label: "Rosenthaler Platz", lat: 52.5298, lng: 13.4014 },
      { label: "Hackescher Markt", lat: 52.5226, lng: 13.4024 },
      { label: "Alexanderplatz", lat: 52.5222, lng: 13.4117 },
    ],
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
    fixtureOrigins: [
      { label: "Yerba Buena Gardens", lat: 37.7858, lng: -122.4026 },
      { label: "South Park", lat: 37.7816, lng: -122.3936 },
      { label: "Mint Plaza", lat: 37.7823, lng: -122.4076 },
    ],
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

/** Legacy snapshot-build coverage sample size per ring. Runtime room seeding
 * no longer uses ring quotas; kept for committed snapshot manifest metadata. */
export const POOL_PER_RING = 40;

/** Ceiling for the additive room pool while whole-scope filling runs. Places
 * beyond it remain available through the explore layer. */
export const POOL_CAP = 2500;
