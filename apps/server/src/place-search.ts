import type { AreaSnapshot, SnapshotVenue } from "./places.ts";
import { haversineMeters } from "./eligibility.ts";

/**
 * Find a place by name, in the area snapshot the room already holds in
 * memory (places.ts, "The venue source").
 *
 * No geocoder, no third-party API: the same rows the map draws are the rows
 * the box searches, so a query never leaves the process and an answer can
 * never name a place the room cannot show. Typing is forgiving — accents,
 * punctuation, word order and a single wrong letter all still match — because
 * people search for a place by the name they remember, not the name OSM
 * recorded.
 *
 * Matching is over names only (`name`, `name:*`, `alt_name`, `old_name`,
 * `brand`, `operator`). Nothing here reads a category, an amenity or any
 * other domain tag: the box behaves the same whatever kind of place the room
 * is converging on (CLAUDE.md §1).
 */

/** Longest query we index or score; anything beyond is the caller's bug. */
export const MAX_QUERY_LENGTH = 100;

const NAME_TAGS = /^(name(:[a-z_-]+)?|alt_name|int_name|old_name|short_name|brand|operator)$/;

/** Lowercase, unaccent, and reduce every separator to a single space. */
export function normalizeName(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim();
}

interface IndexedName {
  /** Normalized whole name. */
  text: string;
  tokens: string[];
  /** 1 for the venue's own `name`, below 1 for an alias: between two hits of
   * the same kind, the name a place actually carries wins. A better kind of
   * hit still wins outright — an exact alias beats a prefix of a name. */
  weight: number;
}

interface IndexedVenue {
  venue: SnapshotVenue;
  names: IndexedName[];
}

const indexes = new WeakMap<AreaSnapshot, IndexedVenue[]>();

function namesOf(venue: SnapshotVenue): IndexedName[] {
  const seen = new Map<string, number>();
  const add = (raw: string | undefined, weight: number) => {
    if (!raw) return;
    const text = normalizeName(raw);
    if (!text) return;
    const previous = seen.get(text);
    if (previous === undefined || previous < weight) seen.set(text, weight);
  };
  add(venue.name, 1);
  for (const [tag, value] of Object.entries(venue.tags)) {
    if (NAME_TAGS.test(tag)) add(value, tag === "name" ? 1 : 0.9);
  }
  return [...seen].map(([text, weight]) => ({
    text,
    tokens: text.split(" "),
    weight,
  }));
}

function indexOf(snapshot: AreaSnapshot): IndexedVenue[] {
  const existing = indexes.get(snapshot);
  if (existing) return existing;
  const built = snapshot.venues.map((venue) => ({ venue, names: namesOf(venue) }));
  indexes.set(snapshot, built);
  return built;
}

/**
 * Is `token` within one edit of the start of `candidate`? Bounded to a single
 * edit, and only for tokens long enough that one wrong letter reads as a typo
 * rather than as a different word.
 */
function nearPrefix(token: string, candidate: string): boolean {
  if (token.length < 4) return false;
  return (
    withinOneEdit(token, candidate.slice(0, token.length)) ||
    withinOneEdit(token, candidate.slice(0, token.length + 1)) ||
    withinOneEdit(token, candidate)
  );
}

/** Levenshtein distance ≤ 1, without building a matrix. */
export function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (long.length - short.length > 1) return false;
  let i = 0;
  while (i < short.length && short[i] === long[i]) i += 1;
  if (i === short.length) return long.length - short.length <= 1;
  if (short.length === long.length) {
    // One substitution: the rest must match exactly.
    return short.slice(i + 1) === long.slice(i + 1);
  }
  // One insertion in `long`: the rest of `short` must match what follows.
  return short.slice(i) === long.slice(i + 1);
}

/**
 * Score one name against the query. Higher is better, 0 is no match.
 *
 * The bands are deliberately far apart: an exact name always outranks a
 * prefix, a prefix always outranks a word match, and a typo only ever wins
 * when nothing spelled correctly matched at all.
 */
function scoreName(name: IndexedName, query: string, queryTokens: string[]): number {
  if (name.text === query) return 1000;
  if (name.text.startsWith(query)) return 800;

  const everyTokenPrefixes = queryTokens.every((token) =>
    name.tokens.some((candidate) => candidate.startsWith(token)),
  );
  if (everyTokenPrefixes) {
    // A word-start hit on every query word: "cafe cin" for "Cafe Cinema".
    return name.tokens[0]?.startsWith(queryTokens[0]) ? 620 : 560;
  }
  if (name.text.includes(query)) return 480;

  const everyTokenNear = queryTokens.every((token) =>
    name.tokens.some(
      (candidate) => candidate.startsWith(token) || nearPrefix(token, candidate),
    ),
  );
  return everyTokenNear ? 300 : 0;
}

export interface PlaceSearchOptions {
  /** Where the viewer is looking; ties break towards it. */
  near?: { lat: number; lng: number };
  limit?: number;
}

export interface PlaceSearchResult {
  venues: SnapshotVenue[];
  /** More venues matched than `limit` returned. */
  truncated: boolean;
}

/**
 * Rank the snapshot's venues against a typed query.
 *
 * Ties are broken by distance to `near` (the viewport the viewer is already
 * looking at), then by the shorter name, then by ref — so the same query
 * against the same viewport always returns the same order.
 */
export function searchSnapshot(
  snapshot: AreaSnapshot,
  rawQuery: string,
  options: PlaceSearchOptions = {},
): PlaceSearchResult {
  const query = normalizeName(rawQuery.slice(0, MAX_QUERY_LENGTH));
  const limit = Math.max(1, Math.min(20, Math.floor(options.limit ?? 8)));
  if (!query) return { venues: [], truncated: false };
  const queryTokens = query.split(" ");

  const scored: Array<{ venue: SnapshotVenue; score: number; distance: number }> = [];
  for (const entry of indexOf(snapshot)) {
    let best = 0;
    for (const name of entry.names) {
      const score = scoreName(name, query, queryTokens) * name.weight;
      if (score > best) best = score;
    }
    if (best <= 0) continue;
    scored.push({
      venue: entry.venue,
      score: best,
      distance: options.near ? haversineMeters(options.near, entry.venue.location) : 0,
    });
  }

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.distance - b.distance ||
      a.venue.name.length - b.venue.name.length ||
      (a.venue.ref < b.venue.ref ? -1 : a.venue.ref > b.venue.ref ? 1 : 0),
  );
  return {
    venues: scored.slice(0, limit).map((match) => match.venue),
    truncated: scored.length > limit,
  };
}
