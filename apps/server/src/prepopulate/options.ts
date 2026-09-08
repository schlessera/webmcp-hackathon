import { parseArgs } from "node:util";
import { AREAS, areaById, type AreaDefinition } from "@webmcp-hackathon/contracts";
import { haversineMeters } from "../eligibility.ts";
import type { AreaSnapshot, SnapshotVenue } from "../places.ts";

export const DINING_CLASSES = new Set(["cafe","restaurant","bar","pub","biergarten","fast_food","ice_cream","bakery","coffee","tea"]);

export const SOURCES = ["overture", "accessibility", "listings", "sites", "images", "search"] as const;
export type Source = typeof SOURCES[number];
export interface PrepopulateOptions {
  area: AreaDefinition;
  radiusM: number;
  limit?: number;
  concurrency: number;
  sources: Source[];
  dryRun: boolean;
  resume?: string;
  retryFailed?: boolean;
  maxRequests?: number;
  maxCostUsd?: number;
  profile?: "explore" | "dining" | "accessibility";
}

export const HELP = `Usage: pnpm prepopulate --area <${AREAS.map((area) => area.id).join("|")}>

Warm the application's durable caches without creating or changing a room.

  --area ID            Required demo region
  --radius-m N         Radius around the demo center (default: 2000, max: 2000)
  --limit N            Only the nearest N places (default: all within radius)
  --concurrency N      Simultaneous places (default: 4, max: 8)
  --sources LIST       Comma-separated: overture,accessibility,listings,sites,images,search
  --profile NAME       explore (default), dining, accessibility
  --resume ID          Continue the same selection using durable stage checkpoints
  --retry-failed       Retry failed stages, including stages at the five-attempt limit
  --max-requests N     Cumulative wire/model attempt cap for this run
  --max-cost-usd N     Cumulative estimated spend admission cap (reconciled when supplied)
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
    resume: { type: "string" }, "retry-failed": { type: "boolean" },
    "max-requests": { type: "string" }, "max-cost-usd": { type: "string" }, profile: { type: "string" },
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
  const profile = values.profile ?? "explore";
  if (!["explore", "dining", "accessibility"].includes(profile)) throw new Error("Invalid --profile");
  if (values.resume && !/^[a-f0-9-]{36}$/.test(values.resume)) throw new Error("Invalid --resume ID");
  const maxCostUsd = values["max-cost-usd"] === undefined ? undefined : Number(values["max-cost-usd"]);
  if (maxCostUsd !== undefined && (!Number.isFinite(maxCostUsd) || maxCostUsd <= 0)) throw new Error("--max-cost-usd must be positive");
  return {
    area,
    profile: profile as PrepopulateOptions["profile"],
    ...(values.resume ? { resume: values.resume } : {}),
    retryFailed: values["retry-failed"] ?? false,
    ...(values["max-requests"] ? { maxRequests: integer("max-requests",values["max-requests"],1,2147483647) } : {}),
    ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
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
    .map(({ venue }) => venue)
    .sort((a,b) => options.profile === "dining" ? Number(DINING_CLASSES.has(b.placeClass ?? ""))-Number(DINING_CLASSES.has(a.placeClass ?? "")) : 0);
}
