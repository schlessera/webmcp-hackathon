import type pg from "pg";
import {
  criterionFor,
  isLikely,
  type Criterion,
} from "@webmcp-hackathon/contracts";
import {
  classifyAll,
  loadEligibilityInputs,
  type EligibilityInputs,
} from "../eligibility.ts";
import { inScope } from "../facets.ts";
import { beginLookups } from "./progress.ts";
import {
  publishInferenceChanges,
  saveInferences,
  stableAttributeHash,
  type StoredCriterionInference,
} from "./index.ts";
import {
  ADJUDICATION_MAX_PLACES,
  adjudicateCells,
  adjudicationCached,
  contextFromCache,
  evidenceHash,
  type AdjudicationCell,
  type AdjudicationPageCache,
} from "./adjudicate.ts";
import { inferenceEnabled } from "./infer.ts";
import { presentIn } from "../presence.ts";
import { pipelineDedupeKey } from "../pipeline/queue.ts";
import { pipelineScheduler } from "../pipeline/scheduler.ts";

const PROACTIVE_THRESHOLD = 20;
const inFlight = new Set<string>();

type Claim = Exclude<StoredCriterionInference, { omitted: true }>;

export interface RunAdjudicationOptions {
  mode: "on_demand" | "proactive";
  candidateIds?: string[];
  inputs?: EligibilityInputs;
  pageCache?: AdjudicationPageCache;
  now?: number;
  /** The room's existing refinement model-call bucket. */
  consumeModelCall: (roomId: string, now: number) => boolean;
}

export interface RunAdjudicationResult {
  calls: number;
  cells: number;
  changed: string[];
}

function criterionDescriptor(criterion: Criterion): AdjudicationCell["criterion"] {
  return {
    kind: criterion.kind,
    label: criterion.label,
    ...(criterion.kind === "question" ? { question: criterion.text } : {}),
    ...(criterion.kind === "key" && criterion.values?.length
      ? { values: criterion.values }
      : {}),
  };
}

function activeCriteria(inputs: EligibilityInputs): Criterion[] {
  return [...new Map(inputs.requirements.flatMap((requirement) => {
    if (
      requirement.withdrawn || requirement.active === false ||
      (requirement.visibility !== "shared" && requirement.visibility !== "application-private")
    ) return [];
    const criterion = criterionFor(requirement.payload as never, {
      timezone: inputs.timezone ?? "UTC",
      now: inputs.now ?? new Date(),
    });
    return criterion ? [[criterion.id, criterion] as const] : [];
  })).values()];
}

function eligibleCandidateIds(inputs: EligibilityInputs, mode: RunAdjudicationOptions["mode"]): Set<string> {
  if (mode === "on_demand") return new Set(inputs.candidates.map((candidate) => candidate.id));
  const rows = classifyAll(
    inputs.candidates,
    inputs.requirements,
    inputs.verdicts,
    inputs.scope,
    inputs.timezone,
  );
  const matchingAndLikely = rows.filter((row) =>
    row.eligibility === "eligible" || row.eligibility === "likely"
  );
  if (matchingAndLikely.length > PROACTIVE_THRESHOLD) return new Set();
  const scoped = new Set(inScope(inputs.candidates, inputs.scope).map((candidate) => candidate.id));
  return new Set(matchingAndLikely
    .filter((row) => scoped.has(row.candidateId))
    .map((row) => row.candidateId));
}

function cellsFor(
  inputs: EligibilityInputs,
  options: RunAdjudicationOptions,
  now: number,
): AdjudicationCell[] {
  const criteria = activeCriteria(inputs);
  const allowed = eligibleCandidateIds(inputs, options.mode);
  const requested = options.candidateIds ? new Set(options.candidateIds) : null;
  return inputs.candidates
    .filter((candidate) =>
      Boolean(candidate.osm_ref) && allowed.has(candidate.id) && (!requested || requested.has(candidate.id))
    )
    .sort((a, b) => a.walk_min - b.walk_min || a.id.localeCompare(b.id))
    .flatMap((candidate) => criteria.flatMap((criterion) => {
      const attribute = candidate.attributes.find((item) => item.key === criterion.id);
      if (!attribute || !isLikely(attribute.status)) return [];
      const stored = candidate.osm_ref
        ? inputs.enrichments?.get(candidate.osm_ref)?.inferred?.[criterion.id]
        : undefined;
      if (!stored || "omitted" in stored || !stored.sourceUrl) return [];
      const claim = stored as Claim;
      // The guard above proves this, but the cast erases the narrowing.
      const sourceUrl = stored.sourceUrl;
      const hash = evidenceHash(claim.evidence);
      if (adjudicationCached(claim, hash, now)) return [];
      const material = contextFromCache(claim, options.pageCache);
      if (!material) return [];
      const key = `${candidate.osm_ref}\u0000${criterion.id}\u0000${hash}`;
      if (inFlight.has(key)) return [];
      return [{
        candidateId: candidate.id,
        osmRef: candidate.osm_ref!,
        criterionId: criterion.id,
        criterion: criterionDescriptor(criterion),
        place: {
          name: candidate.name,
          category: candidate.category,
          ...(candidate.extras?.website ? { website: candidate.extras.website } : {}),
          ...(candidate.extras?.brand ? { brand: candidate.extras.brand } : {}),
        },
        evidence: claim.evidence,
        context: material.context,
        pageTitle: material.pageTitle,
        url: sourceUrl,
        publisherNames: material.publisherNames,
        claim,
        evidenceHash: hash,
      }];
    }));
}

