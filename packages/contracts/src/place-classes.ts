/**
 * OSM tags that make a named feature a place in an area snapshot. This is
 * server-side data: clients render the category sent by the server and never
 * branch on any of these values (CLAUDE.md §1).
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
    "supermarket",
    "convenience",
    "butcher",
    "cheese",
    "deli",
    "greengrocer",
    "confectionery",
    "coffee",
    "tea",
    "wine",
    "florist",
    "gift",
  ]),
} as const);

export type PlaceClassKey = keyof typeof PLACE_CLASS_TABLE;
export type PlaceClass = (typeof PLACE_CLASS_TABLE)[PlaceClassKey][number];

export const PLACE_CLASSES: readonly PlaceClass[] = Object.freeze(
  Object.values(PLACE_CLASS_TABLE).flat() as PlaceClass[],
);

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
