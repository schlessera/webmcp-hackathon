import {
  ATTRIBUTE_VOCABULARY,
  CUISINE_IMPLICATION_SATISFACTION_FLOOR,
  HINT_TAXONOMY,
  RANGE_SANITY,
  implies,
  mapPreparsedConcept,
  normalizeCuisineTokens,
  type Concept,
  type Facet,
  type Interpretation,
  type ScopePayloadReferent,
} from "@webmcp-hackathon/contracts";
import { labelFor } from "./label.ts";
import {
  minimumClarification,
  modeClarification,
  referentClarification,
  unclearSuggestions,
  unitClarification,
} from "./clarify.ts";
import { resolveConceptReferent, type ReferentRoom } from "./resolvers.ts";
import type { Clarification, MapResult, ParsedNeed } from "./types.ts";

export interface UnderstandInput {
  text: string;
  scope: string;
  clarifyOf?: { said: string; question: string };
  room: ReferentRoom & {
    timezone: string;
    currency: "EUR" | "USD";
    now: Date;
    hasOwnOrigin: boolean;
    transport: Array<"walk" | "bike" | "car" | "transit">;
    facets: Facet[];
    activeNeeds: Array<{ label: string }>;
    candidateWalkMinutes: number[];
  };
}

function topicOf(concept: Concept): ParsedNeed["topic"] {
  return concept.topic && HINT_TAXONOMY.includes(concept.topic) ? concept.topic : undefined;
}

/**
 * Only these roles measure something, so only these may ask what unit a bare
 * number meant. Stage A sometimes hangs a stray quantity on an attribute or a
 * quality; without this gate that stray number hijacked the whole sentence
 * into a "0 what?" clarification and the stated need was lost.
 */
const QUANTITY_ROLES: ReadonlySet<Concept["role"]> = new Set(["distance", "travel_time", "money"]);

/**
 * A kind value is actionable when the room's own cuisine facet can speak to
 * it — either it is recorded, or T3.6's sourced taxonomy carries it to a
 * recorded cuisine at verified confidence ("pizza" reaches "italian"). A value
 * with no such path ("sushi" in a room with no Japanese places) stays unknown,
 * and the unknown branches below ask rather than guess.
 */
function actionableCuisine(value: string, recorded: ReadonlySet<string>): boolean {
  if (recorded.has(value)) return true;
  return implies(value).some(({ cuisine, confidence }) =>
    confidence >= CUISINE_IMPLICATION_SATISFACTION_FLOOR && recorded.has(cuisine));
}


function parsedNeed(
  concept: Concept,
  payload: Record<string, unknown>,
  referentLabel?: string | null,
  assumed?: string,
): ParsedNeed {
  const label = labelFor(payload, referentLabel);
  return {
    payload,
    label,
    gist: concept.gist || label.toLocaleLowerCase().slice(0, 40),
    ...(topicOf(concept) ? { topic: topicOf(concept) } : {}),
    ...(assumed ? { assumed } : {}),
  };
}

function assumedFor(concept: Concept, label: string, hasOwnOrigin: boolean, confidence: number): string | undefined {
  if ((concept.role === "distance" || concept.role === "travel_time") && concept.referent?.kind !== "named" && !hasOwnOrigin) {
    return "measured from the area centre until you set where you start";
  }
  if (concept.gist === "close by") return "read as 10 min walk";
  if (concept.role === "money" && /^(?:cheap|budget|inexpensive|günstig|billig)$/i.test(concept.surface.trim())) {
    return `read as ${label.replace(/^budget /, "under ")}`;
  }
  if (concept.quantity?.bound === "about") return "read as an approximate maximum";
  if (confidence < 0.6 && !concept.unresolved) return `read as ${label}`.slice(0, 80);
  return undefined;
}

function withResolvedReferent(
  concept: Concept,
  input: UnderstandInput,
): {
  referent?: ScopePayloadReferent;
  label: string | null;
  clarify?: Clarification;
} {
  const resolved = resolveConceptReferent(concept, input.room);
  if (resolved.referent) {
    return {
      ...(resolved.referent.kind === "self" ? {} : { referent: resolved.referent }),
      label: resolved.label,
    };
  }
  const makeNeed = (referent: ScopePayloadReferent, referentLabel: string) => {
    const payload = mapPreparsedConcept(concept, {
      currency: input.room.currency,
      transport: input.room.transport,
      resolvedReferent: referent,
    });
    return payload ? parsedNeed(concept, payload, referentLabel) : null;
  };
  return {
    label: null,
    clarify: referentClarification(
      input.text,
      resolved.question ?? `I could not place ${concept.referent?.name ?? "that place"}`,
      resolved.choices ?? [],
      makeNeed,
    ),
  };
}

