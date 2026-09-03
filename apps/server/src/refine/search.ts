import { config } from "../config.ts";
import { graded, normalizeQuestion, type Criterion } from "@webmcp-hackathon/contracts";
import {
  echoesCriterion,
  hasWholeSpan,
  MATRIX_CONFIDENCE_CAPS,
  type EvaluatedInference,
  type MatrixEvidenceBucket,
} from "../enrich/evaluate.ts";
import { normalizeEvidence, sanitizeInferenceNote } from "../enrich/infer.ts";
import { parseJson, respond, type Reply } from "../nl/openai.ts";

export interface SearchResult {
  url: string;
  title: string;
  snippet: string;
}

export interface SearchOptions {
  domains?: string[];
}

export interface SearchProvider {
  search(query: string, opts?: SearchOptions): Promise<SearchResult[]>;
}

export interface CombinedSearchInput {
  candidateId: string;
  osmRef: string;
  name: string;
  category: string;
  query: string;
  criteria: Criterion[];
  source: Extract<MatrixEvidenceBucket, "domain_search" | "open_web_search">;
  domains?: string[];
}

const COMBINED_SEARCH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["claims"],
  properties: {
    claims: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["criterionId", "lean", "confidence", "evidence", "sourceUrl"],
        properties: {
          criterionId: { type: "string", minLength: 1 },
          lean: { type: "string", enum: ["yes", "no", "abstain"] },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          evidence: { type: "string", maxLength: 400 },
          sourceUrl: { type: ["string", "null"] },
        },
      },
    },
  },
} as const;

const COMBINED_SEARCH_PROMPT = [
  "Search the web for direct evidence about this one place and evaluate every supplied criterion.",
  "Return exactly one row per criterion. Use lean=abstain, confidence=0, evidence=\"\", and sourceUrl=null when no cited source directly supports yes or no.",
  "For yes or no, evidence must be an exact verbatim source phrase, at least 12 characters and two words, reproduced in this answer, and sourceUrl must be the cited URL supporting it.",
  "A no needs explicit negative wording. Silence or a missing mention always requires abstain.",
  "Never repeat a criterion, key, label, or the user's question as evidence. Never claim verification.",
  "Use only supplied criterionId values and output only the strict JSON object.",
].join("\n");

interface CombinedDraftClaim {
  criterionId?: unknown;
  lean?: unknown;
  confidence?: unknown;
  evidence?: unknown;
  sourceUrl?: unknown;
}

const WORDS = /[\p{L}\p{N}]+/gu;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function cleanDomains(domains: string[] | undefined): string[] {
  return [...new Set((domains ?? []).flatMap((domain) => {
    const value = domain.trim().toLowerCase().replace(/^www\./, "");
    return /^[a-z0-9.-]+$/.test(value) && value.includes(".") ? [value] : [];
  }))].slice(0, 100);
}

function safeHttpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? value : null;
  } catch {
    return null;
  }
}

/** Compare citation URLs after removing only the tracking parameter the
 * Responses web tool appends. Other query parameters remain identity-bearing. */
export function normalizedCitationUrl(value: string): string | null {
  const safe = safeHttpUrl(value);
  if (!safe) return null;
  const url = new URL(safe);
  url.hash = "";
  url.searchParams.delete("utm_source");
  return url.toString();
}

/**
 * The URLs the built-in tool actually retrieved in this call, from the
 * `web_search_call.action.sources` items the request asks for.
 *
 * Under a strict JSON schema the Responses API emits NO `url_citation`
 * annotations — the answer is the JSON object, not cited prose — so the
 * retrieved-source list is the only server-side anchor a combined answer has.
 * Verified live 2026-09-03: schema plus web_search returns one search call
 * with sources and an empty citation array.
 */
export function retrievedSources(reply: Pick<Reply, "citations" | "webSearchCalls">): Set<string> {
  const urls = new Set<string>();
  for (const citation of reply.citations ?? []) {
    const normalized = normalizedCitationUrl(citation.url);
    if (normalized) urls.add(normalized);
  }
  for (const raw of reply.webSearchCalls ?? []) {
    const action = (raw as { action?: { sources?: unknown } }).action;
    for (const source of (action?.sources as Array<{ url?: unknown }>) ?? []) {
      if (typeof source?.url !== "string") continue;
      const normalized = normalizedCitationUrl(source.url);
      if (normalized) urls.add(normalized);
    }
  }
  return urls;
}

