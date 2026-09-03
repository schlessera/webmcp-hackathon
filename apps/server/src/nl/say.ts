import AjvModule from "ajv";
import addFormatsModule from "ajv-formats";
import {
  ATTRIBUTE_LABELS,
  ATTRIBUTE_VOCABULARY,
  HINT_TAXONOMY,
  RequirementPayload,
  areaById,
  preparse,
  type Concept,
  type ConceptRole,
  type Interpretation,
  type SpatialContextResult,
} from "@webmcp-hackathon/contracts";
import { config } from "../config.ts";
import { mapInterpretation, type UnderstandInput } from "./understand/map.ts";
import type { Clarification, ClarifyChoice, ParsedNeed } from "./understand/types.ts";
import { parseJson, respond } from "./llm.ts";

export type Intent = "need" | "ask" | "act" | "clarify" | "unclear";

export interface SayOutcome {
  intent: Intent;
  needs: ParsedNeed[];
  clarify: Clarification | null;
  reply: string | null;
  suggestions?: ClarifyChoice[];
  meta: { model: string | null; ms: number };
}

interface DraftConcept {
  role: ConceptRole;
  surface: string;
  polarity: "include" | "exclude";
  hardness: "hard" | "soft";
  quantityValue: number | null;
  quantityUnit: "m" | "km" | "min" | "h" | "EUR" | "USD" | null;
  quantityBound: "max" | "min" | "about" | "exact" | null;
  mode: "walk" | "bike" | "car" | "transit" | null;
  referentKind: "self" | "here" | "scope_center" | "named" | null;
  referentName: string | null;
  attributeKey: string | null;
  values: string[];
  windowStart: string | null;
  windowEnd: string | null;
  phrase: string | null;
  topic: (typeof HINT_TAXONOMY)[number] | null;
  unresolved: Concept["unresolved"];
  gist: string;
}

interface Draft {
  intent: "need" | "ask" | "act" | "other";
  confidence: number;
  concepts: DraftConcept[];
  reply: string | null;
}

const NULLABLE_STRING = { type: ["string", "null"] };
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["intent", "confidence", "concepts", "reply"],
  properties: {
    intent: { enum: ["need", "ask", "act", "other"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    reply: NULLABLE_STRING,
    concepts: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "role", "surface", "polarity", "hardness", "quantityValue", "quantityUnit",
          "quantityBound", "mode", "referentKind", "referentName", "attributeKey", "values",
          "windowStart", "windowEnd", "phrase", "topic", "unresolved", "gist",
        ],
        properties: {
          role: { enum: ["distance", "travel_time", "money", "time", "attribute", "kind", "quality", "place", "person", "action", "question"] },
          surface: { type: "string", maxLength: 120 },
          polarity: { enum: ["include", "exclude"] },
          hardness: { enum: ["hard", "soft"] },
          quantityValue: { type: ["number", "null"] },
          quantityUnit: { enum: ["m", "km", "min", "h", "EUR", "USD", null] },
          quantityBound: { enum: ["max", "min", "about", "exact", null] },
          mode: { enum: ["walk", "bike", "car", "transit", null] },
          referentKind: { enum: ["self", "here", "scope_center", "named", null] },
          referentName: NULLABLE_STRING,
          attributeKey: NULLABLE_STRING,
          values: { type: "array", maxItems: 8, items: { type: "string", maxLength: 60 } },
          windowStart: NULLABLE_STRING,
          windowEnd: NULLABLE_STRING,
          phrase: NULLABLE_STRING,
          topic: { enum: [...HINT_TAXONOMY, null] },
          unresolved: { enum: ["unit", "value", "referent", "name", "attribute", "kind", null] },
          gist: { type: "string", maxLength: 40 },
        },
      },
    },
  },
};

// CJS/ESM interop: ajv publishes CJS; under Node ESM the class may sit on
// .default depending on the loader (mirrors engine.ts).
const Ajv = ((AjvModule as never as { default?: unknown }).default ??
  AjvModule) as typeof AjvModule.default;
const addFormats = ((addFormatsModule as never as { default?: unknown })
  .default ?? addFormatsModule) as typeof addFormatsModule.default;

const payloadAjv = new Ajv({ strict: false });
addFormats(payloadAjv);
const validatePayload = payloadAjv.compile(RequirementPayload);