function hasExplicitCalendarDate(concept: Concept): boolean {
  const words = concept.phrase ?? concept.surface;
  return /(?:\b\d{4}-\d{2}-\d{2}\b|\bon(?:\s+the)?\s+\d{1,2}(?:st|nd|rd|th)?\b|\bam\s+\d{1,2}\.?(?:\s+[\p{L}]+)?\b)/iu.test(words);
}

function isSane(concept: Concept): boolean {
  const quantity = concept.quantity;
  if (!quantity) return true;
  if (concept.role === "distance") return quantity.value >= RANGE_SANITY.radiusM.min && quantity.value <= RANGE_SANITY.radiusM.max;
  if (concept.role === "travel_time") {
    const minutes = quantity.unit === "h" ? quantity.value * 60 : quantity.value;
    return minutes >= RANGE_SANITY.minutes.min && minutes <= RANGE_SANITY.minutes.max;
  }
  if (concept.role === "money") return quantity.value >= RANGE_SANITY.money.min && quantity.value <= RANGE_SANITY.money.max;
  return true;
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length];
}

export function looksInterrogative(text: string): boolean {
  const normalized = text.trim().toLocaleLowerCase();
  return normalized.endsWith("?") || /^(?:how many|which|what|is there|are there|who|when|wie viele|welche|gibt es|wer|wann)\b/.test(normalized);
}

