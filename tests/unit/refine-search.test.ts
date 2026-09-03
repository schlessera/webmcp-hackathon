import { afterEach, describe, expect, it } from "vitest";
import {
  citedSpans,
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
  it("uses one low-context domain search and reads the statement a marker cites", async () => {
    let wire: Record<string, unknown> | undefined;
    // Responses annotates the inline "([domain](url))" marker, never the
    // sentence it supports, so the evidence is the prose that runs up to it.
    const text = "Free wireless internet is available. ([place.example](https://place.example/visit))" +
      "\n\nThe terrace seats forty. ([other.example](https://other.example/terrace))";
    const firstMarker = text.indexOf(" ([place.example");
    const firstMarkerEnd = text.indexOf("))") + 2;
    const secondMarker = text.indexOf(" ([other.example");
    setTransport(async (body) => {
      wire = body;
      return {
        output: [
          { type: "web_search_call", id: "search_1", action: { type: "search" } },
          {
            type: "message",
            content: [{
              type: "output_text",
              text,
              annotations: [
                { type: "url_citation", start_index: firstMarker, end_index: firstMarkerEnd, url: "https://place.example/visit", title: "Visit" },
                { type: "url_citation", start_index: secondMarker, end_index: text.length, url: "https://other.example/terrace" },
                { type: "url_citation", start_index: 4, end_index: 2, url: "ftp://nope.example" },
              ],
            }],
          },
        ],
      };
    });
    expect(await openAiSearchProvider.search("Alpha Berlin free wifi", {
      domains: ["place.example"],
    })).toEqual([
      {
        url: "https://place.example/visit",
        title: "Visit",
        snippet: "Free wireless internet is available.",
      },
      {
        url: "https://other.example/terrace",
        title: "https://other.example/terrace",
        snippet: "The terrace seats forty.",
      },
    ]);
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

  it("never returns a bare citation marker as evidence", () => {
    const text = "([place.example](https://place.example/visit))";
    expect(citedSpans(text, [
      { url: "https://place.example/visit", start: 0, end: text.length },
    ])).toEqual([]);
  });

  it("falls back to the whole answer when no marker is positioned", () => {
    expect(citedSpans("Free wireless internet is available.", [
      { url: "https://place.example/visit", title: "Visit" },
    ])).toEqual([{
      url: "https://place.example/visit",
      title: "Visit",
      snippet: "Free wireless internet is available.",
    }]);
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
