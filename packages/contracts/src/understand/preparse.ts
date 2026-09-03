import { NEARNESS_DEFAULT, PRICE_DEFAULTS, PRICE_WORDS, RANGE_SANITY } from "./defaults.ts";
import type { Concept, Quantity, Referent } from "./types.ts";

export interface PreparseLocale {
  currency: "EUR" | "USD";
}

export interface PreparseResult {
  concepts: Concept[];
  consumed: Array<[number, number]>;
  remainder: string;
  preparsedWhole: boolean;
}

export type ScopePayloadReferent =
  | { kind: "self" }
  | { kind: "scopeCenter" }
  | { kind: "candidate"; candidateId: string }
  | { kind: "participant"; participantId: string }
  | { kind: "point"; lat: number; lng: number; label?: string }
  | { kind: "landmark"; landmarkId: string };

export type PreparsedPayload =
  | {
      kind: "scope";
      dimension: "walk_min" | "radius_m";
      max: number;
      referent?: ScopePayloadReferent;
    }
  | {
      kind: "scope";
      dimension: "travel_min";
      max: number;
      mode: "walk" | "bike" | "car" | "transit";
      referent?: ScopePayloadReferent;
    }
  | { kind: "budget"; perPersonMax: { amount: number; currency: "EUR" | "USD" } };

const EN_ONES = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
  "seventeen", "eighteen", "nineteen",
] as const;
const EN_TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty"] as const;
const DE_ONES = [
  "null", "eins", "zwei", "drei", "vier", "funf", "sechs", "sieben", "acht", "neun",
  "zehn", "elf", "zwolf", "dreizehn", "vierzehn", "funfzehn", "sechzehn",
  "siebzehn", "achtzehn", "neunzehn",
] as const;
const DE_TENS = ["", "", "zwanzig", "dreissig", "vierzig", "funfzig", "sechzig"] as const;

const NUMBER_WORDS = new Map<string, number>();
for (let value = 0; value <= 60; value += 1) {
  if (value < 20) {
    NUMBER_WORDS.set(EN_ONES[value], value);
    NUMBER_WORDS.set(DE_ONES[value], value);
  } else {
    const tens = Math.floor(value / 10);
    const ones = value % 10;
    const en = ones === 0 ? EN_TENS[tens] : `${EN_TENS[tens]} ${EN_ONES[ones]}`;
    const enHyphen = en.replace(" ", "-");
    const de = ones === 0
      ? DE_TENS[tens]
      : `${ones === 1 ? "ein" : DE_ONES[ones]}und${DE_TENS[tens]}`;
    NUMBER_WORDS.set(en, value);
    NUMBER_WORDS.set(enHyphen, value);
    NUMBER_WORDS.set(de, value);
  }
}
for (const one of ["ein", "eine", "einen", "einem", "einer"]) NUMBER_WORDS.set(one, 1);
NUMBER_WORDS.set("half a", 0.5);
NUMBER_WORDS.set("ein halber", 0.5);
NUMBER_WORDS.set("eine halbe", 0.5);
NUMBER_WORDS.set("halbe", 0.5);
NUMBER_WORDS.set("½", 0.5);
NUMBER_WORDS.set("a couple of", 2);

const BOUNDS = Object.freeze({
  max: [
    "not more than", "no more than", "nicht mehr als", "nicht weiter als", "innerhalb von",
    "at most", "less than", "up to", "hochstens", "maximum", "maximal", "within", "under",
    "below", "unter", "bis zu", "max.", "max",
  ],
  min: ["at least", "more than", "mindestens", "mehr als", "minimum", "over"],
  about: ["about", "around", "roughly", "ungefahr", "etwa", "circa", "ca.", "ish"],
});

const MODE_WORDS = Object.freeze({
  transit: ["by transit", "by train", "by tram", "by bus", "mit den offis", "mit der bahn"],
  bike: ["by bike", "cycling", "mit dem fahrrad", "mit dem rad"],
  car: ["by car", "driving", "mit dem auto"],
  walk: ["on foot", "walking", "walk", "zu fuss"],
});

