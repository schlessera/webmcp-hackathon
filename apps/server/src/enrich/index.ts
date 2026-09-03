import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import {
  ATTRIBUTE_LABELS,
  ATTRIBUTE_VOCABULARY,
  areaById,
  criterionFor,
  graded,
  normalizeStatus,
  type Criterion,
  type DossierLink,
  type LookupsMessage,
} from "@webmcp-hackathon/contracts";
import {
  fetchWebsiteImageCandidates,
  fetchWebsiteFacts,
  type FetchLike,
  type WebFacts,
  type WebsiteFetchResult,
  type WebsitePageCache,
  type WebsiteTransientText,
} from "./website.ts";
import {
  loadPageCache,
  removePageCache,
  refreshPageCache,
  storePageCache,
  transientTextFromPages,
} from "./cache.ts";
import {
  fetchWikidataFacts,
  geosearchCommonsImages,
  resolveCommonsImage,
  type WikiFacts,
} from "./wikidata.ts";
import {
  imageRefreshDue,
  imagesRefreshDue,
  loadImageVersions,
  refreshPlaceImages,
  type ImageCandidate,
} from "./images.ts";
import { menuReaderEnabled, readMenu } from "./menu-reader.ts";
import {
  applyInferredAttributes,
  inferenceEnabled,
  sanitizeInferenceNote,
  type StoredInference,
} from "./infer.ts";
import {
  evaluateMatrix,
  type EvaluateMatrixInput,
  type EvaluatedInference,
  type MatrixInferenceTextSource,
} from "./evaluate.ts";
import type { AdjudicationPageCache } from "./adjudicate.ts";
import { applyGuesses } from "../guess.ts";
import { applyAttestations, loadAttestations } from "../attestations.ts";
import { bumpCandidateMapRevisions } from "../candidate-revisions.ts";
import { withTransaction } from "../db.ts";
import { beginLookups, publishFacts } from "./progress.ts";
import { notifyCommit } from "../commit-notifications.ts";
import {
  outboundFetch,
  proxyEnabled,
  type OutboundPurpose,
} from "../net/outbound.ts";

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
 * - Enrichment stores parsed facts, URLs and short descriptions. Separately,
 *   page_cache keeps at most 6,000 extracted characters per page for seven
 *   days so a new criterion can reuse them. That text is evaluator-only:
 *   never projected to a person, put in a dossier, or written to a log.
 */

export interface Enrichment {
  osmRef: string;
  fetchedAt: string;
  website: PersistedWebFacts | null;
  wikidata: WikiFacts | null;
  inferred?: Record<string, StoredCriterionInference>;
  inferredAt?: string | null;
  error: string | null;
  imageExpiresAt?: string | null;
  providerStatus?: {
    website: ProviderFetchState;
    wikidata: ProviderFetchState;
  };
}

/** The durable website JSONB shape intentionally cannot carry image URLs. */
export type PersistedWebFacts = Omit<WebFacts, "imageCandidates">;

export type StoredCriterionInference =
  | (Exclude<StoredInference, { omitted: true }> & {
      /** A merge-time disagreement, shown instead of the retained evidence span. */
      note?: string;
    })
  | {
      omitted: true;
      observedAt: string;
      /** Durable search-leg accounting. Absent for a local-matrix abstention. */
      searchDay?: string;
      searchAttempts?: number;
    };

export interface ProviderFetchState {
  status: "never" | "ok" | "error";
  fetchedAt: string | null;
  expiresAt: string | null;
  error: string | null;
}

export interface LookupTarget {
  osmRef: string;
  placeName?: string;
  location?: { lat: number; lng: number };
  website?: string;
  wikidata?: string;
  image?: string;
  wikimediaCommons?: string;
  /** Area targeting for venue traffic; never removed by a retry. */
  countryCode?: string;
  /** Opaque per-pass sticky identity shared by site, menu and image legs. */
  session?: string;
}

/** A successful lookup is good for a week; a failed one is retried after an hour. */
const TTL_OK_MS = 7 * 24 * 60 * 60 * 1000;
const TTL_WIKIDATA_OK_MS = 30 * 24 * 60 * 60 * 1000;
const TTL_FAIL_MS = 60 * 60 * 1000;
const TTL_INFER_MS = 7 * 24 * 60 * 60 * 1000;
const TTL_OMITTED_MS = 24 * 60 * 60 * 1000;
export const INFERENCE_PRUNE_DAYS = 30;
export const MAX_QUESTION_INFERENCES = 64;
export const SEARCH_ATTEMPT_CAP = 3;

export type InferenceSourceBucket =
  | "record"
  | "own_site_explicit"
  | "own_site_inferred"
  | "domain_search"
  | "open_web"
  | "name_category";

/** One comparison table for every monotonic evidence merge, lowest to highest. */
export const INFERENCE_SOURCE_BUCKET_RANK: Readonly<Record<InferenceSourceBucket, number>> = {
  name_category: 0,
  open_web: 1,
  domain_search: 2,
  own_site_inferred: 3,
  own_site_explicit: 4,
  record: 5,
};

export const INFERENCE_DISAGREEMENT_NOTE = "another read leaned the other way";

function isOmitted(
  inference: StoredCriterionInference,
): inference is Extract<StoredCriterionInference, { omitted: true }> {
  return "omitted" in inference;
}

function inferenceSourceBucket(
  inference: Exclude<StoredCriterionInference, { omitted: true }>,
): InferenceSourceBucket {
  if (inference.source.startsWith("web:") || inference.source.startsWith("adjudicated:")) {
    return "record";
  }
  const bucket = inference.source.split(":").at(-1);
  if (bucket === "venue_site" || bucket === "menu") {
    return inference.explicit === true ? "own_site_explicit" : "own_site_inferred";
  }
  if (bucket === "domain_search") return "domain_search";
  if (bucket === "open_web_search") return "open_web";
  // name_category is weaker than a quoted open-web span. Legacy infer:<model>
  // entries also land here because their source does not retain a bucket.
  return "name_category";
}

/**
 * Pure, monotonic merge for one place/criterion evidence cell. A re-read may
 * add evidence, strengthen it, or record a contradiction; absence is never
 * disproof and therefore never refreshes an existing claim's observedAt.
 */
export function resolveInference(
  previous: StoredCriterionInference | undefined,
  fresh: StoredCriterionInference,
): StoredCriterionInference {
  if (!previous) return fresh;
  if (isOmitted(fresh)) {
    if (!isOmitted(previous)) return previous;
    if (fresh.searchDay && fresh.searchDay === previous.searchDay) {
      return {
        ...fresh,
        searchAttempts: Math.min(
          SEARCH_ATTEMPT_CAP,
          (previous.searchAttempts ?? 0) + (fresh.searchAttempts ?? 0),
        ),
      };
    }
    return fresh;
  }
  if (isOmitted(previous)) return fresh;

  // Cache metadata is monotonic metadata on this evidence cell, not a second
  // fact path. Retain it even when the evidence comparison keeps the old fact.
  const retainedPrevious = fresh.adjudication
    ? { ...previous, adjudication: fresh.adjudication }
    : previous;

  // A focused reread may flip a likely claim, never a fact already verified.
  if (
    fresh.adjudication &&
    fresh.lean !== previous.lean &&
    previous.confidence >= 0.7
  ) return retainedPrevious;

  const previousRank = INFERENCE_SOURCE_BUCKET_RANK[inferenceSourceBucket(previous)];
  const freshRank = INFERENCE_SOURCE_BUCKET_RANK[inferenceSourceBucket(fresh)];
  if (fresh.lean === previous.lean) {
    return fresh.confidence > previous.confidence || freshRank > previousRank
      ? fresh
      : retainedPrevious;
  }
  if (fresh.explicit === true && freshRank >= previousRank) return fresh;
  return { ...retainedPrevious, note: INFERENCE_DISAGREEMENT_NOTE };
}
const LOOKUP_CONCURRENCY = proxyEnabled() ? 12 : 4;
const WARM_CONCURRENCY = LOOKUP_CONCURRENCY;
export const ON_DEMAND_CONCURRENCY = LOOKUP_CONCURRENCY;
export const ON_DEMAND_MAX_WAITERS = 32;
const LEASE_MS = 2 * 60 * 1000;

