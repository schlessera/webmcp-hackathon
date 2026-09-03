import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { DossierLink } from "@webmcp-hackathon/contracts";
import { fetchWebsiteFacts, type FetchLike, type WebFacts } from "./website.ts";
import { fetchWikidataFacts, type WikiFacts } from "./wikidata.ts";
import { menuReaderEnabled, readMenu } from "./menu-reader.ts";

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
  providerStatus?: {
    website: ProviderFetchState;
    wikidata: ProviderFetchState;
  };
}

export interface ProviderFetchState {
  status: "never" | "ok" | "error";
  fetchedAt: string | null;
  expiresAt: string | null;
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
export const ON_DEMAND_CONCURRENCY = 4;
const LEASE_MS = 2 * 60 * 1000;

const OFFLINE = "ENRICH_NETWORK=0";
const offline: FetchLike = () => Promise.reject(new Error(OFFLINE));
/** ENRICH_NETWORK=0 keeps every lookup off the network (test servers, air-gapped demos). */
let fetchImpl: FetchLike = process.env.ENRICH_NETWORK === "0" ? offline : fetch;
/** Test seam: replace the network. */
export function setEnrichFetch(f: FetchLike | null): void {
  fetchImpl = f ?? (process.env.ENRICH_NETWORK === "0" ? offline : fetch);
}

interface Row {
  osm_ref: string;
  fetched_at: Date;
  expires_at: Date;
  website: WebFacts | null;
  wikidata: WikiFacts | null;
  error: string | null;
  website_status: ProviderFetchState["status"];
  website_fetched_at: Date | null;
  website_expires_at: Date | null;
  website_error: string | null;
  wikidata_status: ProviderFetchState["status"];
  wikidata_fetched_at: Date | null;
  wikidata_expires_at: Date | null;
  wikidata_error: string | null;
}

const stateOf = (
  status: ProviderFetchState["status"],
  fetchedAt: Date | null,
  expiresAt: Date | null,
  error: string | null,
): ProviderFetchState => ({
  status,
  fetchedAt: fetchedAt?.toISOString() ?? null,
  expiresAt: expiresAt?.toISOString() ?? null,
  error,
});

const rowToEnrichment = (r: Row): Enrichment => ({
  osmRef: r.osm_ref,
  fetchedAt: r.fetched_at.toISOString(),
  website: r.website,
  wikidata: r.wikidata,
  error: r.error,
  providerStatus: {
    website: stateOf(
      r.website_status,
      r.website_fetched_at,
      r.website_expires_at,
      r.website_error,
    ),
    wikidata: stateOf(
      r.wikidata_status,
      r.wikidata_fetched_at,
      r.wikidata_expires_at,
      r.wikidata_error,
    ),
  },
});

export async function loadCached(
  q: pg.PoolClient | pg.Pool,
  refs: string[],
): Promise<Map<string, Enrichment>> {
  if (refs.length === 0) return new Map();
  const rows = (
    await q.query(
      // R11: last-known good provider values remain usable while only the
      // failed/expired provider is retried. Freshness decides refresh work,
      // not whether good cached facts disappear from a dossier.
      "SELECT * FROM enrichments WHERE osm_ref = ANY($1)",
      [refs],
    )
  ).rows as Row[];
  return new Map(rows.map((r) => [r.osm_ref, rowToEnrichment(r)]));
}

class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  async use<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= ON_DEMAND_CONCURRENCY) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active += 1;
    try {
      return await work();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}

// R9: one process-wide bound covers every on-demand caller, including the
// page-held screening loop. Database leases provide cross-process dedupe.
const lookupSlots = new Semaphore();

const expired = (state: ProviderFetchState | undefined, now: number): boolean =>
  !state?.expiresAt || new Date(state.expiresAt).getTime() <= now;

function dueProviders(target: LookupTarget, cached: Enrichment | undefined) {
  const now = Date.now();
  return {
    website: Boolean(target.website) && expired(cached?.providerStatus?.website, now),
    wikidata: Boolean(target.wikidata) && expired(cached?.providerStatus?.wikidata, now),
  };
}

async function acquireLease(db: pg.Pool, osmRef: string, owner: string): Promise<boolean> {
  await db.query(
    `INSERT INTO enrichments (osm_ref, fetched_at, expires_at)
     VALUES ($1, now(), now()) ON CONFLICT (osm_ref) DO NOTHING`,
    [osmRef],
  );
  const claimed = await db.query(
    `UPDATE enrichments
        SET lease_owner = $2,
            lease_expires_at = now() + ($3 || ' milliseconds')::interval
      WHERE osm_ref = $1
        AND (lease_owner IS NULL OR lease_expires_at <= now())`,
    [osmRef, owner, String(LEASE_MS)],
  );
  return claimed.rowCount === 1;
}

