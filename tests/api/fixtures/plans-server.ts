import { setTransport } from "../../../apps/server/src/nl/openai.ts";

/**
 * One scripted stage-A answer for the plan-preview API tests: a goal about a
 * park, with the dogs. The wire never leaves the process, so the route is
 * exercised exactly as production runs it and no model is called.
 */
setTransport(async () => ({
  output: [{
    type: "message",
    content: [{
      type: "output_text",
      text: JSON.stringify({
        intent: "plan",
        confidence: 1,
        reply: null,
        placeClass: "park",
        concepts: [{
          role: "attribute",
          surface: "with the dogs",
          polarity: "include",
          hardness: "hard",
          quantityValue: null,
          quantityUnit: null,
          quantityBound: null,
          mode: null,
          referentKind: null,
          referentName: null,
          attributeKey: "dog-friendly",
          values: [],
          windowStart: null,
          windowEnd: null,
          phrase: null,
          topic: null,
          unresolved: null,
          gist: "dogs welcome",
        }],
      }),
    }],
  }],
}));

await import("../../../apps/server/src/server.ts");
