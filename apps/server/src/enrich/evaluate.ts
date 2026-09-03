import { createHash } from "node:crypto";
import type pg from "pg";
import {
  graded,
  normalizeQuestion,
  type AttributeStatus,
  type Criterion,
} from "@webmcp-hackathon/contracts";
import { config } from "../config.ts";
import { parseJson, respond } from "../nl/llm.ts";
import {
  inferenceEnabled,
  INFERENCE_CONFIDENCE_CAPS,
  normalizeEvidence,
  sanitizeInferenceNote,
  type InferenceTextSource,
} from "./infer.ts";
import {
  cleanEvidenceText,
  cleanInlineText,
  cleanTitle,
  hasWholeTextSpan,
  truncateText,
} from "./text.ts";
import { cleanEvaluatedInference } from "./stored-text.ts";

/**
 * One fast-tier call evaluates a rectangular place × criterion matrix. Model
 * output is only a draft: every identity, source index, evidence span and
 * confidence is checked again here before a graded inference can leave this
 * module.
 */

export const MAX_MATRIX_PLACES = 8;
export const MAX_MATRIX_CRITERIA = 5;
export const MAX_TEXT_CHARS_PER_PLACE = 6_000;
/** Evidence (up to 400 chars) plus at most 400 normalized chars on each side. */
export const MAX_EVIDENCE_CONTEXT_CHARS = 1_200;
/** A full batch is a long prompt on a background path, so it is given more
 * room than an interactive call. Twenty seconds was not enough for a live
 * twelve-place matrix and the whole tick returned nothing. */
export const MATRIX_TIMEOUT_MS = Number(process.env.MATRIX_TIMEOUT_MS ?? 90_000);

/** Search source names are consumed by the refinement stream; aliases keep
 * the evidence boundary tolerant at the module edge without changing caps. */
export type MatrixInferenceTextSource =
  | InferenceTextSource
  | "domain_search"
  | "open_web_search"
  | "domain-search"
  | "open-web-search"
  | "search-domain"
  | "search-open";

export interface EvaluateMatrixInput {
  places: Array<{
    candidateId: string;
    osmRef: string;
    name: string;
    category: string;
    /** OSM-recorded venue website, used only to establish own-site provenance. */
    website?: string;
    cuisine?: string[];
    texts: Array<{
      source: MatrixInferenceTextSource;
      text: string;
      url?: string;
      title?: string;
      publisherNames?: string[];
    }>;
  }>;
  criteria: Criterion[];
}

export type MatrixEvidenceBucket =
  | "venue_site"
  | "menu"
  | "domain_search"
  | "open_web_search"
  | "name_category";

export const MATRIX_CONFIDENCE_CAPS: Record<MatrixEvidenceBucket, number> = {
  venue_site: INFERENCE_CONFIDENCE_CAPS.description_website,
  menu: INFERENCE_CONFIDENCE_CAPS.menu,
  domain_search: 0.55,
  open_web_search: 0.5,
  name_category: INFERENCE_CONFIDENCE_CAPS.name_category,
};
export const EXPLICIT_OWN_SITE_CONFIDENCE = 0.72;

export interface EvaluatedInference {
  candidateId: string;
  osmRef: string;
  criterionId: string;
  key: string;
  lean: "yes" | "no";
  status: AttributeStatus;
  confidence: number;
  evidence: string;
  source: string;
  sourceIndex: number;
  observedAt: string;
  sourceUrl?: string;
  context?: string;
  pageTitle?: string;
  publisherNames?: string[];
  adjudication?: NonNullable<import("./infer.ts").InferredClaim["adjudication"]>;
  explicit: boolean;
  value?: string;
  // Deliberately absent: a question's sentence never travels on a claim. It
  // may be application-private, and a claim is what reaches the cross-room
  // enrichments cache. Authorized copy is recovered from the requirement.
}

export interface EvaluatedMatrixBatch {
  input: EvaluateMatrixInput;
  claims: EvaluatedInference[];
  /** Cells for which the model returned a validated claim or explicit abstention. */
  answered: Array<{ candidateId: string; criterionId: string }>;
}

