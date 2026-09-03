import { setTransport } from "../../../apps/server/src/nl/openai.ts";

// A scripted route model: every sentence is one plain need. Anything else the
// server asks the model (screening a held condition) is refused, which the
// background screening path swallows.
setTransport(async (body) => {
  const format = (body as { text?: { format?: { name?: string } } }).text?.format;
  if (format?.name !== "understanding") {
    throw new Error("only the route model is scripted in wire-timeline tests");
  }
  return {
    output: [{
      type: "message",
      content: [{
        type: "output_text",
        text: JSON.stringify({ intent: "need", confidence: 1, concepts: [], reply: null }),
      }],
    }],
  };
});

await import("../../../apps/server/src/server.ts");
