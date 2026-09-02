import type pg from "pg";
import { normalizeStatus, type DossierLink, type LookupsMessage } from "@webmcp-hackathon/contracts";
import { createHash } from "node:crypto";
import { fetchWebsiteFacts, type FetchLike, type WebFacts } from "./website.ts";
import { fetchWikidataFacts, type WikiFacts } from "./wikidata.ts";
import { menuReaderEnabled, readMenu } from "./menu-reader.ts";
import {
  applyInferredAttributes,
  inferAttributes,
  inferenceEnabled,
  INFERABLE_KEYS,
  type StoredInference,
} from "./infer.ts";
import { applyGuesses } from "../guess.ts";
import { applyAttestations, loadAttestations } from "../attestations.ts";
import { beginLookups, publishFacts } from "./progress.ts";

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
  inferred?: Record<string, StoredInference>;
  inferredAt?: string | null;
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
const TTL_INFER_MS = 7 * 24 * 60 * 60 * 1000;
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
  inferred: Record<string, StoredInference>;
  inferred_at: Date | null;
  error: string | null;
}

const rowToEnrichment = (r: Row): Enrichment => ({
  osmRef: r.osm_ref,
  fetchedAt: r.fetched_at.toISOString(),
  website: r.website,
  wikidata: r.wikidata,
  inferred: r.inferred ?? {},
  inferredAt: r.inferred_at?.toISOString() ?? null,
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

export interface RoomLookupTarget extends LookupTarget {
  candidateId: string;
}

export interface LookupNowOptions {
  keys?: string[];
  reason?: NonNullable<LookupsMessage["reason"]>;
}

interface LookupCandidateRow {
  id: string;
  osm_ref: string | null;
  name: string;
  category: string;
  attributes: AttributeLike[];
  extras: {
    description?: { text?: string };
    website?: string;
    wikidata?: string;
  } | null;
}

function mergedForLookup(
  row: LookupCandidateRow,
  enrichment: Enrichment | undefined,
  attestations: Awaited<ReturnType<typeof loadAttestations>>,
  observedAt: string,
): AttributeLike[] {
  const normalised = (row.attributes ?? []).map((attribute) => normalizeStatus(attribute));
  const enriched = applyEnrichmentAttributes(normalised, enrichment);
  const guessed = applyGuesses(row.category, enriched, observedAt);
  const inferred = applyInferredAttributes(guessed, enrichment?.inferred);
  return applyAttestations(row.id, inferred, attestations);
}

/** A deterministic factual hash: order-independent and deliberately omits
 * observedAt because category guesses are stamped at read time. */
export function stableAttributeHash(attributes: AttributeLike[]): string {
  const factual = attributes
    .map(({ observedAt: _observedAt, ...attribute }) => attribute)
    .sort((a, b) => a.key.localeCompare(b.key));
  return createHash("sha256").update(JSON.stringify(factual)).digest("hex");
}

function inferenceTexts(row: LookupCandidateRow, enrichment: Enrichment | undefined) {
  const texts: Array<{ source: "osm" | "web" | "menu" | "wikidata"; text: string }> = [];
  const osmDescription = row.extras?.description?.text;
  if (osmDescription) texts.push({ source: "osm", text: osmDescription });
  const web = enrichment?.website;
  if (web?.description) texts.push({ source: "web", text: web.description });
  if (web) {
    const facts = [
      web.cuisine?.length ? `Cuisine: ${web.cuisine.join(", ")}` : "",
      web.priceLevel ? `Price level: ${web.priceLevel}` : "",
      web.wheelchair !== undefined ? `Wheelchair accessible: ${web.wheelchair ? "yes" : "no"}` : "",
      web.hours?.length ? `Opening hours: ${web.hours.join("; ")}` : "",
    ].filter(Boolean);
    if (facts.length) texts.push({ source: "web", text: facts.join(". ") });
    const menu = [
      ...(web.menuMentions ?? []).map((key) => `${key} mentioned on the menu`),
      ...(web.menuReading?.claims ?? []).map((claim) => claim.evidence),
      ...(web.menuReading?.cuisine ?? []),
      web.menuReading?.priceLevel ? `Menu price level: ${web.menuReading.priceLevel}` : "",
    ].filter(Boolean);
    if (menu.length) texts.push({ source: "menu", text: menu.join(". ") });
  }
  if (enrichment?.wikidata?.description) {
    texts.push({ source: "wikidata", text: enrichment.wikidata.description });
  }
  return texts;
}

function cuisineTokens(attributes: AttributeLike[]): string[] {
  const cuisine = attributes.find((attribute) => attribute.key === "cuisine");
  return typeof cuisine?.value === "string"
    ? cuisine.value.split(";").map((token) => token.trim()).filter(Boolean)
    : [];
}

async function saveInferences(
  pool: pg.Pool,
  osmRef: string,
  claims: Awaited<ReturnType<typeof inferAttributes>>,
  observedAt: string,
): Promise<void> {
  if (claims.length === 0 || !inferenceEnabled()) return;
  const inferred = Object.fromEntries(
    claims.map((claim) => [claim.key, { ...claim, observedAt }]),
  );
  await pool.query(
    `INSERT INTO enrichments
       (osm_ref, fetched_at, expires_at, website, wikidata, inferred, inferred_at, error)
     VALUES ($1, now(), now() + ($2 || ' milliseconds')::interval, NULL, NULL, $3, now(), NULL)
     ON CONFLICT (osm_ref) DO UPDATE SET
       inferred = enrichments.inferred || EXCLUDED.inferred,
       inferred_at = now(),
       expires_at = GREATEST(enrichments.expires_at, EXCLUDED.expires_at)`,
    [osmRef, String(TTL_INFER_MS), JSON.stringify(inferred)],
  );
}

/**
 * Run live lookups for room candidates, at most four at once. Progress is
 * presentation-only. A facts frame and map_revision bump happen only when
 * the stable merged attribute hash changes.
 */
export async function lookupNow(
  pool: pg.Pool,
  roomId: string,
  targets: RoomLookupTarget[],
  options: LookupNowOptions = {},
): Promise<string[]> {
  if (process.env.ENRICH_NETWORK === "0" || targets.length === 0) return [];
  const wantedIds = [...new Set(targets.map((target) => target.candidateId))];
  const targetById = new Map(targets.map((target) => [target.candidateId, target]));
  const rows = (
    await pool.query(
      `SELECT id, osm_ref, name, category, attributes, extras
         FROM candidates WHERE room_id = $1 AND id = ANY($2)`,
      [roomId, wantedIds],
    )
  ).rows as LookupCandidateRow[];
  const actionable = rows.filter((row) => {
    const target = targetById.get(row.id);
    return Boolean(row.osm_ref && (target?.website || target?.wikidata || inferenceEnabled()));
  });
  if (actionable.length === 0) return [];

  const endProgress = beginLookups(roomId, actionable.map((row) => row.id), options.reason);
  const attestations = await loadAttestations(pool, roomId);
  const requested = [...new Set(options.keys ?? [...INFERABLE_KEYS])].filter((key) =>
    (INFERABLE_KEYS as readonly string[]).includes(key),
  );
  const changed: string[] = [];
  let inferenceChanged = false;
  let cursor = 0;
  const worker = async () => {
    while (cursor < actionable.length) {
      const row = actionable[cursor++];
      const target = targetById.get(row.id)!;
      const observedAt = new Date().toISOString();
      try {
        let current = (await loadCached(pool, [row.osm_ref!])).get(row.osm_ref!);
        const before = stableAttributeHash(mergedForLookup(row, current, attestations, observedAt));

        if (!current && (target.website || target.wikidata)) {
          await lookup(pool, target);
          current = (await loadCached(pool, [row.osm_ref!])).get(row.osm_ref!);
        }

        if (inferenceEnabled() && requested.length > 0) {
          const base = applyGuesses(
            row.category,
            applyEnrichmentAttributes(
              (row.attributes ?? []).map((attribute) => normalizeStatus(attribute)),
              current,
            ),
            observedAt,
          );
          const fresh = current?.inferredAt
            ? Date.now() - new Date(current.inferredAt).getTime() < TTL_INFER_MS
            : false;
          const unknown = requested.filter((key) => {
            if (base.find((attribute) => attribute.key === key)?.status !== "unknown") return false;
            return !(fresh && current?.inferred?.[key]);
          });
          if (unknown.length > 0) {
            const claims = await inferAttributes({
              name: row.name,
              category: row.category,
              cuisine: cuisineTokens(base),
              texts: inferenceTexts(row, current),
              keys: unknown,
            });
            await saveInferences(pool, row.osm_ref!, claims, observedAt);
            if (claims.length > 0) inferenceChanged = true;
            current = (await loadCached(pool, [row.osm_ref!])).get(row.osm_ref!);
          }
        }

        const after = stableAttributeHash(mergedForLookup(row, current, attestations, observedAt));
        if (before !== after) changed.push(row.id);
      } catch {
        // A lookup is opportunistic. One broken site/model/database row must
        // not fail the caller or prevent the rest of the batch completing.
      }
    }
  };
  try {
    await Promise.all(
      Array.from({ length: Math.min(WARM_CONCURRENCY, actionable.length) }, () => worker()),
    );
    if (changed.length > 0) {
      await pool.query(
        `UPDATE candidates SET map_revision = map_revision + 1
           WHERE room_id = $1 AND id = ANY($2)`,
        [roomId, changed],
      );
      publishFacts(roomId, {
        type: "facts",
        candidateIds: [...changed].sort(),
        reason: inferenceChanged ? "inference" : "lookup",
      });
    }
    return changed;
  } finally {
    endProgress();
  }
}

/** Background warm-up for a fresh room's pool: bounded, visible, fire-and-forget. */
export function warmEnrichments(
  pool: pg.Pool,
  roomId: string,
  targets: RoomLookupTarget[],
): void {
  void lookupNow(pool, roomId, targets, { reason: { kind: "pool" } }).catch(() => {
    /* warm-up never holds room creation hostage */
  });
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
