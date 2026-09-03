import { labelFor } from "./label.ts";
import {
  PRICE_DEFAULTS,
  mapPreparsedConcept,
  type Concept,
  type Facet,
  type ScopePayloadReferent,
} from "@webmcp-hackathon/contracts";
import type { Clarification, ClarifyChoice, ParsedNeed } from "./types.ts";

const symbol = (currency: "EUR" | "USD") => currency === "EUR" ? "€" : "$";

function choice(id: string, label: string, needs: ParsedNeed[] = []): ClarifyChoice {
  return { id, label: label.slice(0, 60), needs };
}

export function unitClarification(
  said: string,
  concept: Concept,
  currency: "EUR" | "USD",
): Clarification {
  const value = concept.quantity?.value ?? 0;
  const moneyPayload = {
    kind: "budget",
    perPersonMax: { amount: value, currency },
  };
  const walkPayload = {
    kind: "scope",
    dimension: "walk_min",
    max: Math.round(value),
  };
  return {
    question: `${value} what?`.slice(0, 120),
    choices: [
      choice("c1", `${symbol(currency)}${value} per person`, [{
        payload: moneyPayload,
        label: `budget ${symbol(currency)}${value}`,
        gist: "budget",
        topic: "budget",
      }]),
      choice("c2", `${value} min walk`, [{
        payload: walkPayload,
        label: labelFor(walkPayload),
        gist: "travel time",
        topic: "distance",
      }]),
    ],
    allowFreeText: true,
    said,
  };
}

export function minimumClarification(said: string, need: ParsedNeed): Clarification {
  return {
    question: "Did you mean a maximum?",
    choices: [choice("c1", need.label, [need]), choice("c2", "Leave it out")],
    allowFreeText: true,
    said,
  };
}

export function modeClarification(
  said: string,
  concept: Concept,
  currency: "EUR" | "USD",
  transport: Array<"walk" | "bike" | "car" | "transit">,
  resolvedReferent?: ScopePayloadReferent,
): Clarification {
  const value = concept.quantity?.unit === "h"
    ? (concept.quantity?.value ?? 0) * 60
    : concept.quantity?.value ?? 0;
  const choices = transport.slice(0, 3).flatMap((mode, index) => {
    const next = { ...concept, mode };
    const payload = mapPreparsedConcept(next, { currency, transport: [mode], resolvedReferent });
    if (!payload) return [];
    const words = mode === "walk" ? "on foot" : `by ${mode}`;
    return [choice(`c${index + 1}`, `${value} min ${words}`, [{
      payload,
      label: labelFor(payload),
      gist: concept.gist,
      topic: "distance",
    }])];
  });
  return { question: `${value} min how?`, choices, allowFreeText: true, said };
}

export function referentClarification(
  said: string,
  question: string,
  options: Array<{ referent: ScopePayloadReferent; label: string }>,
  makeNeed: (referent: ScopePayloadReferent, label: string) => ParsedNeed | null,
): Clarification {
  const choices = options.slice(0, 3).flatMap((option, index) => {
    const need = makeNeed(option.referent, option.label);
    return need ? [choice(`c${index + 1}`, need.label, [need])] : [];
  });
  if (choices.length < 2) {
    choices.push(choice(`c${choices.length + 1}`, "A place in the room"));
    if (choices.length < 2) choices.push(choice(`c${choices.length + 1}`, "Somewhere else"));
  }
  return {
    question: question.slice(0, 120),
    choices: choices.slice(0, 3),
    allowFreeText: true,
    said,
  };
}

export function unclearSuggestions(input: {
  currency: "EUR" | "USD";
  facets: Facet[];
  activeNeeds: Array<{ label: string }>;
  candidateWalkMinutes: number[];
}): ClarifyChoice[] {
  const stated = new Set(input.activeNeeds.map((need) => need.label.toLocaleLowerCase()));
  const top = input.facets.find((facet) => {
    const label = facet.type === "enum" ? facet.values?.[0]?.label : facet.label;
    return Boolean(label) && !stated.has(label!.toLocaleLowerCase());
  });
  const suggestions: ClarifyChoice[] = [];
  if (top) {
    const enumValue = top.type === "enum" ? top.values?.[0] : undefined;
    const label = enumValue?.label ?? top.label;
    suggestions.push(choice("c1", label, [{
      payload: enumValue
        ? { kind: "inclusion", key: top.key, values: [enumValue.value] }
        : { kind: "attribute", key: top.key, expect: "verified_true" },
      label,
      gist: label.toLocaleLowerCase(),
    }]));
  }
  const values = [...input.candidateWalkMinutes].filter(Number.isFinite).sort((a, b) => a - b);
  const median = values.length ? Math.round(values[Math.floor((values.length - 1) / 2)]) : 10;
  suggestions.push(choice(`c${suggestions.length + 1}`, `within ${median} min walk`, [{
    payload: { kind: "scope", dimension: "walk_min", max: median },
    label: labelFor({ kind: "scope", dimension: "walk_min", max: median }),
    gist: "travel time",
    topic: "distance",
  }]));
  const amount = PRICE_DEFAULTS.mid;
  suggestions.push(choice(`c${suggestions.length + 1}`, `budget ${symbol(input.currency)}${amount}`, [{
    payload: { kind: "budget", perPersonMax: { amount, currency: input.currency } },
    label: `budget ${symbol(input.currency)}${amount}`,
    gist: "budget",
    topic: "budget",
  }]));
  return suggestions.slice(0, 3);
}
