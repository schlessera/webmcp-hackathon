import { areaById } from "@webmcp-hackathon/contracts";
import type pg from "pg";
import { loadSnapshot, type SnapshotLandmark } from "./places.ts";

function distanceMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const toRad = (value: number) => value * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

export interface LandmarkMatch extends SnapshotLandmark {
  kindLabel: string;
  score: number;
}

const KIND_LABELS: Record<string, string> = {
  attraction: "attraction",
  halt: "station",
  marketplace: "marketplace",
  neighbourhood: "neighbourhood",
  park: "park",
  quarter: "quarter",
  square: "square",
  station: "station",
  stop: "stop",
  suburb: "suburb",
  subway_entrance: "station entrance",
  theatre: "theatre",
  university: "university",
};

/** Search spelling: case/diacritics/punctuation do not carry identity, and
 * transit prefixes are leading descriptors rather than part of the name. */
export function normalizeLandmarkName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ß/g, "ss")
    .replace(/^\s*(?:u-bahnhof|s-bahnhof|bahnhof|u|s)\s+/i, "")
    .replace(/[^a-z0-9]+/gi, " ")
    .trim()
    .toLocaleLowerCase();
}

interface IndexedLandmark {
  row: SnapshotLandmark;
  names: string[];
  distance: number;
}

const installed = new Map<string, SnapshotLandmark[]>();
const indices = new Map<string, IndexedLandmark[]>();

function rowsFor(areaId: string): SnapshotLandmark[] {
  if (installed.has(areaId)) return installed.get(areaId)!;
  return loadSnapshot(areaId)?.landmarks ?? [];
}

function indexFor(areaId: string): IndexedLandmark[] {
  const cached = indices.get(areaId);
  if (cached) return cached;
  const center = areaById(areaId)?.center;
  const index = rowsFor(areaId).map((row) => ({
    row,
    names: [...new Set([row.name, ...(row.altNames ?? [])]
      .map(normalizeLandmarkName)
      .filter(Boolean))],
    distance: center ? distanceMeters(center, row.location) : 0,
  }));
  indices.set(areaId, index);
  return index;
}

function matchScore(query: string, name: string): number {
  if (name === query) return 1000;
  if (name.startsWith(query)) return 800 - Math.min(100, name.length - query.length);
  const queryTokens = query.split(" ").filter(Boolean);
  const nameTokens = name.split(" ").filter(Boolean);
  if (queryTokens.length > 0 && queryTokens.every((token) =>
    nameTokens.some((nameToken) => nameToken.startsWith(token))
  )) return 600;
  if (name.includes(query) || query.includes(name)) return 400;
  return 0;
}

export function findLandmarks(areaId: string, query: string): LandmarkMatch[] {
  const normalized = normalizeLandmarkName(query).slice(0, 100);
  if (!normalized) return [];
  return indexFor(areaId)
    .map(({ row, names, distance }) => ({
      row,
      distance,
      score: Math.max(0, ...names.map((name) => matchScore(normalized, name))),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) =>
      b.score - a.score ||
      a.distance - b.distance ||
      a.row.name.localeCompare(b.row.name) ||
      a.row.id.localeCompare(b.row.id)
    )
    .map(({ row, score }) => ({
      ...row,
      kindLabel: KIND_LABELS[row.kind] ?? row.kind.replace(/_/g, " "),
      score,
    }));
}

/** Entrances and single stops orient nobody; they crowd out what does. */
const CLUTTER_KINDS = new Set(["subway_entrance", "stop"]);

/**
 * The landmarks inside a viewport, nearest the middle first — the optional
 * orientation layer the map draws behind the room's own places. Same rows the
 * distance referents resolve against, so what a viewer sees named on the map
 * is exactly what they can measure a need from.
 */
export interface LandmarkInView extends SnapshotLandmark {
  kindLabel: string;
}

export function landmarksInView(
  areaId: string,
  [south, west, north, east]: [number, number, number, number],
  limit = 80,
): LandmarkInView[] {
  const middle = { lat: (south + north) / 2, lng: (west + east) / 2 };
  return rowsFor(areaId)
    .filter(
      (row) =>
        !CLUTTER_KINDS.has(row.kind) &&
        row.location.lat >= south &&
        row.location.lat <= north &&
        row.location.lng >= west &&
        row.location.lng <= east,
    )
    .map((row) => ({
      row,
      distance: distanceMeters(middle, row.location),
    }))
    .sort((a, b) => a.distance - b.distance || a.row.id.localeCompare(b.row.id))
    .slice(0, Math.max(0, limit))
    .map(({ row }) => ({
      ...row,
      kindLabel: KIND_LABELS[row.kind] ?? row.kind.replace(/_/g, " "),
    }));
}

export function landmarkById(areaId: string, landmarkId: string): LandmarkMatch | undefined {
  const row = rowsFor(areaId).find((landmark) => landmark.id === landmarkId);
  return row && {
    ...row,
    kindLabel: KIND_LABELS[row.kind] ?? row.kind.replace(/_/g, " "),
    score: 1000,
  };
}

export async function findRoomLandmarks(
  q: pg.Pool | pg.PoolClient,
  roomId: string,
  query: string,
  limit = 8,
): Promise<{ ok: true; landmarks: LandmarkMatch[] }> {
  const room = (await q.query("SELECT area_id FROM rooms WHERE id = $1", [roomId])).rows[0] as
    | { area_id: string | null }
    | undefined;
  return {
    ok: true,
    landmarks: room?.area_id
      ? findLandmarks(room.area_id, query).slice(0, Math.max(0, limit))
      : [],
  };
}

/** Tests install fixtures in process; production has no alternate source. */
export function installLandmarksForTests(areaId: string, landmarks: SnapshotLandmark[]): void {
  installed.set(areaId, landmarks);
  indices.delete(areaId);
}

export function resetLandmarks(): void {
  installed.clear();
  indices.clear();
}
