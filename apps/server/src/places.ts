import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  AREAS,
  POOL_PER_RING,
  dossierFromTags,
  type AreaDefinition,
  type DossierExtras,
  type ExplorePlacesResult,
} from "@webmcp-hackathon/contracts";
import { haversineMeters } from "./eligibility.ts";

/**
 * The venue source (docs/DATA-QUALITY.md, "Engine decision").
 *
 * One area snapshot per registry entry, built offline by
 * `scripts/build-area-snapshot.mjs` from a Geofabrik extract and committed
 * under `packages/contracts/data/areas/`. Loaded into memory once; every
 * query is an in-process distance sort over a few thousand rows. No public
 * API is called, no third-party service sees a participant's request, and
 * the answer is the same whether the process is cold or warm.
 *
 * Fallback chain, in order: the area snapshot; for Berlin only, the shipped
 * curated dataset. A missing snapshot for any other area is reported, never
 * papered over with invented places.
 */

export interface SnapshotVenue {
  ref: string;
  name: string;
  location: { lat: number; lng: number };
  tags: Record<string, string>;
}

export interface CoverageStats {
  venues: number;
  slots: number;
  decisive: number;
  decisivePct: number;
  tagCounts: Record<string, number>;
  tags: Record<string, number>;
}

export interface SnapshotManifest {
  areaId: string;
  label: string;
  source: string;
  license: string;
  attribution: string;
  extract: { region: string; url: string; updates: string; timestamp: string; bbox: number[] };
  builtAt: string;
  center: { lat: number; lng: number };
  radii: { narrow: number; wide: number; max: number };
  amenities: string[];
  coverage: {
    measuredAt: string;
    city: CoverageStats;
    focus: CoverageStats;
    pool: CoverageStats;
    poolRule: { perRing: number; radii: { narrow: number; wide: number; max: number } };
  };
}

export interface AreaSnapshot {
  manifest: SnapshotManifest;
  venues: SnapshotVenue[];
}

/** What a room records about where its places came from (rooms.data_source). */
export interface DataSource {
  kind: "osm-snapshot" | "curated";
  areaId: string;
  label: string;
  source: string;
  extractTimestamp: string;
  poolSize: number;
  /** Named places within the wide radius of the room's centre. */
  focusVenues: number;
}

export interface CandidateSeed {
  id: string;
  name: string;
  category: string;
  price_level: number | null;
  walk_min: number;
  location: { lat: number; lng: number };
  attributes: unknown[];
  hours: unknown[];
  osmRef?: string;
  /** Links, description, lookup ids (dossier.ts DossierExtras). */
  extras?: DossierExtras;
}

const dataDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..", "..", "..", "packages", "contracts", "data",
);

const snapshots = new Map<string, AreaSnapshot | null>();

export function loadSnapshot(areaId: string): AreaSnapshot | null {
  if (snapshots.has(areaId)) return snapshots.get(areaId)!;
  const path = join(dataDir, "areas", `${areaId}.json`);
  const snapshot = existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as AreaSnapshot)
    : null;
  snapshots.set(areaId, snapshot);
  return snapshot;
}

/** Test seam: forget loaded snapshots (a test may swap the file). */
export function resetSnapshots(): void {
  snapshots.clear();
}

export interface AreaSummary {
  id: string;
  label: string;
  city: string;
  center: { lat: number; lng: number };
  radii: { narrow: number; wide: number; max: number };
  /** False when neither a snapshot nor a fallback can seed a room here. */
  available: boolean;
  /** "osm-snapshot", or "curated" when only the shipped dataset backs it. */
  kind: DataSource["kind"] | null;
  source: string;
  dataAsOf: string | null;
  coverage: SnapshotManifest["coverage"] | null;
}

/** GET /api/areas — the registry joined with what was measured. */
export function areaSummaries(): AreaSummary[] {
  return AREAS.map((area) => {
    const snapshot = loadSnapshot(area.id);
    if (snapshot) {
      return {
        id: area.id,
        label: area.label,
        city: area.city,
        center: area.center,
        radii: area.radii,
        available: true,
        kind: "osm-snapshot",
        source: snapshot.manifest.source,
        dataAsOf: snapshot.manifest.extract.timestamp,
        coverage: snapshot.manifest.coverage,
      };
    }
    const curated = curatedFallbackFor(area.id);
    return {
      id: area.id,
      label: area.label,
      city: area.city,
      center: area.center,
      radii: area.radii,
      available: curated !== null,
      kind: curated ? "curated" : null,
      source: "OpenStreetMap",
      dataAsOf: curated?.manifest.extractTimestamp ?? null,
      coverage: null,
    };
  });
}

const GRID_M = 100;

type LocatedVenue = SnapshotVenue & { distance: number };

function stableRefOrder(a: LocatedVenue, b: LocatedVenue): number {
  return a.distance - b.distance || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0);
}