async function persistProviderResults(
  db: pg.Pool,
  target: LookupTarget,
  owner: string,
  attempted: { website: boolean; wikidata: boolean },
  site: { facts: WebFacts | null; error?: string },
  wiki: { facts: WikiFacts | null; error?: string },
): Promise<void> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    if (attempted.website && !site.error?.includes(OFFLINE)) {
      await client.query(
        `UPDATE enrichments SET
           website = CASE WHEN $3::boolean THEN $2::jsonb ELSE website END,
           website_status = CASE WHEN $3::boolean THEN 'ok' ELSE 'error' END,
           website_fetched_at = now(),
           website_expires_at = now() + ($4 || ' milliseconds')::interval,
           website_error = $5
         WHERE osm_ref = $1 AND lease_owner = $6`,
        [
          target.osmRef,
          site.facts ? JSON.stringify(site.facts) : null,
          !site.error,
          String(site.error ? TTL_FAIL_MS : TTL_OK_MS),
          site.error ?? null,
          owner,
        ],
      );
    }
    if (attempted.wikidata && !wiki.error?.includes(OFFLINE)) {
      await client.query(
        `UPDATE enrichments SET
           wikidata = CASE WHEN $3::boolean THEN $2::jsonb ELSE wikidata END,
           wikidata_status = CASE WHEN $3::boolean THEN 'ok' ELSE 'error' END,
           wikidata_fetched_at = now(),
           wikidata_expires_at = now() + ($4 || ' milliseconds')::interval,
           wikidata_error = $5
         WHERE osm_ref = $1 AND lease_owner = $6`,
        [
          target.osmRef,
          wiki.facts ? JSON.stringify(wiki.facts) : null,
          !wiki.error,
          String(wiki.error ? TTL_FAIL_MS : TTL_OK_MS),
          wiki.error ?? null,
          owner,
        ],
      );
    }
    await client.query(
      `UPDATE enrichments SET
         fetched_at = now(),
         expires_at = LEAST(
           COALESCE(website_expires_at, 'infinity'::timestamptz),
           COALESCE(wikidata_expires_at, 'infinity'::timestamptz)
         ),
         error = NULLIF(concat_ws('; ', website_error, wikidata_error), ''),
         lease_owner = NULL,
         lease_expires_at = NULL
       WHERE osm_ref = $1 AND lease_owner = $2`,
      [target.osmRef, owner],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function releaseLease(db: pg.Pool, osmRef: string, owner: string): Promise<void> {
  await db.query(
    `UPDATE enrichments SET lease_owner = NULL, lease_expires_at = NULL
      WHERE osm_ref = $1 AND lease_owner = $2`,
    [osmRef, owner],
  );
}

async function lookup(db: pg.Pool, target: LookupTarget): Promise<Enrichment | null> {
  const initial = (await loadCached(db, [target.osmRef])).get(target.osmRef);
  if (!Object.values(dueProviders(target, initial)).some(Boolean)) return initial ?? null;

  const owner = randomUUID();
  // R11: this lease is visible to every server process and is acquired in a
  // short statement; no pool client or room lock is held during the network.
  if (!(await acquireLease(db, target.osmRef, owner))) return initial ?? null;
  try {
    const current = (await loadCached(db, [target.osmRef])).get(target.osmRef);
    const attempted = dueProviders(target, current);
    if (!attempted.website && !attempted.wikidata) return current ?? null;

    await lookupSlots.use(async () => {
      const none = { facts: null, error: undefined as string | undefined };
      const [site, wiki] = await Promise.all([
        attempted.website
          ? fetchWebsiteFacts(target.website!, fetchImpl)
          : Promise.resolve(none),
        attempted.wikidata
          ? fetchWikidataFacts(target.wikidata!, fetchImpl)
          : Promise.resolve(none),
      ]);
    // A menu that is a picture gets read (menu-reader.ts); the bytes are
    // never stored, the claims are.
    if (site.facts && "menuFile" in site && site.menuFile && menuReaderEnabled()) {
      try {
        const reading = await readMenu(site.menuFile);
        if (reading) site.facts.menuReading = reading;
      } catch {
        /* an unread menu is still a menu link */
      }
    }
      await persistProviderResults(db, target, owner, attempted, site, wiki);
    });
    return (await loadCached(db, [target.osmRef])).get(target.osmRef) ?? null;
  } finally {
    // Offline mode deliberately does not advance provider freshness, but it
    // must still yield the cross-process lease immediately.
    await releaseLease(db, target.osmRef, owner);
  }
}

/**
 * Cached where possible, fetched where not, but never past `waitMs`: a
 * place panel opens now with what is known and the rest lands in the cache
 * for the next read. Targets without anything to look up are skipped.
 */
export async function ensureEnrichments(
  db: pg.Pool,
  targets: LookupTarget[],
  waitMs: number,
): Promise<Map<string, Enrichment>> {
  const wanted = targets.filter((t) => t.website || t.wikidata);
  const found = await loadCached(db, wanted.map((t) => t.osmRef));
  const stale = wanted.filter((target) =>
    Object.values(dueProviders(target, found.get(target.osmRef))).some(Boolean),
  );
  if (stale.length === 0) return found;

  const jobs = stale.map((target) => lookup(db, target));
  // R9: the request waits only for its remaining budget. Jobs that already
  // hold a lease continue through the same bounded queue and populate cache.
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.allSettled(jobs),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, Math.max(0, waitMs));
      timer.unref?.();
    }),
  ]);
  if (timer) clearTimeout(timer);
  return loadCached(db, wanted.map((t) => t.osmRef));
}

