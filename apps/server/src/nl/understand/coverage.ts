import type { Concept } from "@webmcp-hackathon/contracts";
import type { MapResult } from "./types.ts";

export const MAX_CONCEPTS = 5;

const words = (text: string): string[] => text.normalize("NFKC").toLocaleLowerCase()
  .match(/[\p{L}\p{N}]+|[€$]/gu) ?? [];

// Only framing can remain outside a concept. Negation, preferences, times,
// quantities, and location qualifiers deliberately do not appear here.
const FRAMING = new Set(words(
  "i we want wants need needs would like find show me us a an the place places somewhere that which is are be it there anything with and also but " +
  "please hello hi thanks thank you " +
  "ich wir möchte möchten will wollen brauche brauchen suche suchen zeig mir uns ein eine einen einem einer der die das den dem " +
  "ort orte irgendwo etwas wo es ist sind sein mit und auch aber bitte hallo danke gibt",
));

/** A source-coverage check, not a proof that the model understood the words.
 * Match whole contiguous token spans; never let 'quiet' cover 'quieter'.
 * Keep operators for the composition check in map.ts, rather than classifying
 * them as a missing standalone requirement here.
 */
export function uncoveredSourceWords(text: string, concepts: Concept[]): string[] {
  // An explicitly waived feature is not a requirement to exclude that feature.
  const source = text.split(/([,;]|\b(?:and|but|und|aber)\b)/iu)
    .filter((clause) => !/^\s*[\p{L}\p{N}\s-]+\s+(?:is|are)\s+not\s+required\s*$/iu.test(clause) &&
      !/^\s*[\p{L}\p{N}\s-]+\s+ist\s+nicht\s+(?:nötig|erforderlich)\s*$/iu.test(clause))
    .join("");
  const tokens = words(source);
  const covered = tokens.map(() => false);
  for (const concept of concepts) {
    const span = words(concept.surface);
    if (!span.length) continue;
    for (let i = 0; i <= tokens.length - span.length; i++) {
      if (span.every((token, j) => token === tokens[i + j])) {
        for (let j = 0; j < span.length; j++) covered[i + j] = true;
      }
    }
  }
  return tokens.filter((token, i) => !covered[i] && !FRAMING.has(token) &&
    !["or", "either", "oder", "entweder"].includes(token));
}

export function incompleteReading(text: string, overflow = false): MapResult {
  return {
    intent: "clarify", needs: [], reply: null,
    clarify: {
      question: overflow
        ? "Could you split this into messages with at most five requirements each?"
        : "Could you shorten this into separate clauses while keeping every condition?",
      choices: [], allowFreeText: true, said: text,
    },
  };
}
