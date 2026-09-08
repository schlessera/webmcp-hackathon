import { setTransport } from "../../../apps/server/src/nl/llm.ts";

/**
 * Scripted stage-A answers for the plan-preview API tests. The wire never
 * leaves the process, so the route is exercised exactly as production runs
 * it and no model is called.
 *
 * Two goals are scripted: one that is a single outing, and one that names a
 * second place to go to afterwards. The fixture answers on what the user
 * actually typed, so the two live side by side in one server.
 */

type Concept = Record<string, unknown>;

/** Every field stage A's schema requires, with the ones a case cares about
 * overridden. Keeps each scripted concept to the lines that matter. */
function concept(partial: Concept): Concept {
  return {
    role: "attribute",
    surface: "",
    gist: "",
    polarity: "include",
    hardness: "hard",
    quantityValue: null,
    quantityUnit: null,
    quantityBound: null,
    mode: null,
    referentKind: null,
    referentName: null,
    attributeKey: null,
    values: [],
    dayRef: null,
    dayPart: null,
    clockHour: null,
    clockMinute: null,
    windowStart: null,
    windowEnd: null,
    phrase: null,
    topic: null,
    unresolved: null,
    step: 1,
    ...partial,
  };
}

const DOG_WALK = {
  intent: "plan",
  confidence: 1,
  reply: null,
  steps: [{ placeClass: "park" }],
  concepts: [
    concept({
      role: "attribute",
      surface: "with the dogs",
      attributeKey: "dog-friendly",
      gist: "dogs welcome",
      step: 1,
    }),
  ],
};

/** "Dinner, then the new MCU film" — two places, in order. */
const DINNER_THEN_FILM = {
  intent: "plan",
  confidence: 1,
  reply: null,
  steps: [{ placeClass: "food" }, { placeClass: "cinema" }],
  concepts: [
    concept({ role: "time", surface: "Dinner", phrase: "Dinner", gist: "dinner", dayPart: "evening", step: 1 }),
    concept({
      role: "attribute",
      surface: "outdoor",
      attributeKey: "outdoor-seating",
      gist: "outdoor seating",
      step: 1,
    }),
    concept({
      role: "subject",
      surface: "the new MCU film",
      gist: "the new MCU film",
      step: 2,
    }),
  ],
};

function said(body: Record<string, unknown>): string {
  const input = body.input as Array<{ content?: unknown }> | undefined;
  return String(input?.[0]?.content ?? "").toLocaleLowerCase();
}

setTransport(async (body) => {
  const text = said(body);
  const answer = text.includes("then") || text.includes("film") ? DINNER_THEN_FILM : DOG_WALK;
  return {
    output: [{
      type: "message",
      content: [{ type: "output_text", text: JSON.stringify(answer) }],
    }],
  };
});

await import("../../../apps/server/src/server.ts");
