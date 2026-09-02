import type pg from "pg";
import type { DossierLink } from "@webmcp-hackathon/contracts";
import { fetchWebsiteFacts, type FetchLike, type WebFacts } from "./website.ts";
import { fetchWikidataFacts, type WikiFacts } from "./wikidata.ts";

/**
 * The enrichment layer (docs/ENRICHMENT-SOURCES.md): what the server looks
 * up about the places in focus beyond the map data, and how it lands in a
 * dossier.
 *
 * - Server-side only, never from a participant's browser (no participant IP
 *   reaches a venue or Wikidata). Identifying User-Agent, robots.txt
 *   honoured, one fetch per place per TTL.
 * - Cached in `enrichments` by OSM ref, so every room holding the same place
 *   shares one lookup, and a room opened tomorrow starts warm.
 * - Merged at read time. A looked-up fact only ever fills a slot the record
 *   left `unknown` or `unverified`; a verified record fact is never
 *   overwritten. Sources are `web:<host>` and `wikidata:<id>`, distinct from
 *   `osm:*`, `curated:*` and `agent:*`, so the ledger can say where each
 *   fact came from.
 * - Everything stored is a parsed fact, a URL or a one-line description;
 *   no page text, no review text.
 */

export interface Enrichment {
  osmRef: string;
  fetchedAt: string;
  website: WebFacts | null;
  wikidata: WikiFacts | null;
  error: string | null;
}

export interface LookupTarget {
  osmRef: string;
  website?: string;
  wikidata?: string;
}

/** A successful lookup is good for a week; a failed one is retried after an hour. */
const TTL_OK_MS = 7 * 24 * 60 * 60 * 1000;
const TTL_FAIL_MS = 60 * 60 * 1000;
const WARM_CONCURRENCY = 4;

const OFFLINE = "ENRICH_NETWORK=0";
const offline: FetchLike = () => Promise.reject(new Error(OFFLINE));
/** ENRICH_NETWORK=0 keeps every lookup off the network (test servers, air-gapped demos). */
let fetchImpl: FetchLike = process.env.ENRICH_NETWORK === "0" ? offline : fetch;
/** Test seam: replace the network. */
export function setEnrichFetch(f: FetchLike | null): void {
  fetchImpl = f ?? (process.env.ENRICH_NETWORK === "0" ? offline : fetch);
}

const inFlight = new Map<string, Promise<Enrichment>>();

interface Row {
  osm_ref: string;
  fetched_at: Date;
  expires_at: Date;
  website: WebFacts | null;
  wikidata: WikiFacts | null;
  error: string | null;
}

const rowToEnrichment = (r: Row): Enrichment => ({
  osmRef: r.osm_ref,
  fetchedAt: r.fetched_at.toISOString(),
  website: r.website,
  wikidata: r.wikidata,
  error: r.error,
});

export async function loadCached(
  q: pg.PoolClient | pg.Pool,
  refs: string[],
): Promise<Map<string, Enrichment>> {
  if (refs.length === 0) return new Map();
  const rows = (
    await q.query(
      "SELECT * FROM enrichments WHERE osm_ref = ANY($1) AND expires_at > now()",
      [refs],
    )
  ).rows as Row[];
  return new Map(rows.map((r) => [r.osm_ref, rowToEnrichment(r)]));
}