const OFFLINE = "ENRICH_NETWORK=0";
const offline: FetchLike = () => Promise.reject(new Error(OFFLINE));
/** ENRICH_NETWORK=0 keeps every lookup off the network (test servers, air-gapped demos). */
let fetchImpl: FetchLike = process.env.ENRICH_NETWORK === "0" ? offline : fetch;
let injectedFetch = false;
/** Test seam: replace the network. */
export function setEnrichFetch(f: FetchLike | null): void {
  injectedFetch = f !== null;
  fetchImpl = f ?? (process.env.ENRICH_NETWORK === "0" ? offline : fetch);
}

function purposeForVenueRequest(
  url: string,
  homeUrl: string,
  init: RequestInit | undefined,
): OutboundPurpose {
  const target = new URL(url);
  if (target.pathname === "/robots.txt") return "robots";
  const accept = new Headers(init?.headers).get("accept") ?? "";
  if (/image/i.test(accept)) return "venue-image";
  return target.toString() === new URL(homeUrl).toString() ? "venue-site" : "venue-menu";
}

function liveVenueFetch(target: LookupTarget): FetchLike {
  return (url, init = {}) => {
    const purpose = purposeForVenueRequest(url, target.website!, init);
    return outboundFetch(url, {
      ...init,
      purpose,
      country: target.countryCode,
      session: target.session,
      maxBytes: purpose === "venue-image" ? 6 * 1024 * 1024 : 1_500_000,
      timeoutMs: purpose === "venue-image" ? 10_000 : 20_000,
    });
  };
}

const liveWikiFetch: FetchLike = (url, init = {}) => outboundFetch(url, {
  ...init,
  purpose: url.includes("commons.wikimedia.org") ? "commons" : "wikidata",
  direct: true,
  cacheResponse: true,
  maxBytes: 4 * 1024 * 1024,
  timeoutMs: 10_000,
});

function wikiFetch(): FetchLike {
  return injectedFetch ? fetchImpl : liveWikiFetch;
}

function imageFetch(target: LookupTarget): FetchLike {
  if (injectedFetch) return fetchImpl;
  return (url, init = {}) => {
    const hostname = new URL(url).hostname.toLowerCase();
    const commons = hostname === "upload.wikimedia.org" || hostname.endsWith(".wikimedia.org");
    return outboundFetch(url, {
      ...init,
      purpose: commons ? "commons" : "image-cdn",
      ...(commons ? { direct: true } : { country: target.countryCode, session: target.session }),
      maxBytes: 6 * 1024 * 1024,
      timeoutMs: 20_000,
    });
  };
}

/** The website reader validates DNS before invoking its transport. For the
 * injected test transport there is no network to protect, so resolve against
 * a public numeric placeholder and translate requests back for the fixture. */
function pageCache(db: pg.Pool): WebsitePageCache {
  return {
    load: (url) => loadPageCache(db, url),
    store: (input) => storePageCache(db, input),
    refresh: (url, ttlMs) => refreshPageCache(db, url, ttlMs),
    remove: (url) => removePageCache(db, url),
  };
}

function translatedPageCache(
  cache: WebsitePageCache,
  safeHost: string,
  original: URL,
): WebsitePageCache {
  const translate = (value: string | URL): string => {
    const url = new URL(value);
    if (url.hostname === safeHost) {
      url.hostname = original.hostname;
      url.port = original.port;
    }
    return url.toString();
  };
  return {
    load: (url) => cache.load(translate(url)),
    store: (input) => cache.store({ ...input, url: translate(input.url) }),
    refresh: (url, ttlMs) => cache.refresh(translate(url), ttlMs),
    remove: (url) => cache.remove?.(translate(url)) ?? Promise.resolve(),
  };
}

async function cachedPageText(
  db: pg.Pool,
  target: LookupTarget,
  enrichment: Enrichment | undefined,
): Promise<WebsiteTransientText | undefined> {
  if (!target.website) return undefined;
  const [home, menu] = await Promise.all([
    loadPageCache(db, target.website),
    enrichment?.website?.menuUrl
      ? loadPageCache(db, enrichment.website.menuUrl)
      : Promise.resolve(null),
  ]);
  return transientTextFromPages(home?.fresh ? home : null, menu?.fresh ? menu : null);
}

function fetchInjectedWebsiteFacts(
  db: pg.Pool,
  target: LookupTarget,
  previousFacts?: WebFacts | null,
) {
  const url = target.website!;
  const cache = pageCache(db);
  if (!injectedFetch) return fetchWebsiteFacts(url, liveVenueFetch(target), cache, previousFacts);
  let original: URL;
  try {
    original = new URL(url);
  } catch {
    return fetchWebsiteFacts(url, fetchImpl, cache, previousFacts);
  }
  const safe = new URL(original);
  safe.hostname = "93.184.216.34";
  return fetchWebsiteFacts(safe.toString(), (requested, init) => {
    const translated = new URL(requested);
    translated.hostname = original.hostname;
    translated.port = original.port;
    return fetchImpl(translated.toString(), init);
  }, translatedPageCache(cache, safe.hostname, original), previousFacts);
}

function fetchInjectedWebsiteImageCandidates(db: pg.Pool, target: LookupTarget) {
  const url = target.website!;
  const cache = pageCache(db);
  if (!injectedFetch) return fetchWebsiteImageCandidates(url, liveVenueFetch(target), cache);
  let original: URL;
  try {
    original = new URL(url);
  } catch {
    return fetchWebsiteImageCandidates(url, fetchImpl, cache);
  }
  const safe = new URL(original);
  safe.hostname = "93.184.216.34";
  return fetchWebsiteImageCandidates(safe.toString(), (requested, init) => {
    const translated = new URL(requested);
    translated.hostname = original.hostname;
    translated.port = original.port;
    return fetchImpl(translated.toString(), init);
  }, translatedPageCache(cache, safe.hostname, original)).then((candidates) => candidates.map((candidate) => ({
    ...candidate,
    source: (candidate.imagePolicy.class === "page-image"
      ? `web:page-image:${original.host}`
      : `web:${original.host}`) as `web:${string}`,
    pageUrl: original.toString(),
  })));
}

