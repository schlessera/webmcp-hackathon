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
      timeoutMs: 20_000,
    });
    const text = reply.text ?? "";
    const found = new Map<string, SearchResult>();
    for (const citation of reply.citations ?? []) {
      if (!Number.isInteger(citation.start) || !Number.isInteger(citation.end)) continue;
      const start = citation.start!;
      const end = citation.end!;
      if (start < 0 || end <= start || end > text.length) continue;
      const snippet = text.slice(start, end).replace(/\s+/g, " ").trim();
      if (!snippet) continue;
      found.set(citation.url, {
        url: citation.url,
        title: citation.title?.trim() || citation.url,
        snippet,
      });
    }
    return [...found.values()];
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
        const snippet = result.content.replace(/\s+/g, " ").trim();
        if (!snippet) return [];
        return [{
          url: result.url,
          title: typeof result.title === "string" && result.title.trim()
            ? result.title.trim()
            : result.url,
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
