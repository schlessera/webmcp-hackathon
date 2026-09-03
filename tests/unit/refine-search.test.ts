import { afterEach, describe, expect, it } from "vitest";
import {
  openAiSearchProvider,
  setSearchFetch,
  tavilySearchProvider,
} from "../../apps/server/src/refine/search.ts";
import { setTransport } from "../../apps/server/src/nl/openai.ts";

afterEach(() => {
  setTransport(null);
  setSearchFetch(null);
});

describe("refinement web search", () => {
  it("uses one low-context domain search and keeps only cited spans", async () => {
    let wire: Record<string, unknown> | undefined;
    setTransport(async (body) => {
      wire = body;
      return {
        output: [
          { type: "web_search_call", id: "search_1", action: { type: "search" } },
          {
            type: "message",
            content: [{
              type: "output_text",
              text: "Free wireless internet is available. Unsupported prose.",
              annotations: [
                { type: "url_citation", start_index: 0, end_index: 35, url: "https://place.example/visit", title: "Visit" },
                { type: "url_citation", start_index: 200, end_index: 220, url: "https://bad.example" },
              ],
            }],
          },
        ],
      };
    });
    expect(await openAiSearchProvider.search("Alpha Berlin free wifi", {
      domains: ["place.example"],
    })).toEqual([{
      url: "https://place.example/visit",
      title: "Visit",
      snippet: "Free wireless internet is available",
    }]);
    expect(wire).toMatchObject({
      tools: [{
        type: "web_search",
        filters: { allowed_domains: ["place.example"] },
        search_context_size: "low",
      }],
      include: ["web_search_call.action.sources"],
      store: false,
    });
  });

  it("maps Tavily results onto the same thin interface", async () => {
    process.env.TAVILY_API_KEY = "test";
    setSearchFetch(async () => new Response(JSON.stringify({
      results: [{ url: "https://source.example", title: "Source", content: "  Exact   source words  " }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    expect(await tavilySearchProvider.search("query")).toEqual([{
      url: "https://source.example",
      title: "Source",
      snippet: "Exact source words",
    }]);
    delete process.env.TAVILY_API_KEY;
  });
});
