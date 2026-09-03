import type pg from "pg";
import { PLACE_CLASSES, PRICE_LEVEL_EUR, type PlaceClass } from "@webmcp-hackathon/contracts";
import { outboundFetchFor } from "../net/outbound.ts";

export const LISTING_SOURCE = "listing:google" as const;
export const LISTING_NOTE = "Google business profile";
export const LISTING_CONFIDENCE = 0.65;
export const LISTING_TTL_MS = 7 * 24 * 60 * 60_000;
export const LISTING_ROOM_BUDGET_MS = 24 * 60 * 60_000;
export const DATAFORSEO_REQUEST_USD = 0.012;
export const DATAFORSEO_ITEM_USD = 0.00036;
export const DATAFORSEO_LIMIT = 1_000;
export const LISTING_MATCH_DISTANCE_M = 60;
/** The provider caps a request at 10 categories; a wider pool takes more. */
export const DATAFORSEO_CATEGORIES_PER_REQUEST = 10;
export const DATAFORSEO_MAX_REQUESTS = 6;
/** `location_coordinate` rejects a radius below one kilometre. */
export const DATAFORSEO_MIN_RADIUS_KM = 1;

/**
 * Our place classes to the provider's own category names, every one of them
 * checked against the 5,317-name list its categories endpoint publishes
 * (verified live 2026-09-03). This is a provider translation, not a domain
 * branch: the classes come from the pool, and nothing here reaches a client.
 *
 * It exists because an unfiltered request is useless. Measured on the Berlin
 * demo centre at a 1 km radius: 10,238 businesses match with no category
 * filter, so the 1,000-item cap returns an arbitrary tenth of them — lawyers,
 * software firms and hotels — and one of 31 pool places was found. The same
 * request filtered to the pool's own classes matches 435, fits under the cap
 * whole, and costs less because cost is per item returned.
 */
export const LISTING_CATEGORIES: Readonly<Record<PlaceClass, readonly string[]>> = Object.freeze({
  // A class expands to its subtypes because the provider files a place under
  // the most specific one it has: Grill Royal is `bar_and_grill`, not
  // `restaurant`, and asking only for `restaurant` never returns it. Measured
  // on the Berlin pool, adding subtypes recovered 7 of the 12 places a
  // top-level-only filter missed.
  cafe: ["cafe", "coffee_shop", "espresso_bar", "bistro", "patisserie", "cafeteria"],
  restaurant: [
    "restaurant", "italian_restaurant", "asian_restaurant", "chinese_restaurant",
    "japanese_restaurant", "sushi_restaurant", "ramen_restaurant", "korean_restaurant",
    "thai_restaurant", "vietnamese_restaurant", "indian_restaurant",
    "middle_eastern_restaurant", "turkish_restaurant", "greek_restaurant",
    "spanish_restaurant", "french_restaurant", "german_restaurant",
    "american_restaurant", "mexican_restaurant", "seafood_restaurant",
    "barbecue_restaurant", "bar_and_grill", "fine_dining_restaurant",
    "vegetarian_restaurant", "vegan_restaurant", "brunch_restaurant",
    "breakfast_restaurant",
  ],
  bar: ["bar", "cocktail_bar", "wine_bar", "sports_bar", "gastropub"],
  pub: ["pub", "brewpub", "beer_hall"],
  biergarten: ["beer_garden"],
  fast_food: [
    "fast_food_restaurant", "hamburger_restaurant", "pizza_restaurant",
    "taco_restaurant", "chicken_restaurant", "sandwich_shop", "kebab_shop",
    "salad_shop",
  ],
  cinema: ["movie_theater"],
  theatre: ["performing_arts_theater"],
  library: ["library"],
  coworking_space: ["coworking_space"],
  arts_centre: ["arts_organization", "cultural_center"],
  community_centre: ["community_center"],
  ice_cream: ["ice_cream_shop"],
  park: ["park"],
  garden: ["garden"],
  dog_park: ["dog_park"],
  playground: ["playground"],
  sports_centre: ["sports_complex"],
  fitness_centre: ["fitness_center"],
  museum: ["museum"],
  gallery: ["art_gallery"],
  attraction: ["tourist_attraction"],
  zoo: ["zoo"],
  aquarium: ["aquarium"],
  books: ["book_store"],
  bakery: ["bakery"],
  coffee: ["coffee_shop"],
  tea: ["tea_house"],
});

