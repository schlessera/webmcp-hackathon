import { createHash } from "node:crypto";
import type pg from "pg";
import { outboundFetchFor } from "../net/outbound.ts";
import { withFetchLease } from "../net/fetch-lease.ts";
import { WorkError, httpFailure } from "../work-outcome.ts";
import { listingDistanceMeters, listingNameSimilarity } from "./listings.ts";
import { cleanInlineText } from "./text.ts";

export type DiscoverySource = "overture" | "accessibility";
export interface DiscoveryTarget {
  osmRef: string;
  name: string;
  location: { lat: number; lng: number };
  website?: string;
}
export interface DiscoveryRecord {
  id: string;
  name: string;
  location: { lat: number; lng: number };
  website?: string;
  sourceId?: string;
  originalId?: string;
  sourceName?: string;
  sourceUrl: string;
  license: string;
  licenseUrl?: string;
  release?: string;
  category?: string;
  brand?: string;
  address?: string;
  operatingStatus?: string;
  sources?: Array<{ dataset: string; recordId?: string; license?: string }>;
  wheelchair?: boolean;
}
export type Discoveries = Partial<
  Record<
    DiscoverySource,
    DiscoveryRecord & { fetchedAt: string; expiresAt: string }
  >
>;
const BASE = "https://accessibility-cloud-v2.freetls.fastly.net";
const liveFetch = outboundFetchFor("accessibility", {
  direct: true,
  maxBytes: 8 * 1024 * 1024,
  timeoutMs: 30_000,
});
let apiFetch = liveFetch;
export function setAccessibilityFetch(fetcher: typeof liveFetch | null) {
  apiFetch = fetcher ?? liveFetch;
}
export function sourceEnabled(source: DiscoverySource): boolean {
  return source === "overture"
    ? process.env.OVERTURE === "1"
    : process.env.ENRICH_NETWORK !== "0" &&
        Boolean(
          process.env.ACCESSIBILITY_CLOUD_TOKEN &&
            process.env.ACCESSIBILITY_CLOUD_SOURCE_IDS,
        );
}
export function discoveryUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      /token|secret|signature|api.?key/i.test(url.search)
    )
      return;
    url.hash = "";
    return url.toString();
  } catch {
    return;
  }
}
const label = (value: unknown, max = 200) =>
  typeof value === "string" ? cleanInlineText(value).slice(0, max) : "";
