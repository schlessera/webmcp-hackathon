import {
  ATTRIBUTE_LABELS,
  ATTRIBUTE_VOCABULARY,
  graded,
  type AttributeStatus,
} from "@webmcp-hackathon/contracts";
import { config } from "../config.ts";
import { parseJson, respond } from "../nl/openai.ts";
import { cleanEvidenceText, hasWholeTextSpan } from "./text.ts";

/**
 * Evidence-bounded inference (PLAN D4). The model may only lean on a closed
 * attribute vocabulary and quote text it was actually shown. Its confidence
 * is only an input to a stricter source cap enforced below; it never creates
 * a verified status.
 */

export const INFERABLE_KEYS = ATTRIBUTE_VOCABULARY.filter(
  (key) => key !== "cuisine",
);
export type InferableKey = (typeof INFERABLE_KEYS)[number];
export type InferenceTextSource = "osm" | "web" | "menu" | "wikidata";
type EvidenceSource = "name_category" | "description_website" | "menu";

export interface InferInput {
  name: string;
  category: string;
  cuisine?: string[];
  texts: Array<{ source: InferenceTextSource; text: string }>;
  keys: string[];
}

export interface InferredClaim {
  key: string;
  lean: "yes" | "no";
  confidence: number;
  evidence: string;
  source: string;
  /** Price carries a band; value-specific matrix criteria may carry their tokens. */
  value?: string | number;
  /** Matrix-only provenance: direct statement rather than indirect inference. */
  explicit?: boolean;
  sourceUrl?: string;
  /** Bounded reread material captured when the evidence span was validated. */
  context?: string;
  pageTitle?: string;
  publisherNames?: string[];
  adjudication?: {
    evidenceHash: string;
    verdict: "yes" | "no" | "unclear";
    explicit: boolean;
    publisher: "venue" | "chain" | "third_party" | "unknown";
    quote: string;
    observedAt: string;
  };
}

export type StoredInference =
  | (InferredClaim & {
      observedAt: string;
      /** A merge-time disagreement, shown beside the retained evidence. */
      note?: string;
    })
  | {
      omitted: true;
      observedAt: string;
      searchDay?: string;
      searchAttempts?: number;
    };

export const INFERENCE_CONFIDENCE_CAPS: Record<EvidenceSource, number> = {
  name_category: 0.45,
  description_website: 0.6,
  menu: 0.69,
};

export const INFERENCE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["claims"],
  properties: {
    claims: {
      type: "array",
      maxItems: 12,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "lean", "confidence", "evidence", "evidenceSource", "value"],
        properties: {
          key: { type: "string", enum: [...INFERABLE_KEYS] },
          lean: { type: "string", enum: ["yes", "no"] },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          evidence: { type: "string", minLength: 12, maxLength: 240 },
          evidenceSource: {
            type: "string",
            enum: ["name_category", "description_website", "menu"],
          },
          value: { type: ["integer", "null"], minimum: 1, maximum: 4 },
        },
      },
    },
  },
} as const;

export const INFERENCE_PROMPT = [
  "Extract cautious, evidence-backed venue attribute inferences for a planning tool.",
  "Return one claim for each requested key when the supplied material supports a cautious lean; otherwise omit that key.",
  "Abstain rather than inventing: every claim needs direct support in the supplied material, and omission remains the correct result when that support is absent.",
  "Only use requested keys. Boolean keys use lean=yes or lean=no and value=null. For price-level, value must be a band from 1 (cheap) to 4 (expensive); omit it unless that band is supported.",
  "evidence must be a verbatim substring copied from the supplied name, category, cuisine tokens, or texts. Never paraphrase it.",
  "evidenceSource must identify where that exact span occurs: name_category for name/category/cuisine, description_website for osm/web/wikidata text, or menu for menu text.",
  "Use each text item's source field, not what its prose resembles: source=web/osm/wikidata requires description_website, and only source=menu permits menu.",
  "An explicitly described service, facility, or menu item may support lean=yes. Lean=no requires explicit negative wording; silence, missing navigation labels, or a single item without the feature is not negative evidence.",
  "confidence is the probability that the attribute genuinely holds, from 0 to 1. It will be capped by the server. Never claim that an inference is verified.",
  "Output only the JSON object required by the schema.",
].join("\n");

interface DraftClaim {
  key?: unknown;
  lean?: unknown;
  confidence?: unknown;
  evidence?: unknown;
  evidenceSource?: unknown;
  value?: unknown;
}

/** Collapse whitespace runs to one ASCII space before substring comparison. */
export function normalizeEvidence(text: string): string {
  return cleanEvidenceText(text);
}

/** Evidence is display/context data, never markup or an instruction channel. */
export function sanitizeInferenceNote(text: string): string {
  return cleanEvidenceText(text);
}

function evidencePools(input: InferInput): Record<EvidenceSource, string[]> {
  return {
    name_category: [input.name, input.category, ...(input.cuisine ?? [])]
      .map(normalizeEvidence)
      .filter(Boolean),
    description_website: input.texts
      .filter((t) => t.source !== "menu")
      .map((t) => normalizeEvidence(t.text))
      .filter(Boolean),
    menu: input.texts
      .filter((t) => t.source === "menu")
      .map((t) => normalizeEvidence(t.text))
      .filter(Boolean),
  };
}

const WORDS = /[\p{L}\p{N}]+/gu;

function hasWholeSpan(text: string, evidence: string): boolean {
  return hasWholeTextSpan(text, evidence);
}

function echoesAttributeQuestion(key: InferableKey, evidence: string): boolean {
  const needle = evidence.toLocaleLowerCase();
  const label = ATTRIBUTE_LABELS[key]?.toLocaleLowerCase() ?? "";
  return key.toLocaleLowerCase().includes(needle) || label.includes(needle);
}