export const EVALUATE_MATRIX_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["claims"],
  properties: {
    claims: {
      type: "array",
      maxItems: MAX_MATRIX_PLACES * MAX_MATRIX_CRITERIA,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "candidateId",
          "criterionId",
          "lean",
          "confidence",
          "evidence",
          "sourceIndex",
          "explicit",
        ],
        properties: {
          candidateId: { type: "string", minLength: 1 },
          criterionId: { type: "string", minLength: 1 },
          lean: { type: "string", enum: ["yes", "no", "abstain"] },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          evidence: { type: "string", maxLength: 400 },
          sourceIndex: { type: ["integer", "null"], minimum: -1 },
          explicit: { type: "boolean" },
        },
      },
    },
  },
} as const;

export const EVALUATE_MATRIX_PROMPT = [
  "Evaluate many places against many planning criteria using only the supplied material.",
  "When a criterion includes question and values fields, answer that specific question about those wanted values; never answer the bare key in general.",
  "Return exactly one claim for every candidateId × criterionId pair. Use lean=abstain when the material does not directly support yes or no; abstention is expected and is never a negative answer.",
  "For yes or no, evidence must be a verbatim span copied from that same place. Use sourceIndex 0..n-1 for the indexed texts, or -1 only when the exact span is in that place's name, category, or cuisine tokens.",
  "Evidence must contain at least 12 characters and at least two words. Never paraphrase, combine separate spans, borrow text from another place, or repeat the criterion/question itself as evidence.",
  "A yes needs direct affirmative support. A no needs explicit negative wording; silence or a missing mention requires abstain.",
  "Set explicit=true only when the cited span states the answer outright; use false when the answer is inferred from indirect evidence.",
  "confidence is only your cautious probability from 0 to 1. The server applies a stricter cap based on the cited source. An explicit statement on the venue's own recorded website may be treated as a record-grade fact; all other model claims remain graded evidence.",
  "For abstain use confidence=0, evidence=\"\", and sourceIndex=null.",
  "Use only candidateId and criterionId values supplied in the input. Output only the JSON object required by the schema.",
].join("\n");

interface DraftClaim {
  candidateId?: unknown;
  criterionId?: unknown;
  lean?: unknown;
  confidence?: unknown;
  evidence?: unknown;
  sourceIndex?: unknown;
  explicit?: unknown;
}

const WORDS = /[\p{L}\p{N}]+/gu;

export function hasWholeSpan(text: string, evidence: string): boolean {
  return hasWholeTextSpan(text, evidence);
}

/** A bounded, normalized window around the exact validated evidence span. */
export function evidenceContext(text: string, evidence: string): string | undefined {
  const source = cleanEvidenceText(text);
  const needle = cleanEvidenceText(evidence);
  const at = source.toLocaleLowerCase().indexOf(needle.toLocaleLowerCase());
  if (at < 0) return undefined;
  const start = Math.max(0, at - 400);
  const end = Math.min(source.length, at + needle.length + 400);
  const window = sanitizeInferenceNote(source.slice(start, end));
  return window ? window.slice(0, MAX_EVIDENCE_CONTEXT_CHARS) : undefined;
}

export function echoesCriterion(criterion: Criterion, evidence: string): boolean {
  const needle = normalizeQuestion(evidence);
  if (!needle) return true;
  const forms = criterion.kind === "question"
    ? [criterion.text, criterion.label]
    : [criterion.key, criterion.label];
  return forms.some((form) => normalizeQuestion(form).includes(needle));
}

function evidenceBucket(source: MatrixInferenceTextSource): MatrixEvidenceBucket {
  if (source === "domain_search" || source === "domain-search" || source === "search-domain") {
    return "domain_search";
  }
  if (source === "open_web_search" || source === "open-web-search" || source === "search-open") {
    return "open_web_search";
  }
  if (source === "wikidata") return "open_web_search";
  if (source === "menu") return "menu";
  return "venue_site";
}

