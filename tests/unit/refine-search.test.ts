import { afterEach, describe, expect, it } from "vitest";
import {
  citedSpans,
  combinedClaimsFromReply,
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

  it("validates combined rows against citations and the answer, then applies the search cap", () => {
    const input = {
      candidateId: "p1",
      osmRef: "node/1",
      name: "Alpha",
      category: "cafe",
      query: "Alpha Berlin cafe",
      source: "open_web_search" as const,
      criteria: [
        { id: "delivery", kind: "key" as const, key: "delivery", label: "delivery" },
        { id: "takeaway", kind: "key" as const, key: "takeaway", label: "takeaway" },
        { id: "dog-friendly", kind: "key" as const, key: "dog-friendly", label: "dogs welcome" },
        { id: "outdoor-seating", kind: "key" as const, key: "outdoor-seating", label: "outdoor seating" },
      ],
    };
    const claims = [
      { criterionId: "delivery", lean: "yes", confidence: 0.95, evidence: "Delivery is offered every evening", sourceUrl: "https://source.example/facts" },
      { criterionId: "takeaway", lean: "yes", confidence: 0.9, evidence: "Takeaway meals are available", sourceUrl: "https://wrong.example/facts" },
      { criterionId: "dog-friendly", lean: "yes", confidence: 0.9, evidence: "Pets may enter the courtyard", sourceUrl: "https://source.example/facts" },
      { criterionId: "outdoor-seating", lean: "yes", confidence: 0.9, evidence: "outdoor seating", sourceUrl: "https://source.example/facts" },
    ];
    const text = JSON.stringify({ claims }).replace(
      "Pets may enter the courtyard",
      "Pets\\u0020may\\u0020enter\\u0020the\\u0020courtyard",
    );
    expect(combinedClaimsFromReply({
      text,
      model: "fast",
      citations: [{ url: "https://source.example/facts?utm_source=openai" }],
    }, input)).toEqual([expect.objectContaining({
      criterionId: "delivery",
      confidence: 0.5,
      status: "likely_true",
      sourceUrl: "https://source.example/facts",
    })]);
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