const lookupNowInFlight = new Map<string, Promise<string[]>>();
interface Row {
  osm_ref: string;
  fetched_at: Date;
  expires_at: Date;
  website: PersistedWebFacts | null;
  wikidata: WikiFacts | null;
  inferred: Record<string, StoredCriterionInference>;
  inferred_at: Date | null;
  error: string | null;
  website_status: ProviderFetchState["status"];
  website_fetched_at: Date | null;
  website_expires_at: Date | null;
  website_error: string | null;
  wikidata_status: ProviderFetchState["status"];
  wikidata_fetched_at: Date | null;
  wikidata_expires_at: Date | null;
  wikidata_error: string | null;
  image_expires_at: Date | null;
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

const rowToEnrichment = (r: Row): Enrichment => {
  const inferred = Object.fromEntries(
    Object.entries(r.inferred ?? {}).filter(([, claim]) => {
      const observed = new Date(
        "omitted" in claim ? claim.observedAt : claim.adjudication?.observedAt ?? claim.observedAt,
      ).getTime();
      const ttl = "omitted" in claim
        ? TTL_OMITTED_MS
        : claim.adjudication
          ? INFERENCE_PRUNE_DAYS * 24 * 60 * 60 * 1000
          : TTL_INFER_MS;
      return Number.isFinite(observed) && Date.now() - observed < ttl;
    }),
  );
  return {
    osmRef: r.osm_ref,
    fetchedAt: r.fetched_at.toISOString(),
    website: r.website,
    wikidata: r.wikidata,
    inferred,
    inferredAt: r.inferred_at?.toISOString() ?? null,
    error: r.error,
    imageExpiresAt: r.image_expires_at?.toISOString() ?? null,
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
  };
};

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

export class BoundedSemaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  private readonly limit: number;
  private readonly maxWaiting: number;

  constructor(limit: number, maxWaiting: number) {
    this.limit = limit;
    this.maxWaiting = maxWaiting;
  }

  async use<T>(work: () => Promise<T>): Promise<T | undefined> {
    if (this.active >= this.limit || this.waiting.length > 0) {
      if (this.waiting.length >= this.maxWaiting) return undefined;
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.active += 1;
    }
    try {
      return await work();
    } finally {
      this.release();
    }
  }

  private release(): void {
    this.active -= 1;
    // X4: reserve every newly free counter for an already queued waiter
    // before resolving it. Re-checking here, synchronously, prevents a fresh
    // caller from observing spare capacity and barging past the queue.
    while (this.active < this.limit && this.waiting.length > 0) {
      this.active += 1;
      this.waiting.shift()!();
    }
  }
}

// R9: one process-wide bound covers every on-demand caller, including the
// page-held screening loop. Database leases provide cross-process dedupe.
const lookupSlots = new BoundedSemaphore(
  ON_DEMAND_CONCURRENCY,
  ON_DEMAND_MAX_WAITERS,
);

const expired = (state: ProviderFetchState | undefined, now: number): boolean =>
  !state?.expiresAt || new Date(state.expiresAt).getTime() <= now;

/** Under force: a good read older than FORCE_STALE_MS is due again; a failed
 * read keeps its retry TTL (a site that was down a minute ago is not asked
 * again just because someone pressed the button twice). */
const dueUnderForce = (state: ProviderFetchState | undefined, now: number): boolean => {
  if (expired(state, now)) return true;
  if (state?.status === "error") return false;
  const fetched = state?.fetchedAt ? new Date(state.fetchedAt).getTime() : 0;
  return now - fetched >= FORCE_STALE_MS;
};

function dueProviders(target: LookupTarget, cached: Enrichment | undefined, force = false) {
  const now = Date.now();
  const due = force ? dueUnderForce : expired;
  return {
    website: Boolean(target.website) && due(cached?.providerStatus?.website, now),
    wikidata: Boolean(target.wikidata) && due(cached?.providerStatus?.wikidata, now),
  };
}

const hasLookupSource = (target: LookupTarget): boolean =>
  Boolean(
    target.website || target.wikidata || target.image || target.wikimediaCommons ||
      (target.placeName && target.location),
  );

function commonsFilename(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  if (/^(?:File:)?[^/]+\.(?:jpe?g|png|webp|gif|tiff?|svg)$/i.test(raw.trim())) {
    return raw.trim().replace(/^File:/i, "");
  }
  try {
    const url = new URL(raw);
    if (url.hostname !== "commons.wikimedia.org") return undefined;
    const title = decodeURIComponent(url.pathname.split("/").pop() ?? "");
    return title.replace(/^File:/i, "") || undefined;
  } catch {
    return undefined;
  }
}

