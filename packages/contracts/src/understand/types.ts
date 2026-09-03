import type { HINT_TAXONOMY } from "../manifest.ts";

export type ConceptRole =
  | "distance"
  | "travel_time"
  | "money"
  | "time"
  | "attribute"
  | "kind"
  | "quality"
  | "place"
  | "person"
  | "action"
  | "question";

export interface Quantity {
  value: number;
  unit: "m" | "km" | "min" | "h" | "EUR" | "USD" | null;
  bound: "max" | "min" | "about" | "exact";
}

export interface Referent {
  kind: "self" | "here" | "scope_center" | "named";
  name: string | null;
}

export type TimeDay =
  | { kind: "today" | "tomorrow" }
  | { kind: "weekday"; weekday: 0 | 1 | 2 | 3 | 4 | 5 | 6 };

export type TimePart =
  | "morning"
  | "brunch"
  | "lunch"
  | "afternoon"
  | "evening"
  | "tonight"
  | "night"
  | "late"
  | "now";

export interface TimeSpec {
  day: TimeDay | null;
  part: TimePart | null;
  clock: { hour: number; minute: number } | null;
}

export interface Concept {
  role: ConceptRole;
  surface: string;
  polarity: "include" | "exclude";
  hardness: "hard" | "soft";
  quantity: Quantity | null;
  mode: "walk" | "bike" | "car" | "transit" | null;
  referent: Referent | null;
  attributeKey: string | null;
  values: string[];
  window: { start: string; end: string } | null;
  /** Civil-time words, resolved against the room clock in stage B. */
  timeSpec?: TimeSpec | null;
  phrase: string | null;
  topic: (typeof HINT_TAXONOMY)[number] | null;
  unresolved: "unit" | "value" | "referent" | "name" | "attribute" | "kind" | null;
  gist: string;
  origin: "preparse" | "model";
}

export interface Interpretation {
  intent: "need" | "ask" | "act" | "other";
  concepts: Concept[];
  confidence: number;
  reply: string | null;
  meta: { model: string | null; ms: number; preparsedWhole: boolean };
}