/** Background warm-up for a fresh room's pool: bounded concurrency, fire and forget. */
export function warmEnrichments(pool: pg.Pool, targets: LookupTarget[]): void {
  const queue = targets.filter((t) => t.website || t.wikidata);
  let index = 0;
  const worker = async () => {
    while (index < queue.length) {
      const t = queue[index++];
      try {
        await lookup(pool, t);
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

/** A slot a looked-up fact may fill: nothing, a gap, or a mere guess. */
const fillable = (a: AttributeLike | undefined) =>
  !a || a.status === "unknown" || a.status === "likely_true" || a.status === "likely_false";

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
  // A word on the menu page is evidence, not a verdict (§8.2): a likely fact
  // at modest confidence, so the room sees there is something to check and
  // the engine reads the place as likely, never as in.
  for (const key of web.menuMentions ?? []) {
    const existing = at(key);
    if (!existing || existing.status === "unknown") {
      set(key, { status: "likely_true", value: "mentioned on the menu", confidence: 0.6 });
    }
  }
  // What a model read off a menu picture: a guess with its confidence,
  // capped below verified (menu-reader.ts), labelled as read, evidence kept.
  const reading = web.menuReading;
  if (reading?.legible) {
    const readSource = `menu:${web.host}`;
    for (const c of reading.claims) {
      const existing = at(c.key);
      if (existing && existing.status !== "unknown" && !existing.source?.startsWith("guess:")) continue;
      const patch = {
        status: (c.lean === "yes" ? "likely_true" : "likely_false") as string,
        value: c.evidence ? `menu: ${c.evidence}` : "read from the menu",
        confidence: c.confidence,
        source: readSource,
        observedAt: reading.readAt,
      };
      if (existing) Object.assign(existing, patch);
      else out.push({ key: c.key, ...patch } as T);
    }
    if (reading.cuisine.length && fillable(at("cuisine"))) {
      const existing = at("cuisine");
      const patch = { status: "likely_true", value: reading.cuisine.join(";"), confidence: 0.6, source: readSource, observedAt: reading.readAt };
      if (existing) Object.assign(existing, patch);
      else out.push({ key: "cuisine", ...patch } as T);
    }
    if (reading.priceLevel && fillable(at("price-level"))) {
      const existing = at("price-level");
      const patch = { status: "likely_true", value: reading.priceLevel, confidence: 0.5, source: readSource, observedAt: reading.readAt };
      if (existing) Object.assign(existing, patch);
      else out.push({ key: "price-level", ...patch } as T);
    }
  }
  if (web.hours?.length && (at("hours")?.status === "unknown" || at("hours")?.status === "likely_true")) {
    // A pill, not a timetable: the first rules, capped, as published.
    const value = web.hours.slice(0, 3).join("; ");
    set("hours", { status: "likely_true", value: value.length > 80 ? `${value.slice(0, 79)}…` : value, confidence: 0.6 });
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
    if (web.deliveryUrl && !has("delivery")) {
      links.push({ kind: "delivery", label: "delivery", url: web.deliveryUrl, source });
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
  const order = ["website", "menu", "hours", "reservations", "delivery", "wikipedia", "instagram"];
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
