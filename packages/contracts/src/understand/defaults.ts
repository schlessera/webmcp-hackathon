export const NEARNESS_DEFAULT = Object.freeze({
  minutes: 10,
  mode: "walk" as const,
  assumed: "read as 10 min walk",
});

export const PRICE_DEFAULTS = Object.freeze({
  cheap: 15,
  mid: 25,
  splurge: 40,
});

export const PRICE_WORDS = Object.freeze({
  cheap: ["cheap", "budget", "inexpensive", "günstig", "billig"],
  mid: ["mid-range", "mid range", "moderate"],
  splurge: ["splurge", "fancy", "pricey ok"],
});

/** Straight-line conventions only. Transit deliberately has no source. */
export const TRAVEL_SPEED_M_PER_MIN = Object.freeze({
  walk: 75,
  bike: 250,
  car: 400,
  transit: null,
});

export const RANGE_SANITY = Object.freeze({
  radiusM: Object.freeze({ min: 20, max: 20_000 }),
  minutes: Object.freeze({ min: 1, max: 180 }),
  money: Object.freeze({ min: 1, max: 500 }),
});

export const VAGUE_NEARNESS_WORDS = Object.freeze([
  "close by",
  "nearby",
  "near me",
  "close to me",
  "walking distance",
  "in der nähe",
  "fußläufig",
  "um die ecke",
]);
