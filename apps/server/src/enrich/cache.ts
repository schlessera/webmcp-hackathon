import { createHash } from "node:crypto";
import type pg from "pg";
import type { EvaluatedInference } from "./evaluate.ts";
import type { WebsiteImageCandidate, WebsiteTransientText } from "./website.ts";

export const PAGE_CACHE_TTL_MS = 7 * 24 * 60 * 60_000;
export const ROBOTS_CACHE_TTL_MS = 24 * 60 * 60_000;
export const DNS_CACHE_TTL_MS = 10 * 60_000;
export const METADATA_CACHE_TTL_MS = 30 * 24 * 60 * 60_000;
export const SEARCH_CACHE_TTL_MS = 7 * 24 * 60 * 60_000;
export const IMAGE_CACHE_TTL_MS = 30 * 24 * 60 * 60_000;
export const MAX_CACHED_PAGE_TEXT = 6_000;

export function cacheTtlMsForSource(
  source: "page" | "robots" | "dns" | "wikidata" | "commons" | "search" | "image",
): number {
  if (source === "page") return PAGE_CACHE_TTL_MS;
  if (source === "robots") return ROBOTS_CACHE_TTL_MS;
  if (source === "dns") return DNS_CACHE_TTL_MS;
  if (source === "search") return SEARCH_CACHE_TTL_MS;
  if (source === "image") return IMAGE_CACHE_TTL_MS;
  return METADATA_CACHE_TTL_MS;
}

export type CacheQuery = Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query">;

export interface PageCacheEntry {
  url: string;
  host: string;
  fetchedAt: string;
  expiresAt: string;
  etag?: string;
  lastModified?: string;
  status: number;
  text?: string;
  imageCandidates?: WebsiteImageCandidate[];
  robots?: string | null;
  fresh: boolean;
}

interface PageCacheRow {
  url: string;
  host: string;
  fetched_at: Date;
  expires_at: Date;
  etag: string | null;
  last_modified: string | null;
  status: number;
  text: string | null;
  image_candidates: WebsiteImageCandidate[] | null;
  robots: string | null;
  fresh: boolean;
}

export function cacheUrlHash(url: string | URL): string {
  return createHash("sha256").update(new URL(url).toString()).digest("hex");
}

export function cacheQueryHash(query: string, domains: string[] = []): string {
  return createHash("sha256")
    .update(JSON.stringify({ query, domains: [...domains].sort() }))
    .digest("hex");
}

function pageEntry(row: PageCacheRow): PageCacheEntry {
  return {
    url: row.url,
    host: row.host,
    fetchedAt: row.fetched_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    ...(row.etag ? { etag: row.etag } : {}),
    ...(row.last_modified ? { lastModified: row.last_modified } : {}),
    status: row.status,
    ...(row.text ? { text: row.text } : {}),
    ...(Array.isArray(row.image_candidates) ? { imageCandidates: row.image_candidates } : {}),
    robots: row.robots,
    fresh: row.fresh,
  };
}

export async function loadPageCache(q: CacheQuery, url: string | URL): Promise<PageCacheEntry | null> {
  const row = (await q.query(
    `SELECT *, expires_at > now() AS fresh FROM page_cache WHERE url_hash = $1`,
    [cacheUrlHash(url)],
  )).rows[0] as PageCacheRow | undefined;
  return row ? pageEntry(row) : null;
}

export interface StorePageInput {
  url: string;
  status: number;
  ttlMs?: number;
  etag?: string | null;
  lastModified?: string | null;
  text?: string | null;
  imageCandidates?: WebsiteImageCandidate[] | null;
  robots?: string | null;
}

/** Store only evaluator material. Cached text is bounded here as well as by a
 * database CHECK and is never exposed through an API or dossier. */
