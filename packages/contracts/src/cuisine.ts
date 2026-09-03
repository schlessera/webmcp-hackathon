import { VERIFIED_CONFIDENCE_FLOOR } from "./status.ts";

/** A sourced, directional cuisine implication from grounding T3.6. */
export interface CuisineRule {
  from: string;
  implies: string;
  confidence: number;
  source: "osm-cooccurrence" | "wikidata-p2012" | "wikidata-p279" | "overture-hierarchy" | "both";
  evidence: string;
}

/**
 * An implication can satisfy an inclusion only when its path is as confident
 * as verified evidence. Anything below the verified floor remains a guess.
 */
export const CUISINE_IMPLICATION_SATISFACTION_FLOOR = VERIFIED_CONFIDENCE_FLOOR;

/**
 * T3.6's four evidence blocks. Dish rules require a dominant OSM pairing, a
 * clean Wikidata P2012 result, or both; regional roll-ups follow Overture's
 * v1.18 hierarchy; sub-national rows follow Wikidata P279 plus OSM usage.
 */
export const CUISINE_RULES: readonly CuisineRule[] = [
  // Dish -> national cuisine: two-source agreement plus T3.6's OSM-only burger seed (18).
  { from: "pizza", implies: "italian", confidence: 0.95, source: "both", evidence: "OSM 9,116 co-occurrences; wd:Q177 P2012 -> Q192786" },
  { from: "sushi", implies: "japanese", confidence: 0.95, source: "both", evidence: "OSM 2,415 co-occurrences; wd:Q46383 P2012 -> Q234138" },
  { from: "pasta", implies: "italian", confidence: 0.95, source: "both", evidence: "OSM 1,072 co-occurrences; Wikidata P2012 Italian cuisine" },
  { from: "ramen", implies: "japanese", confidence: 0.95, source: "both", evidence: "OSM 635 co-occurrences; wd:Q234646 P2012 -> Q234138" },
  { from: "kebab", implies: "turkish", confidence: 0.9, source: "both", evidence: "OSM 1,015 co-occurrences; wd:Q20734 P2012 -> Q654493" },
  { from: "tapas", implies: "spanish", confidence: 0.9, source: "both", evidence: "OSM 357 co-occurrences; wd:Q220964 P2012 -> Q622512" },
  { from: "tacos", implies: "mexican", confidence: 0.9, source: "both", evidence: "OSM 295 co-occurrences; wd:Q191655 P2012 -> Q207965" },
  { from: "udon", implies: "japanese", confidence: 0.9, source: "both", evidence: "OSM 222 co-occurrences; wd:Q471861 P2012 -> Q234138" },
  { from: "hot_pot", implies: "chinese", confidence: 0.8, source: "both", evidence: "OSM hotpot/hot_pot 493 co-occurrences; Wikidata P2012 single cuisine" },
  { from: "doner", implies: "turkish", confidence: 0.9, source: "both", evidence: "OSM doner/kebab dominant co-occurrence; wd:Q20734 P2012 -> Q654493" },
  { from: "pho", implies: "vietnamese", confidence: 0.8, source: "both", evidence: "OSM dominant co-occurrence; Wikidata P2012 single cuisine" },
  { from: "banh_mi", implies: "vietnamese", confidence: 0.8, source: "both", evidence: "OSM dominant co-occurrence; Wikidata P2012 single cuisine" },
  { from: "gyoza", implies: "japanese", confidence: 0.8, source: "both", evidence: "OSM dominant co-occurrence; Wikidata P2012 single cuisine" },
  { from: "dim_sum", implies: "chinese", confidence: 0.8, source: "both", evidence: "OSM dominant co-occurrence; Wikidata P2012 single cuisine" },
  { from: "falafel", implies: "middle_eastern", confidence: 0.8, source: "both", evidence: "OSM dominant co-occurrence; Wikidata P2012 single cuisine" },
  { from: "hummus", implies: "middle_eastern", confidence: 0.8, source: "both", evidence: "OSM dominant co-occurrence; Wikidata P2012 single cuisine" },
  { from: "burrito", implies: "mexican", confidence: 0.8, source: "both", evidence: "OSM dominant co-occurrence; Wikidata P2012 single cuisine" },
  { from: "burger", implies: "american", confidence: 0.8, source: "osm-cooccurrence", evidence: "OSM 1,040 co-occurrences; no clean Wikidata link" },

  // Dish -> national cuisine: Wikidata P2012 only or contested (12).
  { from: "tempura", implies: "japanese", confidence: 0.8, source: "wikidata-p2012", evidence: "wd:Q328709 P2012 -> Q234138" },
  { from: "pad_thai", implies: "thai", confidence: 0.9, source: "wikidata-p2012", evidence: "wd:Q730298 P2012 -> Q841984" },
  { from: "bibimbap", implies: "korean", confidence: 0.8, source: "wikidata-p2012", evidence: "wd:Q648352 P2012 -> Q647500" },
  { from: "churro", implies: "spanish", confidence: 0.8, source: "wikidata-p2012", evidence: "wd:Q727605 P2012 -> Q622512" },
  { from: "tiramisu", implies: "italian", confidence: 0.8, source: "wikidata-p2012", evidence: "wd:Q131582 P2012 -> Q192786" },
  { from: "paella", implies: "valencian", confidence: 0.8, source: "wikidata-p2012", evidence: "wd:Q212121 P2012 -> Q1223242" },
  { from: "shawarma", implies: "arab", confidence: 0.8, source: "wikidata-p2012", evidence: "wd:Q3412448 P2012 -> Q623970" },
  { from: "curry", implies: "indian", confidence: 0.6, source: "wikidata-p2012", evidence: "Wikidata P2012 is contested (Q145 country); capped at 0.60" },
  { from: "soba", implies: "japanese", confidence: 0.8, source: "wikidata-p2012", evidence: "Wikidata P2012 single-cuisine result" },
  { from: "yakitori", implies: "japanese", confidence: 0.8, source: "wikidata-p2012", evidence: "Wikidata P2012 single-cuisine result" },
  { from: "kimchi", implies: "korean", confidence: 0.8, source: "wikidata-p2012", evidence: "Wikidata P2012 single-cuisine result" },
  { from: "injera", implies: "ethiopian", confidence: 0.8, source: "wikidata-p2012", evidence: "Wikidata P2012 single-cuisine result" },

  // Connective regional edges: direct Wikidata subclass statements.
  { from: "valencian", implies: "spanish", confidence: 0.9, source: "wikidata-p279", evidence: "wd:Q1223242 P279 -> Q622512" },
  { from: "arab", implies: "middle_eastern", confidence: 0.9, source: "wikidata-p279", evidence: "wd:Q623970 P279 -> Q1547037" },

  // National -> regional roll-up: Overture v1.18 hierarchy (22).
  { from: "chinese", implies: "asian", confidence: 0.95, source: "overture-hierarchy", evidence: "[eat_and_drink,restaurant,asian_restaurant,chinese_restaurant]" },
  { from: "japanese", implies: "asian", confidence: 0.95, source: "overture-hierarchy", evidence: "[eat_and_drink,restaurant,asian_restaurant,japanese_restaurant]" },
  { from: "korean", implies: "asian", confidence: 0.95, source: "overture-hierarchy", evidence: "[eat_and_drink,restaurant,asian_restaurant,korean_restaurant]" },
  { from: "thai", implies: "asian", confidence: 0.95, source: "overture-hierarchy", evidence: "[eat_and_drink,restaurant,asian_restaurant,thai_restaurant]" },
  { from: "vietnamese", implies: "asian", confidence: 0.95, source: "overture-hierarchy", evidence: "[eat_and_drink,restaurant,asian_restaurant,vietnamese_restaurant]" },
  { from: "mexican", implies: "latin_american", confidence: 0.95, source: "overture-hierarchy", evidence: "[eat_and_drink,restaurant,latin_american_restaurant,mexican_restaurant]" },
  { from: "tex-mex", implies: "latin_american", confidence: 0.9, source: "overture-hierarchy", evidence: "texmex_restaurant under latin_american_restaurant" },
  { from: "peruvian", implies: "latin_american", confidence: 0.95, source: "overture-hierarchy", evidence: "[eat_and_drink,restaurant,latin_american_restaurant,peruvian_restaurant]" },
  { from: "brazilian", implies: "latin_american", confidence: 0.95, source: "overture-hierarchy", evidence: "[eat_and_drink,restaurant,latin_american_restaurant,brazilian_restaurant]" },
  { from: "turkish", implies: "middle_eastern", confidence: 0.95, source: "overture-hierarchy", evidence: "[eat_and_drink,restaurant,middle_eastern_restaurant,turkish_restaurant]" },
  { from: "lebanese", implies: "middle_eastern", confidence: 0.95, source: "overture-hierarchy", evidence: "[eat_and_drink,restaurant,middle_eastern_restaurant,lebanese_restaurant]" },
  { from: "persian", implies: "middle_eastern", confidence: 0.95, source: "overture-hierarchy", evidence: "persian_restaurant under middle_eastern_restaurant" },
  { from: "georgian", implies: "middle_eastern", confidence: 0.8, source: "overture-hierarchy", evidence: "[eat_and_drink,restaurant,middle_eastern_restaurant,georgian_restaurant] (contested placement)" },
  { from: "armenian", implies: "middle_eastern", confidence: 0.95, source: "overture-hierarchy", evidence: "[eat_and_drink,restaurant,middle_eastern_restaurant,armenian_restaurant]" },
  { from: "egyptian", implies: "middle_eastern", confidence: 0.95, source: "overture-hierarchy", evidence: "[eat_and_drink,restaurant,middle_eastern_restaurant,egyptian_restaurant]" },
  { from: "israeli", implies: "middle_eastern", confidence: 0.95, source: "overture-hierarchy", evidence: "[eat_and_drink,restaurant,middle_eastern_restaurant,israeli_restaurant]" },
  { from: "syrian", implies: "middle_eastern", confidence: 0.95, source: "overture-hierarchy", evidence: "[eat_and_drink,restaurant,middle_eastern_restaurant,syrian_restaurant]" },
  { from: "ethiopian", implies: "african", confidence: 0.95, source: "overture-hierarchy", evidence: "[eat_and_drink,restaurant,african_restaurant,ethiopian_restaurant]" },
  { from: "moroccan", implies: "african", confidence: 0.9, source: "overture-hierarchy", evidence: "[eat_and_drink,restaurant,african_restaurant,moroccan_restaurant]" },
  { from: "nigerian", implies: "african", confidence: 0.95, source: "overture-hierarchy", evidence: "[eat_and_drink,restaurant,african_restaurant,nigerian_restaurant]" },
  { from: "senegalese", implies: "african", confidence: 0.95, source: "overture-hierarchy", evidence: "[eat_and_drink,restaurant,african_restaurant,senegalese_restaurant]" },
  { from: "south_african", implies: "african", confidence: 0.95, source: "overture-hierarchy", evidence: "[eat_and_drink,restaurant,african_restaurant,south_african_restaurant]" },

  // Sub-national -> national: Wikidata P279 plus OSM vocabulary (8).
  { from: "sichuan", implies: "chinese", confidence: 0.9, source: "both", evidence: "Wikidata P279 chain under Chinese cuisine; OSM cuisine value" },
  { from: "cantonese", implies: "chinese", confidence: 0.9, source: "both", evidence: "Wikidata P279 chain under Chinese cuisine; OSM cuisine value" },
  { from: "hunanese", implies: "chinese", confidence: 0.9, source: "both", evidence: "Wikidata P279 chain under Chinese cuisine; OSM cuisine value" },
  { from: "bavarian", implies: "german", confidence: 0.9, source: "both", evidence: "Wikidata P279 under German cuisine; OSM cuisine value" },
  { from: "basque", implies: "spanish", confidence: 0.9, source: "both", evidence: "Wikidata P279 under Spanish cuisine; OSM cuisine value" },
  { from: "catalan", implies: "spanish", confidence: 0.9, source: "both", evidence: "Wikidata P279 under Spanish cuisine; OSM cuisine value" },
  { from: "galician", implies: "spanish", confidence: 0.9, source: "both", evidence: "Wikidata P279 under Spanish cuisine; OSM cuisine value" },
  { from: "sicilian", implies: "italian", confidence: 0.9, source: "both", evidence: "Wikidata P279 under Italian cuisine; OSM cuisine value" },
] as const;