const host = (url?: string) => {
  try {
    return new URL(url!).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
};
/** Identity and proximity must agree. Ambiguous nearby branches yield no match. */
export function matchDiscovery(
  target: DiscoveryTarget,
  records: DiscoveryRecord[],
): DiscoveryRecord | null {
  if (
    /^(?:cafe|restaurant|bar|pub|park|museum|library|bakery|playground|toilets)$/i.test(
      target.name.trim(),
    )
  )
    return null;
  const eligible = records.filter((r) => {
    if (target.website && r.website && host(target.website) !== host(r.website))
      return false;
    const distance = listingDistanceMeters(target.location, r.location);
    const similarity = listingNameSimilarity(target.name, r.name);
    return distance <= 40 && similarity >= 0.92;
  });
  return eligible.length === 1 ? eligible[0] : null;
}
export function overtureRecord(
  feature: unknown,
  release: string,
): DiscoveryRecord | null {
  const f = feature as {
    type?: string;
    geometry?: { type?: string; coordinates?: unknown[] };
    properties?: Record<string, any>;
  } | null;
  const p = f?.properties;
  const coords = f?.geometry?.coordinates;
  if (
    f?.type !== "Feature" ||
    f.geometry?.type !== "Point" ||
    !p ||
    !coords ||
    coords.length < 2
  )
    return null;
  const [lng, lat] = coords;
  if (
    typeof lat !== "number" ||
    typeof lng !== "number" ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    Math.abs(lat) > 90 ||
    Math.abs(lng) > 180
  )
    return null;
  const id = label(p.id ?? (f as any).id),
    name = label(p.names?.primary);
  if (!id || !name || p.operating_status === "permanently_closed") return null;
  const sources = Array.isArray(p.sources)
    ? p.sources.slice(0, 12).flatMap((s: any) =>
        typeof s?.dataset === "string"
          ? [
              {
                dataset: label(s.dataset),
                recordId: label(s.record_id),
                license: label(s.license),
              },
            ]
          : [],
      )
    : [];
  return {
    id,
    name,
    location: { lat, lng },
    release,
    website: Array.isArray(p.websites)
      ? p.websites.map(discoveryUrl).find(Boolean)
      : undefined,
    category: label(
      p.basic_category ?? p.taxonomy?.primary ?? p.categories?.primary,
    ),
    brand: label(p.brand?.names?.primary),
    address: label(p.addresses?.[0]?.freeform),
    operatingStatus: label(p.operating_status),
    sources,
    sourceUrl: "https://explore.overturemaps.org/",
    license: "Overture Places — see upstream source licences",
    licenseUrl: "https://docs.overturemaps.org/attribution/",
  };
}

/** Unlocalized API responses use language maps; older responses use strings. */
function accessibilityName(value: unknown): string {
  if (typeof value === "string") return label(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const translations = Object.entries(value)
    .filter(([locale]) => /^[a-z]{2,3}(?:[-_][a-z0-9]{2,8})*$/i.test(locale))
    .sort(([a], [b]) => a.localeCompare(b));
  const preferred = [
    ...translations.filter(([locale]) => /^en(?:[-_]|$)/i.test(locale)),
    ...translations,
  ];
  return preferred.map(([, name]) => label(name)).find(Boolean) ?? "";
}

function accessibilityOpenLicense(license: Record<string, unknown>): boolean {
  const name = label(license.name),
    url = discoveryUrl(license.websiteURL);
  if (
    license.consideredAs === "restricted" ||
    /non.?commercial|no.?derivatives|share.?alike|by[ -](?:nc|nd|sa)/i.test(
      `${name} ${url ?? ""}`,
    )
  )
    return false;
  // The live catalogue classifies ODbL as CCSA. Recognize its canonical URL
  // without admitting every licence grouped into that broad category.
  if (url) {
    const parsed = new URL(url);
    if (
      /^(?:www\.)?opendatacommons\.org$/.test(parsed.hostname) &&
      /^\/licenses\/odbl(?:\/|$)/.test(parsed.pathname)
    )
      return true;
  }
  return ["CC0", "CCBY", "ODbL", "public-domain", "Public Domain"].includes(
    String(license.consideredAs ?? name),
  );
}

export function accessibilityRecords(
  body: unknown,
  allowed: string[],
): DiscoveryRecord[] {
  const root = body as {
    type?: string;
    features?: unknown[];
    related?: { sources?: Record<string, any>; licenses?: Record<string, any> };
  } | null;
  if (root?.type !== "FeatureCollection" || !Array.isArray(root.features))
    throw new WorkError({
      provider: "accessibility",
      code: "invalid_response",
      deferred: false,
    });
  return root.features.flatMap((raw): DiscoveryRecord[] => {
    const f = raw as any,
      p = f?.properties,
      coords = f?.geometry?.coordinates;
    if (
      f?.geometry?.type !== "Point" ||
      !Array.isArray(coords) ||
      !p ||
      !allowed.includes(p.sourceId)
    )
      return [];
    const source = root.related?.sources?.[p.sourceId],
      license = root.related?.licenses?.[source?.licenseId];
    // Token scope alone does not grant redistribution. Restrict to selected,
    // attributed open sources; retain their identity instead of counting OSM twice.
    if (
      !source ||
      !license ||
      !label(source.name) ||
      !label(license.name) ||
      !accessibilityOpenLicense(license)
    )
      return [];
    if (
      /wheelmap|openstreetmap|\bosm\b/i.test(
        `${source.name ?? ""} ${source.originWebsiteURL ?? ""}`,
      )
    )
      return [];
    const [lng, lat] = coords;
    if (
      typeof lat !== "number" ||
      typeof lng !== "number" ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      Math.abs(lat) > 90 ||
      Math.abs(lng) > 180
    )
      return [];
    const name = accessibilityName(p.name),
      id = label(p._id),
      wheelchair = p.accessibility?.accessibleWith?.wheelchair;
    if (!name || !id || typeof wheelchair !== "boolean") return [];
    return [
      {
        id,
        name,
        location: { lat, lng },
        sourceId: p.sourceId,
        originalId: label(p.originalId),
        sourceName: label(source.name),
        sourceUrl:
          discoveryUrl(source.originWebsiteURL) ??
          `${BASE}/place-infos/${encodeURIComponent(id)}.json`,
        license: label(license.name),
        licenseUrl: discoveryUrl(license.websiteURL),
        wheelchair,
      },
    ];
  });
}
export function accessibilityTiles(location: {
  lat: number;
  lng: number;
}): Array<{ x: number; y: number; z: number }> {
  const z = 16,
    n = 2 ** z,
    rad = Math.PI / 180;
  const tile = (lat: number, lng: number) => ({
    x: Math.floor(((lng + 180) / 360) * n),
    y: Math.floor(
      ((1 -
        Math.asinh(Math.tan(Math.max(-85, Math.min(85, lat)) * rad)) /
          Math.PI) /
        2) *
        n,
    ),
    z,
  });
  // Include neighbours at a tile boundary so a 40m match is never lost there.
  const dy = 45 / 111_320,
    dx = dy / Math.max(0.1, Math.cos(location.lat * rad));
  return [
    ...new Map(
      [-dy, dy]
        .flatMap((y) =>
          [-dx, dx].map((x) => tile(location.lat + y, location.lng + x)),
        )
        .map((t) => [`${t.x}/${t.y}`, t]),
    ).values(),
  ];
}
async function readAccessibilityTile(
  db: pg.Pool,
  tile: { x: number; y: number; z: number },
): Promise<DiscoveryRecord[]> {
  const allowed = (process.env.ACCESSIBILITY_CLOUD_SOURCE_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .sort();
  const token = process.env.ACCESSIBILITY_CLOUD_TOKEN!;
  const scope = createHash("sha256")
    .update(JSON.stringify([token, allowed]))
    .digest("hex");
  const key = `accessibility:v2:${scope}:${tile.z}/${tile.x}/${tile.y}`;
  const cached = async () =>
    (
      await db.query(
        "SELECT records FROM source_tiles WHERE cache_key=$1 AND expires_at>now()",
        [key],
      )
    ).rows[0]?.records as DiscoveryRecord[] | undefined;
  const found = await cached();
  if (found) return found;
  return withFetchLease(db, key, async () => {
    const after = await cached();
    if (after) return after;
    const records: DiscoveryRecord[] = [];
    for (let page = 0; page < 10; page++) {
      const url = new URL(`${BASE}/place-infos.json`);
      for (const [k, v] of Object.entries({
        ...tile,
        appToken: token,
        includeSourceIds: allowed.join(","),
        includeRelated: "source,source.license",
        limit: 1000,
        skip: page * 1000,
        sort: "properties._id",
      }))
        url.searchParams.set(k, String(v));
      const response = await apiFetch(url.toString());
      if (!response.ok) {
        await response.body?.cancel();
        throw httpFailure("accessibility", response);
      }
      const body = await response.json();
      records.push(...accessibilityRecords(body, allowed));
      if (
        body.features.length < 1000 ||
        Number(body.totalFeatureCount) <= (page + 1) * 1000
      ) {
        const unique = [...new Map(records.map((r) => [r.id, r])).values()];
        await db.query(
          `INSERT INTO source_tiles(cache_key,records,expires_at) VALUES($1,$2,now()+interval '1 day')
          ON CONFLICT(cache_key) DO UPDATE SET records=$2,expires_at=EXCLUDED.expires_at`,
          [key, JSON.stringify(unique)],
        );
        return unique;
      }
    }
    throw new WorkError({
      provider: "accessibility",
      code: "capacity",
      deferred: true,
      retryAt: new Date(Date.now() + 3600_000).toISOString(),
    });
  });
}

export async function discoverSources(
  db: pg.Pool,
  targets: DiscoveryTarget[],
  sources: DiscoverySource[] = ["overture", "accessibility"],
): Promise<number> {
  let matched = 0;
  for (const target of targets)
    for (const source of sources) {
      if (!sourceEnabled(source)) continue;
      const prior = (
        await db.query(
          "SELECT discoveries->$2 AS record FROM enrichments WHERE osm_ref=$1",
          [target.osmRef, source],
        )
      ).rows[0]?.record;
      if (prior && Date.parse(prior.expiresAt) > Date.now()) continue;
      let records: DiscoveryRecord[];
      if (source === "overture")
        records = (
          await db.query(
            `SELECT DISTINCT ON(id) facts FROM overture_places WHERE lat BETWEEN $1-0.001 AND $1+0.001
       AND lng BETWEEN $2-0.01 AND $2+0.01 ORDER BY id,imported_at DESC`,
            [target.location.lat, target.location.lng],
          )
        ).rows.map((r) => r.facts);
      else
        records = [
          ...new Map(
            (
              await Promise.all(
                accessibilityTiles(target.location).map((t) =>
                  readAccessibilityTile(db, t),
                ),
              )
            )
              .flat()
              .map((r) => [r.id, r]),
          ).values(),
        ];
      const match = matchDiscovery(target, records);
      if (!match) continue;
      const fetchedAt = new Date().toISOString(),
        expiresAt = new Date(
          Date.now() + (source === "overture" ? 7 : 1) * 86400_000,
        ).toISOString();
      if (source === "accessibility" && typeof match.wheelchair === "boolean") {
        const { saveInferences } = await import("./index.ts");
        const key = "wheelchair-accessible";
        await saveInferences(db, [
          {
            osmRef: target.osmRef,
            criteria: [
              { id: key, kind: "key", key, label: "Wheelchair accessible" },
            ],
            claims: [
              {
                candidateId: target.osmRef,
                osmRef: target.osmRef,
                criterionId: key,
                key,
                lean: match.wheelchair ? "yes" : "no",
                status: match.wheelchair ? "likely_true" : "likely_false",
                confidence: 0.65,
                explicit: false,
                evidence: `${match.sourceName} via accessibility.cloud (${match.license})`,
                source: `accessibility.cloud:${match.sourceId}`,
                sourceIndex: 0,
                sourceUrl: match.sourceUrl,
                observedAt: fetchedAt,
              },
            ],
            answeredCriterionIds: [key],
            observedAt: fetchedAt,
          },
        ]);
      }
      // Mark discovery fresh only after its claim is durable. If saving either
      // part fails, the next attempt can safely replay the cached source data.
      await db.query(
        `INSERT INTO enrichments(osm_ref,fetched_at,expires_at,discoveries) VALUES($1,now(),now(),jsonb_build_object($2::text,$3::jsonb))
      ON CONFLICT(osm_ref) DO UPDATE SET discoveries=enrichments.discoveries||EXCLUDED.discoveries`,
        [
          target.osmRef,
          source,
          JSON.stringify({ ...match, fetchedAt, expiresAt }),
        ],
      );
      matched++;
    }
  return matched;
}
