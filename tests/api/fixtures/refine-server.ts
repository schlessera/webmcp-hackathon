import { setEnrichFetch } from "../../../apps/server/src/enrich/index.ts";
import { setTransport } from "../../../apps/server/src/nl/openai.ts";

const TRANSIENT = "REFINE-TRANSIENT-PAGE-MARKER";

setEnrichFetch(async (url) => {
  if (url.endsWith("/robots.txt")) return new Response("", { status: 200 });
  return new Response(
    `<html><body><p>${TRANSIENT} General information about this place.</p></body></html>`,
    { status: 200, headers: { "content-type": "text/html" } },
  );
});

setTransport(async (body) => {
  if (Array.isArray(body.tools)) {
    const query = String((body.input as Array<{ content?: string }>)[0]?.content ?? "");
    const name = query.startsWith("Alpha") ? "alpha" : query.startsWith("Beta") ? "beta" : "gamma";
    if (name === "gamma") {
      return {
        output: [{
          type: "message",
          content: [{ type: "output_text", text: "No cited support was found.", annotations: [] }],
        }],
      };
    }
    // The real Responses shape: the annotation covers the inline marker, and
    // the evidence is the statement that runs up to it.
    const statement = "Free wireless internet is available";
    const marker = ` ([${name}.example](https://${name}.example/connectivity))`;
    const text = `${statement}.${marker}`;
    return {
      output: [
        { type: "web_search_call", id: `search_${name}`, action: { type: "search" } },
        {
          type: "message",
          content: [{
            type: "output_text",
            text,
            annotations: [{
              type: "url_citation",
              start_index: statement.length + 1,
              end_index: text.length,
              url: `https://${name}.example/connectivity`,
              title: `${name} connectivity`,
            }],
          }],
        },
      ],
    };
  }

  const matrix = JSON.parse((body.input as Array<{ content: string }>)[0].content) as {
    places: Array<{ candidateId: string; texts: Array<{ source: string; text: string }> }>;
    criteria: Array<{ id: string; kind: string; text?: string }>;
  };
  if (
    matrix.criteria.some((criterion) => criterion.kind === "key") &&
    matrix.places.some((place) => place.texts.some((item) => item.source === "web")) &&
    matrix.places.some((place) => !place.texts.some((item) => item.text.includes(TRANSIENT)))
  ) {
    throw new Error("the second tick lost its transient page-text LRU");
  }
  const claims = matrix.places.flatMap((place) => matrix.criteria.map((criterion) => {
    const sourceIndex = place.texts.findIndex((item) =>
      (item.source === "domain_search" || item.source === "open_web_search") &&
      item.text.includes("Free wireless internet is available")
    );
    if (sourceIndex >= 0 && criterion.kind === "question" && criterion.text === "free wifi") {
      return {
        candidateId: place.candidateId,
        criterionId: criterion.id,
        lean: "yes",
        confidence: 0.95,
        evidence: "Free wireless internet is available",
        sourceIndex,
      };
    }
    return {
      candidateId: place.candidateId,
      criterionId: criterion.id,
      lean: "abstain",
      confidence: 0,
      evidence: "",
      sourceIndex: null,
    };
  }));
  return {
    output: [{
      type: "message",
      content: [{ type: "output_text", text: JSON.stringify({ claims }) }],
    }],
  };
});

await import("../../../apps/server/src/server.ts");
