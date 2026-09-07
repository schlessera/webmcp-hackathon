import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import {
  ATTRIBUTE_LABELS, dossierFromTags, normalizeStatus, type Criterion,
} from "@webmcp-hackathon/contracts";
import { config } from "../config.ts";
import type { AreaSnapshot, SnapshotVenue } from "../places.ts";
import {
  applyEnrichmentAttributes, inferenceTexts, loadCached, lookupTargetOf,
  persistListingMatches, readRefinementSource, saveInferences, warmCachedImages,
  type AttributeLike, type Enrichment, type LookupPass,
} from "../enrich/index.ts";
import { INFERABLE_KEYS, inferenceEnabled } from "../enrich/infer.ts";
import { evaluateMatrix, type EvaluateMatrixInput, type EvaluatedInference } from "../enrich/evaluate.ts";
import { loadPageCache, storeSearchCache, transientTextFromPages } from "../enrich/cache.ts";
import { fetchListingsForCandidates, listingsEnabled, type ListingCandidate } from "../enrich/listings.ts";
import { searchRefinementPlaces } from "../refine/worker.ts";
import { search, searchProviderId } from "../refine/search.ts";
import type { PrepopulateOptions, Source } from "./options.ts";

export function sourceAvailability(): Record<Source | "models", string | null> {
  const offline = process.env.ENRICH_NETWORK === "0";
  const model = !offline && inferenceEnabled();
  const provider = searchProviderId();
  const searchKey = provider === "parallel" ? process.env.PARALLEL_API_KEY
    : provider === "tavily" ? process.env.TAVILY_API_KEY : config.nlEnabled;
  return {
    sites: offline ? "ENRICH_NETWORK=0" : null,
    images: offline ? "ENRICH_NETWORK=0" : null,
    listings: listingsEnabled() ? null : "requires LISTINGS!=0, network and DATAFORSEO_LOGIN/PASSWORD",
    models: model ? null : "requires inference enabled and a configured model API key",
    search: offline ? "ENRICH_NETWORK=0" : !searchKey ? `missing credentials for ${provider}`
      : !model ? "requires inference to validate and persist search evidence" : null,
  };
}

function candidateOf(venue: SnapshotVenue, observedAt: string) {
  const dossier = dossierFromTags(venue.tags, observedAt);
  return {
    id: venue.ref, osm_ref: venue.ref, name: venue.name,
    location: venue.location, category: venue.placeClass ?? dossier.category,
    attributes: dossier.attributes.map(normalizeStatus), extras: dossier.extras,
  };
}

/** All query words come from the server vocabulary; no room needs are loaded. */
export function openCriteria(attributes: AttributeLike[], cached?: Enrichment, searchEnabled = false): Criterion[] {
  return INFERABLE_KEYS.filter((key) =>
    (attributes.find((attribute) => attribute.key === key)?.status ?? "unknown") === "unknown" &&
    (!cached?.inferred?.[key] || (searchEnabled && "omitted" in cached.inferred[key] &&
      !cached.inferred[key].searchDay))
  ).map((key) => ({ id: key, kind: "key", key, label: ATTRIBUTE_LABELS[key] }));
}

async function warmListings(db: pg.Pool, options: PrepopulateOptions, venues: SnapshotVenue[], observedAt: string) {
  const candidates: ListingCandidate[] = venues.map((venue) => {
    const row = candidateOf(venue, observedAt);
    return {
      candidateId: row.id, osmRef: venue.ref, name: venue.name, location: venue.location,
      website: row.extras.website, placeClass: row.category,
    };
  });
  const scope = { center: options.area.center, radiusM: options.radiusM };
  const key = createHash("sha256").update(JSON.stringify({ scope, candidates })).digest("hex");
  const owner = randomUUID();
  const admission = await db.query(
    `INSERT INTO prepopulate_listing_fetches (scope_hash, owner, status, expires_at)
     VALUES ($1, $2, 'running', now() + interval '10 minutes')
     ON CONFLICT (scope_hash) DO UPDATE SET
       owner = EXCLUDED.owner, status = 'running', expires_at = EXCLUDED.expires_at
     WHERE prepopulate_listing_fetches.expires_at <= now()
     RETURNING scope_hash`, [key, owner],
  );
  if (!admission.rowCount) {
    const previous = (await db.query(
      "SELECT status FROM prepopulate_listing_fetches WHERE scope_hash = $1", [key],
    )).rows[0];
    if (previous?.status === "error") throw new Error("Listing fetch is in failure backoff");
    return { status: previous?.status === "running" ? "running" : "cached", matched: 0, costUsd: 0 };
  }
  try {
    const result = await fetchListingsForCandidates(candidates, scope);
    await persistListingMatches(db, result.matches);
    await db.query(
      `UPDATE prepopulate_listing_fetches SET status = 'ok', expires_at = now() + interval '7 days'
       WHERE scope_hash = $1 AND owner = $2`, [key, owner],
    );
    return { status: "fetched", matched: result.matches.length, costUsd: result.costUsd };
  } catch (error) {
    await db.query(
      `UPDATE prepopulate_listing_fetches SET status = 'error', expires_at = now() + interval '1 hour'
       WHERE scope_hash = $1 AND owner = $2`, [key, owner],
    );
    throw error;
  }
}