/**
 * Provider categories for the classes this pool actually holds, in stable
 * class order, chunked to the provider's per-request cap. An empty result
 * means no class was recognized; the caller then sends no filter rather than
 * fetching nothing.
 */
export function listingCategoryBatches(classes: readonly string[]): string[][] {
  const known = new Set(PLACE_CLASSES as readonly string[]);
  const present = new Set(classes.filter((value) => known.has(value)));
  const names = [...new Set(
    (PLACE_CLASSES as readonly PlaceClass[])
      .filter((placeClass) => present.has(placeClass))
      .flatMap((placeClass) => LISTING_CATEGORIES[placeClass] ?? []),
  )];
  const batches: string[][] = [];
  for (let at = 0; at < names.length; at += DATAFORSEO_CATEGORIES_PER_REQUEST) {
    batches.push(names.slice(at, at + DATAFORSEO_CATEGORIES_PER_REQUEST));
  }
  return batches.slice(0, DATAFORSEO_MAX_REQUESTS);
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const liveListingFetch: FetchLike = outboundFetchFor("dataforseo", {
  direct: true,
  maxBytes: 12 * 1024 * 1024,
  timeoutMs: 30_000,
});
let listingFetch: FetchLike = liveListingFetch;
const unreportedSpendByRoom = new Map<string, number>();

/** Test seam for the DataForSEO transport. */
export function setListingFetch(next: FetchLike | null): void {
  listingFetch = next ?? liveListingFetch;
}

/** Consume listing spend once in the room's next structured refinement tick. */
export function takeListingSpendUsd(roomId: string): number {
  const spend = unreportedSpendByRoom.get(roomId) ?? 0;
  unreportedSpendByRoom.delete(roomId);
  return spend;
}

export interface ListingCandidate {
  candidateId: string;
  osmRef: string;
  name: string;
  location: { lat: number; lng: number };
  website?: string;
}

interface ListingRating {
  value?: unknown;
  votes_count?: unknown;
  rating_max?: unknown;
}

interface ListingTime {
  hour?: unknown;
  minute?: unknown;
}

interface ListingInterval {
  open?: ListingTime;
  close?: ListingTime;
}

interface ListingWorkHours {
  timetable?: Record<string, ListingInterval[] | null>;
  current_status?: unknown;
}

export interface DataForSeoListing {
  type?: unknown;
  title?: unknown;
  original_title?: unknown;
  latitude?: unknown;
  longitude?: unknown;
  url?: unknown;
  domain?: unknown;
  check_url?: unknown;
  place_id?: unknown;
  cid?: unknown;
  attributes?: {
    available_attributes?: unknown;
    unavailable_attributes?: unknown;
  } | null;
  work_time?: { work_hours?: ListingWorkHours | null } | null;
  work_hours?: ListingWorkHours | null;
  price_level?: unknown;
  rating?: ListingRating | null;
}

export interface ListingClaim {
  key: string;
  lean: "yes" | "no";
  confidence: typeof LISTING_CONFIDENCE;
  evidence: typeof LISTING_NOTE;
  source: typeof LISTING_SOURCE;
  sourceUrl: string;
  value?: number;
  explicit: false;
}

export interface ListingFacts {
  title: string;
  source: typeof LISTING_SOURCE;
  sourceUrl: string;
  fetchedAt: string;
  expiresAt: string;
  website?: string;
  domain?: string;
  hours?: string[];
  priceLevel?: keyof typeof PRICE_LEVEL_EUR;
  rating?: { value: number; best: number; count?: number };
  claims: ListingClaim[];
}

export interface MatchedListing {
  candidate: ListingCandidate;
  listing: DataForSeoListing;
  facts: ListingFacts;
  distanceM: number;
  nameSimilarity: number;
}

export interface ListingBatchResult {
  roomId: string;
  scopeId: string;
  observedAt: string;
  returnedItems: number;
  costUsd: number;
  matches: MatchedListing[];
}

function safeHttpUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function normalizedDomain(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const withScheme = value.includes("://") ? value : `https://${value}`;
    return new URL(withScheme).hostname.toLocaleLowerCase().replace(/^www\./, "") || undefined;
  } catch {
    return undefined;
  }
}

function candidateDomain(candidate: ListingCandidate): string | undefined {
  return normalizedDomain(candidate.website);
}

