import {
  ATTRIBUTE_LABELS,
  areaById,
  criterionFor,
  type Criterion,
  type SpatialContextResult,
} from "@webmcp-hackathon/contracts";
import { pool } from "../db.ts";
import {
  loadEligibilityInputs,
  classifyAll,
  haversineMeters,
  type CandidateRow,
  type EligibilityInputs,
} from "../eligibility.ts";
import { inScope } from "../facets.ts";
import {
  inferenceTexts,
  loadCached,
  lookupTargetOf,
  publishInferenceChanges,
  readRefinementSource,
  saveInferences,
  stableAttributeHash,
  type Enrichment,
  type LookupPass,
} from "../enrich/index.ts";
import {
  evaluateMatrix,
  MAX_MATRIX_CRITERIA,
  MAX_MATRIX_PLACES,
  type EvaluateMatrixInput,
  type EvaluatedInference,
} from "../enrich/evaluate.ts";
import { INFERABLE_KEYS, inferenceEnabled } from "../enrich/infer.ts";
import { beginLookups, lookupPending } from "../enrich/progress.ts";
import { onPresenceChange, presentIn } from "../presence.ts";
import { createTokenBucket } from "../token-bucket.ts";
import {
  combinedSearch,
  search,
  type SearchResult,
} from "./search.ts";

export const REFINE_BATCH_SIZE = MAX_MATRIX_PLACES;
export const REFINE_IDLE_STOP_MS = positiveInt(
  process.env.REFINE_IDLE_STOP_MS,
  10 * 60_000,
);
export const REFINE_TICK_MS = Number(process.env.REFINE_TICK_MS ?? 1_000);
/** With nothing to refine the loop must not reload every candidate in the
 * room once a second. A need commit wakes it immediately, so a long idle
 * gap costs no responsiveness. */
export const REFINE_IDLE_TICK_MS = Number(
  process.env.REFINE_IDLE_TICK_MS ?? 30 * REFINE_TICK_MS,
);
export const REFINE_MODEL_CALLS_PER_HOUR = positiveInt(
  process.env.REFINE_MODEL_CALLS_PER_HOUR,
  60,
);
export const REFINE_SEARCHES_PER_HOUR = positiveInt(
  process.env.REFINE_SEARCHES_PER_HOUR,
  40,
);
export type RefineSearchMode = "combined" | "split";
export type RefineDomainRule = "domain-first" | "open-web-first";
/** Measured 2026-09-03 over three live twelve-place Berlin runs: the plain
 * query won every run (14 validated claims to the shaped query's 11). Address,
 * category and local-language words narrow the search away from the pages that
 * actually answer, so `plain` is the default and `shaped` stays reachable
 * through REFINE_QUERY_SHAPING for a re-measurement on another area. */
export type RefineQueryShaping = "plain" | "shaped";
export const DEFAULT_REFINE_QUERY_SHAPING: RefineQueryShaping = "plain";

export function refineQueryShaping(
  value = process.env.REFINE_QUERY_SHAPING,
): RefineQueryShaping {
  return value === "shaped" || value === "plain" ? value : DEFAULT_REFINE_QUERY_SHAPING;
}
export const DEFAULT_REFINE_SEARCH_MODE: RefineSearchMode = "split";
export const MAX_REFINE_QUERY_CHARS = 400;
const HOUR_MS = 60 * 60_000;
const STALE_MS = 7 * 24 * 60 * 60_000;
const TEXT_TTL_MS = 10 * 60_000;
const TEXT_CACHE_CAP = 500;

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

const modelBudget = createTokenBucket({
  capacity: REFINE_MODEL_CALLS_PER_HOUR,
  windowMs: HOUR_MS,
});
const searchBudget = createTokenBucket({
  capacity: REFINE_SEARCHES_PER_HOUR,
  windowMs: HOUR_MS,
});

interface TextCacheEntry {
  text: NonNullable<LookupPass["pageText"]>;
  expiresAt: number;
}

/** Process-local only. Values have no persistence, logging or wire path. */
const transientText = new Map<string, TextCacheEntry>();