async function imageCandidatesFor(
  target: LookupTarget,
  enrichment: Enrichment | undefined,
  websiteCandidates: ImageCandidate[],
  /** Commons/Wikidata API calls only. Named apart from the module-level
   * `imageFetch` factory, which routes image *bytes* through a venue exit. */
  wikiApiFetch: FetchLike = wikiFetch(),
): Promise<ImageCandidate[]> {
  const pageUrl = `https://www.openstreetmap.org/${target.osmRef}`;
  const out: ImageCandidate[] = [];
  const osmImageFile = commonsFilename(target.image);
  if (osmImageFile) {
    const image = await resolveCommonsImage(osmImageFile, "osm:image", wikiApiFetch);
    if (image) out.push(image);
  } else if (target.image) {
    try {
      const url = new URL(target.image.split(";")[0].trim());
      if (url.protocol === "http:" || url.protocol === "https:") {
        out.push({ url: url.toString(), source: "osm:image", pageUrl });
      }
    } catch {
      /* an unresolvable tag contributes no candidate */
    }
  }
  const commonsFile = commonsFilename(target.wikimediaCommons);
  if (commonsFile) {
    const image = await resolveCommonsImage(
      commonsFile,
      "osm:wikimedia_commons",
      wikiApiFetch,
    );
    if (image) out.push(image);
  }
  if (enrichment?.wikidata?.image) out.push(enrichment.wikidata.image);
  else if (enrichment?.wikidata?.commonsFile) {
    const image = await resolveCommonsImage(
      enrichment.wikidata.commonsFile,
      `wikidata:${enrichment.wikidata.id}`,
      wikiApiFetch,
    );
    if (image) out.push(image);
  }
  if (target.placeName && target.location) {
    out.push(...await geosearchCommonsImages(target.placeName, target.location, wikiApiFetch));
  }
  out.push(...websiteCandidates);
  return [...new Map(out.map((candidate) => [candidate.url, candidate])).values()];
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
  // Image URLs are deliberately pass-local. Strip them at the only website
  // JSON serialization boundary so stale URLs can never enter `website`.
  const persistedSiteFacts: PersistedWebFacts | null = site.facts
    ? (({ imageCandidates: _imageCandidates, ...facts }) => facts)(site.facts)
    : null;
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
          persistedSiteFacts ? JSON.stringify(persistedSiteFacts) : null,
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
          String(wiki.error ? TTL_FAIL_MS : TTL_WIKIDATA_OK_MS),
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
         error = NULLIF(concat_ws('; ', website_error, wikidata_error), '')
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

export interface LookupPass {
  enrichment: Enrichment | null;
  /** Server-private evaluator text, normally served from the seven-day page cache. */
  pageText?: WebsiteTransientText;
}

async function lookup(db: pg.Pool, target: LookupTarget, force = false): Promise<LookupPass> {
  const passTarget: LookupTarget = {
    ...target,
    session: target.session ?? randomUUID().replace(/-/g, "").slice(0, 16),
  };
  const initial = (await loadCached(db, [target.osmRef])).get(target.osmRef);
  const initialImagesDue = await imageRefreshDue(
    db,
    target.osmRef,
    force ? FORCE_STALE_MS : undefined,
  );
  if (!Object.values(dueProviders(target, initial, force)).some(Boolean) && !initialImagesDue) {
    const pageText = await cachedPageText(db, target, initial);
    return { enrichment: initial ?? null, ...(pageText ? { pageText } : {}) };
  }

  // X4: queue before acquiring the cross-process lease. A bounded waiter can
  // never consume lease lifetime while another lookup owns all network slots.
  const completed = await lookupSlots.use(async () => {
    const beforeLease = (await loadCached(db, [target.osmRef])).get(target.osmRef);
    const beforeLeaseImagesDue = await imageRefreshDue(
      db,
      target.osmRef,
      force ? FORCE_STALE_MS : undefined,
    );
    if (!Object.values(dueProviders(target, beforeLease, force)).some(Boolean) && !beforeLeaseImagesDue) {
      const pageText = await cachedPageText(db, target, beforeLease);
      return { enrichment: beforeLease ?? null, ...(pageText ? { pageText } : {}) };
    }
    const owner = randomUUID();
    // R11: this lease is visible to every server process and is acquired in a
    // short statement; no pool client or room lock is held during the network.
    if (!(await acquireLease(db, target.osmRef, owner))) {
      return { enrichment: beforeLease ?? null };
    }
    try {
      const current = (await loadCached(db, [target.osmRef])).get(target.osmRef);
      const attempted = dueProviders(target, current, force);
      const attemptedImages = await imageRefreshDue(
        db,
        target.osmRef,
        force ? FORCE_STALE_MS : undefined,
      );
      if (!attempted.website && !attempted.wikidata && !attemptedImages) {
        const pageText = await cachedPageText(db, target, current);
        return { enrichment: current ?? null, ...(pageText ? { pageText } : {}) };
      }

      const noSite: WebsiteFetchResult = { facts: null };
      const noWiki: { facts: WikiFacts | null; error?: string } = { facts: null };
      const imageWork = { commonsApiCalls: 0 };
      // Counts on the routed Wikimedia leg, so the log line reports real
      // outbound Commons API calls rather than intended ones.
      const routedWikiFetch = wikiFetch();
      const countedWikiFetch: FetchLike = (url, init) => {
        try {
          const targetUrl = new URL(url);
          if (targetUrl.hostname === "commons.wikimedia.org" && targetUrl.pathname === "/w/api.php") {
            imageWork.commonsApiCalls += 1;
          }
        } catch {
          /* the called fetch path owns invalid-URL handling */
        }
        return routedWikiFetch(url, init);
      };
      const harvestWebsiteImages = attemptedImages && Boolean(target.website) && !attempted.website;
      const [site, wiki, harvestedWebsiteCandidates] = await Promise.all([
        attempted.website
          ? fetchInjectedWebsiteFacts(db, passTarget, current?.website)
          : Promise.resolve(noSite),
        attempted.wikidata
          ? fetchWikidataFacts(target.wikidata!, countedWikiFetch)
          : Promise.resolve(noWiki),
        harvestWebsiteImages
          ? fetchInjectedWebsiteImageCandidates(db, passTarget)
          : Promise.resolve([]),
      ]);
      // A menu that is a picture gets read (menu-reader.ts); the bytes are
      // never stored, the claims are.
      if (site.facts && site.menuFile && menuReaderEnabled()) {
        try {
          const reading = await readMenu(site.menuFile);
          if (reading) site.facts.menuReading = reading;
        } catch {
          /* an unread menu is still a menu link */
        }
      }
      await persistProviderResults(db, target, owner, attempted, site, wiki);
      const refreshed = (await loadCached(db, [target.osmRef])).get(target.osmRef);
      if (attemptedImages) {
        await refreshPlaceImages(
          db,
          target.osmRef,
          target.placeName ?? target.osmRef,
          await imageCandidatesFor(
            passTarget,
            refreshed,
            site.facts?.imageCandidates ?? harvestedWebsiteCandidates,
            countedWikiFetch,
          ),
          imageFetch(passTarget),
          imageWork,
        );
      }
      const finalEnrichment = (await loadCached(db, [target.osmRef])).get(target.osmRef);
      const pageText = site.pageText ?? await cachedPageText(db, target, finalEnrichment);
      return {
        enrichment: finalEnrichment ?? null,
        ...(pageText ? { pageText } : {}),
      };
    } finally {
      // Offline mode deliberately does not advance provider freshness, but it
      // must still yield the cross-process lease immediately.
      await releaseLease(db, target.osmRef, owner);
    }
  });
  // A full queue is load shedding, not a failed fact read: return stale data.
  if (completed !== undefined) return completed;
  const pageText = await cachedPageText(db, target, initial);
  return { enrichment: initial ?? null, ...(pageText ? { pageText } : {}) };
}

/** The refinement worker's one provider pass for a place. Page text stays on
 * this server-private return path; page_cache persists it only for evaluators. */
export function readRefinementSource(
  db: pg.Pool,
  target: LookupTarget,
  countryCode?: string,
): Promise<LookupPass> {
  return lookup(db, { ...target, ...(countryCode ? { countryCode } : {}) }, true);
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
  const wanted = targets.filter(hasLookupSource);
  const found = await loadCached(db, wanted.map((t) => t.osmRef));
  const imagesDue = await imagesRefreshDue(db, wanted.map((t) => t.osmRef));
  const stale = wanted.filter(
    (target) =>
      Object.values(dueProviders(target, found.get(target.osmRef))).some(Boolean) ||
      imagesDue.has(target.osmRef),
  );
  if (stale.length === 0) return found;

  const jobs = stale.map((target) => lookup(db, target));
  // R9/X4: the request waits only for its remaining budget. Jobs admitted to
  // the bounded queue continue and populate cache; queued jobs hold no lease.
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

export interface RoomLookupTarget extends LookupTarget {
  candidateId: string;
}

export interface LookupNowOptions {
  keys?: string[];
  /** Criterion-aware callers carry questions without flattening them to keys. */
  criteria?: Criterion[];
  reason?: NonNullable<LookupsMessage["reason"]>;
  /**
   * "Look again": a provider whose last good read is older than
   * FORCE_STALE_MS is read again inside its success TTL, and inference runs
   * again for every requested key that is still unknown on the record,
   * monotonically merging what was inferred before. A provider's failure TTL, the
   * robots and network rules, and the per-participant budget all still hold.
   */
  force?: boolean;
  /** Fresh fetched/proxy page material for focused adjudication in this pass. */
  pageCache?: AdjudicationPageCache;
}

/** A forced lookup re-reads a provider only when its last read is older than this. */
export const FORCE_STALE_MS = 10 * 60_000;

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
    brand?: string;
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
  // Same order as eligibility.ts mergedAttributes: inference before the
  // kind-of-place rules, so a quoted span is never shadowed by a rule.
  const inferred = applyInferredAttributes(
    enriched,
    enrichment?.inferred as Record<string, StoredInference> | undefined,
  );
  const guessed = applyGuesses(row.category, inferred, observedAt);
  return applyAttestations(row.id, guessed, attestations);
}

/** A deterministic factual hash: order-independent and deliberately omits
 * observedAt because category guesses are stamped at read time. */
export function stableAttributeHash(attributes: AttributeLike[]): string {
  const factual = attributes
    .map(({ observedAt: _observedAt, ...attribute }) => attribute)
    .sort((a, b) => a.key.localeCompare(b.key));
  return createHash("sha256").update(JSON.stringify(factual)).digest("hex");
}

export function inferenceTexts(
  row: LookupCandidateRow,
  enrichment: Enrichment | undefined,
  transient?: WebsiteTransientText,
) {
  const texts: Array<{
    source: MatrixInferenceTextSource;
    text: string;
    url?: string;
    title?: string;
    publisherNames?: string[];
  }> = [];
  const osmDescription = row.extras?.description?.text;
  if (osmDescription) texts.push({ source: "osm", text: osmDescription });
  const web = enrichment?.website;
  const webIdentity = web ? {
    ...(web.pageTitle ? { title: web.pageTitle } : {}),
    ...(web.publisherNames?.length ? { publisherNames: web.publisherNames } : {}),
  } : {};
  if (web?.description) {
    texts.push({ source: "web", text: web.description, url: web.url, ...webIdentity });
  }
  if (transient?.homepage) {
    texts.push({
      source: "web",
      text: transient.homepage,
      ...(row.extras?.website ?? web?.url ? { url: row.extras?.website ?? web?.url } : {}),
      ...webIdentity,
    });
  }
  if (web) {
    // Only what the place itself wrote may serve as evidence. Facts the
    // server already parsed into slots (price band, wheelchair, hours) are
    // not prose: a synthesized "Price level: 2" line must never come back
    // as the quoted evidence for an unrelated key.
    const facts = [
      web.cuisine?.length ? `Cuisine: ${web.cuisine.join(", ")}` : "",
    ].filter(Boolean);
    if (facts.length) {
      texts.push({ source: "web", text: facts.join(". "), url: web.url, ...webIdentity });
    }
    const menu = [
      ...(web.menuMentions ?? []).map((key) => `${key} mentioned on the menu`),
      ...(web.menuReading?.claims ?? []).map((claim) => claim.evidence),
      ...(web.menuReading?.cuisine ?? []),
    ].filter(Boolean);
    if (menu.length) {
      texts.push({
        source: "menu",
        text: menu.join(". "),
        url: web.menuUrl ?? web.url,
        ...webIdentity,
      });
    }
  }
  if (transient?.menu) {
    texts.push({
      source: "menu",
      text: transient.menu,
      ...(web?.menuUrl ?? web?.url ?? row.extras?.website
        ? { url: web?.menuUrl ?? web?.url ?? row.extras?.website }
        : {}),
      ...webIdentity,
    });
  }
  if (enrichment?.wikidata?.description) {
    texts.push({
      source: "wikidata",
      text: enrichment.wikidata.description,
      ...(enrichment.wikidata.wikipedia ? { url: enrichment.wikidata.wikipedia } : {}),
    });
  }
  return texts;
}

function cuisineTokens(attributes: AttributeLike[]): string[] {
  const cuisine = attributes.find((attribute) => attribute.key === "cuisine");
  return typeof cuisine?.value === "string"
    ? cuisine.value.split(";").map((token) => token.trim()).filter(Boolean)
    : [];
}

export interface InferenceBatchWrite {
  osmRef: string;
  criteria: Criterion[];
  claims: EvaluatedInference[];
  /** Criterion ids returned as validated claims or explicit abstentions. */
  answeredCriterionIds: string[];
  /** Cells for which an outbound search leg was actually spent. */
  searchedCriterionIds?: string[];
  observedAt: string;
}

/** Persist one model batch, including explicit omission markers. Question
 * copy never enters this cross-room cache. Rows are locked for the complete
 * read-resolve-write transaction so lookup and refinement cannot interleave. */
export async function saveInferences(
  pool: pg.Pool,
  writes: InferenceBatchWrite[],
): Promise<void> {
  const rows = writes.filter(
    (write) =>
      write.claims.length > 0 ||
      write.answeredCriterionIds.length > 0 ||
      (write.searchedCriterionIds?.length ?? 0) > 0,
  );
  if (rows.length === 0) return;
  const incomingByRef = new Map<string, Record<string, StoredCriterionInference>>();
  const ttlByRef = new Map<string, number>();
  for (const write of rows) {
    const claimed = new Map(write.claims.map((claim) => [claim.criterionId, claim]));
    const answered = new Set(write.answeredCriterionIds);
    const searched = new Set(write.searchedCriterionIds ?? []);
    const inferred: Record<string, StoredCriterionInference> = {};
    for (const criterion of write.criteria) {
      const key = criterion.id;
      // A q:<sha1> is a stable, guessable commitment, not a secret. It is safe
      // here only because neither the normalized sentence nor its label is
      // stored; dossier copy is recovered from a viewer-authorized requirement.
      const claim = claimed.get(criterion.id);
      if (claim) {
        inferred[key] = {
          key,
          lean: claim.lean,
          confidence: claim.confidence,
          evidence: claim.evidence,
          source: claim.source,
          observedAt: claim.observedAt,
          explicit: claim.explicit,
          ...(claim.value ? { value: claim.value } : {}),
          ...(claim.sourceUrl ? { sourceUrl: claim.sourceUrl } : {}),
          ...(claim.context ? { context: claim.context } : {}),
          ...(claim.pageTitle ? { pageTitle: claim.pageTitle } : {}),
          ...(claim.publisherNames?.length ? { publisherNames: claim.publisherNames } : {}),
          ...(claim.adjudication ? { adjudication: claim.adjudication } : {}),
        };
      } else if (answered.has(criterion.id) || searched.has(criterion.id)) {
        inferred[key] = {
          omitted: true,
          observedAt: write.observedAt,
          ...(searched.has(criterion.id)
            ? { searchDay: write.observedAt.slice(0, 10), searchAttempts: 1 }
            : {}),
        };
      }
    }
    incomingByRef.set(write.osmRef, {
      ...(incomingByRef.get(write.osmRef) ?? {}),
      ...inferred,
    });
    ttlByRef.set(
      write.osmRef,
      Math.max(
        ttlByRef.get(write.osmRef) ?? 0,
        write.claims.length > 0 ? TTL_INFER_MS : TTL_OMITTED_MS,
      ),
    );
  }
  const refs = [...incomingByRef.keys()];
  const ttls = refs.map((ref) => String(ttlByRef.get(ref)));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Materialize missing rows first. A concurrent insert of the same ref
    // blocks here, after which both transactions lock and resolve in order.
    await client.query(
      `INSERT INTO enrichments
         (osm_ref, fetched_at, expires_at, website, wikidata, inferred, inferred_at, error)
       SELECT batch.osm_ref,
              now(),
              now() + (batch.ttl_ms || ' milliseconds')::interval,
              NULL,
              NULL,
              '{}'::jsonb,
              NULL,
              NULL
         FROM unnest($1::text[], $2::text[]) AS batch(osm_ref, ttl_ms)
       ON CONFLICT (osm_ref) DO NOTHING`,
      [refs, ttls],
    );
    const locked = (
      await client.query(
        `SELECT osm_ref, inferred
           FROM enrichments
          WHERE osm_ref = ANY($1::text[])
          ORDER BY osm_ref
          FOR UPDATE`,
        [refs],
      )
    ).rows as Array<{
      osm_ref: string;
      inferred: Record<string, StoredCriterionInference>;
    }>;
    const resolvedRefs = locked.map((row) => row.osm_ref);
    const resolvedPayloads = locked.map((row) => {
      const resolved = { ...(row.inferred ?? {}) };
      for (const [key, fresh] of Object.entries(incomingByRef.get(row.osm_ref) ?? {})) {
        resolved[key] = resolveInference(resolved[key], fresh);
      }
      return JSON.stringify(resolved);
    });

    // SQL retains only storage maintenance: the 30-day age limit and the
    // independent 64-entry question/open partitions. It makes no evidence
    // choice; the full resolved objects above are its input.
    await client.query(
      `WITH batch AS (
         SELECT * FROM unnest($1::text[], $2::jsonb[]) AS value(osm_ref, inferred)
       ), observed AS (
         SELECT batch.osm_ref,
                entry.key,
                entry.value,
                GREATEST(
                  CASE
                    WHEN pg_input_is_valid(entry.value->>'observedAt', 'timestamp with time zone')
                    THEN (entry.value->>'observedAt')::timestamptz
                    ELSE NULL
                  END,
                  CASE
                    WHEN pg_input_is_valid(entry.value->'adjudication'->>'observedAt', 'timestamp with time zone')
                    THEN (entry.value->'adjudication'->>'observedAt')::timestamptz
                    ELSE NULL
                  END
                ) AS observed_at
           FROM batch
           CROSS JOIN LATERAL jsonb_each(batch.inferred) AS entry
       ), ranked AS (
         SELECT osm_ref,
                key,
                value,
                row_number() OVER (
                  PARTITION BY osm_ref, CASE
                    WHEN key LIKE 'q:%' THEN 'question'
                    WHEN key LIKE 'open:%' THEN 'time-window'
                    ELSE key
                  END
                  ORDER BY observed_at DESC NULLS LAST, key
                ) AS age_rank
           FROM observed
          WHERE observed_at >= now() - ($3 || ' days')::interval
       ), pruned AS (
         SELECT batch.osm_ref,
                COALESCE(
                  jsonb_object_agg(ranked.key, ranked.value) FILTER (
                    WHERE ranked.key IS NOT NULL
                      AND ((ranked.key NOT LIKE 'q:%' AND ranked.key NOT LIKE 'open:%')
                        OR ranked.age_rank <= $4)
                  ),
                  '{}'::jsonb
                ) AS inferred
           FROM batch
           LEFT JOIN ranked ON ranked.osm_ref = batch.osm_ref
          GROUP BY batch.osm_ref
       )
       UPDATE enrichments
          SET inferred = pruned.inferred,
              inferred_at = now()
         FROM pruned
        WHERE enrichments.osm_ref = pruned.osm_ref`,
      [resolvedRefs, resolvedPayloads, String(INFERENCE_PRUNE_DAYS), MAX_QUESTION_INFERENCES],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Run live lookups for room candidates, at most four at once. Progress is
 * presentation-only. A facts frame and map_revision bump happen only when
 * the stable merged attribute hash changes.
 */
export function lookupNow(
  pool: pg.Pool,
  roomId: string,
  targets: RoomLookupTarget[],
  options: LookupNowOptions = {},
): Promise<string[]> {
  if (process.env.ENRICH_NETWORK === "0" || targets.length === 0) return Promise.resolve([]);
  const tracked = [
    ...new Map(
      targets
        .filter(
          (target) => target.osmRef && (hasLookupSource(target) || inferenceEnabled()),
        )
        .map((target) => [target.candidateId, target]),
    ).values(),
  ];
  if (tracked.length === 0) return Promise.resolve([]);
  const keys = [...new Set(options.keys ?? [...ATTRIBUTE_VOCABULARY])]
    .filter((key) => (ATTRIBUTE_VOCABULARY as readonly string[]).includes(key))
    .sort();
  const criteria = [
    ...new Map((options.criteria ?? []).map((criterion) => [criterion.id, criterion])).values(),
  ];
  const keyFor = (target: RoomLookupTarget) =>
    JSON.stringify([
      roomId,
      target.candidateId,
      keys,
      criteria.map((criterion) => criterion.id).sort(),
      options.force === true,
    ]);
  const existingJobs: Promise<string[]>[] = [];
  const fresh: RoomLookupTarget[] = [];
  for (const target of tracked) {
    const existing = lookupNowInFlight.get(keyFor(target));
    if (existing) existingJobs.push(existing);
    else fresh.push(target);
  }
  if (fresh.length > 0) {
    // Begin before the first await so a read issued immediately after this call
    // can truthfully return lookupPending=true.
    const endProgress = beginLookups(
      roomId,
      fresh.map((target) => target.candidateId),
      options.reason,
    );
    const freshKeys = fresh.map(keyFor);
    const job = runLookupNow(pool, roomId, fresh, { ...options, keys, criteria }).finally(() => {
      endProgress();
      for (const key of freshKeys) {
        if (lookupNowInFlight.get(key) === job) lookupNowInFlight.delete(key);
      }
    });
    for (const key of freshKeys) lookupNowInFlight.set(key, job);
    existingJobs.push(job);
  }
  const wanted = new Set(tracked.map((target) => target.candidateId));
  return Promise.all([...new Set(existingJobs)]).then((results) =>
    [...new Set(results.flat())].filter((candidateId) => wanted.has(candidateId)),
  );
}

async function runLookupNow(
  pool: pg.Pool,
  roomId: string,
  targets: RoomLookupTarget[],
  options: LookupNowOptions,
): Promise<string[]> {
  const wantedIds = [...new Set(targets.map((target) => target.candidateId))];
  const [candidateRows, roomArea] = await Promise.all([
    pool.query(
      `SELECT id, osm_ref, name, category, attributes, extras
         FROM candidates WHERE room_id = $1 AND id = ANY($2)`,
      [roomId, wantedIds],
    ),
    pool.query("SELECT area_id FROM rooms WHERE id = $1", [roomId]),
  ]);
  const countryCode = areaById(String(roomArea.rows[0]?.area_id ?? ""))?.countryCode;
  const targetById = new Map(targets.map((target) => [target.candidateId, {
    ...target,
    ...(countryCode ? { countryCode } : {}),
  }]));
  const rows = candidateRows.rows as LookupCandidateRow[];
  const actionable = rows.filter((row) => {
    const target = targetById.get(row.id);
    return Boolean(row.osm_ref && (target && hasLookupSource(target) || inferenceEnabled()));
  });
  if (actionable.length === 0) return [];

  const [attestations, requirementRows, initialCache, initialImageVersions] = await Promise.all([
    loadAttestations(pool, roomId),
    // Shared and application-private payloads may reach the server-side model:
    // that is application-private's tier contract. Agent-private content stays
    // in its owner's agent and is never harvested. Model access is distinct
    // from what the cross-room cache may store and a dossier viewer may see.
    pool.query(
      `SELECT visibility, payload FROM requirements
        WHERE room_id = $1 AND NOT withdrawn AND active IS NOT FALSE
          AND visibility IN ('shared', 'application-private')`,
      [roomId],
    ),
    loadCached(pool, actionable.map((row) => row.osm_ref!).filter(Boolean)),
    loadImageVersions(pool, actionable.map((row) => row.osm_ref!).filter(Boolean)),
  ]);
  const activeCriteria = new Map<string, Criterion>();
  for (const criterion of options.criteria ?? []) activeCriteria.set(criterion.id, criterion);
  for (const criterion of harvestRequirementCriteria(requirementRows.rows)) {
    activeCriteria.set(criterion.id, criterion);
  }

  interface CandidateEvaluation {
    row: LookupCandidateRow;
    current?: Enrichment;
    observedAt: string;
    before: string;
    base?: AttributeLike[];
    texts?: ReturnType<typeof inferenceTexts>;
    openCriteria?: Criterion[];
  }
  const evaluations = new Map<string, CandidateEvaluation>();
  let cursor = 0;
  const worker = async () => {
    while (cursor < actionable.length) {
      const row = actionable[cursor++];
      const target = targetById.get(row.id)!;
      const observedAt = new Date().toISOString();
      let current = initialCache.get(row.osm_ref!);
      const evaluation: CandidateEvaluation = {
        row,
        current,
        observedAt,
        before: stableAttributeHash(mergedForLookup(row, current, attestations, observedAt)),
      };
      evaluations.set(row.id, evaluation);
      try {
        let transientText: WebsiteTransientText | undefined;

        // Provider freshness is independent: lookup retries only the due leg,
        // retains last-known-good facts, and preserves a failed leg's TTL.
        if (hasLookupSource(target)) {
          const pass = await lookup(pool, target, options.force === true);
          current = pass.enrichment ?? undefined;
          transientText = pass.pageText;
        }
        evaluation.current = current;
        evaluation.base = applyGuesses(
          row.category,
          applyEnrichmentAttributes(
            (row.attributes ?? []).map((attribute) => normalizeStatus(attribute)),
            current,
          ),
          observedAt,
        );
        evaluation.texts = inferenceTexts(row, current, transientText);
      } catch {
        // A lookup is opportunistic. One broken site/model/database row must
        // not fail the caller or prevent the rest of the batch completing.
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(WARM_CONCURRENCY, actionable.length) }, () => worker()),
  );

  const criteria = new Map(activeCriteria);
  for (const evaluation of evaluations.values()) {
    for (const key of options.keys ?? ATTRIBUTE_VOCABULARY) {
      if (!(ATTRIBUTE_VOCABULARY as readonly string[]).includes(key)) continue;
      // Cuisine is meaningful only with the wanted values carried by an
      // active value-specific criterion; a bare "cuisine?" cell is unusable.
      if (key === "cuisine") continue;
      const attr = evaluation.base?.find((attribute) => attribute.key === key);
      if (attr?.status !== "unknown") continue;
      criteria.set(key, {
        id: key,
        kind: "key",
        key,
        label: ATTRIBUTE_LABELS[key as keyof typeof ATTRIBUTE_LABELS] ?? key,
      });
    }
  }

  const matrixPlaces: EvaluateMatrixInput["places"] = [];
  const matrixCriteria = new Map<string, Criterion>();
  for (const evaluation of evaluations.values()) {
    if (!evaluation.base || !evaluation.texts) continue;
    const openCriteria = [...criteria.values()].filter((criterion) => {
      // A time window is a deterministic predicate over structured hours.
      // Fetching the site may supply those hours, but prose/model inference
      // must never manufacture an answer to an `open:*` criterion.
      if (criterion.kind === "key" && criterion.key.startsWith("open:")) return false;
      const key = criterion.kind === "key" ? criterion.key : criterion.id;
      const storedKey = criterion.id;
      const attr = evaluation.base!.find((attribute) => attribute.key === key);
      if (attr && attr.status !== "unknown") return false;
      if (!attr && criterion.kind === "key" && !activeCriteria.has(criterion.id)) return false;
      return options.force === true || !evaluation.current?.inferred?.[storedKey];
    });
    evaluation.openCriteria = openCriteria;
    if (openCriteria.length === 0) continue;
    for (const criterion of openCriteria) matrixCriteria.set(criterion.id, criterion);
    matrixPlaces.push({
      candidateId: evaluation.row.id,
      osmRef: evaluation.row.osm_ref!,
      name: evaluation.row.name,
      category: evaluation.row.category,
      ...(evaluation.row.extras?.website ? { website: evaluation.row.extras.website } : {}),
      cuisine: cuisineTokens(evaluation.base),
      texts: evaluation.texts,
    });
  }

  // Prefer fresh page material during the focused reread. It stays in the
  // caller-owned process-local map and is never persisted as a whole page.
  for (const place of matrixPlaces) {
    for (const source of place.texts) {
      if (!source.url || !source.text) continue;
      const previous = options.pageCache?.get(source.url);
      options.pageCache?.set(source.url, {
        text: previous ? `${previous.text}\n${source.text}` : source.text,
        title: source.title ?? previous?.title,
        publisherNames: source.publisherNames ?? previous?.publisherNames,
      });
    }
  }

  let inferenceChanged = false;
  if (matrixPlaces.length > 0 && matrixCriteria.size > 0 && inferenceEnabled()) {
    try {
      const openByCandidate = new Map(
        [...evaluations.values()].map((evaluation) => [
          evaluation.row.id,
          new Set((evaluation.openCriteria ?? []).map((criterion) => criterion.id)),
        ]),
      );
      const claims = await evaluateMatrix({
        places: matrixPlaces,
        criteria: [...matrixCriteria.values()],
      }, async (batch) => {
        const answeredByCandidate = new Map<string, string[]>();
        for (const cell of batch.answered) {
          if (!openByCandidate.get(cell.candidateId)?.has(cell.criterionId)) continue;
          const ids = answeredByCandidate.get(cell.candidateId) ?? [];
          ids.push(cell.criterionId);
          answeredByCandidate.set(cell.candidateId, ids);
        }
        const accepted = batch.claims.filter((claim) =>
          openByCandidate.get(claim.candidateId)?.has(claim.criterionId)
        );
        await saveInferences(
          pool,
          batch.input.places.flatMap((place) => {
            const evaluation = evaluations.get(place.candidateId);
            if (!evaluation?.openCriteria?.length) return [];
            const criterionIds = new Set(batch.input.criteria.map((criterion) => criterion.id));
            return [{
              osmRef: evaluation.row.osm_ref!,
              criteria: evaluation.openCriteria.filter((criterion) => criterionIds.has(criterion.id)),
              claims: accepted.filter((claim) => claim.candidateId === place.candidateId),
              answeredCriterionIds: answeredByCandidate.get(place.candidateId) ?? [],
              observedAt: evaluation.observedAt,
            }];
          }),
        );
        if (accepted.length > 0) inferenceChanged = true;
      }, pool, options.force === true ? "refresh" : "reuse");
      inferenceChanged ||= claims.length > 0;
      const refreshed = await loadCached(
        pool,
        [...evaluations.values()].map((evaluation) => evaluation.row.osm_ref!).filter(Boolean),
      );
      for (const evaluation of evaluations.values()) {
        evaluation.current = refreshed.get(evaluation.row.osm_ref!);
      }
    } catch {
      // Model and persistence work are opportunistic; provider facts still land.
    }
  }

  const changed = [...evaluations.values()].flatMap((evaluation) => {
    const after = stableAttributeHash(
      mergedForLookup(
        evaluation.row,
        evaluation.current,
        attestations,
        evaluation.observedAt,
      ),
    );
    return evaluation.before === after ? [] : [evaluation.row.id];
  });
  if (changed.length > 0) {
    await publishInferenceChanges(pool, roomId, changed, inferenceChanged ? "inference" : "lookup");
  }
  const finalImageVersions = await loadImageVersions(
    pool,
    actionable.map((row) => row.osm_ref!).filter(Boolean),
  );
  const imageChanged = actionable.flatMap((row) =>
    initialImageVersions.get(row.osm_ref!) !== finalImageVersions.get(row.osm_ref!)
      ? [row.id]
      : [],
  );
  const attributeChanged = new Set(changed);
  const imageOnly = imageChanged.filter((candidateId) => !attributeChanged.has(candidateId));
  if (imageOnly.length > 0) {
    // An image does not change eligibility or invalidate private screening,
    // so it needs a facts frame but no room/map revision bump.
    publishFacts(roomId, { type: "facts", candidateIds: imageOnly, reason: "lookup" });
  }
  return [...new Set([...changed, ...imageChanged])];
}

/** Defense in depth for callers/tests that supply rows without the SQL gate. */
export function harvestRequirementCriteria(
  rows: Array<{ visibility?: unknown; payload?: unknown }>,
): Criterion[] {
  return rows.flatMap((row) => {
    if (row.visibility !== "shared" && row.visibility !== "application-private") return [];
    const criterion = criterionFor(row.payload as never);
    return criterion ? [criterion] : [];
  });
}

/** One revision/facts publication path for lookup and refinement writes. */
export async function publishInferenceChanges(
  pool: pg.Pool,
  roomId: string,
  candidateIds: string[],
  reason: "inference" | "lookup" = "inference",
): Promise<string[]> {
  const changed = [...new Set(candidateIds)].sort();
  if (changed.length === 0) return [];
  const notification = await withTransaction(async (client) => {
    const room = (
      await client.query(
        "SELECT revision FROM rooms WHERE id = $1 FOR UPDATE",
        [roomId],
      )
    ).rows[0] as { revision: number } | undefined;
    if (!room) return null;
    const screeningEvents = await bumpCandidateMapRevisions(client, roomId, changed);
    let revision = room.revision;
    const storedRevisions: number[] = [];
    for (const event of screeningEvents) {
      revision += 1;
      storedRevisions.push(revision);
      await client.query(
        `INSERT INTO events (room_id, revision, type, actor_id, visibility, payload)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [roomId, revision, event.type, event.actorId, event.visibility, event.payload],
      );
    }
    if (revision !== room.revision) {
      await client.query("UPDATE rooms SET revision = $2 WHERE id = $1", [roomId, revision]);
    }
    return { roomId, revision, storedRevisions, confirmations: [] };
  });
  if (notification) {
    // X7: the registry is cycle-free, so the committed revision enters the
    // ordered broadcast queue synchronously before a later command can.
    notifyCommit(notification);
  }
  publishFacts(roomId, { type: "facts", candidateIds: changed, reason });
  return changed;
}

/** Background warm-up for a fresh room's pool: bounded, visible, fire-and-forget. */
export function warmEnrichments(
  pool: pg.Pool,
  roomId: string,
  targets: RoomLookupTarget[],
): void {
  void warmEnrichmentsDone(pool, roomId, targets);
}

/**
 * The same warm-up, awaitable. A caller adding places in batches chains on
 * this so the room warms one batch at a time and the outbound fetches stay
 * inside WARM_CONCURRENCY, instead of every batch opening its own four.
 */
export function warmEnrichmentsDone(
  pool: pg.Pool,
  roomId: string,
  targets: RoomLookupTarget[],
): Promise<void> {
  if (targets.length === 0) return Promise.resolve();
  return lookupNow(pool, roomId, targets, { reason: { kind: "pool" } })
    .then(() => undefined)
    .catch(() => {
      /* warm-up never holds room creation, or the fill, hostage */
    });
}

// --- merging into a dossier -----------------------------------------------

export interface AttributeLike {
  key: string;
  label?: string;
  status: string;
  value?: string | number;
  source?: string;
  observedAt?: string;
  confidence?: number;
  note?: string;
  sourceUrl?: string;
  explicit?: boolean;
}

/** A slot a looked-up fact may fill: nothing, a gap, or a mere guess. */
const fillable = (a: AttributeLike | undefined) =>
  !a || a.status === "unknown" || a.status === "likely_true" || a.status === "likely_false";

/** Attributes with looked-up facts filled into the slots the record left open. */
export function applyEnrichmentAttributes<T extends AttributeLike>(
  attributes: T[],
  enrichment: Enrichment | undefined,
): T[] {
  const hasQuestionInference = Object.entries(enrichment?.inferred ?? {}).some(
    ([key, stored]) => key.startsWith("q:") && !("omitted" in stored),
  );
  if (!enrichment?.website && !hasQuestionInference) return attributes;
  const out = attributes.map((a) => ({ ...a }));
  const at = (key: string) => out.find((a) => a.key === key);
  const web = enrichment?.website;
  const set = (key: string, patch: Partial<AttributeLike>) => {
    const existing = at(key);
    if (existing) Object.assign(existing, patch);
    else out.push({ key, ...patch } as T);
  };
  if (web) {
    const source = `web:${web.host}`;
    const observedAt = web.fetchedAt;
    const setWeb = (key: string, patch: Partial<AttributeLike>) =>
      set(key, { ...patch, source, observedAt });
    if (web.cuisine?.length && fillable(at("cuisine"))) {
      setWeb("cuisine", { status: "verified_true", value: web.cuisine.join(";"), confidence: 0.7 });
    }
    if (web.priceLevel && fillable(at("price-level"))) {
      setWeb("price-level", { status: "verified_true", value: web.priceLevel, confidence: 0.6 });
    }
    if (web.wheelchair !== undefined && fillable(at("wheelchair-accessible"))) {
      setWeb("wheelchair-accessible", {
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
        setWeb(key, { status: "likely_true", value: "mentioned on the menu", confidence: 0.6 });
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
      setWeb("hours", { status: "likely_true", value: value.length > 80 ? `${value.slice(0, 79)}…` : value, confidence: 0.6 });
    }
  }

  for (const [key, stored] of Object.entries(enrichment?.inferred ?? {})) {
    if (!key.startsWith("q:") || "omitted" in stored || !fillable(at(key))) continue;
    const questionStored = stored as {
      lean: "yes" | "no";
      confidence: number;
      evidence: string;
      source: string;
      observedAt: string;
      sourceUrl?: string;
      explicit?: boolean;
      note?: string;
    };
    const recordGrade =
      questionStored.explicit === true &&
      (questionStored.source.startsWith("web:") ||
        questionStored.source.startsWith("adjudicated:")) &&
      questionStored.confidence >= 0.7;
    const confidence = Math.min(
      questionStored.confidence,
      questionStored.source.startsWith("adjudicated:") ? 0.75 : recordGrade ? 0.72 : 0.6,
    );
    set(key, {
      status: graded(questionStored.lean === "yes", confidence),
      source: questionStored.source,
      observedAt: questionStored.observedAt,
      confidence,
      explicit: recordGrade,
      note: sanitizeInferenceNote(questionStored.note ?? questionStored.evidence),
      ...(questionStored.sourceUrl ? { sourceUrl: questionStored.sourceUrl } : {}),
    });
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
  osm_ref?: string | null;
  name?: string;
  location?: { lat?: unknown; lng?: unknown } | null;
  extras?: {
    website?: string;
    wikidata?: string;
    image?: string;
    wikimediaCommons?: string;
  } | null;
}): LookupTarget | null {
  if (!row.osm_ref) return null;
  return {
    osmRef: row.osm_ref,
    ...(row.name ? { placeName: row.name } : {}),
    ...(typeof row.location?.lat === "number" && typeof row.location.lng === "number"
      ? { location: { lat: row.location.lat, lng: row.location.lng } }
      : {}),
    ...(row.extras?.website ? { website: row.extras.website } : {}),
    ...(row.extras?.wikidata ? { wikidata: row.extras.wikidata } : {}),
    ...(row.extras?.image ? { image: row.extras.image } : {}),
    ...(row.extras?.wikimediaCommons
      ? { wikimediaCommons: row.extras.wikimediaCommons }
      : {}),
  };
}
