/**
 * Wikidata as a source (docs/ENRICHMENT-SOURCES.md, S3). CC0, so anything
 * here may be stored and redistributed. Only places carrying an OSM
 * `wikidata` tag are looked up — about 13 per focus disc, the notable ones —
 * which is exactly where a description, a Wikipedia article and an award are
 * worth having. One entity fetch, no SPARQL, identifying User-Agent.
 */

import type { FetchLike } from "./website.ts";
import { outboundFetchFor } from "../net/outbound.ts";
import { config } from "../config.ts";
import { cleanInlineText, cleanSummary, truncateText } from "./text.ts";

export interface WikiFacts {
  id: string;
  fetchedAt: string;
  description?: string;
  website?: string;
  wikipedia?: string;
  /** Wikidata item ids of awards on record, plus the ones we can name. */
  awards: Array<{ item: string; label?: string }>;
  /** Item ids of P2012 (cuisine); labels are not resolved. */
  cuisineItems: string[];
  /** Raw P18 filename, retained so an expired image can be resolved again
   * without re-fetching the entity document. */
  commonsFile?: string;
  image?: CommonsImageCandidate;
}

export interface CommonsImageCandidate {
  url: string;
  source: string;
  pageUrl: string;
  license: string;
  credit?: string;
}

interface CommonsPage {
  title?: unknown;
  categories?: Array<{ title?: unknown }>;
  imageinfo?: Array<{
    url?: unknown;
    descriptionurl?: unknown;
    extmetadata?: Record<string, { value?: unknown }>;
  }>;
}

const UA = config.identifyingUserAgent;
const TIMEOUT_MS = 8000;

/** The awards worth naming without a second lookup. */
const KNOWN_AWARDS: Record<string, string> = {
  Q20824563: "Michelin star",
  Q16143906: "Bib Gourmand",
  Q1360947: "Michelin Guide listing",
};

interface Claim {
  mainsnak?: { datavalue?: { value?: unknown } };
}
interface Entity {
  descriptions?: Record<string, { value: string }>;
  claims?: Record<string, Claim[]>;
  sitelinks?: Record<string, { title: string; url?: string }>;
}

const itemId = (c: Claim): string | undefined =>
  (c.mainsnak?.datavalue?.value as { id?: string } | undefined)?.id;
const stringValue = (c: Claim): string | undefined => {
  const v = c.mainsnak?.datavalue?.value;
  return typeof v === "string" ? v : undefined;
};

/** Pure: facts out of an entity document. Exported for tests. */
export function parseEntity(id: string, doc: unknown, fetchedAt: string): WikiFacts {
  const entity = ((doc as { entities?: Record<string, Entity> })?.entities ?? {})[id] ?? {};
  const facts: WikiFacts = { id, fetchedAt, awards: [], cuisineItems: [] };
  const desc = entity.descriptions?.en?.value ?? entity.descriptions?.de?.value;
  if (desc) facts.description = cleanSummary(desc, 300);
  const site = (entity.claims?.P856 ?? []).map(stringValue).find(Boolean);
  if (site) facts.website = site;
  const wp = entity.sitelinks?.enwiki ?? entity.sitelinks?.dewiki;
  if (wp) {
    facts.wikipedia =
      wp.url ??
      `https://${entity.sitelinks?.enwiki ? "en" : "de"}.wikipedia.org/wiki/${encodeURIComponent(wp.title.replace(/ /g, "_"))}`;
  }
  for (const c of entity.claims?.P166 ?? []) {
    const item = itemId(c);
    if (item) facts.awards.push({ item, ...(KNOWN_AWARDS[item] ? { label: KNOWN_AWARDS[item] } : {}) });
  }
  facts.cuisineItems = (entity.claims?.P2012 ?? []).map(itemId).filter((x): x is string => Boolean(x));
  const commonsFile = (entity.claims?.P18 ?? []).map(stringValue).find(Boolean);
  if (commonsFile) facts.commonsFile = commonsFile;
  return facts;
}

function metadataText(value: unknown): string | undefined {
  const text = cleanInlineText(value);
  return text || undefined;
}

/** Pure Commons `imageinfo.extmetadata` parser. Only Creative Commons
 * licences are usable; public-domain and missing/opaque terms are rejected. */
