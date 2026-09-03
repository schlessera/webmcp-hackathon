import {
  ATTRIBUTE_LABELS,
  areaById,
  criterionFor,
  type Criterion,
  type SpatialContextResult,
} from "@webmcp-hackathon/contracts";
import type pg from "pg";
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
  SEARCH_ATTEMPT_CAP,
  stableAttributeHash,
  type Enrichment,
  type LookupPass,
} from "../enrich/index.ts";
import {
  evaluateMatrix,
  matrixEvidenceHash,
  MAX_MATRIX_CRITERIA,
  MAX_MATRIX_PLACES,
  trimMatrixPlace,
  type EvaluateMatrixInput,
  type EvaluatedInference,
} from "../enrich/evaluate.ts";
import { INFERABLE_KEYS, inferenceEnabled } from "../enrich/infer.ts";
import { loadSearchCache, storeSearchCache } from "../enrich/cache.ts";
import { takeListingSpendUsd } from "../enrich/listings.ts";
import { lookupPending } from "../enrich/progress.ts";
import { onPresenceChange, presentIn } from "../presence.ts";
import { createTokenBucket } from "../token-bucket.ts";
import { responseMetrics } from "../nl/llm.ts";
import { adjudicateLikelyForRoom } from "../enrich/adjudication-runner.ts";
import {
  parallelSearchProvider,
  search,
  SEARCH_PROVIDER_COST_USD,
  searchProviderId,
  type SearchResult,
  type SearchProviderId,
} from "./search.ts";
import type { InteractiveBudget } from "../pipeline/interactive.ts";
import { pipelineScheduler, type DispatchResult } from "../pipeline/scheduler.ts";
import {
  pipelineDedupeKey,
  type PipelineItem,
  type ReadyCell,
} from "../pipeline/queue.ts";
import { MatrixBatcher } from "../pipeline/batcher.ts";

export const REFINE_BATCH_SIZE = MAX_MATRIX_PLACES;
export const REFINE_IDLE_STOP_MS = positiveInt(
  process.env.REFINE_IDLE_STOP_MS,
  10 * 60_000,
);
export const REFINE_TICK_MS = Number(process.env.REFINE_TICK_MS ?? 1_000);
/** With nothing to refine the planner must not reload every candidate in the
 * room once a second. A need commit wakes it immediately, so a long idle
 * gap costs no responsiveness. */
export const REFINE_IDLE_TICK_MS = Number(
  process.env.REFINE_IDLE_TICK_MS ?? 30 * REFINE_TICK_MS,
);
export const REFINE_PLAN_WATCHDOG_MS = positiveInt(
  process.env.REFINE_PLAN_WATCHDOG_MS,
  REFINE_TICK_MS * 120,
);
export const REFINE_PLAN_WIDTH = 32;
/**
 * Per room per hour. The live walk found the old 40 searches gone 16 seconds
 * after the first need in a 343-place room, which is not a budget, it is a
 * stall. Parallel is the default at roughly $0.001 per search, in addition to
 * the OpenRouter usage cost reported for judge calls. A room only works flat
 * out while someone is watching it.
 */
export const REFINE_MODEL_CALLS_PER_HOUR = positiveInt(
  process.env.REFINE_MODEL_CALLS_PER_HOUR,
  200,
);
export const REFINE_SEARCHES_PER_HOUR = positiveInt(
  process.env.REFINE_SEARCHES_PER_HOUR,
  150,
);
export const INTERACTIVE_MODEL_CALLS_PER_HOUR = positiveInt(
  process.env.INTERACTIVE_MODEL_CALLS_PER_HOUR,
  120,
);
export const INTERACTIVE_SEARCHES_PER_HOUR = positiveInt(
  process.env.INTERACTIVE_SEARCHES_PER_HOUR,
  60,
);
export type RefineDomainRule = "domain-first" | "open-web-first";
export const MAX_REFINE_QUERY_CHARS = 400;
const HOUR_MS = 60 * 60_000;
const STALE_MS = 7 * 24 * 60 * 60_000;
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
const interactiveModelBudget = createTokenBucket({
  capacity: INTERACTIVE_MODEL_CALLS_PER_HOUR,
  windowMs: HOUR_MS,
});
const interactiveSearchBudget = createTokenBucket({
  capacity: INTERACTIVE_SEARCHES_PER_HOUR,
  windowMs: HOUR_MS,
});

interface RoomState {
  timer?: ReturnType<typeof setTimeout>;
  idleTimer?: ReturnType<typeof setTimeout>;
  /** A wake that arrived while this room's planner was inside an await. */
  pendingWake: boolean;
  /** Invalidates settle callbacks from older watchdog generations. */
  planGeneration: number;
  /** Bumped by every wake. A batch that finishes after its epoch moved must not
   * write its cursor back: the need it was working from has since changed. */
  cursorEpoch: number;
  stopped: boolean;
  budgetLogged: boolean;
  paused: "budget" | null;
  /** Every tier, for logs only. Never the number the client renders. */
  backlog: number;
  queued: number;
  tier1Queued: number;
  evaluated: Map<string, Set<string>>;
  providerChecked: Set<string>;
  checkedDay: string;
  checked: Set<string>;
  calls: number;
  searches: number;
  costUsd: number;
}

const rooms = new Map<string, RoomState>();
const pipelinePlanning = new Set<string>();
let pipelinePlanWorkForTest: ((roomId: string) => Promise<void>) | undefined;
const pipelineLatestPlans = new Map<string, {
  epoch: number;
  items: Map<string, RefinementQueueItem>;
  priorities: Map<string, PipelineItem["priority"]>;
  activeIds: Set<string>;
}>();

export interface RefinementQueueItem {
  candidate: CandidateRow;
  tier: 1 | 2 | 3;
  criteria: Criterion[];
}

export function refinementQueueCounts(queue: RefinementQueueItem[]): {
  total: number;
  tier1: number;
} {
  return {
    total: queue.length,
    tier1: queue.filter((item) => item.tier === 1).length,
  };
}

interface ActiveCriterion {
  criterion: Criterion;
  visibilities: Set<string>;
}

/**
 * May this criterion's words leave the server in a search query?
 *
 * Two different rules, because two different things are at stake. A criterion
 * that belongs to an ACTIVE need is governed by the privacy rule: only a
 * shared need's words go out, because a search would otherwise reveal both the
 * words of a private need and the fact that this room is asking. A criterion
 * that belongs to no active need is background sweeping: the planner walks the
 * whole vocabulary over every place regardless of what anyone wants, so its
 * label is server vocabulary and the query is evidence of nobody's need.
 *
 * Only `ATTRIBUTE_LABELS` counts as vocabulary. A question criterion carries a
 * person's own sentence, so it can only ever travel as an active shared need.
 */