export async function storePageCache(q: CacheQuery, input: StorePageInput): Promise<void> {
  const url = new URL(input.url).toString();
  const text = input.text == null ? null : input.text.slice(0, MAX_CACHED_PAGE_TEXT);
  await q.query(
    `INSERT INTO page_cache
       (url_hash, url, host, fetched_at, expires_at, etag, last_modified,
        status, text, image_candidates, robots)
     VALUES ($1, $2, $3, now(), now() + ($4 || ' milliseconds')::interval,
             $5, $6, $7, $8, $9::jsonb, $10)
     ON CONFLICT (url_hash) DO UPDATE SET
       url = EXCLUDED.url,
       host = EXCLUDED.host,
       fetched_at = EXCLUDED.fetched_at,
       expires_at = EXCLUDED.expires_at,
       etag = EXCLUDED.etag,
       last_modified = EXCLUDED.last_modified,
       status = EXCLUDED.status,
       text = EXCLUDED.text,
       image_candidates = EXCLUDED.image_candidates,
       robots = EXCLUDED.robots`,
    [
      cacheUrlHash(url), url, new URL(url).hostname.toLowerCase(),
      String(input.ttlMs ?? PAGE_CACHE_TTL_MS), input.etag ?? null,
      input.lastModified ?? null, input.status, text,
      input.imageCandidates == null ? null : JSON.stringify(input.imageCandidates),
      input.robots ?? null,
    ],
  );
}

/** A validator hit extends freshness without replacing extracted material. */
export async function refreshPageCache(q: CacheQuery, url: string | URL, ttlMs = PAGE_CACHE_TTL_MS): Promise<void> {
  await q.query(
    `UPDATE page_cache
        SET fetched_at = now(), expires_at = now() + ($2 || ' milliseconds')::interval
      WHERE url_hash = $1`,
    [cacheUrlHash(url), String(ttlMs)],
  );
}

export async function removePageCache(q: CacheQuery, url: string | URL): Promise<void> {
  await q.query("DELETE FROM page_cache WHERE url_hash = $1", [cacheUrlHash(url)]);
}

export interface SearchCacheEntry {
  snippets?: Array<{ url: string; title: string; snippet: string }>;
  claims?: EvaluatedInference[];
  answeredIds?: string[];
}

export async function loadSearchCache(
  q: CacheQuery,
  osmRef: string,
  query: string,
  provider: "tavily" | "openai",
  domains: string[] = [],
): Promise<SearchCacheEntry | null> {
  const row = (await q.query(
    `SELECT snippets, claims, answered_ids FROM search_cache
      WHERE osm_ref = $1 AND query_hash = $2 AND provider = $3 AND expires_at > now()`,
    [osmRef, cacheQueryHash(query, domains), provider],
  )).rows[0] as { snippets: SearchCacheEntry["snippets"] | null; claims: EvaluatedInference[] | null; answered_ids: string[] | null } | undefined;
  return row ? {
    ...(Array.isArray(row.snippets) ? { snippets: row.snippets } : {}),
    ...(Array.isArray(row.claims) ? { claims: row.claims } : {}),
    ...(Array.isArray(row.answered_ids) ? { answeredIds: row.answered_ids } : {}),
  } : null;
}

export async function storeSearchCache(
  q: CacheQuery,
  input: {
    osmRef: string;
    query: string;
    provider: "tavily" | "openai";
    domains?: string[];
    snippets?: SearchCacheEntry["snippets"];
    claims?: EvaluatedInference[];
    answeredIds?: string[];
  },
): Promise<void> {
  // Provider policy is enforced at the write boundary: OpenAI web-search raw
  // snippets never enter durable storage, only validated application claims.
  const snippets = input.provider === "tavily" ? input.snippets : undefined;
  await q.query(
    `INSERT INTO search_cache
       (osm_ref, query_hash, provider, fetched_at, expires_at, snippets, claims, answered_ids)
     VALUES ($1, $2, $3, now(), now() + ($4 || ' milliseconds')::interval,
             $5::jsonb, $6::jsonb, $7::jsonb)
     ON CONFLICT (osm_ref, query_hash, provider) DO UPDATE SET
       fetched_at = EXCLUDED.fetched_at,
       expires_at = EXCLUDED.expires_at,
       snippets = EXCLUDED.snippets,
       claims = EXCLUDED.claims,
       answered_ids = EXCLUDED.answered_ids`,
    [
      input.osmRef,
      cacheQueryHash(input.query, input.domains),
      input.provider,
      String(SEARCH_CACHE_TTL_MS),
      snippets ? JSON.stringify(snippets) : null,
      input.claims ? JSON.stringify(input.claims) : null,
      input.answeredIds ? JSON.stringify(input.answeredIds) : null,
    ],
  );
}

export function transientTextFromPages(home: PageCacheEntry | null, menu: PageCacheEntry | null): WebsiteTransientText | undefined {
  const text = {
    ...(home?.text ? { homepage: home.text } : {}),
    ...(menu?.text ? { menu: menu.text } : {}),
  };
  return Object.keys(text).length ? text : undefined;
}
