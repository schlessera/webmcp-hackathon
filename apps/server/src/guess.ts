import type { AttributeStatus } from "@webmcp-hackathon/contracts";

/**
 * Responsible guesses (SPATIAL-PROTOCOL.md §8.2): what the kind of place
 * suggests about facts nobody recorded. Every guess is `likely_*`, carries
 * the confidence of the rule that made it, names its reason, and only ever
 * fills a slot the record left `unknown`. A guess never becomes a verdict:
 * the engine reads it as "likely" / "unlikely", never as in or out.
 *
 * The rules are deliberately few and boring. A cuisine that is vegetarian
 * by definition, a cuisine that nearly always has a vegetarian dish, a
 * cuisine that nearly never does, the price band a fast-food counter or a
 * steak house usually sits in. Anything cleverer belongs to an agent that
 * can look it up and attest.
 */

export interface Guess {
  key: string;
  status: AttributeStatus;
  confidence: number;
  /** Which rule fired, for the ledger: "guess:cuisine" / "guess:amenity". */
  source: string;
  note: string;
  value?: number;
}

interface Rule {
  when: (tokens: Set<string>, amenity: string) => boolean;
  key: string;
  lean: boolean;
  confidence: number;
  note: string;
  value?: number;
}

const has = (tokens: Set<string>, ...any: string[]) => any.some((t) => tokens.has(t));

const RULES: Rule[] = [
  // Vegetarian by definition.
  { when: (t) => has(t, "vegetarian", "vegan"), key: "vegetarian-options", lean: true, confidence: 0.9, note: "the cuisine is vegetarian" },
  { when: (t) => has(t, "vegan"), key: "vegan-options", lean: true, confidence: 0.9, note: "the cuisine is vegan" },
  { when: (t) => has(t, "vegetarian"), key: "vegan-options", lean: true, confidence: 0.5, note: "a vegetarian kitchen usually has a vegan dish" },
  // Cuisines that nearly always carry a vegetarian dish.
  {
    when: (t) => has(t, "indian", "vietnamese", "thai", "falafel", "lebanese", "middle_eastern", "ethiopian", "italian", "pizza", "mexican", "salad", "buffet", "chinese", "japanese", "korean", "asian", "turkish", "greek", "spanish", "tapas", "breakfast", "coffee_shop"),
    key: "vegetarian-options", lean: true, confidence: 0.6, note: "this kind of kitchen usually has a vegetarian dish",
  },
  // Cuisines that nearly never do.
  { when: (t) => has(t, "steak_house", "bbq", "barbecue", "grill", "chicken", "wings", "fish", "seafood", "sausage", "kebab", "burger"), key: "vegetarian-options", lean: false, confidence: 0.55, note: "this kind of kitchen rarely has a vegetarian dish" },
  // Halal.
  { when: (t) => has(t, "turkish", "lebanese", "pakistani", "afghan", "persian", "iranian", "arab", "middle_eastern", "kebab", "syrian", "egyptian", "malaysian", "indonesian"), key: "halal-options", lean: true, confidence: 0.5, note: "this kind of kitchen is often halal" },
  // Price bands.
  { when: (_, a) => a === "fast_food", key: "price-level", lean: true, confidence: 0.5, note: "a fast-food counter", value: 1 },
  { when: (_, a) => a === "cafe", key: "price-level", lean: true, confidence: 0.4, note: "a café", value: 2 },
  { when: (t) => has(t, "steak_house", "fine_dining", "sushi"), key: "price-level", lean: true, confidence: 0.5, note: "this kind of kitchen usually sits in the upper band", value: 3 },
];

/** Guesses for one place, from its category and verified cuisine tokens. */
export function guessesFor(
  amenity: string,
  cuisine: string | undefined,
): Guess[] {
  const tokens = new Set((cuisine ?? "").split(";").map((t) => t.trim().toLowerCase()).filter(Boolean));
  const out: Guess[] = [];
  for (const r of RULES) {
    if (!r.when(tokens, amenity)) continue;
    if (out.some((g) => g.key === r.key)) continue; // first rule per key wins
    out.push({
      key: r.key,
      status: r.lean ? "likely_true" : "likely_false",
      confidence: r.confidence,
      source: tokens.size && r.when(tokens, "") ? "guess:cuisine" : "guess:amenity",
      note: r.note,
      ...(r.value !== undefined ? { value: r.value } : {}),
    });
  }
  return out;
}

export interface GuessableAttribute {
  key: string;
  status: string;
  value?: string | number;
  source?: string;
  confidence?: number;
  note?: string;
  observedAt?: string;
}

/** Attributes with guesses filled into the slots the record left unknown. */
export function applyGuesses<T extends GuessableAttribute>(
  category: string,
  attributes: T[],
  observedAt: string,
): T[] {
  const cuisine = attributes.find((a) => a.key === "cuisine");
  const cuisineValue =
    cuisine && (cuisine.status === "verified_true" || cuisine.status === "likely_true") && typeof cuisine.value === "string"
      ? cuisine.value
      : undefined;
  const guesses = guessesFor(category, cuisineValue);
  if (guesses.length === 0) return attributes;
  const out = attributes.map((a) => ({ ...a }));
  for (const g of guesses) {
    const existing = out.find((a) => a.key === g.key);
    if (existing && existing.status !== "unknown") continue;
    const patch = { status: g.status, confidence: g.confidence, source: g.source, note: g.note, observedAt, ...(g.value !== undefined ? { value: g.value } : {}) };
    if (existing) Object.assign(existing, patch);
    else out.push({ key: g.key, ...patch } as T);
  }
  return out;
}