function listingDomain(listing: DataForSeoListing): string | undefined {
  return normalizedDomain(listing.domain) ?? normalizedDomain(listing.url);
}

function normalizeName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function bigrams(value: string): string[] {
  const compact = value.replace(/\s+/g, " ");
  if (compact.length < 2) return compact ? [compact] : [];
  return Array.from({ length: compact.length - 1 }, (_, index) => compact.slice(index, index + 2));
}

/** Sørensen-Dice similarity, with exact normalized names taking the fast path. */
export function listingNameSimilarity(left: string, right: string): number {
  const a = normalizeName(left);
  const b = normalizeName(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const remaining = new Map<string, number>();
  for (const gram of bigrams(a)) remaining.set(gram, (remaining.get(gram) ?? 0) + 1);
  let overlap = 0;
  const rightBigrams = bigrams(b);
  for (const gram of rightBigrams) {
    const count = remaining.get(gram) ?? 0;
    if (count <= 0) continue;
    overlap += 1;
    remaining.set(gram, count - 1);
  }
  return 2 * overlap / (bigrams(a).length + rightBigrams.length);
}

export function listingDistanceMeters(
  left: { lat: number; lng: number },
  right: { lat: number; lng: number },
): number {
  const rad = Math.PI / 180;
  const dLat = (right.lat - left.lat) * rad;
  const dLng = (right.lng - left.lng) * rad;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(left.lat * rad) * Math.cos(right.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function listingLocation(listing: DataForSeoListing): { lat: number; lng: number } | undefined {
  const lat = Number(listing.latitude);
  const lng = Number(listing.longitude);
  return Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
    ? { lat, lng }
    : undefined;
}

export const LISTING_CONTAINED_DISTANCE_M = 25;
export const LISTING_NAME_SIMILARITY = 0.72;

/**
 * True when one name is the other plus extra whole words — the shape a branch
 * suffix takes. Dice similarity punishes the length difference and scores
 * these below the threshold even though they are the same place: measured on
 * the Berlin pool, "Hackescher Hof" against "Restaurant Hackescher Hof"
 * scores 0.70 at 14 m, and "Haferkater" against "Haferkater,
 * Friedrichstrasse" scores 0.53 at 15 m.
 *
 * Containment alone is far too loose ("sushi" sits inside "Sushi Miyabi"), so
 * it counts only with a tight distance, a name long enough to be an identity,
 * and the shorter name covering half the longer one's words.
 */
export function listingNameContains(left: string, right: string): boolean {
  const a = normalizeName(left);
  const b = normalizeName(right);
  if (!a || !b || a === b) return false;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  // Six characters, because "sushi" (five) sits inside "Sushi Miyabi" and is
  // a dish, not an identity.
  if (shorter.length < 6) return false;
  const words = longer.split(" ");
  const shortWords = shorter.split(" ");
  if (!` ${longer} `.includes(` ${shorter} `)) return false;
  return shortWords.length / words.length >= 0.5;
}

/**
 * A match needs both identity and proximity. When both records name a domain,
 * that identity signal must agree as well; a nearby similarly named venue on
 * another site is deliberately rejected.
 */
export function matchListing(
  candidate: ListingCandidate,
  listing: DataForSeoListing,
): { distanceM: number; nameSimilarity: number } | null {
  const title = typeof listing.title === "string"
    ? listing.title
    : typeof listing.original_title === "string"
      ? listing.original_title
      : "";
  const location = listingLocation(listing);
  if (!title || !location) return null;
  const distanceM = listingDistanceMeters(candidate.location, location);
  if (distanceM > LISTING_MATCH_DISTANCE_M) return null;
  const nameSimilarity = listingNameSimilarity(candidate.name, title);
  const contained = distanceM <= LISTING_CONTAINED_DISTANCE_M &&
    listingNameContains(candidate.name, title);
  if (nameSimilarity < LISTING_NAME_SIMILARITY && !contained) return null;
  const candidateSite = candidateDomain(candidate);
  const listingSite = listingDomain(listing);
  if (candidateSite && listingSite && candidateSite !== listingSite) return null;
  return { distanceM, nameSimilarity };
}

function collectAttributeNames(value: unknown, out: Set<string>): void {
  if (typeof value === "string") {
    out.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectAttributeNames(item, out);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (nested === true) out.add(key);
    else collectAttributeNames(nested, out);
  }
}

const ATTRIBUTE_KEYS = {
  welcomes_dogs: "dog-friendly",
  has_wheelchair_accessible_entrance: "wheelchair-accessible",
  has_seating_outdoors: "outdoor-seating",
  serves_vegetarian: "vegetarian-options",
  has_wi_fi: "wifi",
  has_takeout: "takeaway",
  takeaway: "takeaway",
  has_delivery: "delivery",
  delivery: "delivery",
} as const;

const PRICE_LEVELS: Record<string, keyof typeof PRICE_LEVEL_EUR> = {
  inexpensive: 1,
  moderate: 2,
  expensive: 3,
  very_expensive: 4,
};

function listingCitation(listing: DataForSeoListing): string | undefined {
  const checked = safeHttpUrl(listing.check_url);
  if (checked) return checked;
  if (typeof listing.place_id === "string" && listing.place_id.trim()) {
    return `https://www.google.com/maps/search/?api=1&query_place_id=${encodeURIComponent(listing.place_id.trim())}`;
  }
  if (typeof listing.cid === "string" && /^\d+$/.test(listing.cid)) {
    return `https://www.google.com/maps?cid=${listing.cid}`;
  }
  return undefined;
}

function twoDigits(value: unknown): string | undefined {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 && number <= 59
    ? String(number).padStart(2, "0")
    : undefined;
}

export function listingHours(listing: DataForSeoListing): string[] {
  const workHours = listing.work_time?.work_hours ?? listing.work_hours;
  const timetable = workHours?.timetable;
  if (!timetable || typeof timetable !== "object") return [];
  const dayNames: Record<string, string> = {
    monday: "Mo", tuesday: "Tu", wednesday: "We", thursday: "Th",
    friday: "Fr", saturday: "Sa", sunday: "Su",
  };
  return Object.entries(timetable).flatMap(([day, intervals]) => {
    const prefix = dayNames[day.toLocaleLowerCase()];
    if (!prefix || !Array.isArray(intervals)) return [];
    const spans = intervals.flatMap((interval) => {
      const openHour = twoDigits(interval?.open?.hour);
      const openMinute = twoDigits(interval?.open?.minute);
      const closeHour = twoDigits(interval?.close?.hour);
      const closeMinute = twoDigits(interval?.close?.minute);
      return openHour && openMinute && closeHour && closeMinute
        ? [`${openHour}:${openMinute}-${closeHour}:${closeMinute}`]
        : [];
    });
    return spans.length ? [`${prefix} ${spans.join(",")}`] : [];
  });
}

/** Pure mapping used by both the provider and unit fixtures. */
export function mapListing(
  listing: DataForSeoListing,
  observedAt = new Date().toISOString(),
): ListingFacts | null {
  const title = typeof listing.title === "string" && listing.title.trim()
    ? listing.title.trim()
    : typeof listing.original_title === "string" && listing.original_title.trim()
      ? listing.original_title.trim()
      : "";
  const sourceUrl = listingCitation(listing);
  if (!title || !sourceUrl) return null;
  const available = new Set<string>();
  const unavailable = new Set<string>();
  collectAttributeNames(listing.attributes?.available_attributes, available);
  collectAttributeNames(listing.attributes?.unavailable_attributes, unavailable);
  const claims = new Map<string, ListingClaim>();
  for (const [providerKey, key] of Object.entries(ATTRIBUTE_KEYS)) {
    const lean = available.has(providerKey) ? "yes" : unavailable.has(providerKey) ? "no" : null;
    if (!lean || claims.has(key)) continue;
    claims.set(key, {
      key,
      lean,
      confidence: LISTING_CONFIDENCE,
      evidence: LISTING_NOTE,
      source: LISTING_SOURCE,
      sourceUrl,
      explicit: false,
    });
  }
  const rawPrice = typeof listing.price_level === "string"
    ? PRICE_LEVELS[listing.price_level.toLocaleLowerCase()]
    : undefined;
  if (rawPrice) {
    claims.set("price-level", {
      key: "price-level",
      lean: "yes",
      confidence: LISTING_CONFIDENCE,
      evidence: LISTING_NOTE,
      source: LISTING_SOURCE,
      sourceUrl,
      value: rawPrice,
      explicit: false,
    });
  }
  const value = Number(listing.rating?.value);
  const best = Number(listing.rating?.rating_max ?? 5);
  const count = Number(listing.rating?.votes_count);
  const rating = Number.isFinite(value) && Number.isFinite(best) && best > 0 && value >= 0 && value <= best
    ? { value, best, ...(Number.isInteger(count) && count >= 0 ? { count } : {}) }
    : undefined;
  const website = safeHttpUrl(listing.url);
  const domain = listingDomain(listing);
  const hours = listingHours(listing);
  const priceLevel = rawPrice;
  return {
    title,
    source: LISTING_SOURCE,
    sourceUrl,
    fetchedAt: observedAt,
    expiresAt: new Date(new Date(observedAt).getTime() + LISTING_TTL_MS).toISOString(),
    ...(website ? { website } : {}),
    ...(domain ? { domain } : {}),
    ...(hours.length ? { hours } : {}),
    ...(priceLevel ? { priceLevel } : {}),
    ...(rating ? { rating } : {}),
    claims: [...claims.values()],
  };
}

/** Greedy one-to-one assignment, best identity signal first. */
export function matchListings(
  candidates: ListingCandidate[],
  listings: DataForSeoListing[],
  observedAt = new Date().toISOString(),
): MatchedListing[] {
  const possible = candidates.flatMap((candidate) => listings.flatMap((listing, listingIndex) => {
    const match = matchListing(candidate, listing);
    const facts = match ? mapListing(listing, observedAt) : null;
    return match && facts ? [{ candidate, listing, listingIndex, facts, ...match }] : [];
  })).sort((a, b) =>
    b.nameSimilarity - a.nameSimilarity || a.distanceM - b.distanceM ||
    a.candidate.candidateId.localeCompare(b.candidate.candidateId)
  );
  const usedCandidates = new Set<string>();
  const usedListings = new Set<number>();
  return possible.flatMap(({ listingIndex, ...match }) => {
    if (usedCandidates.has(match.candidate.candidateId) || usedListings.has(listingIndex)) return [];
    usedCandidates.add(match.candidate.candidateId);
    usedListings.add(listingIndex);
    return [match];
  });
}

interface RoomListingRow {
  scope_id: string;
  center: { lat?: unknown; lng?: unknown };
  radius_m: number;
}

async function reserveRoomFetch(
  q: Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query">,
  roomId: string,
): Promise<RoomListingRow | null> {
  const room = (await q.query(
    `SELECT scope->>'scopeId' AS scope_id,
            scope->'area'->'center' AS center,
            (scope->'area'->>'radiusM')::double precision AS radius_m
       FROM rooms
      WHERE id = $1 AND scope->'area'->>'kind' = 'circle'`,
    [roomId],
  )).rows[0] as RoomListingRow | undefined;
  const lat = Number(room?.center?.lat);
  const lng = Number(room?.center?.lng);
  if (!room?.scope_id || !Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(room.radius_m)) {
    return null;
  }
  const reserved = await q.query(
    `INSERT INTO room_listing_fetches (room_id, scope_id, fetched_at, status)
     VALUES ($1, $2, now(), 'pending')
     ON CONFLICT (room_id) DO UPDATE SET
       scope_id = EXCLUDED.scope_id,
       fetched_at = EXCLUDED.fetched_at,
       status = 'pending',
       item_count = 0,
       cost_usd = 0
     WHERE room_listing_fetches.scope_id IS DISTINCT FROM EXCLUDED.scope_id
        OR room_listing_fetches.fetched_at <= now() - interval '24 hours'
     RETURNING room_id`,
    [roomId, room.scope_id],
  );
  return reserved.rowCount === 1
    ? { ...room, center: { lat, lng } }
    : null;
}

function responseListings(body: unknown): { items: DataForSeoListing[]; cost?: number } {
  if (!body || typeof body !== "object") return { items: [] };
  const root = body as {
    cost?: unknown;
    tasks?: Array<{
      status_code?: unknown;
      cost?: unknown;
      result?: Array<{ items?: unknown }>;
    }>;
  };
  const task = root.tasks?.find((entry) => Number(entry.status_code) === 20_000) ?? root.tasks?.[0];
  const items = task?.result?.flatMap((result) => Array.isArray(result.items)
    ? result.items.filter((item): item is DataForSeoListing => Boolean(item && typeof item === "object"))
    : []) ?? [];
  const suppliedCost = Number(task?.cost ?? root.cost);
  return { items, ...(Number.isFinite(suppliedCost) && suppliedCost >= 0 ? { cost: suppliedCost } : {}) };
}

export function listingsEnabled(): boolean {
  return process.env.LISTINGS !== "0" &&
    process.env.ENRICH_NETWORK !== "0" &&
    Boolean(process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD);
}

/**
 * Reserve and fetch the whole current room pool once. The reservation is
 * durable, so concurrent processes and repeated warm-up batches cannot spend
 * a second request inside 24 hours; changing scopeId grants exactly one new
 * request immediately.
 */
export async function fetchRoomListings(
  q: Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query">,
  roomId: string,
): Promise<ListingBatchResult | null> {
  if (!listingsEnabled()) return null;
  const room = await reserveRoomFetch(q, roomId);
  if (!room) return null;
  const observedAt = new Date().toISOString();
  try {
    const rows = (await q.query(
      `SELECT id, osm_ref, name, category, location, extras->>'website' AS website
         FROM candidates
        WHERE room_id = $1 AND osm_ref IS NOT NULL
        ORDER BY id
        LIMIT $2`,
      [roomId, DATAFORSEO_LIMIT],
    )).rows as Array<{
      id: string;
      osm_ref: string;
      name: string;
      category: string | null;
      location: { lat?: unknown; lng?: unknown };
      website: string | null;
    }>;
    const candidates = rows.flatMap((row): ListingCandidate[] => {
      const lat = Number(row.location?.lat);
      const lng = Number(row.location?.lng);
      return Number.isFinite(lat) && Number.isFinite(lng)
        ? [{
            candidateId: row.id,
            osmRef: row.osm_ref,
            name: row.name,
            location: { lat, lng },
            ...(row.website ? { website: row.website } : {}),
          }]
        : [];
    });
    if (candidates.length === 0) {
      await q.query(
        "UPDATE room_listing_fetches SET status = 'ok' WHERE room_id = $1",
        [roomId],
      );
      return {
        roomId,
        scopeId: room.scope_id,
        observedAt,
        returnedItems: 0,
        costUsd: 0,
        matches: [],
      };
    }
    // The provider rejects a radius under a kilometre, so a tighter scope is
    // fetched at the floor and the 60 m match rule discards the overshoot.
    const radiusKm = Math.max(DATAFORSEO_MIN_RADIUS_KM, room.radius_m / 1_000);
    const coordinate =
      `${Number(room.center.lat).toFixed(7)},${Number(room.center.lng).toFixed(7)},${Number(radiusKm.toFixed(3))}`;
    // One request per category batch; an unrecognized pool sends no filter
    // rather than fetching nothing.
    const batches = listingCategoryBatches(rows.map((row) => row.category ?? ""));
    const requests = batches.length ? batches : [null];
    const items: DataForSeoListing[] = [];
    let costUsd = 0;
    for (const categories of requests) {
      const response = await listingFetch(
        "https://api.dataforseo.com/v3/business_data/business_listings/search/live",
        {
          method: "POST",
          headers: {
            authorization: `Basic ${Buffer.from(`${process.env.DATAFORSEO_LOGIN}:${process.env.DATAFORSEO_PASSWORD}`).toString("base64")}`,
            "content-type": "application/json",
          },
          body: JSON.stringify([{
            location_coordinate: coordinate,
            limit: DATAFORSEO_LIMIT,
            ...(categories ? { categories } : {}),
          }]),
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`DataForSEO returned ${response.status}`);
      }
      const parsed = responseListings(await response.json());
      items.push(...parsed.items);
      costUsd += parsed.cost ?? DATAFORSEO_REQUEST_USD + DATAFORSEO_ITEM_USD * parsed.items.length;
    }
    unreportedSpendByRoom.set(roomId, (unreportedSpendByRoom.get(roomId) ?? 0) + costUsd);
    await q.query(
      `UPDATE room_listing_fetches
          SET status = 'ok', item_count = $2, cost_usd = $3
        WHERE room_id = $1`,
      [roomId, items.length, costUsd],
    );
    return {
      roomId,
      scopeId: room.scope_id,
      observedAt,
      returnedItems: items.length,
      costUsd,
      matches: matchListings(candidates, items, observedAt),
    };
  } catch (error) {
    await q.query(
      `UPDATE room_listing_fetches SET status = 'error' WHERE room_id = $1`,
      [roomId],
    ).catch(() => undefined);
    throw error;
  }
}
