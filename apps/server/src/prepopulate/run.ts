import type pg from "pg";
import {
  ATTRIBUTE_LABELS,
  dossierFromTags,
  normalizeStatus,
  type Criterion,
} from "@webmcp-hackathon/contracts";
import { config } from "../config.ts";
import type { AreaSnapshot, SnapshotVenue } from "../places.ts";
import {
  cachedPageText,
  applyEnrichmentAttributes,
  inferenceTexts,
  loadCached,
  lookupTargetOf,
  persistListingMatches,
  readRefinementSource,
  saveInferences,
  warmCachedImages,
  type AttributeLike,
  type Enrichment,
  type LookupPass,
} from "../enrich/index.ts";
import { INFERABLE_KEYS, inferenceEnabled } from "../enrich/infer.ts";
import {
  evaluateMatrix,
  type EvaluateMatrixInput,
  type EvaluatedInference,
} from "../enrich/evaluate.ts";
import { storeSearchCache } from "../enrich/cache.ts";
import {
  fetchListingsForCandidates,
  listingsEnabled,
  type ListingCandidate,
} from "../enrich/listings.ts";
import { searchRefinementPlaces } from "../refine/worker.ts";
import { search, searchProviderId } from "../refine/search.ts";
import { withModelReservation } from "../admission.ts";
import { withWork } from "../work-context.ts";
import { WorkError } from "../work-outcome.ts";
import { Checkpoints } from "./checkpoints.ts";
import { discoverSources, sourceEnabled } from "../enrich/discovery.ts";
import {
  DINING_CLASSES,
  type PrepopulateOptions,
  type Source,
} from "./options.ts";

export function sourceAvailability(): Record<Source | "models", string | null> {
  const offline = process.env.ENRICH_NETWORK === "0";
  const model = !offline && inferenceEnabled();
  const provider = searchProviderId();
  const searchKey =
    provider === "parallel"
      ? process.env.PARALLEL_API_KEY
      : provider === "tavily"
        ? process.env.TAVILY_API_KEY
        : config.nlEnabled;
  return {
    overture: sourceEnabled("overture")
      ? null
      : "requires an imported regional extract and OVERTURE=1",
    accessibility: sourceEnabled("accessibility")
      ? null
      : "requires ACCESSIBILITY_CLOUD_TOKEN and ACCESSIBILITY_CLOUD_SOURCE_IDS",
    sites: offline ? "ENRICH_NETWORK=0" : null,
    images: offline ? "ENRICH_NETWORK=0" : null,
    listings: listingsEnabled()
      ? null
      : "requires LISTINGS!=0, network and DATAFORSEO_LOGIN/PASSWORD",
    models: model
      ? null
      : "requires inference enabled and a configured model API key",
    search: offline
      ? "ENRICH_NETWORK=0"
      : !searchKey
        ? `missing credentials for ${provider}`
        : !model
          ? "requires inference to validate and persist search evidence"
          : null,
  };
}
function candidateOf(venue: SnapshotVenue, observedAt: string) {
  const dossier = dossierFromTags(venue.tags, observedAt);
  return {
    id: venue.ref,
    osm_ref: venue.ref,
    name: venue.name,
    location: venue.location,
    category: venue.placeClass ?? dossier.category,
    attributes: dossier.attributes.map(normalizeStatus),
    extras: dossier.extras,
  };
}
export function openCriteria(
  attributes: AttributeLike[],
  cached?: Enrichment,
  searchEnabled = false,
): Criterion[] {
  return INFERABLE_KEYS.filter(
    (key) =>
      (attributes.find((a) => a.key === key)?.status ?? "unknown") ===
        "unknown" &&
      (!cached?.inferred?.[key] ||
        (searchEnabled &&
          "omitted" in cached.inferred[key] &&
          !cached.inferred[key].searchDay)),
  ).map((key) => ({ id: key, kind: "key", key, label: ATTRIBUTE_LABELS[key] }));
}
const DINING_CRITERIA = new Set([
  "vegan-options",
  "vegetarian-options",
  "gluten-free-options",
  "halal-options",
  "lactose-free-options",
  "takeaway",
  "delivery",
]);
export function profileCriteria(
  criteria: Criterion[],
  category: string,
  profile: PrepopulateOptions["profile"] = "explore",
) {
  return criteria.filter((c) =>
    profile === "accessibility"
      ? c.id === "wheelchair-accessible"
      : DINING_CLASSES.has(category) || !DINING_CRITERIA.has(c.id),
  );
}
async function mapBounded<T, R>(
  items: T[],
  concurrency: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  let cursor = 0;
  const results: R[] = [];
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (cursor < items.length) {
        const i = cursor++;
        results[i] = await run(items[i]);
      }
    }),
  );
  return results;
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
  runId?: string;
  status?: string;
  deferred?: number;
  retryAt?: string | null;
  accounting?: Record<string, unknown>;
}
type MatrixPlace = EvaluateMatrixInput["places"][number];
interface Ready {
  venue: SnapshotVenue;
  row: ReturnType<typeof candidateOf>;
  place: MatrixPlace;
  criteria: Criterion[];
  pass: LookupPass;
}

