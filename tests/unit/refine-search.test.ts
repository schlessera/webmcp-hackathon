import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  citedSpans,
  findVerbatimPageSpan,
  openAiSearchProvider,
  parallelSearchProvider,
  parseParallelResponse,
  searchProviderId,
  setParallelFetch,
  setSearchFetch,
  tavilySearchProvider,
} from "../../apps/server/src/refine/search.ts";
import { buildRefinementQuery } from "../../apps/server/src/refine/worker.ts";
import parallelFixture from "./fixtures/parallel-search.json" with { type: "json" };
import { setTransport } from "../../apps/server/src/nl/openai.ts";

afterEach(() => {
  setTransport(null);
  setSearchFetch(null);
  setParallelFetch(null);
  delete process.env.PARALLEL_API_KEY;
  delete process.env.SEARCH_PROVIDER;
  vi.unstubAllEnvs();
});

beforeEach(() => vi.stubEnv("LLM_PROVIDER", "openrouter"));

describe("refinement web search", () => {
  it("uses one low-context domain search and reads the statement a marker cites", async () => {
    let wire: Record<string, unknown> | undefined;
    // OpenRouter supplies a source excerpt on each zero-offset annotation.
    const text = "Free wireless internet is available. ([place.example](https://place.example/visit))" +
      "\n\nThe terrace seats forty. ([other.example](https://other.example/terrace))";
    const firstMarker = text.indexOf(" ([place.example");
    const firstMarkerEnd = text.indexOf("))") + 2;
    const secondMarker = text.indexOf(" ([other.example");
    setTransport(async (body) => {
      wire = body;
      return {
        output: [
          { type: "openrouter:web_search", id: "search_1", action: { type: "search" } },
          {
            type: "message",
            content: [{
              type: "output_text",
              text,
              annotations: [
                { type: "url_citation", start_index: 0, end_index: 0, url: "https://place.example/visit", title: "Visit", content: "Free wireless internet is available." },
                { type: "url_citation", start_index: 0, end_index: 0, url: "https://other.example/terrace", content: "The terrace seats forty." },
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
        type: "openrouter:web_search",
        parameters: {
          allowed_domains: ["place.example"],
          search_context_size: "low",
        },
      }],
      store: false,
    });
    expect(wire).not.toHaveProperty("include");
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

  it("keeps separate prose for citation markers following separate paragraphs", () => {
    const first = "Dogs are welcome in the covered courtyard.";
    const markerA = " ([one.example](https://one.example/dogs))";
    const second = "The rear entrance has a permanent step-free ramp.";
    const markerB = " ([two.example](https://two.example/access))";
    const text = `${first}${markerA}\n\n${second}${markerB}`;
    expect(citedSpans(text, [
      { url: "https://one.example/dogs", start: first.length, end: first.length + markerA.length },
      { url: "https://two.example/access", start: text.length - markerB.length, end: text.length },
    ])).toEqual([
      { url: "https://one.example/dogs", title: "https://one.example/dogs", snippet: first },
      { url: "https://two.example/access", title: "https://two.example/access", snippet: second },
    ]);
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

  it("parses Parallel results and proves its optimized excerpt is not itself a page substring", () => {
    const [result] = parseParallelResponse(parallelFixture.response);
    expect(result).toMatchObject({
      url: "https://venue.example/connectivity",
      title: "Venue connectivity",
    });
    const pageText = "Visit\nFree wireless internet is available throughout the dining room.";
    expect(pageText).not.toContain(result.excerpts[0]);
    expect(findVerbatimPageSpan(result.excerpts[0], pageText, "Venue Berlin wifi"))
      .toBe("Free wireless internet is available throughout the dining room.");
  });

  it("uses fast mode and fetches at most two pages to recover literal spans", async () => {
    process.env.PARALLEL_API_KEY = "test";
    let apiBody: Record<string, unknown> | undefined;
    let pageFetches = 0;
    setParallelFetch(async (url, init) => {
      if (url === "https://api.parallel.ai/v1/search") {
        apiBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({
          results: [
            ...parallelFixture.response.results,
            { ...parallelFixture.response.results[0], url: "https://second.example/page", title: "Second" },
            { ...parallelFixture.response.results[0], url: "https://third.example/page", title: "Third" },
          ],
        });
      }
      pageFetches += 1;
      return new Response(parallelFixture.pageHtml, {
        headers: { "content-type": "text/html" },
      });
    });
    const results = await parallelSearchProvider.search("Venue Berlin wifi", {
      domains: ["venue.example"],
    });
    expect(apiBody).toMatchObject({
      objective: "Venue Berlin wifi",
      search_queries: ["Venue Berlin wifi"],
      mode: "fast",
      advanced_settings: {
        source_policy: { include_domains: ["venue.example"] },
      },
    });
    expect(pageFetches).toBe(2);
    expect(results).toHaveLength(2);
    expect(results[0].snippet).toBe("Free wireless internet is available throughout the dining room.");
  });

  it("keeps a private predicate out of the request sent to Parallel", async () => {
    process.env.PARALLEL_API_KEY = "test";
    const privateSentence = "private-zebra needs a silent courtyard";
    const query = buildRefinementQuery({
      name: "Venue",
      searchCriteria: [{ id: "wifi", kind: "key", key: "wifi", label: "wi-fi" }],
    }, { city: "Berlin", label: "Berlin Mitte", countryCode: "DE" });
    let wire = "";
    setParallelFetch(async (url, init) => {
      if (url.includes("api.parallel.ai")) {
        wire = String(init?.body ?? "");
        return Response.json(parallelFixture.response);
      }
      return new Response(parallelFixture.pageHtml, { headers: { "content-type": "text/html" } });
    });
    await parallelSearchProvider.search(query);
    expect(wire).toContain("Venue Berlin wi-fi");
    expect(wire).not.toContain(privateSentence);
  });

  it("keeps Parallel as the default regardless of available credentials", () => {
    process.env.PARALLEL_API_KEY = "parallel";
    process.env.OPENAI_API_KEY = "openai";
    expect(searchProviderId()).toBe("parallel");
    delete process.env.PARALLEL_API_KEY;
    expect(searchProviderId()).toBe("parallel");
    delete process.env.OPENAI_API_KEY;
    expect(searchProviderId()).toBe("parallel");
    process.env.SEARCH_PROVIDER = "openai";
    expect(searchProviderId()).toBe("openai");
  });
});