async function evaluatePlace(
  db: pg.Pool, place: EvaluateMatrixInput["places"][number], criteria: Criterion[],
) {
  const answered = new Set<string>();
  const claims = await evaluateMatrix({ places: [place], criteria }, async (batch) => {
    for (const cell of batch.answered) answered.add(cell.criterionId);
  }, db);
  return { claims, answered };
}

export interface RunSummary {
  selected: number;
  completed: number;
  failed: number;
  interrupted: boolean;
  claims: number;
  searches: number;
  searchCacheHits: number;
  listingMatches: number;
  listingCostUsd: number;
  sourceErrors: Partial<Record<Source, number>>;
}

export async function runPrepopulation(
  db: pg.Pool, options: PrepopulateOptions, snapshot: AreaSnapshot, venues: SnapshotVenue[],
  report: (event: Record<string, unknown>) => void,
  signal?: AbortSignal,
): Promise<RunSummary> {
  if (options.dryRun) throw new Error("Dry runs must not enter the database runner");
  if (process.env.ENRICH_NETWORK === "0") throw new Error("Prepopulation is disabled by ENRICH_NETWORK=0");
  // Fail before spending on providers if migrations or database configuration are missing.
  await db.query("SELECT osm_ref FROM enrichments LIMIT 0");
  await db.query("SELECT scope_hash FROM prepopulate_listing_fetches LIMIT 0");
  const available = sourceAvailability();
  const enabled = (source: Source) => options.sources.includes(source) && available[source] === null;
  if (!options.sources.some(enabled)) throw new Error("None of the selected sources are available; check the plan and provider settings");
  const summary: RunSummary = {
    selected: venues.length, completed: 0, failed: 0, interrupted: false,
    claims: 0, searches: 0, searchCacheHits: 0, listingMatches: 0, listingCostUsd: 0, sourceErrors: {},
  };
  const sourceError = (source: Source) => {
    summary.sourceErrors[source] = (summary.sourceErrors[source] ?? 0) + 1;
    report({ event: "source-error", source }); // Never log provider bodies, URLs or queries.
  };
  if (venues.length && enabled("listings") && !signal?.aborted) {
    try {
      const listing = await warmListings(db, options, venues, snapshot.manifest.extract.timestamp);
      summary.listingMatches = listing.matched;
      summary.listingCostUsd = listing.costUsd;
      report({ event: "listings", ...listing });
    } catch { sourceError("listings"); }
  }
  let cursor = 0;
  const worker = async () => {
    while (cursor < venues.length && !signal?.aborted) {
      const venue = venues[cursor++];
      let failed = false;
      const fail = (source: Source) => { failed = true; sourceError(source); };
      try {
        const row = candidateOf(venue, snapshot.manifest.extract.timestamp);
        let cached = (await loadCached(db, [venue.ref])).get(venue.ref);
        const target = lookupTargetOf(row)!;
        target.countryCode = options.area.countryCode;
        target.website ??= cached?.listing?.website;
        // Discovered sites must establish the same own-site provenance as tagged sites.
        if (target.website) row.extras.website = target.website;
        let pass: LookupPass = { enrichment: cached ?? null };
        if (enabled("sites")) {
          try {
            pass = await readRefinementSource(db, target, options.area.countryCode);
            cached = pass.enrichment ?? cached;
            if ((target.website && cached?.providerStatus?.website.status === "error") ||
                (target.wikidata && cached?.providerStatus?.wikidata.status === "error")) fail("sites");
          } catch { fail("sites"); }
        } else if (target.website) {
          const pages = await Promise.all([target.website, cached?.website?.menuUrl]
            .filter((url): url is string => Boolean(url)).map((url) => loadPageCache(db, url)));
          pass.pageText = transientTextFromPages(
            pages[0]?.fresh ? pages[0] : null, pages[1]?.fresh ? pages[1] : null,
          );
        }
        if (enabled("images")) {
          try {
            await warmCachedImages(db, target, pass);
            const image = (await db.query("SELECT image_error FROM enrichments WHERE osm_ref = $1", [venue.ref])).rows[0];
            if (image?.image_error) fail("images");
          } catch { fail("images"); }
        }
        if (available.models === null && (enabled("sites") || enabled("search"))) {
          const attributes = applyEnrichmentAttributes(row.attributes, cached);
          const criteria = openCriteria(attributes, cached, enabled("search"));
          const place: EvaluateMatrixInput["places"][number] = {
            candidateId: venue.ref, osmRef: venue.ref, name: row.name, category: row.category,
            website: target.website, texts: inferenceTexts(row, cached, pass.pageText),
            cuisine: String(attributes.find((attribute) => attribute.key === "cuisine")?.value ?? "")
              .split(";").map((value) => value.trim()).filter(Boolean),
          };
          const first = await evaluatePlace(db, place, criteria);
          const answered = new Set(first.answered);
          let claims = first.claims;
          // Persist before search so an interruption or failed provider cannot lose site evidence.
          await saveInferences(db, [{ osmRef: venue.ref, criteria, claims,
            answeredCriterionIds: [...answered], observedAt: new Date().toISOString() }]);
          const unresolved = criteria.filter((criterion) => !claims.some((claim) => claim.criterionId === criterion.id));
          let searchedIds: string[] = [];
          if (enabled("search") && unresolved.length && !signal?.aborted) {
            let providerFailed = false;
            const provider = async (...args: Parameters<typeof search>) => {
              try { return await search(...args); }
              catch (error) { providerFailed = true; throw error; }
            };
            const [entry] = await searchRefinementPlaces([{
              candidateId: venue.ref, osmRef: venue.ref, name: row.name, category: row.category,
              website: target.website, siteTextUsable: Object.values(pass.pageText ?? {})
                .some((text) => typeof text === "string" && text.trim().length >= 12),
              criteria: unresolved, searchCriteria: unresolved,
            }], options.area, provider, { cacheDb: db, providerName: searchProviderId() });
            // No room id: Parallel snippets cannot enter a cache shared by demo rooms.
            if (providerFailed) fail("search");
            else {
              if (entry.cacheHit) summary.searchCacheHits += 1;
              else { summary.searches += 1; searchedIds = unresolved.map((criterion) => criterion.id); }
              let searchClaims: EvaluatedInference[] = entry.cachedClaims ?? [];
              const searchAnswered = new Set(entry.cachedAnsweredIds ?? []);
              if (entry.results.length) {
                const second = await evaluatePlace(db, { ...place, texts: entry.results.map((result) => ({
                  source: entry.source, text: result.snippet, url: result.url, title: result.title,
                })) }, unresolved);
                searchClaims = second.claims;
                for (const id of second.answered) searchAnswered.add(id);
              }
              if (searchProviderId() === "openai" && !entry.cacheHit && searchAnswered.size) {
                await storeSearchCache(db, { osmRef: venue.ref, query: entry.cacheQuery!,
                  provider: "openai", domains: entry.cacheDomains, claims: searchClaims,
                  answeredIds: [...searchAnswered] });
              }
              claims = [...claims, ...searchClaims];
              for (const id of searchAnswered) answered.add(id);
            }
          }
          await saveInferences(db, [{ osmRef: venue.ref, criteria, claims,
            answeredCriterionIds: [...answered], searchedCriterionIds: searchedIds,
            observedAt: new Date().toISOString() }]);
          summary.claims += claims.length;
          if (criteria.some((criterion) => !answered.has(criterion.id) &&
              !claims.some((claim) => claim.criterionId === criterion.id)) && !searchedIds.length) {
            fail(enabled("search") ? "search" : "sites");
          }
        }
      } catch {
        failed = true;
        report({ event: "place-error" });
      }
      summary.completed += 1;
      if (failed) summary.failed += 1;
      report({ event: "progress", completed: summary.completed, selected: summary.selected, failed: summary.failed });
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.concurrency, venues.length) }, worker));
  summary.interrupted = signal?.aborted ?? false;
  return summary;
}