export function parseCommonsImageInfo(
  doc: unknown,
  source: string,
): CommonsImageCandidate | null {
  const pages = (doc as { query?: { pages?: Record<string, {
    imageinfo?: Array<{
      url?: unknown;
      descriptionurl?: unknown;
      extmetadata?: Record<string, { value?: unknown }>;
    }>;
  }> } })?.query?.pages;
  const info = pages && Object.values(pages)[0]?.imageinfo?.[0];
  const url = typeof info?.url === "string" ? info.url : undefined;
  const pageUrl = typeof info?.descriptionurl === "string" ? info.descriptionurl : undefined;
  const metadata = info?.extmetadata ?? {};
  const license = metadataText(
    metadata.LicenseShortName?.value ?? metadata.UsageTerms?.value,
  );
  if (!url || !pageUrl || !license || !/^CC(?:0|[ -]BY(?:[ -]SA)?)(?:\s|$|-\d)/i.test(license)) {
    return null;
  }
  const credit = metadataText(metadata.Artist?.value ?? metadata.Credit?.value);
  return {
    url,
    pageUrl,
    source,
    license: truncateText(license, 80),
    ...(credit ? { credit: truncateText(credit, 180) } : {}),
  };
}

const COMMON_PLACE_WORDS = new Set([
  "a", "an", "and", "bar", "cafe", "coffee", "das", "de", "der", "die",
  "ein", "eine", "gaststatte", "haus", "hotel", "im", "inn", "la", "le",
  "of", "pub", "restaurant", "the", "und", "venue", "zum", "zur",
]);

export function normalizeCommonsName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * A nearby file is curated only when its own **title** names this place.
 *
 * Three rules, each paid for by a wrong picture found in a live Berlin run:
 *
 * 1. Only the title counts. A category is the photographer's filing, not their
 *    subject: a file called "(20250217) Berlin 04.jpg" filed under a category
 *    mentioning "Grimm" was served as the photo of a place called "Grimm Café".
 * 2. The name tokens must appear **contiguously**. Scattered word hits let a
 *    long title borrow a name it does not carry.
 * 3. A token sitting inside a hyphenated compound is a different name. "Grimm"
 *    in "Jacob-und Wilhelm-Grimm-Zentrum" is a university library, not the café
 *    next door.
 *
 * `categories` is still accepted so a caller can pass what it has; it may
 * corroborate a title match but can never carry one on its own.
 */
export function commonsGeosearchNameMatches(
  placeName: string,
  title: string,
  _categories: string[] = [],
): boolean {
  const wanted = normalizeCommonsName(placeName)
    .split(" ")
    .filter((token) => token.length >= 3 && !COMMON_PLACE_WORDS.has(token));
  if (wanted.length === 0) return false;
  const bare = title.replace(/^Category:|^File:/i, "");
  const words = normalizeCommonsName(bare).split(" ");
  const phrase = wanted.join(" ");
  const contiguous = words.some((_, i) =>
    i + wanted.length <= words.length &&
    words.slice(i, i + wanted.length).join(" ") === phrase
  );
  if (!contiguous) return false;
  // A hyphenated compound that carries one of our tokens *plus* a word we did
  // not ask for is a different name wearing the same word.
  const wantedSet = new Set(wanted);
  for (const compound of bare.match(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)+/gu) ?? []) {
    const parts = normalizeCommonsName(compound).split(" ").filter(Boolean);
    if (!parts.some((part) => wantedSet.has(part))) continue;
    if (parts.some((part) => !wantedSet.has(part) && !COMMON_PLACE_WORDS.has(part))) return false;
  }
  return true;
}

/** Pure parser for the second geosearch request: name gate first, then the
 * existing CC licence/credit parser. */
export function parseCommonsGeosearchImageInfo(
  doc: unknown,
  placeName: string,
): CommonsImageCandidate[] {
  const pages = (doc as { query?: { pages?: CommonsPage[] | Record<string, CommonsPage> } })
    ?.query?.pages;
  if (!pages) return [];
  const out: CommonsImageCandidate[] = [];
  for (const page of Object.values(pages)) {
    const title = typeof page.title === "string" ? page.title : "";
    const categories = (page.categories ?? []).flatMap((category) =>
      typeof category.title === "string" ? [category.title] : []
    );
    if (!commonsGeosearchNameMatches(placeName, title, categories)) continue;
    const candidate = parseCommonsImageInfo(
      { query: { pages: [page] } },
      "commons:geosearch",
    );
    if (candidate) out.push(candidate);
  }
  return out;
}