function gridPoint(
  center: { lat: number; lng: number },
  location: { lat: number; lng: number },
): { x: number; y: number } {
  return {
    x:
      (location.lng - center.lng) *
      111_320 *
      Math.cos((center.lat * Math.PI) / 180),
    y: (location.lat - center.lat) * 111_320,
  };
}

/**
 * Thin a distance-ordered ring onto a 100 m grid, then choose the next point
 * farthest from everything already chosen. Ties retain distance/ref order.
 */
function spreadRing(
  ordered: LocatedVenue[],
  center: { lat: number; lng: number },
  limit: number,
): LocatedVenue[] {
  if (ordered.length <= limit) return ordered;
  const points = new Map<string, { venue: LocatedVenue; x: number; y: number }>();
  for (const venue of ordered) {
    const point = gridPoint(center, venue.location);
    const cell = `${Math.floor(point.x / GRID_M)},${Math.floor(point.y / GRID_M)}`;
    if (!points.has(cell)) points.set(cell, { venue, ...point });
  }

  const candidates = [...points.values()];
  const selected = candidates.length > 0 ? [candidates.shift()!] : [];
  while (selected.length < limit && candidates.length > 0) {
    let bestIndex = 0;
    let bestDistance = -1;
    for (let i = 0; i < candidates.length; i += 1) {
      const point = candidates[i];
      let nearest = Number.POSITIVE_INFINITY;
      for (const chosen of selected) {
        const distance = (point.x - chosen.x) ** 2 + (point.y - chosen.y) ** 2;
        if (distance < nearest) nearest = distance;
      }
      if (nearest > bestDistance) {
        bestDistance = nearest;
        bestIndex = i;
      }
    }
    selected.push(candidates.splice(bestIndex, 1)[0]);
  }

  // A very sparse snapshot can have fewer grid cells than the requested
  // count. Backfill from the stable source order without duplicating refs.
  const refs = new Set(selected.map((point) => point.venue.ref));
  for (const venue of ordered) {
    if (selected.length >= limit) break;
    if (!refs.has(venue.ref)) {
      selected.push({ venue, ...gridPoint(center, venue.location) });
      refs.add(venue.ref);
    }
  }
  return selected.map((point) => point.venue);
}

/**
 * The pool rule, identical in all three rings: stable distance/ref ordering,
 * 100 m grid thinning, then deterministic farthest-point selection. This
 * preserves POOL_PER_RING while covering the usable geography of each ring.
 */
export function poolFor(
  area: AreaDefinition,
  snapshot: AreaSnapshot,
  center: { lat: number; lng: number },
  perRing = POOL_PER_RING,
): Array<SnapshotVenue & { distance: number }> {
  // Whole metres, as the builder measures, so the pool and the coverage
  // numbers the picker shows are cut at exactly the same places.
  const withDistance = snapshot.venues
    .map((v) => ({ ...v, distance: Math.round(haversineMeters(center, v.location)) }))
    .filter((v) => v.distance <= area.radii.max)
    .sort(stableRefOrder);
  const { narrow, wide, max } = area.radii;
  const ring = (from: number, to: number) =>
    spreadRing(
      withDistance.filter((v) => v.distance > from && v.distance <= to),
      center,
      perRing,
    );
  return [...ring(-1, narrow), ...ring(narrow, wide), ...ring(wide, max)];
}

const WALK_SPEED_M_PER_MIN = 4500 / 60;

export interface CandidateSet {
  candidates: CandidateSeed[];
  dataSource: DataSource;
}

function seedsForVenues(
  roomId: string,
  venues: LocatedVenue[],
  observedAt: string,
  startAt = 1,
): CandidateSeed[] {
  const suffix = roomId.replace(/^room_/, "");
  return venues.map((v, i) => {
    const dossier = dossierFromTags(v.tags, observedAt);
    return {
      id: `pl_${suffix}_${String(startAt + i).padStart(3, "0")}`,
      name: v.name,
      category: dossier.category,
      price_level: dossier.priceLevel,
      walk_min: Math.max(1, Math.round(v.distance / WALK_SPEED_M_PER_MIN)),
      location: v.location,
      attributes: dossier.attributes,
      hours: dossier.hours,
      osmRef: v.ref,
      extras: dossier.extras,
    };
  });
}

/**
 * Candidate rows for a new room. Ids are namespaced by room: candidates.id
 * is a global primary key and `place_N` belongs to room_demo.
 */
