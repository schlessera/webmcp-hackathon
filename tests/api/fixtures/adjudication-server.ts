import { setTransport } from "../../../apps/server/src/nl/openai.ts";

setTransport(async (body) => {
  const schema = (body.text as { format?: { name?: string } } | undefined)?.format?.name;
  const content = String((body.input as Array<{ content?: string }>)[0]?.content ?? "{}");
  if (schema === "venue_evidence_adjudication") {
    const input = JSON.parse(content) as { cells: Array<{ evidence: string }> };
    console.info(`adjudication-scripted-call cells=${input.cells.length}`);
    return {
      output: [{
        type: "message",
        content: [{
          type: "output_text",
          text: JSON.stringify({
            results: input.cells.map((cell) => ({
              verdict: "yes",
              explicit: true,
              publisher: "chain",
              quote: cell.evidence,
            })),
          }),
        }],
      }],
      usage: { input_tokens: 920, output_tokens: 85, cost: 0.000189 },
    };
  }

  // Any ordinary matrix call remains scripted and abstains. The fixture must
  // never reach a live model even if a setup omission opens another cell.
  const input = JSON.parse(content) as {
    places?: Array<{ candidateId: string }>;
    criteria?: Array<{ id: string }>;
  };
  return {
    output: [{
      type: "message",
      content: [{
        type: "output_text",
        text: JSON.stringify({
          claims: (input.places ?? []).flatMap((place) =>
            (input.criteria ?? []).map((criterion) => ({
              candidateId: place.candidateId,
              criterionId: criterion.id,
              lean: "abstain",
              confidence: 0,
              evidence: "",
              sourceIndex: null,
              explicit: false,
            }))
          ),
        }),
      }],
    }],
    usage: { input_tokens: 100, output_tokens: 20 },
  };
});

await import("../../../apps/server/src/server.ts");
