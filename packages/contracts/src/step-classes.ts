import { PLACE_CLASSES, type PlaceClass } from "./place-classes.ts";

/**
 * What a step of a plan is about — "somewhere to eat", "a cinema", "a park".
 *
 * A step class groups the snapshot place classes a room draws its pool from.
 * It is server data, exactly like `area.placeClasses`: the label travels on
 * the wire and the client renders it, so no client ever branches on a key
 * (CLAUDE.md §1). Labels follow COPY.md — a noun phrase in sentence case,
 * naming a kind of place rather than a domain the app knows about.
 *
 * `food` is the default and its members are exactly the six classes every
 * room pooled before goals existed, so a room created without a step behaves
 * as it always did.
 *
 * Membership overlaps on purpose: a café is somewhere to eat and it is also
 * a café. A place class may therefore belong to several step classes, and a
 * room only ever uses one of them.
 */
export interface StepClass {
  /** Stable key; travels as the room's `scope.category`. */
  key: string;
  /** The words shown for this step. Server data, never a client branch. */
  label: string;
  /** Snapshot place classes eligible to enter a room on this step. */
  members: readonly PlaceClass[];
}

export const STEP_CLASSES: readonly StepClass[] = Object.freeze([
  {
    key: "food",
    label: "somewhere to eat",
    members: Object.freeze(["cafe", "restaurant", "bar", "pub", "biergarten", "fast_food"]),
  },
  {
    key: "cafe",
    label: "a café",
    members: Object.freeze(["cafe", "coffee", "tea", "bakery", "ice_cream"]),
  },
  {
    key: "drinks",
    label: "somewhere for drinks",
    members: Object.freeze(["bar", "pub", "biergarten"]),
  },
  { key: "cinema", label: "a cinema", members: Object.freeze(["cinema"]) },
  { key: "theatre", label: "a theatre", members: Object.freeze(["theatre", "arts_centre"]) },
  {
    key: "park",
    label: "a park",
    members: Object.freeze(["park", "garden", "dog_park", "playground"]),
  },
  {
    key: "museum",
    label: "a museum or gallery",
    members: Object.freeze(["museum", "gallery", "attraction", "zoo", "aquarium"]),
  },
  {
    key: "coworking",
    label: "a coworking space",
    members: Object.freeze(["coworking_space", "library", "community_centre"]),
  },
  {
    key: "sport",
    label: "somewhere for sport",
    members: Object.freeze(["sports_centre", "fitness_centre"]),
  },
  { key: "books", label: "a bookshop", members: Object.freeze(["books"]) },
] as const satisfies readonly StepClass[]);

/** The class a room falls back to: today's pool, unchanged. */
export const DEFAULT_STEP_CLASS_KEY = "food";

const BY_KEY = new Map(STEP_CLASSES.map((stepClass) => [stepClass.key, stepClass]));

export function stepClassByKey(key: string): StepClass | undefined {
  return BY_KEY.get(key);
}

/** The default class, always present. */
export function defaultStepClass(): StepClass {
  return BY_KEY.get(DEFAULT_STEP_CLASS_KEY)!;
}

/** The first step class a snapshot place class belongs to, in table order. */
export function stepClassFor(placeClass: string): StepClass | undefined {
  return STEP_CLASSES.find((stepClass) =>
    (stepClass.members as readonly string[]).includes(placeClass));
}

/**
 * The place classes a room pools from. `category` is the room's step-class
 * key; anything the table does not know (an older room, a hand-written scope)
 * falls back to the area's own class list, so nothing that worked stops.
 */
export function poolPlaceClasses(
  areaPlaceClasses: readonly PlaceClass[],
  category?: string | null,
): readonly PlaceClass[] {
  const stepClass = category ? BY_KEY.get(category) : undefined;
  return stepClass ? stepClass.members : areaPlaceClasses;
}

/** Every place class the table can reach — the explore layer keeps its own. */
export const STEP_CLASS_MEMBERS: readonly PlaceClass[] = Object.freeze([
  ...new Set(STEP_CLASSES.flatMap((stepClass) => stepClass.members)),
]);

/** Guard against a table entry naming a class no snapshot can hold. */
export function unknownStepClassMembers(): string[] {
  const known = new Set<string>(PLACE_CLASSES);
  return STEP_CLASS_MEMBERS.filter((member) => !known.has(member));
}