const SOFT_MARKERS = [
  "would be nice", "nice to have", "if possible", "wenn moglich", "ware schon",
  "idealerweise", "preferably", "ideally", "am liebsten",
];
const SELF_REFERENTS = [
  "from where i am", "away from me", "from here", "from me", "of me", "to me",
  "von mir aus", "von hier", "von mir", "zu mir",
];
const CENTRE_REFERENTS = [
  "from the centre", "from the center", "from the middle", "of the area", "vom zentrum",
  "von der mitte",
];
const ROOM_RELATIVE = [
  "the restaurant we picked", "the restaurant we chose", "the restaurant we agreed on",
  "the restaurant we are going to", "the place we picked", "the place we chose",
  "the place we agreed on", "the place we are going to", "the one we picked", "the one we chose",
  "where we're going", "where we are going", "the station we meet at", "where we meet",
  "das restaurant, das wir gewahlt haben", "wo wir hingehen", "unser treffpunkt",
  "der bahnhof, an dem wir uns treffen",
];
const ROOM_RELATIVE_NEAR = [
  "in der nahe von dem restaurant, das wir gewahlt haben",
] as const;
const DISTANCE_FILLER = [
  "places that are", "entfernung", "distance", "entfernt", "umkreis", "radius", "range", "away",
];
const STOPWORDS = new Set(["a", "an", "the", "please", "bitte", "and", "und", "that", "are", "is"]);

const LENGTH_UNITS: Array<[RegExp, number]> = [
  [/^(?:kilometers?|kilometres?|km)\b/i, 1_000],
  [/^(?:miles?|mi)\b/i, 1_609.344],
  [/^(?:meters?|metres?|m)\b/i, 1],
];
const DURATION_UNITS: Array<[RegExp, "min" | "h"]> = [
  [/^(?:minuten?|minutes?|mins?|min)\b/i, "min"],
  [/^(?:stunden?|hours?|hrs?|hr|h)\b/i, "h"],
];
const MONEY_UNITS: Array<[RegExp, "EUR" | "USD"]> = [
  [/^(?:euros?\b|eur\b|€)/i, "EUR"],
  [/^(?:dollars?\b|bucks\b|usd\b|\$)/i, "USD"],
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const WORD_NUMBER_PATTERN = [...NUMBER_WORDS.keys()]
  .sort((a, b) => b.length - a.length)
  .map(escapeRegExp)
  .join("|");
const NUMBER_RE = new RegExp(
  `(?<![\\p{L}\\d])(?:\\d+(?:[.,]\\d+)?(?!\\d)|(?:${WORD_NUMBER_PATTERN})(?![\\p{L}\\d]))`,
  "giu",
);

interface FoldedText {
  text: string;
  originalIndex: number[];
}

/** Fold case and diacritics while retaining a map back to exact source spans. */
function foldText(value: string): FoldedText {
  let text = "";
  const originalIndex: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const folded = value[index]
      .toLocaleLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/ß/g, "ss");
    for (const char of folded) {
      text += char;
      originalIndex.push(index);
    }
  }
  return { text, originalIndex };
}

function originalSpan(folded: FoldedText, start: number, end: number): [number, number] {
  return [folded.originalIndex[start] ?? start, (folded.originalIndex[Math.max(start, end - 1)] ?? end - 1) + 1];
}

function phraseAt(haystack: string, phrase: string, from = 0, to = haystack.length): [number, number] | null {
  const index = haystack.slice(from, to).indexOf(phrase);
  return index < 0 ? null : [from + index, from + index + phrase.length];
}

function longestPhrase(
  haystack: string,
  phrases: readonly string[],
  from = 0,
  to = haystack.length,
): { phrase: string; span: [number, number] } | null {
  let hit: { phrase: string; span: [number, number] } | null = null;
  for (const phrase of phrases) {
    const span = phraseAt(haystack, phrase, from, to);
    if (span && (!hit || span[0] < hit.span[0] || (span[0] === hit.span[0] && phrase.length > hit.phrase.length))) {
      hit = { phrase, span };
    }
  }
  return hit;
}

function clauseBounds(text: string, at: number): [number, number] {
  const separators = /\s+(?:and|und|but|aber)\s+|[;\n]/gi;
  let start = 0;
  let end = text.length;
  for (const match of text.matchAll(separators)) {
    const index = match.index ?? 0;
    if (index < at) start = index + match[0].length;
    else {
      end = index;
      break;
    }
  }
  return [start, end];
}