function batchesByPlaces(cells: AdjudicationCell[]): AdjudicationCell[][] {
  const byPlace = new Map<string, AdjudicationCell[]>();
  for (const cell of cells) {
    const list = byPlace.get(cell.candidateId) ?? [];
    list.push(cell);
    byPlace.set(cell.candidateId, list);
  }
  const places = [...byPlace.values()];
  const batches: AdjudicationCell[][] = [];
  for (let at = 0; at < places.length; at += ADJUDICATION_MAX_PLACES) {
    batches.push(places.slice(at, at + ADJUDICATION_MAX_PLACES).flat());
  }
  return batches;
}

function logBatch(
  roomId: string,
  cells: number,
  result: Awaited<ReturnType<typeof adjudicateCells>>,
): void {
  const verdicts = { yes: 0, no: 0, unclear: 0 };
  for (const outcome of result.outcomes) verdicts[outcome.verdict] += 1;
  const cost = result.reply.usage.costUsd ?? 0;
  console.info(JSON.stringify({
    msg: "adjudication batch",
    roomId,
    cells,
    verdicts,
    costUsd: Number(cost.toFixed(6)),
    latencyMs: result.reply.ms,
  }));
}

export async function adjudicateLikelyForRoom(
  pool: pg.Pool,
  roomId: string,
  options: RunAdjudicationOptions,
): Promise<RunAdjudicationResult> {
  if (!inferenceEnabled()) return { calls: 0, cells: 0, changed: [] };
  const now = options.now ?? Date.now();
  const inputs = options.inputs ?? await loadEligibilityInputs(pool, roomId);
  const cells = cellsFor(inputs, options, now);
  if (cells.length === 0) return { calls: 0, cells: 0, changed: [] };
  const before = new Map(inputs.candidates.map((candidate) => [
    candidate.id,
    stableAttributeHash(candidate.attributes as never),
  ]));
  let calls = 0;
  let attemptedCells = 0;
  const criteria = new Map(activeCriteria(inputs).map((criterion) => [criterion.id, criterion]));
  const endProgress = beginLookups(
    roomId,
    [...new Set(cells.map((cell) => cell.candidateId))],
    options.mode === "proactive" ? { kind: "refine" } : { kind: "place" },
  );
  try {
    const scheduled: Promise<void>[] = [];
    for (const batch of batchesByPlaces(cells)) {
      const keys = batch.map((cell) => `${cell.osmRef}\u0000${cell.criterionId}\u0000${cell.evidenceHash}`);
      const admitted = batch.filter((_, index) => !inFlight.has(keys[index]));
      if (admitted.length === 0) continue;
      if (!options.consumeModelCall(roomId, now)) break;
      for (const key of admitted.map((cell) =>
        `${cell.osmRef}\u0000${cell.criterionId}\u0000${cell.evidenceHash}`
      )) inFlight.add(key);
      const run = async (): Promise<void> => {
        const started = Date.now();
        try {
          const result = await adjudicateCells(
            admitted,
            options.mode === "on_demand" ? "interactive" : "background",
          );
          calls += 1;
          attemptedCells += admitted.length;
          logBatch(roomId, admitted.length, result);
          await saveInferences(pool, [...new Set(admitted.map((cell) => cell.osmRef))].flatMap((osmRef) => {
            const placeCells = admitted.filter((cell) => cell.osmRef === osmRef);
            const claims = result.outcomes
              .filter((outcome) => placeCells.some((cell) => cell.criterionId === outcome.criterionId))
              .map((outcome) => outcome.inference);
            const usedCriteria = placeCells.flatMap((cell) => {
              const criterion = criteria.get(cell.criterionId);
              return criterion ? [criterion] : [];
            });
            return usedCriteria.length ? [{
              osmRef,
              criteria: usedCriteria,
              claims,
              answeredCriterionIds: [],
              observedAt: new Date(now).toISOString(),
            }] : [];
          }));
        } catch {
          // A timeout, malformed response, or write failure is not a verdict.
          console.info(JSON.stringify({
            msg: "adjudication batch",
            roomId,
            cells: admitted.length,
            verdicts: { yes: 0, no: 0, unclear: 0 },
            costUsd: 0,
            latencyMs: Date.now() - started,
            outcome: "error",
          }));
        } finally {
          for (const key of admitted.map((cell) =>
            `${cell.osmRef}\u0000${cell.criterionId}\u0000${cell.evidenceHash}`
          )) inFlight.delete(key);
        }
      };
      const items = admitted.flatMap((cell) => {
        const criterion = criteria.get(cell.criterionId);
        if (!criterion) return [];
        const base = {
          roomId,
          candidateId: cell.candidateId,
          osmRef: cell.osmRef,
          kind: "process.adjudicate" as const,
          criteria: [criterion],
          priority: options.mode === "on_demand" ? 0 as const : 1 as const,
          intent: options.mode === "on_demand" ? "interactive" as const : "background" as const,
          evidenceHash: cell.evidenceHash,
          needsEpoch: 0,
          enqueuedAt: Date.now(),
        };
        return [{ ...base, dedupeKey: pipelineDedupeKey(base) }];
      });
      scheduled.push(pipelineScheduler.enqueueBatch(items, run, {
        present: presentIn(roomId).size > 0,
        reason: options.mode === "proactive" ? { kind: "refine" } : { kind: "place" },
      }));
    }
    await Promise.all(scheduled);
  } finally {
    endProgress();
  }
  if (calls === 0) return { calls, cells: attemptedCells, changed: [] };
  const refreshed = await loadEligibilityInputs(pool, roomId);
  const changed = refreshed.candidates.flatMap((candidate) =>
    before.has(candidate.id) &&
      before.get(candidate.id) !== stableAttributeHash(candidate.attributes as never)
      ? [candidate.id]
      : []
  );
  await publishInferenceChanges(pool, roomId, changed, "inference");
  return { calls, cells: attemptedCells, changed };
}

export function resetAdjudicationForTest(): void {
  inFlight.clear();
}