/** Exact hostname matching, case-insensitive, with one leading www. ignored. */
export function normalizedWebsiteHost(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLocaleLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function isExplicitOwnSite(
  place: EvaluateMatrixInput["places"][number],
  sourceIndex: number,
  explicit: unknown,
): boolean {
  if (explicit !== true || sourceIndex < 0) return false;
  const cited = place.texts[sourceIndex];
  if (!cited || (cited.source !== "web" && cited.source !== "menu")) return false;
  const citedHost = normalizedWebsiteHost(cited.url);
  const recordedHost = normalizedWebsiteHost(place.website);
  return citedHost !== null && recordedHost !== null && citedHost === recordedHost;
}

/** Preserve short sources first; the longest source is last and therefore the
 * first one shortened when all text would exceed the per-place allowance. */
export function trimMatrixPlace(
  place: EvaluateMatrixInput["places"][number],
): EvaluateMatrixInput["places"][number] {
  const ordered = place.texts
    .map((item, index) => ({
      ...item,
      text: cleanInlineText(item.text),
      ...(item.title ? { title: truncateText(cleanTitle(item.title), 160) } : {}),
      ...(item.publisherNames?.length
        ? { publisherNames: item.publisherNames.map(cleanInlineText).filter(Boolean).slice(0, 6) }
        : {}),
      index,
    }))
    .filter((item) => item.text.length > 0)
    .sort((a, b) => a.text.length - b.text.length || a.index - b.index);
  let remaining = MAX_TEXT_CHARS_PER_PLACE;
  const texts: EvaluateMatrixInput["places"][number]["texts"] = [];
  for (const { index: _index, ...item } of ordered) {
    if (remaining <= 0) break;
    const text = item.text.slice(0, remaining);
    if (text) texts.push({ ...item, text });
    remaining -= text.length;
  }
  return {
    ...place,
    name: cleanInlineText(place.name),
    category: cleanInlineText(place.category),
    ...(place.cuisine ? { cuisine: place.cuisine.map(cleanInlineText).filter(Boolean) } : {}),
    texts,
  };
}

function uniqueInput(input: EvaluateMatrixInput): EvaluateMatrixInput {
  return {
    places: [
      ...new Map(input.places.map((place) => [place.candidateId, trimMatrixPlace(place)])).values(),
    ],
    criteria: [...new Map(input.criteria.map((criterion) => [criterion.id, criterion])).values()]
      .filter((criterion) => !isTimeCriterion(criterion)),
  };
}

/** Stable cache identity for every piece of evidence the model can inspect,
 * including the record tokens available through sourceIndex -1. */
export function matrixEvidenceHash(place: EvaluateMatrixInput["places"][number]): string {
  const bounded = trimMatrixPlace(place);
  return createHash("sha256").update(JSON.stringify({
    name: bounded.name,
    category: bounded.category,
    website: bounded.website ?? null,
    cuisine: bounded.cuisine ?? [],
    texts: bounded.texts.map((text) => ({
      source: text.source,
      text: text.text,
      url: text.url ?? null,
    })),
  })).digest("hex");
}

export function matrixCacheKey(
  place: EvaluateMatrixInput["places"][number],
  criterion: Criterion,
): string {
  return `${place.osmRef}\u0000${criterion.id}\u0000${matrixEvidenceHash(place)}`;
}

function isTimeCriterion(criterion: Criterion): boolean {
  return criterion.kind === "key" && criterion.key.startsWith("open:");
}

/** Pure validation for one already-bounded matrix answer. */
export function matrixClaimsFromAnswer(
  answer: unknown,
  input: EvaluateMatrixInput,
  model: string,
  observedAt = new Date().toISOString(),
): EvaluatedInference[] {
  return matrixBatchFromAnswer(answer, input, model, observedAt).claims;
}

/** Validate claims and retain the cells the model genuinely answered. */
export function matrixBatchFromAnswer(
  answer: unknown,
  input: EvaluateMatrixInput,
  model: string,
  observedAt = new Date().toISOString(),
): EvaluatedMatrixBatch {
  const places = new Map(input.places.map((place) => [place.candidateId, place]));
  const criteria = new Map(input.criteria
    .filter((criterion) => !isTimeCriterion(criterion))
    .map((criterion) => [criterion.id, criterion]));
  const drafts = (answer as { claims?: unknown } | null)?.claims;
  if (!Array.isArray(drafts)) return { input, claims: [], answered: [] };
  const seen = new Set<string>();
  const claims: EvaluatedInference[] = [];
  const answered: EvaluatedMatrixBatch["answered"] = [];
  for (const raw of drafts as DraftClaim[]) {
    if (!raw || typeof raw !== "object") continue;
    const candidateId = String(raw.candidateId ?? "");
    const criterionId = String(raw.criterionId ?? "");
    const cell = `${candidateId}\u0000${criterionId}`;
    if (seen.has(cell)) continue;
    const place = places.get(candidateId);
    const criterion = criteria.get(criterionId);
    if (!place || !criterion) continue;
    // The first occurrence owns the cell even when its contents fail later
    // validation. A duplicate cannot repair or replace it within one answer.
    seen.add(cell);
    if (raw.lean === "abstain") {
      answered.push({ candidateId, criterionId });
      continue;
    }
    if (raw.lean !== "yes" && raw.lean !== "no") continue;
    if (typeof raw.sourceIndex !== "number") continue;
    const sourceIndex = raw.sourceIndex;
    if (!Number.isInteger(sourceIndex) || sourceIndex < -1) continue;
    const evidence = normalizeEvidence(String(raw.evidence ?? ""));
    if (evidence.length < 12 || (evidence.match(WORDS)?.length ?? 0) < 2) continue;
    if (echoesCriterion(criterion, evidence)) continue;
    const cited = sourceIndex === -1
      ? [place.name, place.category, ...(place.cuisine ?? [])]
          .map(normalizeEvidence)
          .filter(Boolean)
      : place.texts[sourceIndex]
        ? [normalizeEvidence(place.texts[sourceIndex].text)]
        : [];
    if (!cited.some((text) => hasWholeSpan(text, evidence))) continue;
    const safeEvidence = sanitizeInferenceNote(evidence);
    if (!safeEvidence) continue;
    if (typeof raw.confidence !== "number") continue;
    const rawConfidence = raw.confidence;
    // Time windows are deterministic predicates over structured hours. Even
    // a direct own-site sentence can never promote an `open:*` cell.
    const recordGrade = !isTimeCriterion(criterion) &&
      isExplicitOwnSite(place, sourceIndex, raw.explicit);
    if (!Number.isFinite(rawConfidence) || (!recordGrade && rawConfidence <= 0)) continue;
    const bucket = sourceIndex === -1
      ? "name_category"
      : evidenceBucket(place.texts[sourceIndex].source);
    const confidence = recordGrade
      ? EXPLICIT_OWN_SITE_CONFIDENCE
      : Math.min(rawConfidence, MATRIX_CONFIDENCE_CAPS[bucket]);
    const status = graded(raw.lean === "yes", confidence);
    if ((status === "verified_true" || status === "verified_false") && !recordGrade) continue;
    answered.push({ candidateId, criterionId });
    const sourceUrl = sourceIndex >= 0 ? place.texts[sourceIndex].url : undefined;
    const sourceText = sourceIndex >= 0 ? place.texts[sourceIndex] : undefined;
    const context = sourceText ? evidenceContext(sourceText.text, evidence) : undefined;
    const pageTitle = sourceText?.title
      ? truncateText(cleanTitle(sourceText.title), 160)
      : undefined;
    const publisherNames = sourceText?.publisherNames
      ?.map((name) => sanitizeInferenceNote(name).slice(0, 120))
      .filter(Boolean)
      .slice(0, 6);
    claims.push({
      candidateId,
      osmRef: place.osmRef,
      criterionId,
      key: criterion.id,
      lean: raw.lean,
      status,
      confidence,
      evidence: safeEvidence,
      source: recordGrade
        ? `web:${normalizedWebsiteHost(place.texts[sourceIndex].url)}`
        : `infer:${model}:${bucket}`,
      sourceIndex,
      observedAt,
      explicit: raw.explicit === true,
      ...(criterion.kind === "key" && criterion.key === "cuisine" && criterion.values?.length
        ? { value: criterion.values.join(";") }
        : {}),
      ...(sourceUrl ? { sourceUrl } : {}),
      ...(context ? { context } : {}),
      ...(pageTitle ? { pageTitle } : {}),
      ...(publisherNames?.length ? { publisherNames } : {}),
    });
  }
  return { input, claims, answered };
}

async function evaluateBounded(
  input: EvaluateMatrixInput,
  intent: "interactive" | "background",
): Promise<EvaluatedMatrixBatch> {
  const reply = await respond({
    model: config.llmJudgeModel,
    intent,
    instructions: EVALUATE_MATRIX_PROMPT,
    input: [{ role: "user", content: JSON.stringify(input) }],
    schema: { name: "venue_criterion_matrix", schema: EVALUATE_MATRIX_SCHEMA },
    reasoning: "none",
    maxOutputTokens: 4_000,
    timeoutMs: MATRIX_TIMEOUT_MS,
  });
  const answer = parseJson<{ claims?: unknown }>(reply.text);
  if (!answer || !Array.isArray(answer.claims)) {
    throw new Error("matrix response was not parseable structured output");
  }
  return matrixBatchFromAnswer(answer, input, reply.model);
}

type MatrixCacheQuery = Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query">;

/** "refresh" skips judgement reuse but still writes the newly evaluated answer. */
type MatrixCacheMode = "reuse" | "refresh";

interface MatrixCacheRow {
  osm_ref: string;
  criterion_id: string;
  evidence_hash: string;
  claim: EvaluatedInference | null;
  answered: boolean;
}

async function loadMatrixCache(
  q: MatrixCacheQuery,
  input: EvaluateMatrixInput,
): Promise<Map<string, MatrixCacheRow>> {
  const cells = input.places.flatMap((place) => input.criteria.map((criterion) => ({
    osmRef: place.osmRef,
    criterionId: criterion.id,
    evidenceHash: matrixEvidenceHash(place),
  })));
  if (!cells.length) return new Map();
  const rows = (await q.query(
    `SELECT m.osm_ref, m.criterion_id, m.evidence_hash, m.claim, m.answered
       FROM matrix_cache m
       JOIN jsonb_to_recordset($1::jsonb)
         AS wanted(osm_ref text, criterion_id text, evidence_hash text)
         USING (osm_ref, criterion_id, evidence_hash)`,
    [JSON.stringify(cells.map((cell) => ({
      osm_ref: cell.osmRef,
      criterion_id: cell.criterionId,
      evidence_hash: cell.evidenceHash,
    })))],
  )).rows as MatrixCacheRow[];
  return new Map(rows.map((row) => [
    `${row.osm_ref}\u0000${row.criterion_id}\u0000${row.evidence_hash}`,
    { ...row, ...(row.claim ? { claim: cleanEvaluatedInference(row.claim) } : {}) },
  ]));
}

async function storeMatrixBatch(q: MatrixCacheQuery, batch: EvaluatedMatrixBatch): Promise<void> {
  const places = new Map(batch.input.places.map((place) => [place.candidateId, place]));
  const claims = new Map(batch.claims.map((claim) => [
    `${claim.candidateId}\u0000${claim.criterionId}`,
    claim,
  ]));
  const rows = batch.answered.flatMap((cell) => {
    const place = places.get(cell.candidateId);
    if (!place) return [];
    return [{
      osm_ref: place.osmRef,
      criterion_id: cell.criterionId,
      evidence_hash: matrixEvidenceHash(place),
      claim: claims.get(`${cell.candidateId}\u0000${cell.criterionId}`)
        ? cleanEvaluatedInference(claims.get(`${cell.candidateId}\u0000${cell.criterionId}`)!)
        : null,
      answered: true,
    }];
  });
  if (!rows.length) return;
  await q.query(
    `INSERT INTO matrix_cache
       (osm_ref, criterion_id, evidence_hash, evaluated_at, claim, answered)
     SELECT osm_ref, criterion_id, evidence_hash, now(), claim, answered
       FROM jsonb_to_recordset($1::jsonb)
         AS x(osm_ref text, criterion_id text, evidence_hash text,
              claim jsonb, answered boolean)
     ON CONFLICT (osm_ref, criterion_id, evidence_hash) DO UPDATE SET
       evaluated_at = EXCLUDED.evaluated_at,
       claim = EXCLUDED.claim,
       answered = EXCLUDED.answered`,
    [JSON.stringify(rows)],
  );
}

/** Split on both axes and merge every validated cell; no model answer is
 * truncated merely because the caller supplied more than one bounded batch. */
export async function evaluateMatrix(
  input: EvaluateMatrixInput,
  persistBatch?: (batch: EvaluatedMatrixBatch) => Promise<void>,
  cacheDb?: MatrixCacheQuery,
  cacheMode: MatrixCacheMode = "reuse",
  intent: "interactive" | "background" = "background",
): Promise<EvaluatedInference[]> {
  if (!inferenceEnabled()) return [];
  const clean = uniqueInput(input);
  if (clean.places.length === 0 || clean.criteria.length === 0) return [];
  const claims: EvaluatedInference[] = [];
  let cached = new Map<string, MatrixCacheRow>();
  if (cacheDb && cacheMode === "reuse") {
    try {
      cached = await loadMatrixCache(cacheDb, clean);
    } catch {
      // A cache outage may cost a model call but must not stop evaluation.
    }
  }

  const cachedAnswered: EvaluatedMatrixBatch["answered"] = [];
  const cachedClaims: EvaluatedInference[] = [];
  for (const place of clean.places) {
    for (const criterion of clean.criteria) {
      const hit = cached.get(matrixCacheKey(place, criterion));
      if (!hit?.answered) continue;
      cachedAnswered.push({ candidateId: place.candidateId, criterionId: criterion.id });
      // The cache is cross-room by OSM ref. Candidate ids are room-local, so
      // replay the validated result under this input's identity.
      if (hit.claim) cachedClaims.push({
        ...hit.claim,
        candidateId: place.candidateId,
        osmRef: place.osmRef,
        criterionId: criterion.id,
      });
    }
  }
  if (cachedAnswered.length) {
    const batch = { input: clean, claims: cachedClaims, answered: cachedAnswered };
    if (persistBatch) await persistBatch(batch);
    claims.push(...cachedClaims);
  }

  // Group identical missing criterion sets. Every rectangle sent below is all
  // misses, so a hit is never incidentally re-asked alongside another cell.
  const groups = new Map<string, { places: EvaluateMatrixInput["places"]; criteria: Criterion[] }>();
  for (const place of clean.places) {
    const criteria = clean.criteria.filter((criterion) => !cached.has(matrixCacheKey(place, criterion)));
    if (!criteria.length) continue;
    const signature = criteria.map((criterion) => criterion.id).join("\u0000");
    const group = groups.get(signature) ?? { places: [], criteria };
    group.places.push(place);
    groups.set(signature, group);
  }
  for (const group of groups.values()) {
    for (let placeAt = 0; placeAt < group.places.length; placeAt += MAX_MATRIX_PLACES) {
      const places = group.places.slice(placeAt, placeAt + MAX_MATRIX_PLACES);
      for (
        let criterionAt = 0;
        criterionAt < group.criteria.length;
        criterionAt += MAX_MATRIX_CRITERIA
      ) {
        const criteria = group.criteria.slice(criterionAt, criterionAt + MAX_MATRIX_CRITERIA);
        try {
          const batch = await evaluateBounded({ places, criteria }, intent);
          if (cacheDb) {
            await storeMatrixBatch(cacheDb, batch).catch(() => undefined);
          }
          if (persistBatch) await persistBatch(batch);
          claims.push(...batch.claims);
        } catch {
          // A transport, parse, or persistence failure is not an answer. Other
          // bounded batches remain independent and may still be persisted.
        }
      }
    }
  }
  return claims;
}