function makeConcept(overrides: Partial<Concept> & Pick<Concept, "role" | "surface" | "gist">): Concept {
  return {
    role: overrides.role,
    surface: overrides.surface,
    polarity: overrides.polarity ?? "include",
    hardness: overrides.hardness ?? "hard",
    quantity: overrides.quantity ?? null,
    mode: overrides.mode ?? null,
    referent: overrides.referent ?? null,
    attributeKey: overrides.attributeKey ?? null,
    values: overrides.values ?? [],
    window: overrides.window ?? null,
    phrase: overrides.phrase ?? null,
    topic: overrides.topic ?? null,
    unresolved: overrides.unresolved ?? null,
    gist: overrides.gist,
    origin: "preparse",
  };
}

function numberValue(raw: string): number | null {
  if (/^\d/.test(raw)) {
    const value = Number(raw.replace(",", "."));
    return Number.isFinite(value) ? value : null;
  }
  return NUMBER_WORDS.get(raw) ?? null;
}

function phraseEndingNear(text: string, phrases: readonly string[], end: number, clauseStart: number) {
  let best: { phrase: string; span: [number, number] } | null = null;
  for (const phrase of phrases) {
    const before = text.slice(clauseStart, end);
    const index = before.lastIndexOf(phrase);
    if (index < 0) continue;
    const span: [number, number] = [clauseStart + index, clauseStart + index + phrase.length];
    const trailing = text.slice(span[1], end).trim().split(/\s+/).filter(Boolean);
    if (trailing.length <= 3 && (!best || phrase.length > best.phrase.length)) best = { phrase, span };
  }
  return best;
}

function modeIn(text: string, start: number, end: number) {
  for (const mode of ["transit", "bike", "car", "walk"] as const) {
    const hit = longestPhrase(text, MODE_WORDS[mode], start, end);
    if (hit) return { mode, ...hit };
  }
  return null;
}

function referentAfter(text: string, start: number, end: number): { referent: Referent; span?: [number, number] } {
  const self = longestPhrase(text, SELF_REFERENTS, start, end);
  if (self) return { referent: { kind: "self", name: null }, span: self.span };
  const centre = longestPhrase(text, CENTRE_REFERENTS, start, end);
  if (centre) return { referent: { kind: "scope_center", name: null }, span: centre.span };
  const relative = longestPhrase(text, ROOM_RELATIVE, start, end);
  if (relative) return { referent: { kind: "named", name: relative.phrase }, span: relative.span };

  const tail = text.slice(start, end);
  const connector = /(?:^|\s)(in der nahe vo(?:n|m)|nah am|nahe|from|of|near|to|around|von|vom|am|bei)\s+(.+)$/i.exec(tail);
  if (connector && connector.index !== undefined) {
    const connectorStart = start + connector.index + connector[0].indexOf(connector[2]);
    let name = connector[2].trim();
    name = name.replace(/\s+(?:by bike|by car|by transit|by train|by tram|by bus|on foot|zu fuss|mit dem rad|mit dem fahrrad|mit dem auto|mit der bahn|mit den offis)$/i, "").trim();
    name = name.replace(/\s+(?:away|entfernt|distance|entfernung|radius|umkreis)$/i, "").trim();
    if (name && !/^(?:me|here|mir|hier|the centre|the center|the middle|the area)$/i.test(name)) {
      const nameEnd = connectorStart + connector[2].indexOf(name) + name.length;
      return {
        referent: { kind: "named", name },
        span: [start + connector.index, nameEnd],
      };
    }
  }
  return { referent: { kind: "self", name: null } };
}

function mergeSpans(spans: Array<[number, number]>): Array<[number, number]> {
  const sorted = spans.filter(([start, end]) => end > start).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [];
  for (const span of sorted) {
    const last = merged.at(-1);
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push([...span]);
  }
  return merged;
}

function cleanRemainder(text: string, spans: Array<[number, number]>): string {
  const chars = [...text];
  for (const [start, end] of spans) for (let index = start; index < end; index += 1) chars[index] = " ";
  return chars.join("").replace(/[\s,;:.!?()[\]{}]+/g, " ").trim().replace(/\s+/g, " ");
}

function onlyStopwords(text: string): boolean {
  if (!text) return true;
  return text.split(/\s+/).every((word) => STOPWORDS.has(foldText(word).text));
}