export function searchableCriterion(
  criterion: Criterion,
  active: Map<string, ActiveCriterion>,
): boolean {
  const need = active.get(criterion.id);
  if (need) return need.visibilities.has("shared");
  return criterion.kind === "key" &&
    Object.prototype.hasOwnProperty.call(ATTRIBUTE_LABELS, criterion.key);
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
      pendingWake: false,
      planGeneration: 0,
      cursorEpoch: 0,
      stopped: false,
      budgetLogged: false,
      paused: null,
      backlog: 0,
      queued: 0,
      tier1Queued: 0,
      evaluated: new Map(),
      providerChecked: new Set(),
      checkedDay: utcDay(),
      checked: new Set(),
      calls: 0,
      searches: 0,
      costUsd: 0,
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

function unknown(
  inputs: EligibilityInputs,
  candidate: CandidateRow,
  criterion: Criterion,
  now: number,
): boolean {
  const key = criterion.kind === "key" ? criterion.key : criterion.id;
  if ((candidate.attributes.find((attribute) => attribute.key === key)?.status ?? "unknown") !==
    "unknown") return false;
  const stored = candidate.osm_ref
    ? inputs.enrichments?.get(candidate.osm_ref)?.inferred?.[criterion.id]
    : undefined;
  return !(
    stored &&
    "omitted" in stored &&
    stored.searchDay === utcDay(now) &&
    (stored.searchAttempts ?? 0) >= SEARCH_ATTEMPT_CAP
  );
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
/** Set by `buildRefinementQueue` when it skipped a place only because that
 * place already had a lookup in flight. An empty queue for that reason is
 * busy, not idle, and must not trigger the long backoff. */
let lastQueueDeferred = false;

export function refinementQueueDeferred(): boolean {
  return lastQueueDeferred;
}

export function buildRefinementQueue(
  inputs: EligibilityInputs,
  state: Pick<RoomState, "evaluated" | "providerChecked">,
  roomId: string,
  now = Date.now(),
): RefinementQueueItem[] {
  lastQueueDeferred = false;
  const { activeList, inactiveVocabulary } = refinementCriterionSets(inputs);
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
    if (!candidate.osm_ref) continue;
    if (!inScopeIds.has(candidate.id)) continue;
    if (lookupPending(roomId, candidate.id)) {
      lastQueueDeferred = true;
      continue;
    }
    const eligibility = classified.get(candidate.id)?.eligibility;
    // The classifier is the authority on decisive active needs. Once a place
    // is already excluded, refining a different gap cannot bring it back.
    if (eligibility === "excluded") continue;
    const done = state.evaluated.get(candidate.id);
    const activeOpen = activeList.filter((criterion) =>
      unknown(inputs, candidate, criterion, now) && !done?.has(criterion.id)
    );
    const inactiveOpen = inactiveVocabulary.filter((criterion) =>
      unknown(inputs, candidate, criterion, now) && !done?.has(criterion.id)
    );
    let tier: RefinementQueueItem["tier"] | null = null;
    let criteria: Criterion[] = [];
    if (
      eligibility === "uncertain" && activeOpen.length > 0
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

function refinementCriterionSets(inputs: EligibilityInputs): {
  activeList: Criterion[];
  inactiveVocabulary: Criterion[];
} {
  const activeList = [...activeCriteria(inputs).values()]
    .map((entry) => entry.criterion)
    .filter(modelCriterion);
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
  return { activeList, inactiveVocabulary };
}

function refinementScopeNeeds(
  inputs: EligibilityInputs,
  state: Pick<RoomState, "evaluated">,
  now = Date.now(),
): { inScopeIds: Set<string>; openCandidateIds: Set<string> } {
  const inScopeIds = new Set(inScope(inputs.candidates, inputs.scope).map((candidate) => candidate.id));
  const { activeList, inactiveVocabulary } = refinementCriterionSets(inputs);
  const criteria = [...activeList, ...inactiveVocabulary];
  const openCandidateIds = new Set<string>();
  for (const candidate of inputs.candidates) {
    const done = state.evaluated.get(candidate.id);
    if (candidate.osm_ref && criteria.some((criterion) =>
      unknown(inputs, candidate, criterion, now) && !done?.has(criterion.id)
    )) openCandidateIds.add(candidate.id);
  }
  return { inScopeIds, openCandidateIds };
}

/** How long the planner waits before rebuilding a room. An empty queue must not
 * reload every candidate in the room once a second; a need commit wakes the
 * planner immediately, so the long gap costs no responsiveness. */
export function refinementPlanDelay(queueLength: number): number {
  return queueLength === 0 ? REFINE_IDLE_TICK_MS : REFINE_TICK_MS;
}

export function startRefinement(roomId: string, scheduleLoop = true): boolean {
  if (!refinementEnabled()) return false;
  const alreadyActive = refinementActive(roomId);
  const state = stateFor(roomId);
  state.stopped = false;
  if (state.idleTimer) clearTimeout(state.idleTimer);
  state.idleTimer = undefined;
  if (scheduleLoop) schedulePipelinePlan(roomId);
  if (!alreadyActive) {
    console.info(JSON.stringify({ msg: "pipeline loop started", roomId }));
  }
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
  pipelineLatestPlans.delete(roomId);
  console.info(JSON.stringify({ msg: "pipeline loop stopped", roomId }));
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

/** Need commits clear the criterion cursor and rebuild the plan immediately. */
export function wakeRefinement(roomId: string): void {
  const state = rooms.get(roomId);
  if (!state || state.stopped) return;
  state.cursorEpoch += 1;
  state.planGeneration += 1;
  cancelStalePipelineCells(roomId, state.cursorEpoch);
  // Forget the cursor for need-shaped cells so the changed need is re-queued,
  // but keep the background vocabulary sweep's progress. Restarting the sweep
  // on every toggle would re-buy the whole pool's vocabulary work every time
  // somebody flicks a need in the brief.
  for (const [candidateId, ids] of state.evaluated) {
    for (const id of [...ids]) {
      if (!Object.prototype.hasOwnProperty.call(ATTRIBUTE_LABELS, id)) ids.delete(id);
    }
    if (ids.size === 0) state.evaluated.delete(candidateId);
  }
  state.providerChecked.clear();
  if (state.timer) clearTimeout(state.timer);
  state.timer = undefined;
  if (pipelinePlanning.has(roomId)) state.pendingWake = true;
  schedulePipelinePlan(roomId);
}

/** Plan each place independently and submit its stages to the scheduler. */
function schedulePipelinePlan(roomId: string, delay = 0): void {
  const state = rooms.get(roomId);
  if (!state || state.stopped || state.timer || pipelinePlanning.has(roomId)) return;
  state.timer = setTimeout(() => {
    state.timer = undefined;
    void planPipelineRoom(roomId);
  }, Math.max(0, delay));
  state.timer.unref?.();
}

async function planPipelineRoom(roomId: string): Promise<void> {
  const state = rooms.get(roomId);
  if (!state || state.stopped || pipelinePlanning.has(roomId)) return;
  pipelinePlanning.add(roomId);
  const generation = ++state.planGeneration;
  try {
    if (pipelinePlanWorkForTest) {
      await pipelinePlanWorkForTest(roomId);
      return;
    }
    let inputs = await loadEligibilityInputs(pool, roomId);
    const proactive = await adjudicateLikelyForRoom(pool, roomId, {
      mode: "proactive",
      inputs,
      consumeModelCall: consumeRefinementModelCall,
    });
    if (proactive.changed.length > 0) inputs = await loadEligibilityInputs(pool, roomId);
    const activeIds = new Set(activeCriteria(inputs).keys());
    pipelineScheduler.needsChanged(roomId, state.cursorEpoch, activeIds);
    const queue = buildRefinementQueue(inputs, state, roomId);
    const { inScopeIds, openCandidateIds } = refinementScopeNeeds(inputs, state);
    const counts = refinementQueueCounts(queue);
    state.queued = counts.tier1;
    state.tier1Queued = counts.tier1;
    state.backlog = counts.total;
    pipelineScheduler.volume.pause(roomId, state.paused);
    pipelineScheduler.dropQueued(roomId, (item) =>
      item.intent === "background" && item.kind !== "process.judge" &&
      item.plannerOwned === true &&
      (!inScopeIds.has(item.candidateId) || !openCandidateIds.has(item.candidateId))
    );
    if (queue.length === 0) {
      pipelineLatestPlans.set(roomId, {
        epoch: state.cursorEpoch,
        items: new Map(),
        priorities: new Map(),
        activeIds,
      });
      pipelineScheduler.frames.changed(roomId);
      const delay = refinementQueueDeferred() ? REFINE_TICK_MS : refinementPlanDelay(0);
      queueMicrotask(() => {
        if (rooms.get(roomId) === state && state.planGeneration === generation) {
          schedulePipelinePlan(roomId, delay);
        }
      });
      return;
    }
    const priorities = new Map<string, PipelineItem["priority"]>(queue.map((planned) => [
      planned.candidate.id,
      planned.tier,
    ]));
    const ranking = new Map<string, PipelineItem["priority"]>(queue.map((planned) => [
      pipelineDedupeKey({
        kind: "fetch.site",
        osmRef: planned.candidate.osm_ref!,
        criteria: [],
        intent: "background",
      }),
      planned.tier,
    ]));
    pipelineLatestPlans.set(roomId, {
      epoch: state.cursorEpoch,
      items: new Map(queue.map((entry) => [entry.candidate.id, entry])),
      priorities,
      activeIds,
    });
    pipelineScheduler.reprioritise(roomId, ranking, (item) => item.plannerOwned === true);
    const plannedNow = queue.slice(0, REFINE_PLAN_WIDTH);
    const placeInfo = await roomPlace(roomId);
    const cached = await loadCached(
      pool,
      plannedNow.map((item) => item.candidate.osm_ref!).filter(Boolean),
    );
    const promises = plannedNow.flatMap((planned) => {
      const website = planned.candidate.extras?.website;
      let host: string | undefined;
      try {
        host = website ? new URL(website).hostname.toLowerCase() : undefined;
      } catch {
        host = undefined;
      }
      const base = {
        roomId,
        candidateId: planned.candidate.id,
        osmRef: planned.candidate.osm_ref!,
        kind: "fetch.site" as const,
        // Site evidence is criterion-independent. Keeping this empty makes a
        // need change join the queued/in-flight read instead of buying it a
        // second time; the completion is rematched through `pipelineLatestPlans`.
        criteria: [],
        priority: priorities.get(planned.candidate.id) ?? planned.tier,
        intent: "background" as const,
        plannerOwned: true,
        ...(host ? { host, purpose: "venue-site" as const } : {}),
        needsEpoch: state.cursorEpoch,
        enqueuedAt: Date.now(),
      };
      const item = { ...base, dedupeKey: pipelineDedupeKey(base) };
      if (pipelineScheduler.queue.has(item.dedupeKey)) return [];
      const reason = refinementLookupReason([planned], inputs);
      const promise = pipelineScheduler.enqueue<PreparedPlace>(
        item,
        async (route, _attempt, signal): Promise<DispatchResult<PreparedPlace>> => ({
          value: await preparePlace(
            planned,
            cached,
            placeInfo.countryCode,
            "background",
            route,
            signal,
          ),
          actualRoute: route ?? "direct",
        }),
        {
          present: presentIn(roomId).size > 0,
          reason: { ...reason, ...(reason.label ? { visibility: "shared" as const } : {}) },
        },
      ).then((prepared) => {
        const latest = pipelineLatestPlans.get(roomId);
        const rematched = latest?.items.get(planned.candidate.id);
        if (!latest || !rematched) {
          return REFINE_TICK_MS;
        }
        return queuePreparedForJudging(
          roomId,
          { ...prepared, item: rematched },
          latest.priorities.get(rematched.candidate.id) ?? rematched.tier,
          latest.epoch,
          latest.activeIds,
          { ...reason, ...(reason.label ? { visibility: "shared" as const } : {}) },
        );
      });
      return [promise];
    });
    void refinementPlanSettled(promises).then((delay) => {
      if (rooms.get(roomId) === state && state.planGeneration === generation) {
        schedulePipelinePlan(roomId, delay);
      }
    });
  } catch (error) {
    console.warn("pipeline planning failed:", error instanceof Error ? error.message : String(error));
    queueMicrotask(() => schedulePipelinePlan(roomId, REFINE_TICK_MS));
  } finally {
    pipelinePlanning.delete(roomId);
    if (rooms.get(roomId) === state && !state.stopped && state.pendingWake) {
      state.pendingWake = false;
      schedulePipelinePlan(roomId);
    }
    logPipelineTick(roomId, state);
  }
}

export function refinementPlanSettled(
  promises: Promise<number>[],
  watchdogMs = REFINE_PLAN_WATCHDOG_MS,
): Promise<number> {
  return new Promise((resolve) => {
    let finished = false;
    const finish = (delay: number) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(delay);
    };
    const timer = setTimeout(() => finish(REFINE_TICK_MS), Math.max(1, watchdogMs));
    timer.unref?.();
    void Promise.allSettled(promises).then((results) => finish(Math.max(
      REFINE_TICK_MS,
      ...results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []),
    )));
  });
}

function logPipelineTick(roomId: string, state: RoomState): void {
  const frame = pipelineScheduler.frames.currentPipeline(roomId);
  console.info(JSON.stringify({
    msg: "pipeline tick",
    roomId,
    pools: pipelineScheduler.accounting().inFlight,
    outstanding: frame.outstanding,
    inFlight: frame.inFlight,
    done: frame.done,
    calls: state.calls,
    searches: state.searches,
    costUsd: Number(state.costUsd.toFixed(4)),
  }));
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
  /** True when this response replayed the seven-day provider cache. */
  cacheHit?: boolean;
  cachedClaims?: EvaluatedInference[];
  cachedAnsweredIds?: string[];
  cacheQuery?: string;
  cacheDomains?: string[];
}

export interface RefinementAreaContext {
  city: string;
  label: string;
  countryCode: string;
}

export interface RefinementSearchPolicy {
  domainRule?: RefineDomainRule;
  cacheDb?: Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query">;
  providerName?: SearchProviderId;
  /** Parallel output is licensed to one room, so its cache key requires this. */
  roomId?: string;
  /** A focused open may be superseded while queued or between legs. */
  signal?: AbortSignal;
  /** Scheduler context for the room plan that owns this search. */
  pipeline?: {
    roomId: string;
    needsEpoch: number;
    priority?: PipelineItem["priority"];
    intent?: PipelineItem["intent"];
  };
}

export interface RefinementTickOptions extends RefinementSearchPolicy {
  /** Benchmark seam: keep queue membership and order fixed across variants. */
  frozenCandidateIds?: string[];
}

export interface RefinementBatchOptions extends RefinementSearchPolicy {}

function boundedQuery(parts: string[]): string {
  const query = parts.join(" ").replace(/\s+/g, " ").trim();
  if (query.length <= MAX_REFINE_QUERY_CHARS) return query;
  const prefix = query.slice(0, MAX_REFINE_QUERY_CHARS + 1);
  const boundary = prefix.lastIndexOf(" ");
  return prefix.slice(0, boundary > 0 ? boundary : MAX_REFINE_QUERY_CHARS).trim();
}

/**
 * The query is a privacy boundary, not a tuning knob. There used to be a
 * second, richer shaper behind REFINE_QUERY_SHAPING, carrying the street
 * address, the category and a German lexicon. The privacy ruling forbids
 * every one of those words leaving the server, so the two shapers had become
 * the same function and the knob only lied about it. It is gone. Measurement
 * for the record: over three live twelve-place Berlin runs the plain query
 * won every one, 14 validated claims to the richer query's 11.
 */
export function buildRefinementQuery(
  request: Pick<RefinementSearchRequest, "name" | "searchCriteria">,
  area: RefinementAreaContext,
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
  const wanted = requests.filter((request) => request.searchCriteria.length > 0);
  const one = async (
    request: RefinementSearchRequest,
    signal?: AbortSignal,
  ): Promise<RefinementSearchResponse> => {
    const domains = refinementSearchDomains(request, policy.domainRule);
    const query = buildRefinementQuery(request, area);
    const providerName = policy.providerName ?? searchProviderId();
    if (policy.cacheDb) {
      const cached = await loadSearchCache(
        policy.cacheDb,
        request.osmRef,
        query,
        providerName,
        domains,
        policy.roomId,
      ).catch(() => null);
      if (cached?.snippets || cached?.claims || cached?.answeredIds) {
        return {
          ...request,
          source: domains ? "domain_search" as const : "open_web_search" as const,
          results: cached.snippets ?? [],
          cacheHit: true,
          ...(cached.claims ? { cachedClaims: cached.claims.map((claim) => ({
            ...claim,
            candidateId: request.candidateId,
            osmRef: request.osmRef,
          })) } : {}),
          ...(cached.answeredIds ? { cachedAnsweredIds: cached.answeredIds } : {}),
          cacheQuery: query,
          ...(domains ? { cacheDomains: domains } : {}),
        };
      }
    }
    let results: SearchResult[] = [];
    try {
      results = await provider(query, domains || signal
        ? { ...(domains ? { domains } : {}), ...(signal ? { signal } : {}) }
        : undefined);
    } catch {
      results = [];
    }
    if (policy.cacheDb && (providerName === "tavily" || providerName === "parallel")) {
      await storeSearchCache(policy.cacheDb, {
        osmRef: request.osmRef,
        query,
        provider: providerName,
        ...(policy.roomId ? { roomId: policy.roomId } : {}),
        ...(domains ? { domains } : {}),
        snippets: results,
      }).catch(() => undefined);
    }
    return {
      ...request,
      source: domains ? "domain_search" as const : "open_web_search" as const,
      results,
      cacheQuery: query,
      ...(domains ? { cacheDomains: domains } : {}),
    };
  };
  if (!policy.pipeline) return Promise.all(wanted.map((request) => one(request)));
  const scheduled = wanted.map((request) => {
    const base = {
      roomId: policy.pipeline!.roomId,
      candidateId: request.candidateId,
      osmRef: request.osmRef,
      kind: "fetch.search" as const,
      // The item carries every open cell. Only searchCriteria reaches the
      // query builder; private cells therefore remain useful for returned
      // snippets without contributing a byte of query text.
      criteria: request.criteria,
      priority: policy.pipeline!.priority ?? 1,
      intent: policy.pipeline!.intent ?? "background" as const,
      needsEpoch: policy.pipeline!.needsEpoch,
      enqueuedAt: Date.now(),
    };
    const item = { ...base, dedupeKey: pipelineDedupeKey(base) };
    return pipelineScheduler.enqueue(
      item,
      async (_route, _attempt, deadlineSignal): Promise<DispatchResult<RefinementSearchResponse>> => ({
        value: await one(
          request,
          policy.signal && deadlineSignal
            ? AbortSignal.any([policy.signal, deadlineSignal])
            : policy.signal ?? deadlineSignal,
        ),
        actualRoute: "direct",
      }),
      { present: presentIn(policy.pipeline!.roomId).size > 0 },
    );
  });
  return new Promise<RefinementSearchResponse[]>((resolve, reject) => {
    if (scheduled.length === 0) {
      resolve([]);
      return;
    }
    const results: RefinementSearchResponse[] = new Array(scheduled.length);
    let remaining = scheduled.length;
    scheduled.forEach((job, index) => {
      void job.then((result) => {
        results[index] = result;
        remaining -= 1;
        if (remaining === 0) resolve(results);
      }, reject);
    });
  });
}

/** The single Parallel-turbo search permitted after an interactive site pass. */
export async function searchInteractiveCandidate(
  roomId: string,
  candidateId: string,
  budget: InteractiveBudget,
  signal?: AbortSignal,
  onSearch?: () => void,
): Promise<{
  searched: boolean;
  paidSearch: boolean;
  modelCall: boolean;
  budgetRefused: boolean;
  changed: string[];
}> {
  const empty = { searched: false, paidSearch: false, modelCall: false, budgetRefused: false, changed: [] };
  if (signal?.aborted) return empty;
  const inputs = await loadEligibilityInputs(pool, roomId);
  if (signal?.aborted) return empty;
  const candidate = inputs.candidates.find((entry) => entry.id === candidateId);
  if (!candidate?.osm_ref) return empty;
  const active = activeCriteria(inputs);
  const unresolved = [...active.values()]
    .map((entry) => entry.criterion)
    .filter(modelCriterion)
    .filter((criterion) => unknown(inputs, candidate, criterion, Date.now()));
  if (unresolved.length > MAX_MATRIX_CRITERIA) wakeRefinement(roomId);
  const interactiveCriteria = unresolved.slice(0, MAX_MATRIX_CRITERIA);
  const searchCriteria = interactiveCriteria.filter((criterion) => searchableCriterion(criterion, active));
  if (searchCriteria.length === 0) return empty;
  if (!process.env.PARALLEL_API_KEY) {
    wakeRefinement(roomId);
    return empty;
  }
  if (!budget.take("search")) {
    wakeRefinement(roomId);
    return empty;
  }
  if (signal?.aborted) return empty;
  if (!interactiveSearchBudget.consume(roomId, 1, Date.now())) {
    wakeRefinement(roomId);
    return { ...empty, budgetRefused: true };
  }
  const area = await roomPlace(roomId);
  const request: RefinementSearchRequest = {
    candidateId,
    osmRef: candidate.osm_ref,
    name: candidate.name,
    category: candidate.category,
    website: candidate.extras?.website,
    address: candidate.extras?.address,
    siteTextUsable: false,
    criteria: interactiveCriteria,
    searchCriteria,
  };
  onSearch?.();
  const [found] = await searchRefinementPlaces([request], area, parallelSearchProvider.search, {
    cacheDb: pool,
    providerName: "parallel",
    roomId,
    signal,
    pipeline: { roomId, needsEpoch: stateFor(roomId).cursorEpoch, priority: 0, intent: "interactive" },
  });
  const paidSearch = Boolean(process.env.PARALLEL_API_KEY && found && !found.cacheHit);
  if (signal?.aborted) return { ...empty, searched: true, paidSearch };
  if (!found || found.results.length === 0) {
    return { ...empty, searched: true, paidSearch };
  }
  if (!budget.take("model")) {
    wakeRefinement(roomId);
    return { ...empty, searched: true, paidSearch };
  }
  if (signal?.aborted) return { ...empty, searched: true, paidSearch };
  if (!interactiveModelBudget.consume(roomId, 1, Date.now())) {
    wakeRefinement(roomId);
    return { ...empty, searched: true, paidSearch, budgetRefused: true };
  }
  const place = {
    candidateId,
    osmRef: candidate.osm_ref,
    name: candidate.name,
    category: candidate.category,
    cuisine: [],
    texts: found.results.map((result) => ({
      source: found.source,
      text: result.snippet,
      url: result.url,
      title: result.title,
    })),
  } satisfies EvaluateMatrixInput["places"][number];
  const before = stableAttributeHash(candidate.attributes as never);
  const answered = new Set<string>();
  const base = {
    roomId,
    candidateId,
    osmRef: candidate.osm_ref,
    kind: "process.judge" as const,
    criteria: interactiveCriteria,
    priority: 0 as const,
    intent: "interactive" as const,
    evidenceHash: matrixEvidenceHash(place),
    needsEpoch: stateFor(roomId).cursorEpoch,
    enqueuedAt: Date.now(),
  };
  const claims = await pipelineScheduler.enqueue(
    { ...base, dedupeKey: pipelineDedupeKey(base) },
    async () => ({
      value: await evaluateMatrix(
        { places: [place], criteria: interactiveCriteria },
        async (batch) => {
          for (const cell of batch.answered) answered.add(cell.criterionId);
        },
        pool,
        "refresh",
        "interactive",
      ),
      actualRoute: "direct",
    }),
    { present: presentIn(roomId).size > 0, reason: { kind: "place" } },
  );
  await saveInferences(pool, [{
    osmRef: candidate.osm_ref,
    criteria: interactiveCriteria,
    claims,
    answeredCriterionIds: [...answered],
    searchedCriterionIds: searchCriteria.map((criterion) => criterion.id),
    observedAt: new Date().toISOString(),
  }]);
  const refreshed = await loadEligibilityInputs(pool, roomId);
  const updated = refreshed.candidates.find((entry) => entry.id === candidateId);
  const changed = updated && stableAttributeHash(updated.attributes as never) !== before ? [candidateId] : [];
  await publishInferenceChanges(pool, roomId, changed, "interactive", "web");
  return { searched: true, paidSearch, modelCall: true, budgetRefused: false, changed };
}

function modelCalls(places: number, criteria: number): number {
  if (places === 0 || criteria === 0) return 0;
  return Math.ceil(places / MAX_MATRIX_PLACES) * Math.ceil(criteria / MAX_MATRIX_CRITERIA);
}

function markBudgetPause(roomId: string, state: RoomState): void {
  state.paused = "budget";
  if (state.budgetLogged) return;
  state.budgetLogged = true;
  console.info(
    `refinement paused for room ${roomId}: hourly model-call budget exhausted`,
  );
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

type PipelineReason = {
  kind: "refine";
  label?: string;
  visibility?: "shared" | "application-private" | "agent-private";
};

interface PipelineCellCompletion {
  remaining: number;
  settled: boolean;
  delay: number;
  resolve(value: number): void;
  reject(error: unknown): void;
}

interface PipelineReadyValue {
  prepared: PreparedPlace;
  item: PipelineItem;
  needsEpoch: number;
  reason: PipelineReason;
  completion: PipelineCellCompletion;
}

function finishPipelineCell(
  value: PipelineReadyValue,
  error?: unknown,
  delay = REFINE_TICK_MS,
): void {
  if (value.completion.settled) return;
  if (error !== undefined) {
    value.completion.settled = true;
    value.completion.reject(error);
    return;
  }
  value.completion.delay = Math.max(value.completion.delay, delay);
  value.completion.remaining -= 1;
  if (value.completion.remaining <= 0) {
    value.completion.settled = true;
    value.completion.resolve(value.completion.delay);
  }
}

function queuePreparedForJudging(
  roomId: string,
  prepared: PreparedPlace,
  priority: PipelineItem["priority"],
  needsEpoch: number,
  activeIds: Set<string>,
  reason: PipelineReason,
): Promise<number> {
  // A fetch that crossed a need change is still useful: its page text is now
  // in the page cache/transient evidence map. The next plan rematches it to
  // the new criteria instead of running stale judge cells.
  const room = rooms.get(roomId);
  if (!room || room.cursorEpoch !== needsEpoch) return Promise.resolve(REFINE_TICK_MS);

  const criteria = prepared.item.criteria.filter(modelCriterion);
  if (criteria.length === 0) return Promise.resolve(REFINE_TICK_MS);
  const bytes = Buffer.byteLength(JSON.stringify(prepared.matrix), "utf8");
  if (
    bytes > pipelineScheduler.ready.roomCap ||
    bytes > pipelineScheduler.ready.globalCap
  ) {
    const evaluated = room.evaluated.get(prepared.item.candidate.id) ?? new Set<string>();
    for (const criterion of criteria) evaluated.add(criterion.id);
    room.evaluated.set(prepared.item.candidate.id, evaluated);
    console.warn(JSON.stringify({
      msg: "pipeline place dropped",
      roomId,
      candidateId: prepared.item.candidate.id,
      reason: "ready-buffer-place-too-large",
      bytes,
    }));
    return Promise.resolve(REFINE_TICK_MS);
  }
  return new Promise<number>((resolve, reject) => {
    const completion: PipelineCellCompletion = {
      remaining: criteria.length,
      settled: false,
      delay: REFINE_TICK_MS,
      resolve,
      reject,
    };
    const evidenceHash = matrixEvidenceHash(prepared.matrix);
    const cells = criteria.map((criterion): ReadyCell<PipelineReadyValue> => {
      const base = {
        roomId,
        candidateId: prepared.item.candidate.id,
        osmRef: prepared.item.candidate.osm_ref!,
        kind: "process.judge" as const,
        criteria: [criterion],
        priority,
        intent: "background" as const,
        evidenceHash,
        predictedPool: "llm-matrix" as const,
        sweep: !activeIds.has(criterion.id),
        needsEpoch,
        enqueuedAt: Date.now(),
      };
      const processItem: PipelineItem = {
        ...base,
        dedupeKey: pipelineDedupeKey(base),
      };
      return {
        roomId,
        candidateId: processItem.candidateId,
        criterionId: criterion.id,
        priority: processItem.priority,
        bytes,
        chargeKey: `${processItem.candidateId}\0${evidenceHash}`,
        value: {
          prepared,
          item: processItem,
          needsEpoch,
          reason,
          completion,
        },
      };
    });
    const added: Array<ReadyCell<PipelineReadyValue>> = [];
    for (const cell of cells) {
      if (pipelineScheduler.ready.push(cell)) {
        added.push(cell);
        continue;
      }
      pipelineScheduler.ready.take((candidate) => added.includes(candidate as ReadyCell<PipelineReadyValue>));
      finishPipelineCell(cell.value, new Error("pipeline ready buffer is full"));
      return;
    }
    for (const cell of cells) {
      const processItem = cell.value.item;
      pipelineScheduler.buffer(processItem, { reason });
    }
    pipelineBatcher.addMany(cells);
  });
}

class PipelineDispatchSemaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  async run<T>(body: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    } else {
      this.active += 1;
    }
    try {
      return await body();
    } finally {
      this.active -= 1;
      const next = this.waiters.shift();
      if (next) {
        this.active += 1;
        next();
      }
    }
  }
}

const pipelineDispatchSemaphore = new PipelineDispatchSemaphore(4);

async function dispatchPipelineBatch(cells: Array<ReadyCell<PipelineReadyValue>>): Promise<void> {
  return pipelineDispatchSemaphore.run(() => dispatchPipelineBatchBody(cells));
}

async function dispatchPipelineBatchBody(cells: Array<ReadyCell<PipelineReadyValue>>): Promise<void> {
  pipelineScheduler.ready.take((candidate) => cells.includes(candidate as ReadyCell<PipelineReadyValue>));
  const live = cells.filter((cell) =>
    rooms.get(cell.roomId)?.cursorEpoch === cell.value.needsEpoch
  );
  for (const cell of cells) {
    if (live.includes(cell)) continue;
    pipelineScheduler.dropBuffered(cell.value.item);
    finishPipelineCell(cell.value);
  }
  if (live.length === 0) return;
  const roomId = live[0].roomId;
  const processItems = live.map((cell) => cell.value.item);
  const preparedByCandidate = new Map<string, PreparedPlace>();
  for (const cell of live) {
    const source = cell.value.prepared;
    const current = preparedByCandidate.get(cell.candidateId);
    const criteria = new Map(
      (current?.item.criteria ?? []).map((criterion) => [criterion.id, criterion]),
    );
    for (const criterion of cell.value.item.criteria) criteria.set(criterion.id, criterion);
    preparedByCandidate.set(cell.candidateId, {
      ...source,
      item: { ...source.item, criteria: [...criteria.values()] },
    });
  }
  const prepared = [...preparedByCandidate.values()];
  const reason = live.every((cell) =>
    JSON.stringify(cell.value.reason) === JSON.stringify(live[0].value.reason)
  ) ? live[0].value.reason : { kind: "refine" as const };
  const present = presentIn(roomId).size > 0;
  let firstQueued = false;
  const phases: RefinementMatrixPhases = {
    first: <T>(run: () => Promise<T>) => {
      firstQueued = true;
      return pipelineScheduler.enqueueBatch(processItems, run, {
        buffered: true,
        present,
        reason,
      });
    },
    subsequent: <T>(items: PipelineItem[], run: () => Promise<T>) =>
      pipelineScheduler.enqueueBatch(items, run, { present, reason }),
  };
  try {
    const delay = await processRefinementBatch(roomId, prepared, phases);
    await adjudicateLikelyForRoom(pool, roomId, {
      mode: "proactive",
      consumeModelCall: consumeRefinementModelCall,
    });
    for (const cell of live) finishPipelineCell(cell.value, undefined, delay);
  } catch (error) {
    for (const cell of live) finishPipelineCell(cell.value, error);
  } finally {
    if (!firstQueued) {
      for (const item of processItems) pipelineScheduler.dropBuffered(item);
    }
  }
}

const pipelineBatcher = new MatrixBatcher<PipelineReadyValue>(dispatchPipelineBatch);

function cancelStalePipelineCells(roomId: string, needsEpoch: number): void {
  const removed = pipelineBatcher.remove((cell) => {
    if (cell.roomId !== roomId || cell.value.needsEpoch === needsEpoch) return false;
    if (cell.value.item.sweep) {
      cell.value.needsEpoch = needsEpoch;
      cell.value.item.needsEpoch = needsEpoch;
      return false;
    }
    return true;
  });
  if (removed.length === 0) return;
  pipelineScheduler.ready.take((cell) => removed.includes(cell as ReadyCell<PipelineReadyValue>));
  for (const cell of removed) {
    pipelineScheduler.dropBuffered(cell.value.item);
    finishPipelineCell(cell.value);
  }
}

function clearPipelineCells(): void {
  const removed = pipelineBatcher.remove(() => true);
  if (removed.length === 0) return;
  pipelineScheduler.ready.take((cell) => removed.includes(cell as ReadyCell<PipelineReadyValue>));
  const error = new Error("refinement pipeline reset");
  for (const cell of removed) {
    pipelineScheduler.dropBuffered(cell.value.item);
    finishPipelineCell(cell.value, error);
  }
}

function usablePageText(text: LookupPass["pageText"] | undefined): boolean {
  return Boolean(text && Object.values(text).some((value) =>
    typeof value === "string" && value.replace(/\s+/g, " ").trim().length >= 12
  ));
}

async function preparePlace(
  item: RefinementQueueItem,
  cached: Map<string, Enrichment>,
  countryCode?: string,
  intent: "interactive" | "background" = "background",
  scheduledRoute?: "direct" | "proxy",
  signal?: AbortSignal,
): Promise<PreparedPlace> {
  const candidate = item.candidate;
  const target = lookupTargetOf(candidate);
  let enrichment = cached.get(candidate.osm_ref!);
  let text: LookupPass["pageText"] | undefined;
  if (!text && target && (target.website || target.wikidata)) {
    const pass = await readRefinementSource(
      pool,
      target,
      countryCode,
      intent,
      scheduledRoute,
      signal,
    );
    enrichment = pass.enrichment ?? enrichment;
    if (pass.pageText) text = pass.pageText;
  }
  return {
    item,
    enrichment,
    siteTextUsable: usablePageText(text),
    matrix: trimMatrixPlace({
      candidateId: candidate.id,
      osmRef: candidate.osm_ref!,
      name: candidate.name,
      category: candidate.category,
      cuisine: (() => {
        const value = candidate.attributes.find((attribute) => attribute.key === "cuisine")?.value;
        return typeof value === "string" ? value.split(";").map((part) => part.trim()).filter(Boolean) : [];
      })(),
      texts: inferenceTexts(candidate as never, enrichment, text),
    }),
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

/** Process one scheduler-selected rectangle from the ready buffer. */
interface RefinementMatrixPhases {
  first<T>(run: () => Promise<T>): Promise<T>;
  subsequent<T>(items: PipelineItem[], run: () => Promise<T>): Promise<T>;
}

async function processRefinementBatch(
  roomId: string,
  prepared: PreparedPlace[],
  phases: RefinementMatrixPhases,
  now = Date.now(),
  options: RefinementBatchOptions = {},
): Promise<number> {
  if (!refinementEnabled()) {
    await phases.first(async () => []);
    return REFINE_TICK_MS;
  }
  const state = stateFor(roomId);
  const inputs = await loadEligibilityInputs(pool, roomId);
  const batch = prepared.map((place) => place.item);
  if (batch.length === 0) return REFINE_IDLE_TICK_MS;
  const epoch = state.cursorEpoch;
  const criteria = [...new Map(batch.flatMap((item) => item.criteria).map((criterion) => [
    criterion.id,
    criterion,
  ])).values()].filter(modelCriterion);
  const firstCalls = modelCalls(batch.length, criteria.length);
  // An empty search bucket is not a reason to stop. Site text plus the batch
  // matrix costs no search at all and still moves places off the queue, so the
  // pipeline keeps reading and only the search leg goes quiet. Only the model
  // bucket can pause processing, because without it there is nothing to run.
  // Searches are handed out in queue order, so a short bucket is spent on
  // tier 1 first and the background sweep takes whatever is left over.
  const searchSlots = Math.min(searchBudget.remaining(roomId, now), batch.length);
  const worstCalls = firstCalls + (searchSlots > 0 ? firstCalls : 0);
  const delay = modelBudget.remaining(roomId, now) >= worstCalls
    ? 0
    : modelBudget.retryAfterMs(roomId, worstCalls, now);
  if (delay > 0) {
    markBudgetPause(roomId, state);
    await phases.first(async () => []);
    return delay;
  }
  state.budgetLogged = false;
  state.paused = null;
  const spendBefore = responseMetrics();
  const providerName = searchProviderId();

  {
    const placeInfo = await roomPlace(roomId);
    // Cells the model genuinely answered (a claim or an explicit abstention);
    // only those are cached, everything else is re-queued (C3).
    const answeredCells = new Set<string>();
    const collectAnswered = async (batch: { answered: Array<{ candidateId: string; criterionId: string }> }) => {
      for (const cell of batch.answered) answeredCells.add(`${cell.candidateId}\u0000${cell.criterionId}`);
    };
    let firstClaims: EvaluatedInference[] = [];
    firstClaims = await phases.first(() => {
      if (criteria.length === 0) return Promise.resolve([]);
      if (!modelBudget.consume(roomId, firstCalls, now)) {
        markBudgetPause(roomId, state);
        throw new Error("refinement model budget was exhausted while waiting for admission");
      }
      return evaluateMatrix(
        { places: prepared.map((place) => place.matrix), criteria },
        collectAnswered,
        pool,
        "reuse",
        "background",
      );
    });
    const openByCandidate = new Map(batch.map((item) => [
      item.candidate.id,
      new Map(item.criteria.map((criterion) => [criterion.id, criterion])),
    ]));
    firstClaims = firstClaims.filter((claim) =>
      openByCandidate.get(claim.candidateId)?.has(claim.criterionId)
    );
    const firstCells = new Set(firstClaims.map((claim) => `${claim.candidateId}\u0000${claim.criterionId}`));
    const wanted: RefinementSearchRequest[] = [];
    const searchedCells = new Set<string>();
    const active = activeCriteria(inputs);
    for (const preparedPlace of prepared) {
      const unresolved = preparedPlace.item.criteria.filter((criterion) =>
        modelCriterion(criterion) &&
        !firstCells.has(`${preparedPlace.item.candidate.id}\u0000${criterion.id}`)
      );
      if (unresolved.length === 0) continue;
      const searchCriteria = unresolved.filter((criterion) =>
        searchableCriterion(criterion, active)
      );
      // A private criterion can be evaluated over text already fetched for
      // another criterion's search, but it can never cause a search on its own.
      if (searchCriteria.length === 0) continue;
      wanted.push({
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
    const searchRequests = wanted.slice(0, searchSlots);
    searchBudget.consume(roomId, searchRequests.length, now);
    let searchClaims: EvaluatedInference[] = [];
    let paidSearches = 0;
    const preparedById = new Map(prepared.map((item) => [item.item.candidate.id, item]));
    const searched = (await searchRefinementPlaces(
      searchRequests,
      placeInfo,
      search,
      {
        ...options,
        cacheDb: pool,
        providerName,
        roomId,
        pipeline: { roomId, needsEpoch: epoch, priority: batch[0]?.tier ?? 1 },
      },
    )).map((entry) => ({
      ...entry,
      prepared: preparedById.get(entry.candidateId)!,
    }));
    paidSearches = searched.filter((entry) => !entry.cacheHit).length;
    for (const entry of searched) {
      // searchAttempts measures paid outbound legs. Replaying snippets or
      // derived claims must not consume another attempt merely because a
      // requirement toggle caused the worker to revisit the cell.
      if (!entry.cacheHit) {
        const attempted = entry.results.length > 0 || entry.cachedClaims
          ? entry.criteria
          : entry.searchCriteria;
        for (const criterion of attempted) {
          searchedCells.add(`${entry.candidateId}\u0000${criterion.id}`);
        }
      }
      for (const id of entry.cachedAnsweredIds ?? []) {
        answeredCells.add(`${entry.candidateId}\u0000${id}`);
      }
    }
    const cachedClaims = searched.flatMap((entry) => entry.cachedClaims ?? []);
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
          title: result.title,
        })),
      }));
      const secondCalls = modelCalls(searchPlaces.length, searchCriteria.length);
      const searchPlacesById = new Map(searchPlaces.map((place) => [place.candidateId, place]));
      const secondItems = withSnippets.flatMap((entry) => entry.criteria.map((criterion) => {
        const place = searchPlacesById.get(entry.candidateId)!;
        const base = {
          roomId,
          candidateId: entry.candidateId,
          osmRef: entry.osmRef,
          kind: "process.judge" as const,
          criteria: [criterion],
          priority: entry.prepared.item.tier,
          intent: "background" as const,
          evidenceHash: matrixEvidenceHash(place),
          predictedPool: "llm-matrix" as const,
          sweep: !active.has(criterion.id),
          needsEpoch: epoch,
          enqueuedAt: Date.now(),
        };
        return { ...base, dedupeKey: pipelineDedupeKey(base) };
      }));
      const evaluatedClaims = await phases.subsequent(
        secondItems,
        () => {
          if (!modelBudget.consume(roomId, secondCalls, now)) {
            markBudgetPause(roomId, state);
            throw new Error("refinement model budget was exhausted while waiting for admission");
          }
          return evaluateMatrix(
            { places: searchPlaces, criteria: searchCriteria },
            collectAnswered,
            pool,
          );
        },
      );
      const unresolvedByCandidate = new Map(withSnippets.map((entry) => [
        entry.prepared.item.candidate.id,
        new Set(entry.criteria.map((criterion) => criterion.id)),
      ]));
      const acceptedClaims = evaluatedClaims.filter((claim) =>
        unresolvedByCandidate.get(claim.candidateId)?.has(claim.criterionId)
      );
      if (providerName === "openai") {
        await Promise.all(withSnippets.map((entry) => {
          const answeredIds = entry.criteria
            .map((criterion) => criterion.id)
            .filter((id) => answeredCells.has(`${entry.candidateId}\u0000${id}`));
          if (!answeredIds.length) return Promise.resolve();
          return storeSearchCache(pool, {
            osmRef: entry.osmRef,
            query: entry.cacheQuery!,
            provider: "openai",
            ...(entry.cacheDomains ? { domains: entry.cacheDomains } : {}),
            claims: acceptedClaims.filter((claim) => claim.candidateId === entry.candidateId),
            answeredIds,
          }).catch(() => undefined);
        }));
      }
      searchClaims = [...cachedClaims, ...acceptedClaims];
    } else {
      searchClaims = cachedClaims;
    }
    if (providerName === "openai") {
      await Promise.all(searched
        .filter((entry) => entry.results.length === 0 && entry.cachedClaims === undefined)
        .map((entry) => storeSearchCache(pool, {
          osmRef: entry.osmRef,
          query: entry.cacheQuery!,
          provider: "openai",
          ...(entry.cacheDomains ? { domains: entry.cacheDomains } : {}),
          claims: [],
          answeredIds: [],
        }).catch(() => undefined)));
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
        searchedCriterionIds: open
          .map((criterion) => criterion.id)
          .filter((id) => searchedCells.has(`${item.candidate.id}\u0000${id}`)),
        observedAt,
      }] : [];
    }));

  // A wake during this batch already cleared the cursor for the need that
    // changed. Writing this batch's cursor back would erase that invalidation
    // and the changed need would wait for the whole background sweep.
    const cursorStillOurs = state.cursorEpoch === epoch;
    for (const item of batch) {
      if (cursorStillOurs) {
        const ids = state.evaluated.get(item.candidate.id) ?? new Set<string>();
        for (const criterion of item.criteria) ids.add(criterion.id);
        state.evaluated.set(item.candidate.id, ids);
        state.providerChecked.add(item.candidate.id);
      }
      if (item.criteria.length > 0) state.checked.add(item.candidate.id);
    }
    const batchCounts = refinementQueueCounts(batch);
    state.queued = Math.max(0, state.queued - batchCounts.tier1);
    state.tier1Queued = state.queued;
    state.backlog = Math.max(0, state.backlog - batchCounts.total);

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
    logBatch(roomId, {
      places: batch.length,
      criteria: criteria.length,
      searches: paidSearches,
      claims: claims.length,
      changed: changed.length,
      queued: state.queued,
      spend: spendBefore,
      providerName,
    });
    return REFINE_TICK_MS;
  }
}