/**
 * Dish tokens, the `from` side of T3.6's two dish blocks. They are common
 * nouns, so reader-facing copy keeps them lowercase; every other token names
 * a place or a people and keeps its capital.
 */
export const DISH_TOKENS: ReadonlySet<string> = new Set([
  "pizza", "sushi", "pasta", "ramen", "kebab", "tapas", "tacos", "udon",
  "hot_pot", "doner", "pho", "banh_mi", "gyoza", "dim_sum", "falafel",
  "hummus", "burrito", "burger", "tempura", "pad_thai", "bibimbap", "churro",
  "tiramisu", "paella", "shawarma", "curry", "soba", "yakitori", "kimchi",
  "injera",
]);

const ALIASES: Readonly<Record<string, string>> = {
  hotpot: "hot_pot",
  taco: "tacos",
};

/** Normalize raw OSM values, including arrays of semicolon-joined tags. */
export function normalizeCuisineTokens(raw: string | string[]): string[] {
  const out: string[] = [];
  for (const part of (Array.isArray(raw) ? raw : [raw]).flatMap((value) => value.split(";"))) {
    const token = part.trim().toLowerCase();
    if (!token) continue;
    const expanded = token === "italian_pizza" ? ["italian", "pizza"] : [ALIASES[token] ?? token];
    for (const value of expanded) if (!out.includes(value)) out.push(value);
  }
  return out;
}

const byFrom = new Map<string, CuisineRule[]>();
for (const rule of CUISINE_RULES) {
  const rows = byFrom.get(rule.from) ?? [];
  rows.push(rule);
  byFrom.set(rule.from, rows);
}

/**
 * Direct implications plus one additional hop. A two-edge confidence is the
 * product of its edges; duplicate destinations keep their strongest path.
 */
export function implies(token: string): Array<{ cuisine: string; confidence: number }> {
  const results = new Map<string, number>();
  for (const from of normalizeCuisineTokens(token)) {
    for (const direct of byFrom.get(from) ?? []) {
      results.set(direct.implies, Math.max(results.get(direct.implies) ?? 0, direct.confidence));
      for (const second of byFrom.get(direct.implies) ?? []) {
        const confidence = direct.confidence * second.confidence;
        results.set(second.implies, Math.max(results.get(second.implies) ?? 0, confidence));
      }
    }
  }
  return [...results.entries()]
    .map(([cuisine, confidence]) => ({ cuisine, confidence }))
    .sort((a, b) => b.confidence - a.confidence || a.cuisine.localeCompare(b.cuisine));
}
