import { setEnrichFetch } from "../../../apps/server/src/enrich/index.ts";
import { setTransport } from "../../../apps/server/src/nl/openai.ts";
import { setParallelFetch } from "../../../apps/server/src/refine/search.ts";

const TRANSIENT = "REFINE-TRANSIENT-PAGE-MARKER";
const PRIVATE_SENTENCE = "private-zebra-741 needs a quiet courtyard";
const PRIVATE_EVIDENCE = "A quiet courtyard is available behind the main room";

setEnrichFetch(async (url) => {
  if (url.endsWith("/robots.txt")) return new Response("", { status: 200 });
  return new Response(
    `<html><body><p>${TRANSIENT} General information about this place. ${PRIVATE_EVIDENCE}.</p></body></html>`,
    { status: 200, headers: { "content-type": "text/html" } },
  );
});

setParallelFetch(async (url, init) => {
  if (url === "https://api.parallel.ai/v1/search") {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      objective?: string;
      mode?: string;
    };
    console.info(`parallel-search-request ${JSON.stringify(body)}`);
    const name = body.objective?.startsWith("Alpha")
      ? "alpha"
      : body.objective?.startsWith("Beta")
        ? "beta"
        : "gamma";
    return Response.json({
      search_id: `search_${name}`,
      results: name === "gamma" ? [] : [{
        url: `https://${name}.evidence.example/connectivity`,
        title: `${name} connectivity`,
        excerpts: [
          "Section Title: Amenities\n Content:\n Free wireless internet is available throughout the dining room.\n\n... (content truncated)",
        ],
      }],
    });
  }
  return new Response(
    "<html><body><p>Free wireless internet is available throughout the dining room.</p></body></html>",
    { headers: { "content-type": "text/html" } },
  );
});

setTransport(async (body) => {
  if (Array.isArray(body.tools)) {
    console.info(`web-search-request ${JSON.stringify(body)}`);
    const content = String((body.input as Array<{ content?: string }>)[0]?.content ?? "");
    const combined = (body.text as { format?: { name?: string } } | undefined)?.format?.name ===
      "venue_search_matrix_row";
    const query = combined
      ? String((JSON.parse(content) as { place?: { name?: string } }).place?.name ?? "")
      : content;
    const name = query.startsWith("Alpha") ? "alpha" : query.startsWith("Beta") ? "beta" : "gamma";
    if (combined) {
      console.info(`combined refinement call ${name}`);
      const criteria = (JSON.parse(content) as {
        criteria: Array<{ id: string }>;
      }).criteria;
      const sourceUrl = `https://${name}.example/connectivity`;
      const claims = criteria.map((criterion) => name === "gamma"
        ? {
            criterionId: criterion.id,
            lean: "abstain",
            confidence: 0,
            evidence: "",
            sourceUrl: null,
          }
        : {
            criterionId: criterion.id,
            lean: "yes",
            confidence: 0.95,
            evidence: "Free wireless internet is available",
            sourceUrl,
          });
      const text = JSON.stringify({ claims });
      return {
        output: [
          { type: "web_search_call", id: `search_${name}`, action: { type: "search" } },
          {
            type: "message",
            content: [{
              type: "output_text",
              text,
              annotations: name === "gamma" ? [] : [{
                type: "url_citation",
                start_index: text.indexOf(sourceUrl),
                end_index: text.indexOf(sourceUrl) + sourceUrl.length,
                url: `${sourceUrl}?utm_source=openai`,
                title: `${name} connectivity`,
              }],
            }],
          },
        ],
      };
    }
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
    const privateSourceIndex = place.texts.findIndex((item) =>
      item.source === "web" && item.text.includes(PRIVATE_EVIDENCE)
    );
    if (
      privateSourceIndex >= 0 &&
      criterion.kind === "question" &&
      criterion.text === PRIVATE_SENTENCE
    ) {
      return {
        candidateId: place.candidateId,
        criterionId: criterion.id,
        lean: "yes",
        confidence: 0.95,
        evidence: PRIVATE_EVIDENCE,
        sourceIndex: privateSourceIndex,
        explicit: true,
      };
    }
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
        explicit: false,
      };
    }
    return {
      candidateId: place.candidateId,
      criterionId: criterion.id,
      lean: "abstain",
      confidence: 0,
      evidence: "",
      sourceIndex: null,
      explicit: false,
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