/** Commons files within 40 m, followed by metadata/category resolution. The
 * radius alone is never enough: `parseCommonsGeosearchImageInfo` must tie the
 * file name or a category to the place name. */
export async function geosearchCommonsImages(
  placeName: string,
  location: { lat: number; lng: number },
  fetchImpl: FetchLike = outboundFetchFor("commons", {
    direct: true,
    cacheResponse: true,
    maxBytes: 2 * 1024 * 1024,
    timeoutMs: 10_000,
  }),
): Promise<CommonsImageCandidate[]> {
  const api = new URL("https://commons.wikimedia.org/w/api.php");
  api.searchParams.set("action", "query");
  api.searchParams.set("format", "json");
  api.searchParams.set("formatversion", "2");
  api.searchParams.set("list", "geosearch");
  api.searchParams.set("gsnamespace", "6");
  api.searchParams.set("gscoord", `${location.lat}|${location.lng}`);
  api.searchParams.set("gsradius", "40");
  api.searchParams.set("gslimit", "10");
  try {
    const response = await fetchImpl(api.toString(), {
      headers: { "user-agent": UA, accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return [];
    const hits = (await response.json() as {
      query?: { geosearch?: Array<{ title?: unknown }> };
    }).query?.geosearch ?? [];
    const titles = hits.flatMap((hit) => typeof hit.title === "string" ? [hit.title] : []);
    if (titles.length === 0) return [];

    const metadataApi = new URL("https://commons.wikimedia.org/w/api.php");
    metadataApi.searchParams.set("action", "query");
    metadataApi.searchParams.set("format", "json");
    metadataApi.searchParams.set("formatversion", "2");
    metadataApi.searchParams.set("prop", "imageinfo|categories");
    metadataApi.searchParams.set("iiprop", "url|extmetadata");
    metadataApi.searchParams.set("cllimit", "max");
    metadataApi.searchParams.set("titles", titles.join("|"));
    const metadataResponse = await fetchImpl(metadataApi.toString(), {
      headers: { "user-agent": UA, accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!metadataResponse.ok) return [];
    return parseCommonsGeosearchImageInfo(await metadataResponse.json(), placeName);
  } catch {
    return [];
  }
}

export async function resolveCommonsImage(
  file: string,
  source: string,
  fetchImpl: FetchLike = outboundFetchFor("commons", {
    direct: true,
    cacheResponse: true,
    maxBytes: 2 * 1024 * 1024,
    timeoutMs: 10_000,
  }),
): Promise<CommonsImageCandidate | null> {
  const title = file.replace(/^File:/i, "").trim();
  if (!title || /^Category:/i.test(title)) return null;
  const api = new URL("https://commons.wikimedia.org/w/api.php");
  api.searchParams.set("action", "query");
  api.searchParams.set("format", "json");
  api.searchParams.set("formatversion", "2");
  api.searchParams.set("prop", "imageinfo");
  api.searchParams.set("iiprop", "url|extmetadata");
  api.searchParams.set("titles", `File:${title}`);
  try {
    const response = await fetchImpl(api.toString(), {
      headers: { "user-agent": UA, accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    return parseCommonsImageInfo(await response.json(), source);
  } catch {
    return null;
  }
}

export async function fetchWikidataFacts(
  id: string,
  fetchImpl: FetchLike = outboundFetchFor("wikidata", {
    direct: true,
    cacheResponse: true,
    maxBytes: 4 * 1024 * 1024,
    timeoutMs: TIMEOUT_MS,
  }),
): Promise<{ facts: WikiFacts | null; error?: string }> {
  if (!/^Q\d{1,12}$/.test(id)) return { facts: null, error: "not a Wikidata id" };
  try {
    const res = await fetchImpl(`https://www.wikidata.org/wiki/Special:EntityData/${id}.json`, {
      headers: { "user-agent": UA, accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      await res.body?.cancel();
      return { facts: null, error: `HTTP ${res.status}` };
    }
    const facts = parseEntity(id, await res.json(), new Date().toISOString());
    if (facts.commonsFile) {
      const image = await resolveCommonsImage(facts.commonsFile, `wikidata:${id}`, fetchImpl);
      if (image) facts.image = image;
    }
    return { facts };
  } catch (err) {
    const e = err as Error & { cause?: { message?: string } };
    return { facts: null, error: `${e?.name ?? "Error"}: ${e?.cause?.message ?? e?.message ?? String(err)}`.slice(0, 120) };
  }
}
