import type pg from "pg";
import type { StoredInference } from "./infer.ts";
import type { WebFacts } from "./website.ts";
import type { WikiFacts } from "./wikidata.ts";
import { cleanText } from "./text.ts";
import { cleanStoredInferences, cleanWebFacts, cleanWikiFacts } from "./stored-text.ts";
import { MAX_CACHED_PAGE_TEXT } from "./cache.ts";

type RecleanQuery = Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query">;

export interface RecleanOptions {
  /** A hard ceiling per table. Use the returned cursor to continue a large table. */
  maxRowsPerTable?: number;
  batchSize?: number;
  afterOsmRef?: string;
  afterUrlHash?: string;
}

export interface RecleanTableResult {
  scanned: number;
  updated: number;
  truncated: boolean;
  nextCursor?: string;
}

export interface RecleanResult {
  enrichments: RecleanTableResult;
  pageCache: RecleanTableResult;
}

function boundedInteger(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(value!)));
}

function chunks<T>(values: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let at = 0; at < values.length; at += size) out.push(values.slice(at, at + size));
  return out;
}

/**
 * Re-clean durable extraction text without a table-wide unbounded update.
 * Every transform is idempotent, and `IS DISTINCT FROM` avoids touching an
 * already-clean row (including on a second run against the same cursor range).
 */
export async function recleanStoredText(
  q: RecleanQuery,
  options: RecleanOptions = {},
): Promise<RecleanResult> {
  const maxRows = boundedInteger(options.maxRowsPerTable, 10_000, 50_000);
  const batchSize = boundedInteger(options.batchSize, 250, 1_000);

  const enrichmentRows = (await q.query(
    `SELECT osm_ref, website, wikidata, inferred
       FROM enrichments
      WHERE osm_ref > $1
      ORDER BY osm_ref
      LIMIT $2`,
    [options.afterOsmRef ?? "", maxRows + 1],
  )).rows as Array<{
    osm_ref: string;
    website: WebFacts | null;
    wikidata: WikiFacts | null;
    inferred: Record<string, StoredInference> | null;
  }>;
  const enrichmentTruncated = enrichmentRows.length > maxRows;
  const boundedEnrichments = enrichmentRows.slice(0, maxRows).map((row) => ({
    osm_ref: row.osm_ref,
    website: cleanWebFacts(row.website),
    wikidata: cleanWikiFacts(row.wikidata),
    inferred: cleanStoredInferences(row.inferred),
  }));
  let enrichmentUpdated = 0;
  for (const batch of chunks(boundedEnrichments, batchSize)) {
    const result = await q.query(
      `UPDATE enrichments AS stored
          SET website = clean.website,
              wikidata = clean.wikidata,
              inferred = clean.inferred
         FROM jsonb_to_recordset($1::jsonb)
           AS clean(osm_ref text, website jsonb, wikidata jsonb, inferred jsonb)
        WHERE stored.osm_ref = clean.osm_ref
          AND (stored.website, stored.wikidata, stored.inferred)
              IS DISTINCT FROM (clean.website, clean.wikidata, clean.inferred)`,
      [JSON.stringify(batch)],
    );
    enrichmentUpdated += result.rowCount ?? 0;
  }

  const pageRows = (await q.query(
    `SELECT url_hash, text
       FROM page_cache
      WHERE url_hash > $1 AND text IS NOT NULL
      ORDER BY url_hash
      LIMIT $2`,
    [options.afterUrlHash ?? "", maxRows + 1],
  )).rows as Array<{ url_hash: string; text: string }>;
  const pageTruncated = pageRows.length > maxRows;
  const boundedPages = pageRows.slice(0, maxRows).map((row) => ({
    url_hash: row.url_hash,
    text: cleanText(row.text).slice(0, MAX_CACHED_PAGE_TEXT),
  }));
  let pageUpdated = 0;
  for (const batch of chunks(boundedPages, batchSize)) {
    const result = await q.query(
      `UPDATE page_cache AS stored
          SET text = clean.text
         FROM jsonb_to_recordset($1::jsonb) AS clean(url_hash text, text text)
        WHERE stored.url_hash = clean.url_hash
          AND stored.text IS DISTINCT FROM clean.text`,
      [JSON.stringify(batch)],
    );
    pageUpdated += result.rowCount ?? 0;
  }

  return {
    enrichments: {
      scanned: boundedEnrichments.length,
      updated: enrichmentUpdated,
      truncated: enrichmentTruncated,
      ...(enrichmentTruncated && boundedEnrichments.length
        ? { nextCursor: boundedEnrichments.at(-1)!.osm_ref }
        : {}),
    },
    pageCache: {
      scanned: boundedPages.length,
      updated: pageUpdated,
      truncated: pageTruncated,
      ...(pageTruncated && boundedPages.length
        ? { nextCursor: boundedPages.at(-1)!.url_hash }
        : {}),
    },
  };
}