/**
 * One line per batch, so a walk can measure the pipeline instead of inferring it
 * from the map. Counts and dollars only: no place name, no criterion text, no
 * query. A private need must not be readable from a log either.
 */
function logBatch(
  roomId: string,
  batch: {
    places: number;
    criteria: number;
    searches: number;
    claims: number;
    changed: number;
    queued: number;
    spend: ReturnType<typeof responseMetrics>;
    providerName: SearchProviderId;
  },
): void {
  const now = responseMetrics();
  const calls = now.calls - batch.spend.calls;
  const serviceTierCalls = Object.fromEntries(
    Object.entries(now.serviceTierCalls)
      .map(([tier, count]) => [
        tier,
        count - batch.spend.serviceTierCalls[tier as keyof typeof batch.spend.serviceTierCalls],
      ] as const)
      .filter(([, count]) => count > 0),
  );
  const usedServiceTiers = Object.keys(serviceTierCalls);
  const serviceTier = usedServiceTiers.length > 1
    ? "mixed"
    : usedServiceTiers[0] ?? "none";
  const modelCost = now.costUsd - batch.spend.costUsd;
  const listingCost = takeListingSpendUsd(roomId);
  // OpenRouter reports built-in web-search spend in usage.cost. External
  // Parallel/Tavily fees remain separate because they never cross the model
  // transport.
  const searchCost = batch.providerName === "openai"
    ? 0
    : batch.searches * SEARCH_PROVIDER_COST_USD[batch.providerName];
  const cost = modelCost + searchCost + listingCost;
  const state = rooms.get(roomId);
  if (state) {
    state.calls += calls;
    state.searches += batch.searches;
    state.costUsd += cost;
  }
  console.info(JSON.stringify({
    msg: "refine batch",
    roomId,
    places: batch.places,
    criteria: batch.criteria,
    calls,
    serviceTier,
    serviceTierCalls,
    searches: batch.searches,
    searchProvider: batch.providerName,
    listingCostUsd: Number(listingCost.toFixed(4)),
    claims: batch.claims,
    changed: batch.changed,
    queued: batch.queued,
    costUsd: Number(cost.toFixed(4)),
  }));
}