/** Deterministic EN+DE quantity grammar. It performs no I/O and uses no room vocabulary. */
export function preparse(text: string, locale: PreparseLocale): PreparseResult {
  const folded = foldText(text);
  const source = folded.text;
  const concepts: Concept[] = [];
  const consumedFolded: Array<[number, number]> = [];
  const claimed = (start: number, end: number) => consumedFolded.some(([a, b]) => start < b && end > a);

  // Vague named nearness must run before generic "nearby" phrases.
  // Keep the comma-bearing German agreement form intact instead of letting
  // the generic named-referent matcher stop at its relative clause.
  for (const phrase of ROOM_RELATIVE_NEAR) {
    const span = phraseAt(source, phrase);
    if (!span) continue;
    const original = originalSpan(folded, ...span);
    const nameStart = span[0] + phrase.indexOf("dem restaurant");
    const nameOriginal = originalSpan(folded, nameStart, span[1]);
    concepts.push(makeConcept({
      role: "travel_time",
      surface: text.slice(...original),
      quantity: { value: NEARNESS_DEFAULT.minutes, unit: "min", bound: "max" },
      mode: NEARNESS_DEFAULT.mode,
      referent: { kind: "named", name: text.slice(...nameOriginal).trim() },
      topic: "distance",
      gist: "close by",
    }));
    consumedFolded.push(span);
  }
  const namedNear = /(?:close to|near|nah am|nahe|in der nahe vo(?:n|m))\s+([^,;]+?)(?=\s+(?:and|und|but|aber)\s+|$)/gi;
  for (const match of source.matchAll(namedNear)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const rawName = match[1].trim();
    if (/^(?:me|mir|here|hier)$/.test(rawName)) continue;
    const original = originalSpan(folded, start, end);
    const nameStart = start + match[0].indexOf(match[1]);
    const nameOriginal = originalSpan(folded, nameStart, nameStart + match[1].trimEnd().length);
    const [clauseStart, clauseEnd] = clauseBounds(source, start);
    const soft = longestPhrase(source, SOFT_MARKERS, clauseStart, clauseEnd);
    concepts.push(makeConcept({
      role: "travel_time",
      surface: text.slice(...original),
      quantity: { value: NEARNESS_DEFAULT.minutes, unit: "min", bound: "max" },
      mode: NEARNESS_DEFAULT.mode,
      referent: { kind: "named", name: text.slice(...nameOriginal).trim() },
      hardness: soft ? "soft" : "hard",
      topic: "distance",
      gist: "close by",
    }));
    consumedFolded.push([start, end]);
    if (soft) consumedFolded.push(soft.span);
  }

  for (const phrase of [...new Set(Object.values(PRICE_WORDS).flat())].sort((a, b) => b.length - a.length)) {
    let from = 0;
    for (;;) {
      const span = phraseAt(source, foldText(phrase).text, from);
      if (!span) break;
      from = span[1];
      if (claimed(...span)) continue;
      const tier = (Object.entries(PRICE_WORDS) as Array<[keyof typeof PRICE_WORDS, readonly string[]]>)
        .find(([, words]) => words.includes(phrase))?.[0] ?? "cheap";
      const original = originalSpan(folded, ...span);
      const [clauseStart, clauseEnd] = clauseBounds(source, span[0]);
      const soft = longestPhrase(source, SOFT_MARKERS, clauseStart, clauseEnd);
      concepts.push(makeConcept({
        role: "money",
        surface: text.slice(...original),
        quantity: { value: PRICE_DEFAULTS[tier], unit: locale.currency, bound: "max" },
        hardness: soft ? "soft" : "hard",
        topic: "budget",
        gist: phrase,
      }));
      consumedFolded.push(span);
      if (soft) consumedFolded.push(soft.span);
    }
  }

  for (const phrase of [...VAGUE_SELF_FORMS].sort((a, b) => b.length - a.length)) {
    let from = 0;
    for (;;) {
      const span = phraseAt(source, phrase, from);
      if (!span) break;
      from = span[1];
      if (claimed(...span)) continue;
      const original = originalSpan(folded, ...span);
      const [clauseStart, clauseEnd] = clauseBounds(source, span[0]);
      const soft = longestPhrase(source, SOFT_MARKERS, clauseStart, clauseEnd);
      concepts.push(makeConcept({
        role: "travel_time",
        surface: text.slice(...original),
        quantity: { value: NEARNESS_DEFAULT.minutes, unit: "min", bound: "max" },
        mode: "walk",
        referent: { kind: "self", name: null },
        hardness: soft ? "soft" : "hard",
        topic: "distance",
        gist: "close by",
      }));
      consumedFolded.push(span);
      if (soft) consumedFolded.push(soft.span);
    }
  }

  NUMBER_RE.lastIndex = 0;
  for (const match of source.matchAll(NUMBER_RE)) {
    const numberStart = match.index ?? 0;
    const numberEnd = numberStart + match[0].length;
    if (claimed(numberStart, numberEnd)) continue;
    const value = numberValue(match[0]);
    if (value === null) continue;
    const [clauseStart, clauseEnd] = clauseBounds(source, numberStart);
    const suffix = source.slice(numberEnd, clauseEnd);
    const prefix = source.slice(clauseStart, numberStart);
    let unitEnd = numberEnd;
    let quantity: Quantity | null = null;
    let role: Concept["role"] | null = null;
    let currencyPrefix: "EUR" | "USD" | null = null;
    const beforeCurrency = /([€$])\s*$/.exec(prefix);
    if (beforeCurrency) currencyPrefix = beforeCurrency[1] === "€" ? "EUR" : "USD";

    if (currencyPrefix) {
      role = "money";
      quantity = { value, unit: currencyPrefix, bound: "max" };
      consumedFolded.push([numberStart - beforeCurrency![0].length, numberStart]);
    } else {
      for (const [pattern, multiplier] of LENGTH_UNITS) {
        const hit = pattern.exec(suffix.trimStart());
        if (!hit) continue;
        const padding = suffix.length - suffix.trimStart().length;
        unitEnd = numberEnd + padding + hit[0].length;
        role = "distance";
        quantity = { value: value * multiplier, unit: "m", bound: "max" };
        break;
      }
      if (!role) {
        for (const [pattern, unit] of DURATION_UNITS) {
          const hit = pattern.exec(suffix.trimStart());
          if (!hit) continue;
          const padding = suffix.length - suffix.trimStart().length;
          unitEnd = numberEnd + padding + hit[0].length;
          role = "travel_time";
          quantity = { value, unit, bound: "max" };
          break;
        }
      }
      if (!role) {
        for (const [pattern, unit] of MONEY_UNITS) {
          const hit = pattern.exec(suffix.trimStart());
          if (!hit) continue;
          const padding = suffix.length - suffix.trimStart().length;
          unitEnd = numberEnd + padding + hit[0].length;
          role = "money";
          quantity = { value, unit, bound: "max" };
          break;
        }
      }
    }

    let bound: { bound: Quantity["bound"]; span: [number, number] } | null = null;
    for (const key of ["max", "min", "about"] as const) {
      const found = phraseEndingNear(source, BOUNDS[key], numberStart, clauseStart);
      if (found && (!bound || found.phrase.length > source.slice(...bound.span).length)) {
        bound = { bound: key, span: found.span };
      }
    }
    if (!role && bound) {
      role = "money";
      quantity = { value, unit: null, bound: bound.bound };
    }
    if (!role || !quantity) continue;
    quantity.bound = match[0] === "a couple of" ? "about" : bound?.bound ?? "max";

    const mode = modeIn(source, clauseStart, clauseEnd);
    const referent = role === "distance" || role === "travel_time"
      ? referentAfter(source, unitEnd, clauseEnd)
      : null;
    const soft = longestPhrase(source, SOFT_MARKERS, clauseStart, clauseEnd);
    const surfaceStart = Math.min(bound?.span[0] ?? numberStart, numberStart);
    const surfaceEnd = Math.max(unitEnd, referent?.span?.[1] ?? unitEnd, mode?.span[1] ?? unitEnd);
    const original = originalSpan(folded, surfaceStart, surfaceEnd);
    const exactReferent = referent?.referent.kind === "named" && referent.span
      ? {
          kind: "named" as const,
          name: text.slice(...originalSpan(folded, ...referent.span))
            .replace(/^\s*(?:in der nähe vo(?:n|m)|nah am|nahe|from|of|near|to|around|von|vom|am|bei)\s+/iu, "")
            .trim(),
        }
      : referent?.referent ?? null;
    concepts.push(makeConcept({
      role,
      surface: text.slice(...original),
      quantity,
      mode: role === "travel_time" ? mode?.mode ?? null : null,
      referent: exactReferent,
      hardness: soft ? "soft" : "hard",
      unresolved: quantity.unit === null ? "unit" : null,
      topic: role === "money" ? "budget" : "distance",
      gist: role === "money" ? "budget" : role === "distance" ? "distance" : "travel time",
    }));
    consumedFolded.push([numberStart, unitEnd]);
    if (bound) consumedFolded.push(bound.span);
    if (mode) consumedFolded.push(mode.span);
    if (referent?.span) consumedFolded.push(referent.span);
    if (soft) consumedFolded.push(soft.span);
    for (const filler of DISTANCE_FILLER) {
      const hit = longestPhrase(source, [filler], clauseStart, clauseEnd);
      if (hit) consumedFolded.push(hit.span);
    }
  }

  const openNow = longestPhrase(source, ["open now", "jetzt offen"]);
  if (openNow && !claimed(...openNow.span)) {
    const original = originalSpan(folded, ...openNow.span);
    concepts.push(makeConcept({
      role: "time",
      surface: text.slice(...original),
      phrase: text.slice(...original),
      topic: "time",
      gist: "open now",
    }));
    consumedFolded.push(openNow.span);
  }

  const consumed = mergeSpans(consumedFolded.map((span) => originalSpan(folded, ...span)));
  const remainder = cleanRemainder(text, consumed);
  concepts.sort((left, right) => text.indexOf(left.surface) - text.indexOf(right.surface));
  return {
    concepts: concepts.slice(0, 5),
    consumed,
    remainder,
    preparsedWhole: concepts.length > 0 && onlyStopwords(remainder),
  };
}

