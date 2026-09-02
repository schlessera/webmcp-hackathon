/**
 * Wikidata as a source (docs/ENRICHMENT-SOURCES.md, S3). CC0, so anything
 * here may be stored and redistributed. Only places carrying an OSM
 * `wikidata` tag are looked up — about 13 per focus disc, the notable ones —
 * which is exactly where a description, a Wikipedia article and an award are
 * worth having. One entity fetch, no SPARQL, identifying User-Agent.
 */

import type { FetchLike } from "./website.ts";

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
}

const UA =
  "spokes-enrich/0.1 (+https://github.com/schlessera/webmcp-hackathon; alain.schlesser@gmail.com)";
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
  if (desc) facts.description = desc.slice(0, 300);
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
  return facts;
}

export async function fetchWikidataFacts(
  id: string,
  fetchImpl: FetchLike = fetch,
): Promise<{ facts: WikiFacts | null; error?: string }> {
  if (!/^Q\d{1,12}$/.test(id)) return { facts: null, error: "not a Wikidata id" };
  try {
    const res = await fetchImpl(`https://www.wikidata.org/wiki/Special:EntityData/${id}.json`, {
      headers: { "user-agent": UA, accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { facts: null, error: `HTTP ${res.status}` };
    return { facts: parseEntity(id, await res.json(), new Date().toISOString()) };
  } catch (err) {
    const e = err as Error & { cause?: { message?: string } };
    return { facts: null, error: `${e?.name ?? "Error"}: ${e?.cause?.message ?? e?.message ?? String(err)}`.slice(0, 120) };
  }
}