export function candidatesFor(
  roomId: string,
  area: AreaDefinition,
  center: { lat: number; lng: number },
): CandidateSet | null {
  const snapshot = loadSnapshot(area.id);
  if (!snapshot) return curatedCandidates(roomId, area);
  const observedAt = snapshot.manifest.extract.timestamp;
  const pool = poolFor(area, snapshot, center);
  const candidates = seedsForVenues(roomId, pool, observedAt);
  const focusVenues = snapshot.venues.filter(
    (v) => Math.round(haversineMeters(center, v.location)) <= area.radii.wide,
  ).length;
  return {
    candidates,
    dataSource: {
      kind: "osm-snapshot",
      areaId: area.id,
      label: area.label,
      source: snapshot.manifest.source,
      extractTimestamp: observedAt,
      poolSize: candidates.length,
      focusVenues,
    },
  };
}

export type ExploreBbox = [south: number, west: number, north: number, east: number];

/** In-process viewport query over the snapshot; never performs a network call. */
export function explorePlaces(
  _area: AreaDefinition,
  snapshot: AreaSnapshot,
  [south, west, north, east]: ExploreBbox,
  limit = 600,
): ExplorePlacesResult {
  const capped = Math.max(1, Math.min(600, Math.floor(limit)));
  const matches = snapshot.venues
    .filter(
      (venue) =>
        venue.location.lat >= south &&
        venue.location.lat <= north &&
        venue.location.lng >= west &&
        venue.location.lng <= east,
    )
    .sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  return {
    ok: true,
    places: matches.slice(0, capped).map((venue) => ({
      ref: venue.ref,
      name: venue.name,
      location: venue.location,
      category: dossierFromTags(
        venue.tags,
        snapshot.manifest.extract.timestamp,
      ).category,
    })),
    truncated: matches.length > capped,
  };
}

/** Places the same spread rule would seed around a moved scope centre. */
export function topUp(
  roomId: string,
  area: AreaDefinition,
  snapshot: AreaSnapshot,
  center: { lat: number; lng: number },
  scopeRadiusM: number,
  existingRefs: Iterable<string>,
): CandidateSeed[] {
  const existing = new Set(existingRefs);
  const venues = poolFor(area, snapshot, center).filter(
    (venue) => venue.distance <= scopeRadiusM && !existing.has(venue.ref),
  );
  return seedsForVenues(roomId, venues, snapshot.manifest.extract.timestamp);
}

/** Resolve requested snapshot refs into candidate seeds, preserving input order. */
export function candidatesForRefs(
  roomId: string,
  snapshot: AreaSnapshot,
  refs: string[],
  center: { lat: number; lng: number },
): CandidateSeed[] | null {
  const byRef = new Map(snapshot.venues.map((venue) => [venue.ref, venue]));
  const venues: LocatedVenue[] = [];
  for (const ref of refs) {
    const venue = byRef.get(ref);
    if (!venue) return null;
    venues.push({
      ...venue,
      distance: Math.round(haversineMeters(center, venue.location)),
    });
  }
  return seedsForVenues(roomId, venues, snapshot.manifest.extract.timestamp);
}

// --- the floor: the shipped curated dataset (Berlin only) ------------------

interface CuratedFile {
  manifest: {
    extractTimestamp: string;
    demoCenter: { lat: number; lng: number };
    demoRadii: { narrow: number; wide: number };
  };
  venues: Array<{
    candidateId: string;
    name: string;
    location: { lat: number; lng: number };
    category: string;
    priceLevel: number | null;
    hours: unknown[];
    attributes: unknown[];
  }>;
}

const CURATED: Record<string, string> = { "berlin-mitte": "berlin-mitte-venues.json" };
let curatedCache: Map<string, CuratedFile | null> | null = null;

function curatedFallbackFor(areaId: string): CuratedFile | null {
  curatedCache ??= new Map();
  if (curatedCache.has(areaId)) return curatedCache.get(areaId)!;
  const file = CURATED[areaId];
  const path = file ? join(dataDir, file) : null;
  const loaded =
    path && existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as CuratedFile) : null;
  curatedCache.set(areaId, loaded);
  return loaded;
}

function curatedCandidates(roomId: string, area: AreaDefinition): CandidateSet | null {
  const curated = curatedFallbackFor(area.id);
  if (!curated) return null;
  const suffix = roomId.replace(/^room_/, "");
  const center = curated.manifest.demoCenter;
  const candidates = curated.venues.map((v) => ({
    id: `${v.candidateId}_${suffix}`,
    name: v.name,
    category: v.category,
    price_level: v.priceLevel,
    walk_min: Math.max(
      1,
      Math.round(haversineMeters(v.location, center) / WALK_SPEED_M_PER_MIN),
    ),
    location: v.location,
    attributes: v.attributes,
    hours: v.hours ?? [],
  }));
  return {
    candidates,
    dataSource: {
      kind: "curated",
      areaId: area.id,
      label: area.label,
      source: "OpenStreetMap",
      extractTimestamp: curated.manifest.extractTimestamp,
      poolSize: candidates.length,
      focusVenues: candidates.length,
    },
  };
}
