/**
 * OSM tags that make a named feature a place in an area snapshot. This is
 * server-side data: clients render the category sent by the server and never
 * branch on any of these values (CLAUDE.md §1).
 *
 * The test for inclusion is whether a group could agree to MEET there. That
 * keeps the shop set to the few a group converges on — a bookshop, a bakery,
 * a coffee or tea house, an ice cream counter — and excludes errands nobody
 * proposes as a destination: supermarket, convenience, butcher, cheese, deli,
 * greengrocer, confectionery, wine, florist, gift. They were measured and
 * dropped; re-adding them cost Berlin roughly 1.5 MiB of committed snapshot
 * for places no room would pick.
 */
export const PLACE_CLASS_TABLE = Object.freeze({
  amenity: Object.freeze([
    "cafe",
    "restaurant",
    "bar",
    "pub",
    "biergarten",
    "fast_food",
    "cinema",
    "theatre",
    "library",
    "coworking_space",
    "arts_centre",
    "community_centre",
    "ice_cream",
  ]),
  leisure: Object.freeze([
    "park",
    "garden",
    "dog_park",
    "playground",
    "sports_centre",
    "fitness_centre",
  ]),
  tourism: Object.freeze([
    "museum",
    "gallery",
    "attraction",
    "zoo",
    "aquarium",
  ]),
  shop: Object.freeze([
    "books",
    "bakery",
    "coffee",
    "tea",
    "ice_cream",
  ]),
} as const);

export type PlaceClassKey = keyof typeof PLACE_CLASS_TABLE;
export type PlaceClass = (typeof PLACE_CLASS_TABLE)[PlaceClassKey][number];

/** Deduped: a class may be reachable through more than one tag key — an ice
 * cream counter is tagged `amenity=ice_cream` by some mappers and
 * `shop=ice_cream` by others, and it is one class either way. */
export const PLACE_CLASSES: readonly PlaceClass[] = Object.freeze([
  ...new Set(Object.values(PLACE_CLASS_TABLE).flat() as PlaceClass[]),
]);

const PLACE_CLASS_KEYS = Object.keys(PLACE_CLASS_TABLE) as PlaceClassKey[];

/** Return the first recognized class in stable table order. */
export function placeClassFromTags(
  tags: Record<string, string | undefined>,
): PlaceClass | undefined {
  for (const key of PLACE_CLASS_KEYS) {
    const value = tags[key];
    if ((PLACE_CLASS_TABLE[key] as readonly string[]).includes(value ?? "")) {
      return value as PlaceClass;
    }
  }
  return undefined;
}