export function refinementView(
  roomId: string,
  _inputs?: EligibilityInputs,
  now = Date.now(),
): NonNullable<SpatialContextResult["refine"]> {
  const state = rooms.get(roomId);
  const active = Boolean(state && !state.stopped);
  return {
    active,
    queued: state?.queued ?? 0,
    tier1Queued: state?.tier1Queued ?? 0,
    checkedToday: state?.checkedDay === utcDay(now) ? state.checked.size : 0,
    // An out-of-budget room and an empty room both look still; only the server
    // knows which, and the page cannot say "paused for now" honestly without
    // being told. Running searches dry no longer pauses anything.
    paused: !active ? "idle" : state?.paused ?? null,
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

/** Adjudication spends from refinement's existing per-room bucket. */
export function consumeRefinementModelCall(roomId: string, now = Date.now()): boolean {
  return modelBudget.consume(roomId, 1, now);
}

/** Interactive model calls never spend the background sweep's allowance. */
export function consumeInteractiveModelCall(roomId: string, now = Date.now()): boolean {
  return interactiveModelBudget.consume(roomId, 1, now);
}

/** Current process-local need-plan generation, used by open-plan admission. */
export function refinementNeedsEpoch(roomId: string): number {
  return rooms.get(roomId)?.cursorEpoch ?? 0;
}

export function exhaustRefinementBudgetsForTest(roomId: string, now: number): void {
  modelBudget.consume(roomId, REFINE_MODEL_CALLS_PER_HOUR, now);
  searchBudget.consume(roomId, REFINE_SEARCHES_PER_HOUR, now);
}

/** Only the model bucket can pause processing; searches merely go quiet. */
export function refinementBudgetSleepForTest(
  roomId: string,
  calls: number,
  now: number,
): number {
  const state = stateFor(roomId);
  const delay = modelBudget.remaining(roomId, now) >= calls
    ? 0
    : modelBudget.retryAfterMs(roomId, calls, now);
  if (delay > 0) markBudgetPause(roomId, state);
  return delay;
}

/** Empty the search bucket alone, leaving model calls available. */
export function exhaustRefinementSearchesForTest(roomId: string, now: number): void {
  searchBudget.consume(roomId, REFINE_SEARCHES_PER_HOUR, now);
}

/** Replace only the awaited planner body so scheduling races can be pinned. */
export function setRefinementPlanWorkForTest(
  work: ((roomId: string) => Promise<void>) | undefined,
): void {
  pipelinePlanWorkForTest = work;
}

/** Test-only reset for timers, cursors, budgets and scheduler state. */
export function resetRefinement(): void {
  for (const roomId of [...rooms.keys()]) stopRefinement(roomId);
  clearPipelineCells();
  modelBudget.reset();
  searchBudget.reset();
  interactiveModelBudget.reset();
  interactiveSearchBudget.reset();
  pipelinePlanWorkForTest = undefined;
  pipelinePlanning.clear();
  pipelineLatestPlans.clear();
  pipelineScheduler.reset();
}

// Register once per process. Presence frames and fact frames are separate;
// only socket presence reaches this hook, so fact publication cannot loop.
onPresenceChange(noteRefinementPresence);

/** Compatibility aliases for callers that name the refinement worker. */
export const startRefineWorker = startRefinement;
export const stopRefineWorker = stopRefinement;
export const resetRefineWorker = resetRefinement;