export async function runPrepopulation(
  db: pg.Pool,
  options: PrepopulateOptions,
  snapshot: AreaSnapshot,
  venues: SnapshotVenue[],
  report: (event: Record<string, unknown>) => void,
  signal?: AbortSignal,
): Promise<RunSummary> {
  if (options.dryRun)
    throw new Error("Dry runs must not enter the database runner");
  if (process.env.ENRICH_NETWORK === "0")
    throw new Error("Prepopulation is disabled by ENRICH_NETWORK=0");
  const available = sourceAvailability();
  const enabled = (source: Source) =>
    options.sources.includes(source) && available[source] === null;
  if (!options.sources.some(enabled))
    throw new Error("None of the selected sources are available");
  // Resolve required tables and columns before admitting any provider work.
  // LIMIT 0 checks the schema without reading or combining cache contents.
  try {
    await db.query(`SELECT e.discoveries, p.facts, p.links, l.results,
      l.returned_items, l.requests, a.provider_status, a.provider_task_id,
      r.remaining, t.records, o.release
      FROM enrichments e, page_cache p, listing_batches l, provider_attempts a,
        resource_reservations r, source_tiles t, overture_places o LIMIT 0`);
  } catch (error) {
    if (["42P01", "42703"].includes((error as { code?: string }).code ?? ""))
      throw new Error(
        "Apply the server migrations before running prepopulation",
        { cause: error },
      );
    throw error;
  }
  const job = new Checkpoints(db, options, report);
  await job.start(venues.map((v) => v.ref));
  const summary: RunSummary = {
    selected: venues.length,
    completed: 0,
    failed: 0,
    interrupted: false,
    claims: 0,
    searches: 0,
    searchCacheHits: 0,
    listingMatches: 0,
    listingCostUsd: 0,
    sourceErrors: {},
  };
  const sourceError = (source: Source) => {
    summary.sourceErrors[source] = (summary.sourceErrors[source] ?? 0) + 1;
  };
  const badRefs = new Set<string>();
  const stage = async <T>(
    ref: string,
    source: Source,
    run: () => Promise<T>,
  ) => {
    const result = await job.stage(ref, source, run);
    if (result && "failure" in result) {
      sourceError(source);
      badRefs.add(ref);
    }
    return result;
  };
  try {
    await withWork({ workload: "prepopulate", runId: job.id }, async () => {
      if (venues.length && enabled("listings") && !signal?.aborted)
        await stage("@region", "listings", async () => {
          const candidates: ListingCandidate[] = venues.map((v) => {
            const r = candidateOf(v, snapshot.manifest.extract.timestamp);
            return {
              candidateId: v.ref,
              osmRef: v.ref,
              name: v.name,
              location: v.location,
              website: r.extras.website,
              placeClass: r.category,
            };
          });
          const result = await fetchListingsForCandidates(
            candidates,
            { center: options.area.center, radiusM: options.radiusM },
            undefined,
            { db, onPage: (matches) => persistListingMatches(db, matches) },
          );
          summary.listingMatches = result.matches.length;
          summary.listingCostUsd = result.costUsd;
          report({
            event: "listings",
            matched: result.matches.length,
            requests: result.requests,
            costUsd: result.costUsd,
          });
        });
      // Eight ready places, at most `concurrency` fetches. The next buffer is not
      // admitted until evaluation and permitted search evidence have been saved.
      for (
        let offset = 0;
        offset < venues.length && !signal?.aborted && !job.paused;
        offset += 8
      ) {
        const selected = venues.slice(offset, offset + 8);
        const prepared = await mapBounded(
          selected,
          options.concurrency,
          async (venue): Promise<Ready | null> => {
            if (signal?.aborted || job.paused) return null;
            const row = candidateOf(venue, snapshot.manifest.extract.timestamp);
            for (const source of ["overture", "accessibility"] as const)
              if (enabled(source))
                await stage(venue.ref, source, () =>
                  discoverSources(
                    db,
                    [
                      {
                        osmRef: venue.ref,
                        name: row.name,
                        location: venue.location,
                        website: row.extras.website,
                      },
                    ],
                    [source],
                  ),
                );
            let cached = (await loadCached(db, [venue.ref])).get(venue.ref);
            const target = lookupTargetOf(row)!;
            target.countryCode = options.area.countryCode;
            target.website ??=
              cached?.listing?.website ??
              cached?.discoveries?.overture?.website;
            if (target.website) row.extras.website = target.website;
            let pass: LookupPass = { enrichment: cached ?? null };
            if (enabled("sites")) {
              const result = await stage(venue.ref, "sites", async () => {
                const read = await readRefinementSource(
                  db,
                  target,
                  options.area.countryCode,
                );
                if (
                  (target.website &&
                    read.enrichment?.providerStatus?.website.status ===
                      "error") ||
                  (target.wikidata &&
                    read.enrichment?.providerStatus?.wikidata.status ===
                      "error")
                )
                  throw new WorkError({
                    provider: "sites",
                    code: "http",
                    deferred: true,
                    retryAt: new Date(Date.now() + 3600_000).toISOString(),
                  });
                return read;
              });
              if (result && "value" in result) {
                pass = result.value;
                cached = pass.enrichment ?? cached;
              }
            }
            if (!pass.pageText && target.website)
              pass.pageText = await cachedPageText(db, target, cached);
            if (enabled("images"))
              await stage(venue.ref, "images", () =>
                warmCachedImages(db, target, pass),
              );
            const attributes = applyEnrichmentAttributes(
              row.attributes,
              cached,
            );
            const criteria = profileCriteria(
              openCriteria(attributes, cached, enabled("search")),
              row.category,
              options.profile,
            );
            return {
              venue,
              row,
              pass,
              criteria,
              place: {
                candidateId: venue.ref,
                osmRef: venue.ref,
                name: row.name,
                category: row.category,
                website: target.website,
                texts: inferenceTexts(row, cached, pass.pageText),
                cuisine: String(
                  attributes.find((a) => a.key === "cuisine")?.value ?? "",
                )
                  .split(";")
                  .filter(Boolean),
              },
            };
          },
        );
        const ready = prepared.filter((p): p is Ready => Boolean(p));
        if (
          available.models === null &&
          (enabled("sites") || enabled("search")) &&
          !job.paused
        ) {
          const active: Ready[] = [];
          for (const p of ready)
            if (await job.pending(p.venue.ref, "evaluate")) active.push(p);
          if (active.length) {
            let batch: Promise<void> | undefined;
            await Promise.all(
              active
                .map((p) =>
                  job.stage(
                    p.venue.ref,
                    "evaluate",
                    () => (batch ??= evaluateReady(active)),
                  ),
                )
                .map(async (promise) => {
                  const result = await promise;
                  if (result && "failure" in result) {
                    sourceError(enabled("search") ? "search" : "sites");
                  }
                }),
            );
          }
        }
        summary.completed += ready.length;
        summary.failed = badRefs.size;
        report({
          event: "progress",
          completed: summary.completed,
          selected: summary.selected,
          failed: summary.failed,
          paused: job.paused,
        });
      }
    });
  } finally {
    summary.interrupted = signal?.aborted ?? false;
    Object.assign(
      summary,
      await job.finish(summary.interrupted, summary.completed < venues.length),
    );
  }
  return summary;

  async function evaluateReady(ready: Ready[]): Promise<void> {
    const groups = new Map<string, Ready[]>();
    for (const place of ready) {
      const signature = place.criteria
        .map((c) => c.id)
        .sort()
        .join("\0");
      const group = groups.get(signature) ?? [];
      group.push(place);
      groups.set(signature, group);
    }
    if (groups.size > 1) {
      for (const group of groups.values()) await evaluateReady(group);
      return;
    }
    const criteria = [
      ...new Map(
        ready.flatMap((p) => p.criteria).map((c) => [c.id, c]),
      ).values(),
    ];
    if (!criteria.length) return;
    const calls =
      Math.ceil(ready.length / 8) *
        Math.ceil(criteria.length / 5) *
        (enabled("search") ? 2 : 1) +
      (enabled("search") && searchProviderId() === "openai" ? ready.length : 0);
    await withModelReservation(
      calls,
      async () => {
        const localAnswered = new Set<string>();
        const first = await evaluateMatrix(
          { places: ready.map((p) => p.place), criteria },
          async (batch) => {
            for (const c of batch.answered)
              localAnswered.add(`${c.candidateId}\0${c.criterionId}`);
            await saveInferences(
              db,
              ready.map((p) => ({
                osmRef: p.venue.ref,
                criteria: p.criteria,
                claims: batch.claims.filter(
                  (c) =>
                    c.candidateId === p.venue.ref &&
                    p.criteria.some((k) => k.id === c.criterionId),
                ),
                answeredCriterionIds: batch.answered
                  .filter((c) => c.candidateId === p.venue.ref)
                  .map((c) => c.criterionId),
                observedAt: new Date().toISOString(),
              })),
            );
          },
          db,
          "reuse",
          "background",
        );
        summary.claims += first.length;
        if (!enabled("search")) {
          if (
            ready.some((p) =>
              p.criteria.some(
                (c) => !localAnswered.has(`${p.venue.ref}\0${c.id}`),
              ),
            )
          )
            throw new WorkError({
              provider: "model",
              code: "invalid_response",
              deferred: false,
            });
          return;
        }
        if (signal?.aborted)
          throw new WorkError({
            provider: "run",
            code: "interrupted",
            deferred: true,
          });
        const requests = ready.flatMap((p) => {
          const unresolved = p.criteria.filter(
            (c) =>
              !first.some(
                (claim) =>
                  claim.candidateId === p.venue.ref &&
                  claim.criterionId === c.id,
              ),
          );
          return unresolved.length
            ? [
                {
                  candidateId: p.venue.ref,
                  osmRef: p.venue.ref,
                  name: p.row.name,
                  category: p.row.category,
                  website: p.place.website,
                  siteTextUsable: p.place.texts.some(
                    (t) => t.text.length >= 12,
                  ),
                  criteria: unresolved,
                  searchCriteria: unresolved,
                },
              ]
            : [];
        });
        const found = await searchRefinementPlaces(
          requests,
          options.area,
          search,
          { cacheDb: db, providerName: searchProviderId() },
        );
        const successful = found.filter((e) => !("failure" in e.outcome));
        for (const e of successful) {
          if (e.cacheHit) summary.searchCacheHits++;
          else summary.searches++;
        }
        const withText = successful.filter((e) => e.results.length);
        const searchCriteria = [
          ...new Map(
            withText.flatMap((e) => e.criteria).map((c) => [c.id, c]),
          ).values(),
        ];
        const answered = new Map(
          successful.map((e) => [
            e.candidateId,
            new Set(e.cachedAnsweredIds ?? []),
          ]),
        );
        const claims: EvaluatedInference[] = successful.flatMap(
          (e) => e.cachedClaims ?? [],
        );
        if (withText.length)
          claims.push(
            ...(await evaluateMatrix(
              {
                places: withText.map((e) => ({
                  ...ready.find((p) => p.venue.ref === e.osmRef)!.place,
                  texts: e.results.map((r) => ({
                    source: e.source,
                    text: r.snippet,
                    url: r.url,
                    title: r.title,
                  })),
                })),
                criteria: searchCriteria,
              },
              async (batch) => {
                for (const cell of batch.answered)
                  answered.get(cell.candidateId)?.add(cell.criterionId);
                // Save every successful matrix batch before another paid call can fail.
                await saveInferences(
                  db,
                  withText.map((e) => ({
                    osmRef: e.osmRef,
                    criteria: e.criteria,
                    claims: batch.claims.filter(
                      (c) => c.candidateId === e.candidateId,
                    ),
                    answeredCriterionIds: [...answered.get(e.candidateId)!],
                    observedAt: new Date().toISOString(),
                  })),
                );
              },
              db,
              "reuse",
              "background",
            )),
          );
        for (const e of successful) {
          const accepted = claims.filter(
            (c) => c.candidateId === e.candidateId,
          );
          if (
            searchProviderId() === "openai" &&
            !e.cacheHit &&
            (answered.get(e.candidateId)!.size || e.outcome.status === "empty")
          )
            await storeSearchCache(db, {
              osmRef: e.osmRef,
              query: e.cacheQuery!,
              provider: "openai",
              domains: e.cacheDomains,
              claims: accepted,
              answeredIds: [...answered.get(e.candidateId)!],
            });
          await saveInferences(db, [
            {
              osmRef: e.osmRef,
              criteria: e.criteria,
              claims: accepted,
              answeredCriterionIds: [...answered.get(e.candidateId)!],
              searchedCriterionIds: e.criteria
                .filter(
                  (c) =>
                    !e.results.length || answered.get(e.candidateId)?.has(c.id),
                )
                .map((c) => c.id),
              observedAt: new Date().toISOString(),
            },
          ]);
        }
        summary.claims += claims.length;
        if (
          withText.some((e) =>
            e.criteria.some((c) => !answered.get(e.candidateId)?.has(c.id)),
          )
        )
          throw new WorkError({
            provider: "model",
            code: "invalid_response",
            deferred: false,
          });
        const failed = found.find((e) => "failure" in e.outcome);
        if (failed && "failure" in failed.outcome)
          throw new WorkError(failed.outcome.failure);
      },
      db,
    );
  }
}
