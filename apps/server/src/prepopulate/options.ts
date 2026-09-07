import { parseArgs } from "node:util";
import { AREAS, areaById, type AreaDefinition } from "@webmcp-hackathon/contracts";
import { haversineMeters } from "../eligibility.ts";
import type { AreaSnapshot, SnapshotVenue } from "../places.ts";

export const SOURCES = ["listings", "sites", "images", "search"] as const;
export type Source = typeof SOURCES[number];
export interface PrepopulateOptions {
  area: AreaDefinition;
  radiusM: number;
  limit?: number;
  concurrency: number;
  sources: Source[];
  dryRun: boolean;
}

export const HELP = `Usage: pnpm prepopulate --area <${AREAS.map((area) => area.id).join("|")}>

Warm the application's durable caches without creating or changing a room.

  --area ID            Required demo region
  --radius-m N         Radius around the demo center (default: 2000, max: 2000)
  --limit N            Only the nearest N places (default: all within radius)
  --concurrency N      Simultaneous places (default: 4, max: 8)
  --sources LIST       Comma-separated: listings,sites,images,search (default: all)
  --dry-run            Show scope and available providers; no DB or network calls
  --help               Show this help

Uses DATABASE_URL and the same provider keys/settings as the server.
Sites includes Wikidata, menus and evidence evaluation when models are enabled.
Search uses SEARCH_PROVIDER, then evaluates and stores validated claims.
Fresh caches are reused. Unavailable providers are reported and skipped.
Ctrl-C stops admission and lets the current places finish saving their work.
`;

export function parseOptions(args: string[]): PrepopulateOptions | null {
  const { values } = parseArgs({ args, options: {
    area: { type: "string" }, "radius-m": { type: "string" },
    limit: { type: "string" }, concurrency: { type: "string" },
    sources: { type: "string" }, "dry-run": { type: "boolean" },
    help: { type: "boolean", short: "h" },
  } });
  if (values.help) return null;
  const area = areaById(values.area ?? "");
  if (!area) throw new Error(`--area must be one of: ${AREAS.map((a) => a.id).join(", ")}`);
  const integer = (name: string, raw: string | undefined, fallback: number, max: number) => {
    const value = raw === undefined ? fallback : Number(raw);
    if (!Number.isSafeInteger(value) || value < 1 || value > max) {
      throw new Error(`--${name} must be an integer between 1 and ${max}`);
    }
    return value;
  };
  const sources = (values.sources ?? SOURCES.join(",")).split(",");
  if (sources.some((source) => !SOURCES.includes(source as Source))) {
    throw new Error(`--sources must contain only: ${SOURCES.join(",")}`);
  }
  return {
    area,
    radiusM: integer("radius-m", values["radius-m"], area.radii.max, area.radii.max),
    ...(values.limit !== undefined ? { limit: integer("limit", values.limit, 1, Number.MAX_SAFE_INTEGER) } : {}),
    concurrency: integer("concurrency", values.concurrency, 4, 8),
    sources: [...new Set(sources)] as Source[],
    dryRun: values["dry-run"] ?? false,
  };
}

/** Include every place class the map can explore, deduplicated and nearest first. */
export function selectVenues(snapshot: AreaSnapshot, options: PrepopulateOptions): SnapshotVenue[] {
  return [...new Map(snapshot.venues.map((venue) => [venue.ref, venue])).values()]
    .map((venue) => ({ venue, distance: haversineMeters(options.area.center, venue.location) }))
    .filter(({ distance }) => distance <= options.radiusM)
    .sort((a, b) => a.distance - b.distance || a.venue.ref.localeCompare(b.venue.ref))
    .slice(0, options.limit)
    .map(({ venue }) => venue);
}