async function lookup(pool: pg.Pool, target: LookupTarget): Promise<Enrichment> {
  const existing = inFlight.get(target.osmRef);
  if (existing) return existing;
  const job = (async () => {
    const none = { facts: null, error: undefined as string | undefined };
    const [site, wiki] = await Promise.all([
      target.website ? fetchWebsiteFacts(target.website, fetchImpl) : Promise.resolve(none),
      target.wikidata ? fetchWikidataFacts(target.wikidata, fetchImpl) : Promise.resolve(none),
    ]);
    const errors = [site.error, wiki.error].filter(Boolean).join("; ");
    const enrichment: Enrichment = {
      osmRef: target.osmRef,
      fetchedAt: new Date().toISOString(),
      website: site.facts,
      wikidata: wiki.facts,
      error: errors || null,
    };
    // An offline server (tests, air-gapped demos) shares this table with a
    // live one: its non-answers must never be cached as facts.
    if (enrichment.error?.includes(OFFLINE)) return enrichment;
    const ttl = enrichment.website || enrichment.wikidata ? TTL_OK_MS : TTL_FAIL_MS;
    await pool.query(
      `INSERT INTO enrichments (osm_ref, fetched_at, expires_at, website, wikidata, error)
       VALUES ($1, now(), now() + ($2 || ' milliseconds')::interval, $3, $4, $5)
       ON CONFLICT (osm_ref) DO UPDATE SET
         fetched_at = now(), expires_at = EXCLUDED.expires_at,
         website = EXCLUDED.website, wikidata = EXCLUDED.wikidata, error = EXCLUDED.error`,
      [
        target.osmRef, String(ttl),
        enrichment.website ? JSON.stringify(enrichment.website) : null,
        enrichment.wikidata ? JSON.stringify(enrichment.wikidata) : null,
        enrichment.error,
      ],
    );
    return enrichment;
  })().finally(() => inFlight.delete(target.osmRef));
  inFlight.set(target.osmRef, job);
  return job;
}

/**
 * Cached where possible, fetched where not, but never past `waitMs`: a
 * place panel opens now with what is known and the rest lands in the cache
 * for the next read. Targets without anything to look up are skipped.
 */
export async function ensureEnrichments(
  pool: pg.Pool,
  targets: LookupTarget[],
  waitMs: number,
): Promise<Map<string, Enrichment>> {
  const wanted = targets.filter((t) => t.website || t.wikidata);
  const found = await loadCached(pool, wanted.map((t) => t.osmRef));
  const missing = wanted.filter((t) => !found.has(t.osmRef));
  if (missing.length === 0) return found;
  const jobs = missing.map((t) => lookup(pool, t));
  const deadline = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), waitMs));
  const settled = await Promise.race([Promise.allSettled(jobs).then(() => "done" as const), deadline]);
  if (settled === "done") {
    for (const j of jobs) {
      const e = await j.catch(() => null);
      if (e) found.set(e.osmRef, e);
    }
  } else {
    // Take what finished; the rest keeps running and persists itself.
    await Promise.all(
      jobs.map((j) =>
        Promise.race([j, new Promise<null>((r) => setTimeout(() => r(null), 0))]).then((e) => {
          if (e) found.set(e.osmRef, e);
        }),
      ),
    );
  }
  return found;
}

/** Background warm-up for a fresh room's pool: bounded concurrency, fire and forget. */
export function warmEnrichments(pool: pg.Pool, targets: LookupTarget[]): void {
  const queue = targets.filter((t) => t.website || t.wikidata);
  let index = 0;
  const worker = async () => {
    while (index < queue.length) {
      const t = queue[index++];
      try {
        const cached = await loadCached(pool, [t.osmRef]);
        if (!cached.has(t.osmRef)) await lookup(pool, t);
      } catch {
        /* a failed lookup is recorded on the row; nothing to raise */
      }
    }
  };
  for (let i = 0; i < WARM_CONCURRENCY; i += 1) void worker();
}

// --- merging into a dossier -----------------------------------------------

export interface AttributeLike {
  key: string;
  status: string;
  value?: string | number;
  source?: string;
  observedAt?: string;
  confidence?: number;
}

const fillable = (a: AttributeLike | undefined) =>
  !a || a.status === "unknown" || a.status === "unverified";