const VAGUE_SELF_FORMS = [
  "close by", "nearby", "near me", "close to me", "walking distance", "in der nahe",
  "fusslaufig", "um die ecke",
] as const;

/** Shared stage-B primitive for payloads that require no room lookup. */
export function mapPreparsedConcept(
  concept: Concept,
  options: {
    currency: "EUR" | "USD";
    transport?: Array<"walk" | "bike" | "car" | "transit">;
    resolvedReferent?: ScopePayloadReferent;
  },
): PreparsedPayload | null {
  const quantity = concept.quantity;
  if (!quantity || quantity.bound === "min") return null;
  if (concept.role === "money") {
    if (quantity.unit !== "EUR" && quantity.unit !== "USD") return null;
    if (quantity.value < RANGE_SANITY.money.min || quantity.value > RANGE_SANITY.money.max) return null;
    return {
      kind: "budget",
      perPersonMax: { amount: quantity.value, currency: quantity.unit ?? options.currency },
    };
  }
  if (concept.role !== "distance" && concept.role !== "travel_time") return null;
  if (concept.referent?.kind === "named" && !options.resolvedReferent) return null;
  const referent = options.resolvedReferent
    ?? (concept.referent?.kind === "scope_center" ? { kind: "scopeCenter" as const } : undefined);
  if (concept.role === "distance") {
    if (quantity.unit !== "m") return null;
    if (quantity.value < RANGE_SANITY.radiusM.min || quantity.value > RANGE_SANITY.radiusM.max) return null;
    return {
      kind: "scope",
      dimension: "radius_m",
      max: Math.round(quantity.value),
      ...(referent ? { referent } : {}),
    };
  }
  const minutes = quantity.unit === "h" ? quantity.value * 60 : quantity.value;
  if ((quantity.unit !== "min" && quantity.unit !== "h") || minutes < RANGE_SANITY.minutes.min || minutes > RANGE_SANITY.minutes.max) return null;
  const mode = concept.mode
    ?? (options.transport?.length === 1 && options.transport[0] === "walk" ? "walk" : null);
  if (!mode) return null;
  return mode === "walk"
    ? { kind: "scope", dimension: "walk_min", max: Math.round(minutes), ...(referent ? { referent } : {}) }
    : { kind: "scope", dimension: "travel_min", max: Math.round(minutes), mode, ...(referent ? { referent } : {}) };
}
