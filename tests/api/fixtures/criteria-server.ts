import { setEnrichFetch } from "../../../apps/server/src/enrich/index.ts";
import { setTransport } from "../../../apps/server/src/nl/openai.ts";

/** Full-process scripted sources for question-criterion API coverage. */
setEnrichFetch(async (url) => {
  if (url.endsWith("/robots.txt")) return new Response("", { status: 200 });
  const body = url.includes("/alpha")
    ? "<html><body><p>Free wireless internet is available throughout the whole venue.</p></body></html>"
    : "<html><body><p>A neighborhood café serving breakfast and lunch.</p></body></html>";
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/html" },
  });
});

setTransport(async (body) => {
  await new Promise((resolve) => setTimeout(resolve, 250));
  const matrix = JSON.parse((body.input as Array<{ content: string }>)[0].content) as {
    places: Array<{ candidateId: string; texts: Array<{ text: string }> }>;
    criteria: Array<{ id: string }>;
  };
  const claims = matrix.places.flatMap((place) => matrix.criteria.map((criterion) => {
    const sourceIndex = place.texts.findIndex((text) =>
      text.text.includes("Free wireless internet is available"),
    );
    return sourceIndex >= 0
      ? {
          candidateId: place.candidateId,
          criterionId: criterion.id,
          lean: "yes",
          confidence: 0.95,
          evidence: "Free wireless internet is available",
          sourceIndex,
        }
      : {
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