export function inferenceEnabled(): boolean {
  return (
    process.env.ENRICH_NETWORK !== "0" &&
    process.env.INFER !== "0" &&
    Boolean(process.env.OPENAI_API_KEY)
  );
}

/** Pure validation of a model answer; exported so every safety rule is unit-tested. */
export function claimsFromAnswer(
  answer: unknown,
  input: InferInput,
  model: string,
): InferredClaim[] {
  const requested = new Set(
    input.keys.filter((key): key is InferableKey =>
      (INFERABLE_KEYS as readonly string[]).includes(key),
    ),
  );
  const pools = evidencePools(input);
  const drafts = (answer as { claims?: unknown } | null)?.claims;
  if (!Array.isArray(drafts)) return [];
  const claims: InferredClaim[] = [];
  for (const raw of drafts as DraftClaim[]) {
    if (!raw || typeof raw !== "object") continue;
    const key = String(raw.key ?? "");
    if (!requested.has(key as InferableKey)) continue;
    if (claims.some((claim) => claim.key === key)) continue;
    if (raw.lean !== "yes" && raw.lean !== "no") continue;
    const evidenceSource = String(raw.evidenceSource ?? "") as EvidenceSource;
    if (!(evidenceSource in INFERENCE_CONFIDENCE_CAPS)) continue;
    const evidence = normalizeEvidence(String(raw.evidence ?? ""));
    if (evidence.length < 12 || (evidence.match(WORDS)?.length ?? 0) < 2) continue;
    if (echoesAttributeQuestion(key as InferableKey, evidence)) continue;
    if (!pools[evidenceSource].some((text) => hasWholeSpan(text, evidence))) continue;
    const safeEvidence = sanitizeInferenceNote(evidence);
    if (!safeEvidence) continue;
    const rawConfidence = Number(raw.confidence);
    if (!Number.isFinite(rawConfidence) || rawConfidence <= 0) continue;
    const confidence = Math.min(rawConfidence, INFERENCE_CONFIDENCE_CAPS[evidenceSource]);
    const value = Number(raw.value);
    if (key === "price-level" && (!Number.isInteger(value) || value < 1 || value > 4)) continue;
    if (key === "price-level" && raw.lean !== "yes") continue;
    claims.push({
      key: key as InferableKey,
      lean: raw.lean,
      confidence,
      evidence: safeEvidence,
      source: `infer:${model}`,
      ...(key === "price-level" ? { value } : {}),
    });
  }
  return claims;
}

/** One fast-tier model call. Off switches return before touching the transport. */
export async function inferAttributes(input: InferInput): Promise<InferredClaim[]> {
  if (!inferenceEnabled()) return [];
  const keys = [...new Set(input.keys)].filter((key) =>
    (INFERABLE_KEYS as readonly string[]).includes(key),
  );
  if (keys.length === 0) return [];
  const model = config.nlFastModel;
  const reply = await respond({
    model,
    intent: "background",
    instructions: INFERENCE_PROMPT,
    input: [
      {
        role: "user",
        content: JSON.stringify({
          name: input.name,
          category: input.category,
          cuisine: input.cuisine ?? [],
          texts: input.texts,
          keys,
        }),
      },
    ],
    schema: { name: "venue_attribute_inference", schema: INFERENCE_SCHEMA },
    reasoning: "none",
    maxOutputTokens: 1200,
    timeoutMs: 12_000,
  });
  return claimsFromAnswer(parseJson(reply.text), { ...input, keys }, reply.model);
}

interface AttributeLike {
  key: string;
  status: string;
  value?: string | number;
  source?: string;
  observedAt?: string;
  confidence?: number;
  note?: string;
  sourceUrl?: string;
  explicit?: boolean;
}

/** Inference runs after record → web → guess and fills only a remaining unknown. */
export function applyInferredAttributes<T extends AttributeLike>(
  attributes: T[],
  inferred: Record<string, StoredInference> | null | undefined,
): T[] {
  if (!inferred || Object.keys(inferred).length === 0) return attributes;
  const out = attributes.map((attribute) => ({ ...attribute }));
  for (const [key, claim] of Object.entries(inferred)) {
    const isCuisineCriterion = key.startsWith("cuisine:");
    if (!(INFERABLE_KEYS as readonly string[]).includes(key) && !isCuisineCriterion) continue;
    if ("omitted" in claim) continue;
    const existing = out.find((attribute) => attribute.key === key);
    if (existing && existing.status !== "unknown") continue;
    const status: AttributeStatus = graded(claim.lean === "yes", claim.confidence);
    const recordGrade =
      claim.explicit === true &&
      (claim.source.startsWith("web:") || claim.source.startsWith("adjudicated:")) &&
      claim.confidence >= 0.7;
    if ((status === "verified_true" || status === "verified_false") && !recordGrade) continue;
    const patch = {
      status,
      ...(claim.value !== undefined ? { value: claim.value } : {}),
      source: claim.source,
      observedAt: claim.observedAt,
      confidence: claim.confidence,
      // A disagreement is recorded beside the span the claim still rests on,
      // never instead of it: the reader needs to see both what was found and
      // that a later read leaned the other way.
      note: [
        sanitizeInferenceNote(claim.evidence),
        claim.note ? sanitizeInferenceNote(claim.note) : "",
      ].filter(Boolean).join(" · "),
      ...(claim.explicit !== undefined ? { explicit: claim.explicit } : {}),
      ...(claim.sourceUrl ? { sourceUrl: claim.sourceUrl } : {}),
    };
    if (existing) Object.assign(existing, patch);
    else out.push({ key, ...patch } as T);
  }
  return out;
}