/** Attributes with looked-up facts filled into the slots the record left open. */
export function applyEnrichmentAttributes<T extends AttributeLike>(
  attributes: T[],
  enrichment: Enrichment | undefined,
): T[] {
  const web = enrichment?.website;
  if (!web) return attributes;
  const source = `web:${web.host}`;
  const observedAt = web.fetchedAt;
  const out = attributes.map((a) => ({ ...a }));
  const at = (key: string) => out.find((a) => a.key === key);
  const set = (key: string, patch: Partial<AttributeLike>) => {
    const existing = at(key);
    if (existing) Object.assign(existing, patch, { source, observedAt });
    else out.push({ key, ...patch, source, observedAt } as T);
  };
  if (web.cuisine?.length && fillable(at("cuisine"))) {
    set("cuisine", { status: "verified_true", value: web.cuisine.join(";"), confidence: 0.7 });
  }
  if (web.priceLevel && fillable(at("price-level"))) {
    set("price-level", { status: "verified_true", value: web.priceLevel, confidence: 0.6 });
  }
  if (web.wheelchair !== undefined && fillable(at("wheelchair-accessible"))) {
    set("wheelchair-accessible", {
      status: web.wheelchair ? "verified_true" : "verified_false",
      confidence: 0.7,
    });
  }
  if (web.hours?.length && at("hours")?.status === "unknown") {
    // A pill, not a timetable: the first rules, capped, as published.
    const value = web.hours.slice(0, 3).join("; ");
    set("hours", { status: "unverified", value: value.length > 80 ? `${value.slice(0, 79)}…` : value, confidence: 0.5 });
  }
  return out;
}

export interface EnrichmentView {
  links: DossierLink[];
  description?: { text: string; source: string };
  rating?: { value: number; best: number; count?: number; source: string; label: string };
  awards?: Array<{ label: string; source: string }>;
}

/** Links, description, rating and awards for the panel, record links first. */
export function enrichmentView(
  extras: { links?: DossierLink[]; description?: { text: string; source: string } } | null | undefined,
  enrichment: Enrichment | undefined,
): EnrichmentView {
  const links: DossierLink[] = [...(extras?.links ?? [])];
  const has = (kind: string) => links.some((l) => l.kind === kind);
  const view: EnrichmentView = { links };
  if (extras?.description) view.description = extras.description;
  const web = enrichment?.website;
  if (web) {
    const source = `web:${web.host}`;
    if (web.menuUrl && !has("menu")) links.push({ kind: "menu", label: "menu", url: web.menuUrl, source });
    if (web.reservationsUrl && !has("reservations")) {
      links.push({ kind: "reservations", label: "reservations", url: web.reservationsUrl, source });
    }
    if (web.rating) {
      view.rating = { ...web.rating, source, label: "as published by the place" };
    }
    if (!view.description && web.description) view.description = { text: web.description, source };
  }
  const wiki = enrichment?.wikidata;
  if (wiki) {
    const source = `wikidata:${wiki.id}`;
    if (wiki.wikipedia && !has("wikipedia")) {
      links.push({ kind: "wikipedia", label: "wikipedia", url: wiki.wikipedia, source });
    }
    if (wiki.website && !has("website")) {
      links.push({ kind: "website", label: "website", url: wiki.website, source });
    }
    if (!view.description && wiki.description) view.description = { text: wiki.description, source };
    const awards = wiki.awards.filter((a) => a.label).map((a) => ({ label: a.label!, source }));
    if (awards.length) view.awards = awards;
  }
  // The place's own site first, then the menu, then the rest.
  const order = ["website", "menu", "hours", "reservations", "wikipedia", "instagram"];
  links.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  return view;
}

/** What to look up for a candidate row: its site and its Wikidata id. */
export function lookupTargetOf(row: {
  osm_ref: string | null;
  extras: { website?: string; wikidata?: string } | null;
}): LookupTarget | null {
  if (!row.osm_ref) return null;
  return {
    osmRef: row.osm_ref,
    ...(row.extras?.website ? { website: row.extras.website } : {}),
    ...(row.extras?.wikidata ? { wikidata: row.extras.wikidata } : {}),
  };
}
