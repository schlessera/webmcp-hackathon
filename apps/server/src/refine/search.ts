import { config } from "../config.ts";
import { respond } from "../nl/openai.ts";

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