export function mapInterpretation(interpretation: Interpretation, input: UnderstandInput): MapResult {
  const needs: ParsedNeed[] = [];
  let clarify: Clarification | null = null;
  const cuisines = new Set(
    input.room.facets.find((facet) => facet.key === "cuisine" && facet.type === "enum")?.values?.map((row) => row.value) ?? [],
  );

  for (const sourceConcept of interpretation.concepts.slice(0, 5)) {
    let concept = sourceConcept;
    let assumedUnit: string | undefined;
    if (
      concept.role === "distance" &&
      concept.quantity?.unit === null &&
      concept.quantity.value > 60
    ) {
      concept = {
        ...concept,
        quantity: { ...concept.quantity, unit: "m" },
        unresolved: null,
      };
      assumedUnit = "read as metres";
    }
    if (clarify && concept.unresolved) continue;
    if ((concept.role === "distance" || concept.role === "travel_time" || concept.role === "money") && !isSane(concept)) {
      clarify ??= {
        question: `What should ${concept.surface.slice(0, 60)} mean?`,
        choices: [
          { id: "c1", label: "Use a smaller amount", needs: [] },
          { id: "c2", label: "Leave it out", needs: [] },
        ],
        allowFreeText: true,
        said: input.text,
      };
      continue;
    }
    if (QUANTITY_ROLES.has(concept.role) && (concept.unresolved === "unit" || concept.quantity?.unit === null)) {
      clarify ??= unitClarification(input.text, concept, input.room.currency);
      continue;
    }

    if (concept.role === "distance" || concept.role === "travel_time") {
      const resolved = withResolvedReferent(concept, input);
      if (resolved.clarify) {
        clarify ??= resolved.clarify;
        continue;
      }
      if (concept.quantity?.bound === "min") {
        const asMaximum = { ...concept, quantity: { ...concept.quantity, bound: "max" as const } };
        const payload = mapPreparsedConcept(asMaximum, {
          currency: input.room.currency,
          transport: input.room.transport,
          resolvedReferent: resolved.referent,
        });
        if (payload) clarify ??= minimumClarification(input.text, parsedNeed(asMaximum, payload, resolved.label));
        continue;
      }
      if (concept.role === "travel_time" && !concept.mode && input.room.transport.length !== 1) {
        clarify ??= modeClarification(
          input.text,
          concept,
          input.room.currency,
          input.room.transport,
          resolved.referent,
        );
        continue;
      }
      const payload = mapPreparsedConcept(concept, {
        currency: input.room.currency,
        transport: input.room.transport,
        resolvedReferent: resolved.referent,
      });
      if (payload) {
        const label = labelFor(payload, resolved.label);
        needs.push(parsedNeed(
          concept,
          payload,
          resolved.label,
          assumedUnit ?? assumedFor(concept, label, input.room.hasOwnOrigin, interpretation.confidence),
        ));
      }
      continue;
    }

    if (concept.role === "money") {
      const payload = mapPreparsedConcept(concept, { currency: input.room.currency });
      if (payload) {
        const label = labelFor(payload);
        needs.push(parsedNeed(concept, payload, null, assumedFor(concept, label, true, interpretation.confidence)));
      }
      continue;
    }

    if (concept.role === "time") {
      const deterministic = mapPreparsedConcept(concept, {
        currency: input.room.currency,
        now: input.room.now,
        timezone: input.room.timezone,
      });
      const window = deterministic?.kind === "time"
        ? deterministic.window
        : hasExplicitCalendarDate(concept)
          ? concept.window
          : null;
      const hasOffset = (value: string) => /[+-]\d{2}:\d{2}$/.test(value);
      if (window && hasOffset(window.start) && hasOffset(window.end) && Date.parse(window.end) > Date.parse(window.start)) {
        needs.push(parsedNeed(concept, {
          kind: "time",
          window,
          ...(concept.phrase ? { phrase: concept.phrase.slice(0, 200) } : {}),
        }));
      }
      continue;
    }

    if (concept.role === "attribute") {
      if ((ATTRIBUTE_VOCABULARY as readonly string[]).includes(concept.attributeKey ?? "") && concept.attributeKey !== "price-level" && concept.attributeKey !== "cuisine") {
        needs.push(parsedNeed(concept, {
          kind: "attribute",
          key: concept.attributeKey,
          expect: concept.polarity === "exclude" ? "verified_false" : "verified_true",
        }));
      } else if (concept.surface.trim()) {
        needs.push({ ...parsedNeed(concept, { kind: "text", text: concept.surface.trim().slice(0, 120) }), label: concept.gist });
      }
      continue;
    }

    if (concept.role === "kind") {
      const normalized = [...new Set(concept.values.flatMap(normalizeCuisineTokens))];
      const known = normalized.filter((value) => actionableCuisine(value, cuisines));
      const unknown = normalized.filter((value) => !actionableCuisine(value, cuisines));
      if (known.length) {
        const kind = concept.polarity === "exclude" ? "exclusion" : "inclusion";
        needs.push(parsedNeed(concept, { kind, key: "cuisine", values: known, lifetime: "session" }));
      }
      if (unknown.length && concept.polarity === "include") {
        const words = unknown.join(" or ").replace(/_/g, " ");
        needs.push({
          ...parsedNeed(concept, { kind: "text", text: `is this a ${words} kind of place?`.slice(0, 120) }),
          label: `${words} place`.slice(0, 60),
        });
      } else if (unknown.length && concept.polarity === "exclude") {
        const words = unknown.join(" or ").replace(/_/g, " ");
        const nearest = input.room.facets
          .find((facet) => facet.key === "cuisine" && facet.type === "enum")
          ?.values
          ?.map((value) => ({ ...value, distance: editDistance(words, value.value) }))
          .sort((left, right) => left.distance - right.distance || right.count - left.count)[0];
        const closestChoice = nearest ? [{
          id: "c1",
          label: `Avoid ${nearest.label}`.slice(0, 60),
          needs: [parsedNeed(concept, {
            kind: "exclusion", key: "cuisine", values: [nearest.value], lifetime: "session",
          })],
        }] : [];
        clarify ??= {
          question: `No ${words} — closest on record:`.slice(0, 120),
          choices: [
            ...closestChoice,
            { id: `c${closestChoice.length + 1}`, label: `Rule out places whose site mentions ${words}`.slice(0, 60), needs: [{
              payload: { kind: "text", text: `does this place mention ${words}?`.slice(0, 120) },
              label: `avoid ${words}`.slice(0, 60),
              gist: `avoid ${words}`.slice(0, 40),
            }] },
            { id: `c${closestChoice.length + 2}`, label: "Leave it out", needs: [] },
          ],
          allowFreeText: true,
          said: input.text,
        };
      }
      continue;
    }

    if (concept.role === "quality" && concept.surface.trim()) {
      needs.push({
        ...parsedNeed(concept, { kind: "text", text: concept.surface.trim().slice(0, 120) }),
        label: (concept.gist || concept.surface).slice(0, 60),
      });
    }
  }

  if (input.scope === "agent-private") clarify = null;
  const hasReading = needs.length + (clarify?.choices.length ?? 0) > 0;
  let intent: MapResult["intent"];
  if (clarify) intent = "clarify";
  else if (hasReading) {
    intent = interpretation.intent === "ask" && looksInterrogative(input.text) ? "ask" : "need";
  } else if (interpretation.intent === "ask" || interpretation.intent === "act") intent = interpretation.intent;
  else if (interpretation.confidence < 0.6 && interpretation.concepts.some((concept) => concept.unresolved)) intent = "clarify";
  else intent = "unclear";

  if (intent === "unclear") {
    return {
      intent,
      needs: [],
      clarify: null,
      reply: `Nothing in “${input.text.slice(0, 70)}” would rule a place in or out.`.slice(0, 120),
      suggestions: unclearSuggestions({
        currency: input.room.currency,
        facets: input.room.facets,
        activeNeeds: input.room.activeNeeds,
        candidateWalkMinutes: input.room.candidateWalkMinutes,
      }),
    };
  }
  return { intent, needs, clarify, reply: interpretation.reply };
}

export type { ParsedNeed, Clarification, ClarifyChoice, MapResult } from "./types.ts";