function localIso(now: Date, timezone: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23", timeZoneName: "longOffset",
  }).formatToParts(now).map((part) => [part.type, part.value]));
  const offset = parts.timeZoneName === "GMT" ? "+00:00" : parts.timeZoneName?.replace("GMT", "") ?? "+00:00";
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`;
}

function modelInstructions(
  context: SpatialContextResult,
  input: UnderstandInput,
  preparsed: Concept[],
  remainder: string,
): string {
  const vocabulary = ATTRIBUTE_VOCABULARY.filter((key) => key !== "price-level" && key !== "cuisine")
    .map((key) => `${key} ("${ATTRIBUTE_LABELS[key]}")`).join(", ");
  const cuisines = context.facets.find((facet) => facet.key === "cuisine" && facet.type === "enum")
    ?.values?.map((row) => row.value).join(", ") ?? "none";
  return [
    "You read one sentence a person typed into a shared planning room where a small group is choosing a place.",
    "Return the concepts the sentence states, one per distinct thing, up to five. Do not decide what to do with them.",
    "intent need: the sentence states at least one thing that could rule places in or out. A bare noun phrase counts. Content decides this, never wording.",
    "intent ask: the sentence asks about the room or the places. A question that also states a need is still ask, and you still return its concepts.",
    "intent act: the sentence asks for a room move — put forward, propose, accept, agree, veto, withdraw, widen, set aside, done.",
    "intent other: a greeting, chatter, or nothing about places. Return no concepts.",
    `Already understood, do not repeat: ${JSON.stringify(preparsed)}. Read only the remaining words: ${JSON.stringify(remainder)}.`,
    ...(input.clarifyOf
      ? [`This follows the question ${JSON.stringify(input.clarifyOf.question)} about ${JSON.stringify(input.clarifyOf.said)}.`]
      : []),
    "Every quantity must carry quantityValue, quantityUnit and quantityBound. Never guess a unit. A bare number has quantityUnit null and unresolved unit.",
    "A concept that states no amount has quantityValue null. Never write 0 to mean there is no amount.",
    "distance is a length from a referent; travel_time is a duration and carries walk, bike, car or transit when said. Named places use referentKind named and referentName.",
    "Examples: at most 500 m away from me -> distance 500 m max self; max 500m distance -> distance 500 m max self; not more than 20 min by bike -> travel_time 20 min max bike self.",
    "Examples: close to Alexanderplatz -> travel_time 10 min max walk named Alexanderplatz; cheap -> money 15 in the room currency; under 20 -> quantityUnit null and unresolved unit.",
    `Attribute keys are only: ${vocabulary}. Cuisine values on record: ${cuisines}.`,
    "kind names what sort of place or food is wanted — a cuisine, a dish, or a class of venue such as a cinema, a park or a bar. Any such word is a kind concept, never quality and never an attribute.",
    "Put the words in values, lowercase, singular, in English: italienisch is italian, vietnamesisch is vietnamese, Kino is cinema. Alternatives are one concept with several values. Never widen a value: sushi stays sushi, pizza stays pizza.",
    "Examples: no Italian -> kind values [italian] exclude; italian or spanish -> one kind values [italian,spanish] include; anything but pizza -> kind values [pizza] exclude; a cinema -> kind values [cinema] include.",
    "Examples: kein Italienisch -> kind values [italian] exclude; bloß nicht Pizza -> kind values [pizza] exclude; ohne Sushi -> kind values [sushi] exclude; am liebsten vietnamesisch -> kind values [vietnamese] include soft.",
    "quality is an open adjective such as quiet or kid friendly and becomes a safe question. open late is a time concept, not quality.",
    "Examples: vegan options -> attribute vegan-options; vegane Optionen -> attribute vegan-options; quiet -> quality quiet; wäre schön wenn es gemütlich ist -> quality gemütlich soft.",
    "Examples: what changed? -> intent ask, no concepts; was hat sich geändert? -> intent ask, no concepts; is there anything vegan? -> intent ask with attribute vegan-options; gibt es etwas Veganes? -> intent ask with attribute vegan-options.",
    "Examples: put Café Einstein forward -> intent act, place Café Einstein; schlag Café Einstein vor -> intent act, place Café Einstein; hello there -> intent other, no concepts.",
    `Area timezone: ${input.room.timezone}. Current local date/time: ${localIso(input.room.now, input.room.timezone)}.`,
    "Time windows: lunch 12:00-14:00; dinner/evening 18:00-21:00; brunch 10:00-13:00; tonight 18:00-23:00; open late 22:00-02:00 next day; at a clock time spans one hour either side; open now spans two hours.",
    "Time endpoints must be ISO-8601 with the area's numeric offset. Copy the exact time words into phrase.",
    "Polarity is exclude for no/not/without/avoid/kein/nicht/ohne. Hardness is soft for ideally/preferably/if possible/am liebsten/idealerweise/wenn möglich/wäre schön.",
    "surface is exact source words. gist is at most six lowercase words. Output only JSON.",
  ].join("\n");
}

function conceptFromDraft(draft: DraftConcept): Concept {
  return {
    role: draft.role,
    surface: draft.surface,
    polarity: draft.polarity,
    hardness: draft.hardness,
    quantity: draft.quantityValue === null
      ? null
      : { value: draft.quantityValue, unit: draft.quantityUnit, bound: draft.quantityBound ?? "max" },
    mode: draft.mode,
    referent: draft.referentKind ? { kind: draft.referentKind, name: draft.referentName } : null,
    attributeKey: draft.attributeKey,
    values: draft.values,
    window: draft.windowStart && draft.windowEnd ? { start: draft.windowStart, end: draft.windowEnd } : null,
    phrase: draft.phrase,
    topic: draft.topic,
    unresolved: draft.unresolved,
    gist: draft.gist,
    origin: "model",
  };
}

function understandInput(
  text: string,
  scope: string,
  context: SpatialContextResult,
  now: Date,
  clarifyOf?: { said: string; question: string },
  viewerId?: string,
): UnderstandInput {
  const area = areaById(context.area?.areaId ?? "");
  const openProposals = context.proposals.filter((proposal) => proposal.status !== "withdrawn");
  return {
    text,
    scope,
    ...(clarifyOf ? { clarifyOf } : {}),
    room: {
      areaId: context.area?.areaId ?? "",
      timezone: area?.timezone ?? "UTC",
      currency: area?.currency === "USD" ? "USD" : "EUR",
      now,
      hasOwnOrigin: viewerId
        ? Boolean(context.participants.find((participant) => participant.participantId === viewerId)?.origin)
        : context.participants.some((participant) => Boolean(participant.origin)),
      transport: (context.scope?.transport ?? ["walk"]).filter(
        (mode): mode is "walk" | "bike" | "car" | "transit" => ["walk", "bike", "car", "transit"].includes(mode),
      ),
      facets: context.facets,
      activeNeeds: context.activeNeeds,
      candidateWalkMinutes: context.candidates.map((candidate) => candidate.walkMin),
      candidateNames: context.candidates.map((candidate) => ({ candidateId: candidate.candidateId, name: candidate.name })),
      participantNames: context.participants.map((participant) => ({ participantId: participant.participantId, name: participant.displayName })),
      ...(context.agreement ? { agreementCandidateId: context.agreement.candidateId } : {}),
      proposalCandidateIds: openProposals.map((proposal) => proposal.candidateId),
    },
  };
}

export async function say(
  text: string,
  scope: string,
  context: SpatialContextResult,
  now = new Date(),
  clarifyOf?: { said: string; question: string },
  viewerId?: string,
): Promise<SayOutcome> {
  const input = understandInput(text, scope, context, now, clarifyOf, viewerId);
  const parsed = preparse(text, { currency: input.room.currency });
  let interpretation: Interpretation;
  let meta: SayOutcome["meta"];
  if (parsed.preparsedWhole) {
    interpretation = {
      intent: "need",
      concepts: parsed.concepts,
      confidence: 1,
      reply: null,
      meta: { model: null, ms: 0, preparsedWhole: true },
    };
    meta = { model: null, ms: 0 };
  } else {
    const reply = await respond({
      model: config.llmRouteModel,
      instructions: modelInstructions(context, input, parsed.concepts, parsed.remainder),
      input: [{ role: "user", content: parsed.remainder || text }],
      schema: { name: "understanding", schema: SCHEMA },
      reasoning: "low",
      maxOutputTokens: 1_500,
      timeoutMs: 30_000,
      serviceTier: "default",
    });
    const draft = parseJson<Draft>(reply.text);
    interpretation = {
      intent: draft?.intent ?? "other",
      concepts: [...parsed.concepts, ...(draft?.concepts ?? []).map(conceptFromDraft)].slice(0, 5),
      confidence: draft?.confidence ?? 0,
      reply: draft?.reply ?? null,
      meta: { model: reply.model, ms: reply.ms, preparsedWhole: false },
    };
    meta = { model: reply.model, ms: reply.ms };
  }
  const mapped = mapInterpretation(interpretation, input);
  const validNeeds = mapped.needs.filter((need) => validatePayload(need.payload));
  const validClarify = mapped.clarify
    ? {
        ...mapped.clarify,
        choices: mapped.clarify.choices.map((choice) => ({
          ...choice,
          needs: choice.needs.filter((need) => validatePayload(need.payload)),
        })),
      }
    : null;
  return {
    intent: mapped.intent,
    needs: validNeeds,
    clarify: validClarify,
    reply: mapped.reply,
    ...(mapped.suggestions
      ? { suggestions: mapped.suggestions.map((choice) => ({
          ...choice,
          needs: choice.needs.filter((need) => validatePayload(need.payload)),
        })) }
      : {}),
    meta,
  };
}

export type { ParsedNeed, Clarification, ClarifyChoice } from "./understand/types.ts";