interface RoomState {
  timer?: ReturnType<typeof setTimeout>;
  idleTimer?: ReturnType<typeof setTimeout>;
  running: boolean;
  stopped: boolean;
  budgetLogged: boolean;
  queued: number;
  criteriaKey: string;
  evaluated: Map<string, Set<string>>;
  providerChecked: Set<string>;
  checkedDay: string;
  checked: Set<string>;
}

const rooms = new Map<string, RoomState>();

export interface RefinementQueueItem {
  candidate: CandidateRow;
  tier: 1 | 2 | 3;
  criteria: Criterion[];
}

interface ActiveCriterion {
  criterion: Criterion;
  visibilities: Set<string>;
}

function modelCriterion(criterion: Criterion): boolean {
  return !(criterion.kind === "key" &&
    (criterion.key === "cuisine" || criterion.key.startsWith("open:")));
}

function refinementEnabled(): boolean {
  return process.env.REFINE !== "0" &&
    process.env.ENRICH_NETWORK !== "0" &&
    inferenceEnabled();
}

function utcDay(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

function stateFor(roomId: string): RoomState {
  let state = rooms.get(roomId);
  if (!state) {
    state = {
      running: false,
      stopped: false,
      budgetLogged: false,
      queued: 0,
      criteriaKey: "",
      evaluated: new Map(),
      providerChecked: new Set(),
      checkedDay: utcDay(),
      checked: new Set(),
    };
    rooms.set(roomId, state);
  }
  if (state.checkedDay !== utcDay()) {
    state.checkedDay = utcDay();
    state.checked.clear();
  }
  return state;
}

function activeCriteria(inputs: EligibilityInputs): Map<string, ActiveCriterion> {
  const result = new Map<string, ActiveCriterion>();
  for (const requirement of inputs.requirements) {
    if (requirement.active === false || requirement.withdrawn) continue;
    const criterion = criterionFor(requirement.payload as never);
    // Agent-private needs carry no payload by design and therefore cannot
    // contribute words to model input, queries or lookup frames.
    if (!criterion) continue;
    const entry = result.get(criterion.id) ?? { criterion, visibilities: new Set<string>() };
    entry.visibilities.add(requirement.visibility);
    result.set(criterion.id, entry);
  }
  return result;
}

function unknown(candidate: CandidateRow, criterion: Criterion): boolean {
  const key = criterion.kind === "key" ? criterion.key : criterion.id;
  return (candidate.attributes.find((attribute) => attribute.key === key)?.status ?? "unknown") ===
    "unknown";
}

function factsAreStale(candidate: CandidateRow, now: number): boolean {
  const observed = candidate.attributes.flatMap((attribute) => {
    const value = (attribute as { observedAt?: unknown }).observedAt;
    const at = typeof value === "string" ? new Date(value).getTime() : Number.NaN;
    return Number.isFinite(at) ? [at] : [];
  });
  return observed.length > 0 && Math.max(...observed) < now - STALE_MS;
}

/** Pure priority shaping apart from the supplied process-local cursor. */
export function buildRefinementQueue(
  inputs: EligibilityInputs,
  state: Pick<RoomState, "evaluated" | "providerChecked">,
  roomId: string,
  now = Date.now(),
): RefinementQueueItem[] {
  const active = activeCriteria(inputs);
  const activeList = [...active.values()].map((entry) => entry.criterion).filter(modelCriterion);
  const activeKeyIds = new Set(
    activeList.flatMap((criterion) => criterion.kind === "key" ? [criterion.key] : []),
  );
  const inactiveVocabulary: Criterion[] = INFERABLE_KEYS
    .filter((key) => !activeKeyIds.has(key))
    .map((key) => ({
      id: key,
      kind: "key" as const,
      key,
      label: ATTRIBUTE_LABELS[key as keyof typeof ATTRIBUTE_LABELS] ?? key,
    }));
  const inScopeIds = new Set(inScope(inputs.candidates, inputs.scope).map((candidate) => candidate.id));
  const classified = new Map(
    classifyAll(inputs.candidates, inputs.requirements, inputs.verdicts, inputs.scope)
      .map((candidate) => [candidate.candidateId, candidate]),
  );
  const distances = new Map(inputs.candidates.map((candidate) => [
    candidate.id,
    inputs.scope?.area?.center
      ? haversineMeters(inputs.scope.area.center, candidate.location)
      : candidate.walk_min * 75,
  ]));
  const queued: RefinementQueueItem[] = [];
  for (const candidate of inputs.candidates) {
    if (!candidate.osm_ref || lookupPending(roomId, candidate.id)) continue;
    const eligibility = classified.get(candidate.id)?.eligibility;
    // The classifier is the authority on decisive active needs. Once a place
    // is already excluded, refining a different gap cannot bring it back.
    if (eligibility === "excluded") continue;
    const done = state.evaluated.get(candidate.id);
    const activeOpen = activeList.filter((criterion) =>
      unknown(candidate, criterion) && !done?.has(criterion.id)
    );
    const inactiveOpen = inactiveVocabulary.filter((criterion) =>
      unknown(candidate, criterion) && !done?.has(criterion.id)
    );
    let tier: RefinementQueueItem["tier"] | null = null;
    let criteria: Criterion[] = [];
    if (
      inScopeIds.has(candidate.id) && eligibility === "uncertain" && activeOpen.length > 0
    ) {
      tier = 1;
      criteria = activeOpen;
    } else if (factsAreStale(candidate, now) && !state.providerChecked.has(candidate.id)) {
      tier = 2;
      criteria = [...activeOpen, ...inactiveOpen];
    } else if (inactiveOpen.length > 0) {
      tier = 3;
      criteria = inactiveOpen;
    }
    if (tier === null) continue;
    queued.push({ candidate, tier, criteria });
  }
  return queued.sort((a, b) =>
    a.tier - b.tier || (distances.get(a.candidate.id) ?? 0) -
      (distances.get(b.candidate.id) ?? 0) ||
    a.candidate.id.localeCompare(b.candidate.id)
  );
}

/** How long the loop waits before its next tick. An empty queue must not
 * reload every candidate in the room once a second; a need commit wakes the
 * loop immediately, so the long gap costs no responsiveness. */
export function refinementTickDelay(queueLength: number): number {
  return queueLength === 0 ? REFINE_IDLE_TICK_MS : REFINE_TICK_MS;
}

function criteriaSignature(inputs: EligibilityInputs): string {
  return [...activeCriteria(inputs).keys()].sort().join("\u0000");
}

function schedule(roomId: string, delay = REFINE_TICK_MS): void {
  const state = rooms.get(roomId);
  if (!state || state.stopped || state.timer) return;
  state.timer = setTimeout(() => {
    state.timer = undefined;
    void drive(roomId);
  }, Math.max(0, delay));
  state.timer.unref?.();
}

async function drive(roomId: string): Promise<void> {
  const state = rooms.get(roomId);
  if (!state || state.stopped || state.running) return;
  state.running = true;
  let delay = REFINE_TICK_MS;
  try {
    delay = await runRefinementTick(roomId);
  } catch (error) {
    console.warn("refinement tick failed:", error instanceof Error ? error.message : String(error));
  } finally {
    state.running = false;
  }
  schedule(roomId, delay);
}

export function startRefinement(roomId: string, scheduleLoop = true): boolean {
  if (!refinementEnabled()) return false;
  const state = stateFor(roomId);
  state.stopped = false;
  if (state.idleTimer) clearTimeout(state.idleTimer);
  state.idleTimer = undefined;
  if (scheduleLoop) schedule(roomId);
  return true;
}

export function stopRefinement(roomId: string): void {
  const state = rooms.get(roomId);
  if (!state) return;
  state.stopped = true;
  if (state.timer) clearTimeout(state.timer);
  if (state.idleTimer) clearTimeout(state.idleTimer);
  state.timer = undefined;
  state.idleTimer = undefined;
  rooms.delete(roomId);
}

export function noteRefinementPresence(roomId: string, present: Set<string>): void {
  if (present.size > 0) {
    startRefinement(roomId);
    return;
  }
  const state = rooms.get(roomId);
  if (!state || state.idleTimer) return;
  state.idleTimer = setTimeout(() => stopRefinement(roomId), REFINE_IDLE_STOP_MS);
  state.idleTimer.unref?.();
}

/** Need commits clear the criterion cursor and pull the next tick forward. */
export function wakeRefinement(roomId: string): void {
  const state = rooms.get(roomId);
  if (!state || state.stopped) return;
  state.criteriaKey = "";
  state.evaluated.clear();
  state.providerChecked.clear();
  if (state.timer) clearTimeout(state.timer);
  state.timer = undefined;
  schedule(roomId, 0);
}

function cachedText(osmRef: string, now: number): TextCacheEntry["text"] | undefined {
  const entry = transientText.get(osmRef);
  if (!entry || entry.expiresAt <= now) {
    transientText.delete(osmRef);
    return undefined;
  }
  transientText.delete(osmRef);
  transientText.set(osmRef, entry);
  return entry.text;
}

function rememberText(osmRef: string, text: TextCacheEntry["text"], now: number): void {
  transientText.delete(osmRef);
  transientText.set(osmRef, { text, expiresAt: now + TEXT_TTL_MS });
  while (transientText.size > TEXT_CACHE_CAP) {
    const oldest = transientText.keys().next().value as string | undefined;
    if (!oldest) break;
    transientText.delete(oldest);
  }
}

function domainOf(website: string | undefined): string | undefined {
  if (!website) return undefined;
  try {
    return new URL(website).hostname.toLowerCase().replace(/^www\./, "") || undefined;
  } catch {
    return undefined;
  }
}

export interface RefinementSearchRequest {
  candidateId: string;
  osmRef: string;
  name: string;
  category: string;
  website?: string;
  address?: string;
  siteTextUsable: boolean;
  /** Every unresolved cell that may be evaluated over returned snippets. */
  criteria: Criterion[];
  /** Shared active need words permitted to leave the server in the search leg. */
  searchCriteria: Criterion[];
}

export interface RefinementSearchResponse extends RefinementSearchRequest {
  source: "domain_search" | "open_web_search";
  results: SearchResult[];
}

export interface RefinementAreaContext {
  city: string;
  label: string;
  countryCode: string;
}

export interface RefinementSearchPolicy {
  domainRule?: RefineDomainRule;
  queryShaping?: RefineQueryShaping;
}

export interface RefinementTickOptions extends RefinementSearchPolicy {
  searchMode?: RefineSearchMode;
  /** Benchmark seam: keep queue membership and order fixed across variants. */
  frozenCandidateIds?: string[];
}

export function refineSearchMode(value = process.env.REFINE_SEARCH_MODE): RefineSearchMode {
  return value === "combined" || value === "split" ? value : DEFAULT_REFINE_SEARCH_MODE;
}

function boundedQuery(parts: string[]): string {
  const query = parts.join(" ").replace(/\s+/g, " ").trim();
  if (query.length <= MAX_REFINE_QUERY_CHARS) return query;
  const prefix = query.slice(0, MAX_REFINE_QUERY_CHARS + 1);
  const boundary = prefix.lastIndexOf(" ");
  return prefix.slice(0, boundary > 0 ? boundary : MAX_REFINE_QUERY_CHARS).trim();
}

/** Query words remain data-derived. Only vocabulary keys receive a small
 * locale lexicon; a person's free-text question is never translated. */
export function buildRefinementQuery(
  request: Pick<RefinementSearchRequest, "name" | "searchCriteria">,
  area: RefinementAreaContext,
  _shaping: RefineQueryShaping = DEFAULT_REFINE_QUERY_SHAPING,
): string {
  // This is the privacy boundary, not query tuning. Search receives only the
  // place identity and words from shared active needs. Address/category,
  // inactive vocabulary and application-private sentences stay server-side.
  return boundedQuery([
    request.name,
    area.city,
    ...request.searchCriteria.map((criterion) => criterion.label),
  ]);
}

/** The venue domain is useful only when this pass could not read useful
 * text from that same site. A missing website has no domain to filter. */
export function refinementSearchDomains(
  request: Pick<RefinementSearchRequest, "website" | "siteTextUsable">,
  rule: RefineDomainRule = "open-web-first",
): string[] | undefined {
  const domain = domainOf(request.website);
  if (!domain) return undefined;
  if (rule === "domain-first" || !request.siteTextUsable) return [domain];
  return undefined;
}

/** One provider call per place, with all of that place's open criteria. */
export async function searchRefinementPlaces(
  requests: RefinementSearchRequest[],
  area: RefinementAreaContext,
  provider = search,
  policy: RefinementSearchPolicy = {},
): Promise<RefinementSearchResponse[]> {
  return Promise.all(requests.filter((request) => request.searchCriteria.length > 0).map(async (request) => {
    const domains = refinementSearchDomains(request, policy.domainRule);
    let results: SearchResult[] = [];
    try {
      results = await provider(
        buildRefinementQuery(request, area, policy.queryShaping ?? refineQueryShaping()),
        domains ? { domains } : undefined,
      );
    } catch {
      results = [];
    }
    return {
      ...request,
      source: domains ? "domain_search" as const : "open_web_search" as const,
      results,
    };
  }));
}

function modelCalls(places: number, criteria: number): number {
  if (places === 0 || criteria === 0) return 0;
  return Math.ceil(places / MAX_MATRIX_PLACES) * Math.ceil(criteria / MAX_MATRIX_CRITERIA);
}

function budgetDelay(roomId: string, calls: number, searches: number, now: number): number {
  const callDelay = modelBudget.remaining(roomId, now) >= calls
    ? 0
    : modelBudget.retryAfterMs(roomId, calls, now);
  const searchDelay = searchBudget.remaining(roomId, now) >= searches
    ? 0
    : searchBudget.retryAfterMs(roomId, searches, now);
  return Math.max(callDelay, searchDelay);
}

function markBudgetPause(roomId: string, state: RoomState): void {
  if (state.budgetLogged) return;
  state.budgetLogged = true;
  console.info(`refinement paused for room ${roomId}: hourly budget exhausted`);
}

async function roomPlace(roomId: string): Promise<RefinementAreaContext> {
  const row = (await pool.query("SELECT area_id FROM rooms WHERE id = $1", [roomId])).rows[0] as
    | { area_id?: string | null }
    | undefined;
  const area = row?.area_id ? areaById(row.area_id) : undefined;
  return {
    city: area?.city ?? "",
    label: area?.label ?? area?.city ?? "",
    countryCode: area?.countryCode ?? "",
  };
}

interface PreparedPlace {
  item: RefinementQueueItem;
  enrichment?: Enrichment;
  siteTextUsable: boolean;
  matrix: EvaluateMatrixInput["places"][number];
}

function usablePageText(text: LookupPass["pageText"] | undefined): boolean {
  return Boolean(text && Object.values(text).some((value) =>
    typeof value === "string" && value.replace(/\s+/g, " ").trim().length >= 12
  ));
}

async function preparePlace(
  item: RefinementQueueItem,
  cached: Map<string, Enrichment>,
  now: number,
): Promise<PreparedPlace> {
  const candidate = item.candidate;
  const target = lookupTargetOf(candidate);
  let enrichment = cached.get(candidate.osm_ref!);
  let text = cachedText(candidate.osm_ref!, now);
  if (!text && target && (target.website || target.wikidata)) {
    const pass = await readRefinementSource(pool, target);
    enrichment = pass.enrichment ?? enrichment;
    if (pass.pageText) {
      text = pass.pageText;
      rememberText(candidate.osm_ref!, pass.pageText, now);
    }
  }
  return {
    item,
    enrichment,
    siteTextUsable: usablePageText(text),
    matrix: {
      candidateId: candidate.id,
      osmRef: candidate.osm_ref!,
      name: candidate.name,
      category: candidate.category,
      cuisine: (() => {
        const value = candidate.attributes.find((attribute) => attribute.key === "cuisine")?.value;
        return typeof value === "string" ? value.split(";").map((part) => part.trim()).filter(Boolean) : [];
      })(),
      texts: inferenceTexts(candidate as never, enrichment, text),
    },
  };
}

function oneReason(
  batch: RefinementQueueItem[],
  active: Map<string, ActiveCriterion>,
): { kind: "refine"; label?: string } {
  if (batch.some((item) => item.tier !== 1)) return { kind: "refine" };
  const ids = new Set(batch.flatMap((item) => item.criteria.map((criterion) => criterion.id)));
  if (ids.size !== 1) return { kind: "refine" };
  const entry = active.get([...ids][0]);
  return entry && [...entry.visibilities].every((visibility) => visibility === "shared")
    ? { kind: "refine", label: entry.criterion.label }
    : { kind: "refine" };
}

/** Public pure wrapper used to pin the shared-only label rule. */
export function refinementLookupReason(
  batch: RefinementQueueItem[],
  inputs: EligibilityInputs,
): { kind: "refine"; label?: string } {
  return oneReason(batch, activeCriteria(inputs));
}

/** Run exactly one batch. The returned delay is used by the live loop and is
 * also observable in deterministic budget tests. */
export async function runRefinementTick(
  roomId: string,
  now = Date.now(),
  options: RefinementTickOptions = {},
): Promise<number> {
  if (!refinementEnabled()) return REFINE_TICK_MS;
  const state = stateFor(roomId);
  const inputs = await loadEligibilityInputs(pool, roomId);
  const signature = criteriaSignature(inputs);
  if (signature !== state.criteriaKey) {
    state.criteriaKey = signature;
    state.evaluated.clear();
    state.providerChecked.clear();
  }
  let queue = buildRefinementQueue(inputs, state, roomId, now);
  if (options.frozenCandidateIds) {
    const byId = new Map(queue.map((item) => [item.candidate.id, item]));
    queue = options.frozenCandidateIds.flatMap((id) => {
      const item = byId.get(id);
      return item ? [item] : [];
    });
  }
  state.queued = queue.length;
  if (queue.length === 0) return refinementTickDelay(0);

  const searchLeft = searchBudget.remaining(roomId, now);
  const batch = queue.slice(0, Math.min(REFINE_BATCH_SIZE, Math.max(1, searchLeft)));
  const criteria = [...new Map(batch.flatMap((item) => item.criteria).map((criterion) => [
    criterion.id,
    criterion,
  ])).values()].filter(modelCriterion);
  const searchMode = options.searchMode ?? refineSearchMode();
  const queryShaping = options.queryShaping ?? refineQueryShaping();
  const firstCalls = modelCalls(batch.length, criteria.length);
  const worstCalls = firstCalls + (searchMode === "combined" ? batch.length : firstCalls);
  const delay = budgetDelay(roomId, worstCalls, criteria.length ? batch.length : 0, now);
  if (delay > 0) {
    markBudgetPause(roomId, state);
    return delay;
  }
  state.budgetLogged = false;

  const endProgress = beginLookups(
    roomId,
    batch.map((item) => item.candidate.id),
    refinementLookupReason(batch, inputs),
  );
  try {
    const refs = batch.map((item) => item.candidate.osm_ref!).filter(Boolean);
    const cached = await loadCached(pool, refs);
    const prepared = await Promise.all(batch.map((item) => preparePlace(item, cached, now)));
    // Cells the model genuinely answered (a claim or an explicit abstention);
    // only those are cached, everything else is re-queued (C3).
    const answeredCells = new Set<string>();
    const collectAnswered = async (batch: { answered: Array<{ candidateId: string; criterionId: string }> }) => {
      for (const cell of batch.answered) answeredCells.add(`${cell.candidateId}\u0000${cell.criterionId}`);
    };
    let firstClaims: EvaluatedInference[] = [];
    if (criteria.length > 0) {
      modelBudget.consume(roomId, firstCalls, now);
      firstClaims = await evaluateMatrix(
        { places: prepared.map((place) => place.matrix), criteria },
        collectAnswered,
      );
    }
    const openByCandidate = new Map(batch.map((item) => [
      item.candidate.id,
      new Map(item.criteria.map((criterion) => [criterion.id, criterion])),
    ]));
    firstClaims = firstClaims.filter((claim) =>
      openByCandidate.get(claim.candidateId)?.has(claim.criterionId)
    );
    const firstCells = new Set(firstClaims.map((claim) => `${claim.candidateId}\u0000${claim.criterionId}`));
    const placeInfo = await roomPlace(roomId);
    const searchRequests: RefinementSearchRequest[] = [];
    const active = activeCriteria(inputs);
    for (const preparedPlace of prepared) {
      const unresolved = preparedPlace.item.criteria.filter((criterion) =>
        modelCriterion(criterion) &&
        !firstCells.has(`${preparedPlace.item.candidate.id}\u0000${criterion.id}`)
      );
      if (unresolved.length === 0) continue;
      const searchCriteria = unresolved.filter((criterion) =>
        active.get(criterion.id)?.visibilities.has("shared") === true
      );
      // A private criterion can be evaluated over text already fetched for a
      // shared search, but it can never cause a search on its own.
      if (searchCriteria.length === 0) continue;
      searchRequests.push({
        candidateId: preparedPlace.item.candidate.id,
        osmRef: preparedPlace.item.candidate.osm_ref!,
        name: preparedPlace.item.candidate.name,
        category: preparedPlace.item.candidate.category,
        website: preparedPlace.item.candidate.extras?.website,
        address: preparedPlace.item.candidate.extras?.address,
        siteTextUsable: preparedPlace.siteTextUsable,
        criteria: unresolved,
        searchCriteria,
      });
    }
    searchBudget.consume(roomId, searchRequests.length, now);
    let searchClaims: EvaluatedInference[] = [];
    if (searchMode === "combined") {
      modelBudget.consume(roomId, searchRequests.length, now);
      searchClaims = (await Promise.all(searchRequests.map(async (request) => {
        const domains = refinementSearchDomains(request, options.domainRule);
        try {
          return await combinedSearch({
            candidateId: request.candidateId,
            osmRef: request.osmRef,
            name: request.name,
            category: request.category,
            query: buildRefinementQuery(request, placeInfo, queryShaping),
            // Combined mode enables web_search in this very call, so private
            // criteria are excluded from both its query and request body.
            criteria: request.searchCriteria,
            source: domains ? "domain_search" : "open_web_search",
            ...(domains ? { domains } : {}),
          });
        } catch {
          return [];
        }
      }))).flat();
    } else {
      const preparedById = new Map(prepared.map((item) => [item.item.candidate.id, item]));
      const searched = (await searchRefinementPlaces(
        searchRequests,
        placeInfo,
        search,
        options,
      )).map((entry) => ({
        ...entry,
        prepared: preparedById.get(entry.candidateId)!,
      }));
      const withSnippets = searched.filter((entry) => entry.results.length > 0);
      if (withSnippets.length > 0) {
        const searchCriteria = [...new Map(withSnippets.flatMap((entry) => entry.criteria).map(
          (criterion) => [criterion.id, criterion],
        )).values()];
        const searchPlaces = withSnippets.map((entry) => ({
          ...entry.prepared.matrix,
          texts: entry.results.map((result) => ({
            source: entry.source,
            text: result.snippet,
            url: result.url,
          })),
        }));
        const secondCalls = modelCalls(searchPlaces.length, searchCriteria.length);
        modelBudget.consume(roomId, secondCalls, now);
        searchClaims = await evaluateMatrix(
          { places: searchPlaces, criteria: searchCriteria },
          collectAnswered,
        );
        const unresolvedByCandidate = new Map(withSnippets.map((entry) => [
          entry.prepared.item.candidate.id,
          new Set(entry.criteria.map((criterion) => criterion.id)),
        ]));
        searchClaims = searchClaims.filter((claim) =>
          unresolvedByCandidate.get(claim.candidateId)?.has(claim.criterionId)
        );
      }
    }

    const claims = [...firstClaims, ...searchClaims];
    const observedAt = new Date(now).toISOString();
    await saveInferences(pool, batch.flatMap((item) => {
      const open = item.criteria.filter(modelCriterion);
      return open.length ? [{
        osmRef: item.candidate.osm_ref!,
        criteria: open,
        claims: claims.filter((claim) => claim.candidateId === item.candidate.id),
        // Cells with a validated claim count as answered; cells the model
        // left open are re-queued by the priority pass, never cached as omitted.
        answeredCriterionIds: open
          .map((criterion) => criterion.id)
          .filter((id) =>
            answeredCells.has(`${item.candidate.id}\u0000${id}`) ||
            claims.some((claim) => claim.candidateId === item.candidate.id && claim.criterionId === id)
          ),
        observedAt,
      }] : [];
    }));

    for (const item of batch) {
      const ids = state.evaluated.get(item.candidate.id) ?? new Set<string>();
      for (const criterion of item.criteria) ids.add(criterion.id);
      state.evaluated.set(item.candidate.id, ids);
      state.providerChecked.add(item.candidate.id);
      if (item.criteria.length > 0) state.checked.add(item.candidate.id);
    }
    state.queued = Math.max(0, queue.length - batch.length);

    const refreshed = await loadEligibilityInputs(pool, roomId);
    const before = new Map(batch.map((item) => [
      item.candidate.id,
      stableAttributeHash(item.candidate.attributes as never),
    ]));
    const changed = refreshed.candidates.flatMap((candidate) =>
      before.has(candidate.id) && before.get(candidate.id) !== stableAttributeHash(candidate.attributes as never)
        ? [candidate.id]
        : []
    );
    await publishInferenceChanges(pool, roomId, changed, "inference");
    // A tick that did work always re-ticks at the working cadence: finishing
    // a tier can open the next one, and only an empty queue may back off.
    return refinementTickDelay(1);
  } finally {
    endProgress();
  }
}

export function refinementView(
  roomId: string,
  inputs?: EligibilityInputs,
  now = Date.now(),
): NonNullable<SpatialContextResult["refine"]> {
  const state = rooms.get(roomId);
  const queued = inputs && state ? buildRefinementQueue(inputs, state, roomId, now).length : state?.queued ?? 0;
  return {
    active: Boolean(state && !state.stopped),
    queued,
    checkedToday: state?.checkedDay === utcDay(now) ? state.checked.size : 0,
    budgetLeft: {
      calls: modelBudget.remaining(roomId, now),
      searches: searchBudget.remaining(roomId, now),
    },
  };
}

/** Test hooks for deterministic timer and budget assertions. */
export function refinementActive(roomId: string): boolean {
  const state = rooms.get(roomId);
  return Boolean(state && !state.stopped);
}

export function exhaustRefinementBudgetsForTest(roomId: string, now: number): void {
  modelBudget.consume(roomId, REFINE_MODEL_CALLS_PER_HOUR, now);
  searchBudget.consume(roomId, REFINE_SEARCHES_PER_HOUR, now);
}

export function refinementBudgetSleepForTest(
  roomId: string,
  calls: number,
  searches: number,
  now: number,
): number {
  const state = stateFor(roomId);
  const delay = budgetDelay(roomId, calls, searches, now);
  if (delay > 0) markBudgetPause(roomId, state);
  return delay;
}

/** Test-only reset for timers, cursors, budgets and transient prose. */
export function resetRefinement(): void {
  for (const roomId of [...rooms.keys()]) stopRefinement(roomId);
  transientText.clear();
  modelBudget.reset();
  searchBudget.reset();
}

// Register once per process. Presence frames and fact frames are separate;
// only socket presence reaches this hook, so fact publication cannot loop.
onPresenceChange(noteRefinementPresence);

/** Compatibility aliases for tests and callers that name the loop itself. */
export const startRefineWorker = startRefinement;
export const stopRefineWorker = stopRefinement;
export const runRefineTick = runRefinementTick;
export const resetRefineWorker = resetRefinement;
