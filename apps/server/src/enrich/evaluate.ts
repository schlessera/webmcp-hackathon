import {
  graded,
  normalizeQuestion,
  type AttributeStatus,
  type Criterion,
} from "@webmcp-hackathon/contracts";
import { config } from "../config.ts";
import { parseJson, respond } from "../nl/openai.ts";
import {
  inferenceEnabled,
  INFERENCE_CONFIDENCE_CAPS,
  normalizeEvidence,
  sanitizeInferenceNote,
  type InferenceTextSource,
} from "./infer.ts";

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
export const MATRIX_TIMEOUT_MS = Number(process.env.MATRIX_TIMEOUT_MS ?? 45_000);

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

const WORD_CHARACTER = /[\p{L}\p{N}]/u;
const WORDS = /[\p{L}\p{N}]+/gu;

export function hasWholeSpan(text: string, evidence: string): boolean {
  const haystack = text.toLocaleLowerCase();
  const needle = evidence.toLocaleLowerCase();
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return false;
    const before = haystack.slice(0, at);
    const after = haystack.slice(at + needle.length);
    const leftIsWord = WORD_CHARACTER.test([...before].at(-1) ?? "");
    const rightIsWord = WORD_CHARACTER.test([...after][0] ?? "");
    if (!leftIsWord && !rightIsWord) return true;
    from = at + 1;
  }
}

/** A bounded, normalized window around the exact validated evidence span. */
export function evidenceContext(text: string, evidence: string): string | undefined {
  const source = normalizeEvidence(text);
  const at = source.toLocaleLowerCase().indexOf(evidence.toLocaleLowerCase());
  if (at < 0) return undefined;
  const start = Math.max(0, at - 400);
  const end = Math.min(source.length, at + evidence.length + 400);
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
      text: normalizeEvidence(item.text),
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
  return { ...place, texts };
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
      ? sanitizeInferenceNote(sourceText.title).slice(0, 160)
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

async function evaluateBounded(input: EvaluateMatrixInput): Promise<EvaluatedMatrixBatch> {
  const reply = await respond({
    model: config.nlFastModel,
    instructions: EVALUATE_MATRIX_PROMPT,
    input: [{ role: "user", content: JSON.stringify(input) }],
    schema: { name: "venue_criterion_matrix", schema: EVALUATE_MATRIX_SCHEMA },
    reasoning: "none",
    maxOutputTokens: 8_000,
    timeoutMs: MATRIX_TIMEOUT_MS,
  });
  const answer = parseJson<{ claims?: unknown }>(reply.text);
  if (!answer || !Array.isArray(answer.claims)) {
    throw new Error("matrix response was not parseable structured output");
  }
  return matrixBatchFromAnswer(answer, input, reply.model);
}

/** Split on both axes and merge every validated cell; no model answer is
 * truncated merely because the caller supplied more than one bounded batch. */
export async function evaluateMatrix(
  input: EvaluateMatrixInput,
  persistBatch?: (batch: EvaluatedMatrixBatch) => Promise<void>,
): Promise<EvaluatedInference[]> {
  if (!inferenceEnabled()) return [];
  const clean = uniqueInput(input);
  if (clean.places.length === 0 || clean.criteria.length === 0) return [];
  const claims: EvaluatedInference[] = [];
  for (let placeAt = 0; placeAt < clean.places.length; placeAt += MAX_MATRIX_PLACES) {
    const places = clean.places.slice(placeAt, placeAt + MAX_MATRIX_PLACES);
    for (
      let criterionAt = 0;
      criterionAt < clean.criteria.length;
      criterionAt += MAX_MATRIX_CRITERIA
    ) {
      const criteria = clean.criteria.slice(criterionAt, criterionAt + MAX_MATRIX_CRITERIA);
      try {
        const batch = await evaluateBounded({ places, criteria });
        if (persistBatch) await persistBatch(batch);
        claims.push(...batch.claims);
      } catch {
        // A transport, parse, or persistence failure is not an answer. Other
        // bounded batches remain independent and may still be persisted.
      }
    }
  }
  return claims;
}