/**
 * Validate one combined search answer. The guarantee is materially weaker
 * than split mode, and the weakness is worth naming precisely.
 *
 * Split holds the snippet text itself, so a span is checked against words the
 * server read. Combined never sees the page. Its answer IS the JSON object, so
 * checking that the span occurs in the answer proves nothing — the span is in
 * the answer because the model wrote it there. What is actually enforced is
 * that the cited URL is one the tool really retrieved in this same call, plus
 * the length, echo, cap and never-verified rules. That makes a combined claim
 * a supervised guess about a real page, not a quotation the server checked.
 */
export function combinedClaimsFromReply(
  reply: Pick<Reply, "text" | "citations" | "model" | "webSearchCalls">,
  input: CombinedSearchInput,
  observedAt = new Date().toISOString(),
): EvaluatedInference[] {
  const answer = normalizeEvidence(reply.text ?? "");
  const citedUrls = retrievedSources(reply);
  const criteria = new Map(input.criteria.map((criterion) => [criterion.id, criterion]));
  const drafts = (parseJson<{ claims?: unknown }>(reply.text)?.claims ?? []) as unknown;
  if (!Array.isArray(drafts)) return [];
  const seen = new Set<string>();
  const claims: EvaluatedInference[] = [];
  for (const raw of drafts as CombinedDraftClaim[]) {
    if (!raw || typeof raw !== "object") continue;
    const criterionId = String(raw.criterionId ?? "");
    if (seen.has(criterionId)) continue;
    const criterion = criteria.get(criterionId);
    if (!criterion || raw.lean === "abstain") continue;
    if (raw.lean !== "yes" && raw.lean !== "no") continue;
    if (typeof raw.sourceUrl !== "string") continue;
    const sourceUrl = normalizedCitationUrl(raw.sourceUrl);
    if (!sourceUrl || !citedUrls.has(sourceUrl)) continue;
    const evidence = normalizeEvidence(String(raw.evidence ?? ""));
    if (evidence.length < 12 || (evidence.match(WORDS)?.length ?? 0) < 2) continue;
    if (echoesCriterion(criterion, evidence)) continue;
    if (!hasWholeSpan(answer, evidence)) continue;
    const safeEvidence = sanitizeInferenceNote(evidence);
    if (!safeEvidence || typeof raw.confidence !== "number") continue;
    if (!Number.isFinite(raw.confidence) || raw.confidence <= 0) continue;
    const confidence = Math.min(raw.confidence, MATRIX_CONFIDENCE_CAPS[input.source]);
    const status = graded(raw.lean === "yes", confidence);
    if (status === "verified_true" || status === "verified_false") continue;
    seen.add(criterionId);
    claims.push({
      candidateId: input.candidateId,
      osmRef: input.osmRef,
      criterionId,
      key: criterion.kind === "key" ? criterion.key : criterion.id,
      lean: raw.lean,
      status,
      confidence,
      evidence: safeEvidence,
      source: `infer:${reply.model}:${input.source}`,
      sourceIndex: 0,
      observedAt,
      sourceUrl,
      ...(criterion.kind === "question"
        ? { question: normalizeQuestion(criterion.text), label: criterion.label }
        : {}),
    });
  }
  return claims;
}

/** One Responses call does both the search and the row evaluation. */
export async function combinedSearch(input: CombinedSearchInput): Promise<EvaluatedInference[]> {
  const domains = cleanDomains(input.domains);
  const reply = await respond({
    model: config.nlFastModel,
    instructions: COMBINED_SEARCH_PROMPT,
    input: [{
      role: "user",
      content: JSON.stringify({
        query: input.query,
        place: { name: input.name, category: input.category },
        criteria: input.criteria,
      }),
    }],
    schema: { name: "venue_search_matrix_row", schema: COMBINED_SEARCH_SCHEMA },
    tools: [{
      type: "web_search",
      ...(domains.length ? { filters: { allowed_domains: domains } } : {}),
      search_context_size: "low",
    }],
    include: ["web_search_call.action.sources"],
    reasoning: "none",
    maxOutputTokens: 2_400,
    timeoutMs: 30_000,
  });
  return combinedClaimsFromReply(reply, input);
}

/**
 * Responses annotates an answer with the *inline citation marker* — the
 * `([domain](url))` group — not with the sentence that marker supports. Taking
 * the annotated span verbatim therefore yields a bare link, which can never be
 * evidence for anything. The supported statement is the prose that runs up to
 * the marker, so that is what a snippet is: the text since the previous
 * citation, with the markers and emphasis removed so a quoted span matches.
 */
export function citedSpans(
  text: string,
  citations: Array<{ url: string; title?: string; start?: number; end?: number }>,
): SearchResult[] {
  const ordered = citations
    .filter((citation) => Number.isInteger(citation.start) && Number.isInteger(citation.end))
    .sort((a, b) => a.start! - b.start! || a.end! - b.end!);
  const found = new Map<string, SearchResult>();
  let readFrom = 0;
  for (const citation of ordered) {
    const url = safeHttpUrl(citation.url);
    const start = citation.start!;
    const end = citation.end!;
    if (start < 0 || end < start || end > text.length) continue;
    const before = readableSpan(text.slice(Math.min(readFrom, start), start));
    readFrom = Math.max(readFrom, end);
    if (!url || !before) continue;
    const existing = found.get(url);
    // Several markers can follow one statement; keep the fullest reading.
    if (existing && existing.snippet.length >= before.length) continue;
    found.set(url, { url, title: citation.title?.trim() || url, snippet: before });
  }
  if (found.size === 0) {
    // An answer with no positioned annotation still carries its sources.
    const whole = readableSpan(text);
    for (const citation of citations) {
      const url = safeHttpUrl(citation.url);
      if (url && whole) found.set(url, { url, title: citation.title?.trim() || url, snippet: whole });
    }
  }
  return [...found.values()];
}

/** Citation markers and emphasis are the model's own punctuation, not the
 * source's words; a span carrying them can never be quoted back verbatim. */
function readableSpan(raw: string): string {
  const cleaned = raw
    .replace(/\(\[[^\]]*\]\([^)]*\)\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length >= 12 ? cleaned.slice(0, 1_200) : "";
}

export const openAiSearchProvider: SearchProvider = {
  async search(query, opts = {}) {
    const domains = cleanDomains(opts.domains);
    const reply = await respond({
      model: config.nlFastModel,
      instructions: [
        "Find direct evidence that answers every criterion named in the request for this one place.",
        "Keep exact source wording in the answer and cite each supported statement inline.",
        "Silence is not negative evidence. Omit unsupported claims.",
      ].join("\n"),
      input: [{ role: "user", content: query }],
      tools: [{
        type: "web_search",
        ...(domains.length ? { filters: { allowed_domains: domains } } : {}),
        search_context_size: "low",
      }],
      include: ["web_search_call.action.sources"],
      reasoning: "none",
      maxOutputTokens: 1_200,
      timeoutMs: 30_000,
    });
    return citedSpans(reply.text ?? "", reply.citations ?? []);
  },
};

let searchFetch: FetchLike = fetch;

/** Test seam for the Tavily HTTP transport. */
export function setSearchFetch(next: FetchLike | null): void {
  searchFetch = next ?? fetch;
}

export const tavilySearchProvider: SearchProvider = {
  async search(query, opts = {}) {
    if (!process.env.TAVILY_API_KEY) return [];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await searchFetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          api_key: process.env.TAVILY_API_KEY,
          query,
          search_depth: "basic",
          max_results: 5,
          ...(cleanDomains(opts.domains).length
            ? { include_domains: cleanDomains(opts.domains) }
            : {}),
        }),
        signal: controller.signal,
      });
      if (!response.ok) return [];
      const body = await response.json() as {
        results?: Array<{ url?: unknown; title?: unknown; content?: unknown }>;
      };
      return (body.results ?? []).flatMap((result) => {
        if (typeof result.url !== "string" || typeof result.content !== "string") return [];
        const url = safeHttpUrl(result.url);
        if (!url) return [];
        const snippet = result.content.replace(/\s+/g, " ").trim().slice(0, 2_000);
        if (!snippet) return [];
        return [{
          url,
          title: typeof result.title === "string" && result.title.trim()
            ? result.title.trim()
            : url,
          snippet,
        }];
      });
    } finally {
      clearTimeout(timer);
    }
  },
};

let injectedProvider: SearchProvider | null = null;

/** Replace the whole provider in tests; null restores environment selection. */
export function setSearchProvider(next: SearchProvider | null): void {
  injectedProvider = next;
}

export function search(
  query: string,
  opts?: SearchOptions,
): Promise<SearchResult[]> {
  const provider = injectedProvider ?? (
    process.env.SEARCH_PROVIDER === "tavily" ? tavilySearchProvider : openAiSearchProvider
  );
  return provider.search(query, opts);
}
