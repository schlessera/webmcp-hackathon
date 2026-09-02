/**
 * Graded evidence (SPATIAL-PROTOCOL.md §8.2, 2026-09-02).
 *
 * A fact about a place is one of five things, and every one carries the
 * confidence of whoever said it:
 *
 *   verified_true    yes       — the record, the venue itself, or a person who checked
 *   likely_true      likely    — a guess with a reason: a word on the menu, the kind of
 *                                place, a partial value ("limited"), a model reading a photo
 *   likely_false     unlikely  — the same, leaning the other way
 *   verified_false   no
 *   unknown          —         — nobody said anything
 *
 * Only the two verified statuses let the engine rule a place in or out. A
 * likely fact yields "likely" / "unlikely" — drawn, counted and explained
 * separately, never silently folded into "works" or "ruled out"
 * (CLAUDE.md §4: unverified is a state you draw). Confidence travels with the
 * fact and with every classification that rests on it.
 *
 * `unverified` was the old fourth status ("a claim exists, unconfirmed"). It
 * is read as likely_true at confidence ≤ 0.5 wherever old data still carries
 * it; nothing writes it any more.
 */

export const ATTRIBUTE_STATUSES = [
  "verified_true",
  "likely_true",
  "likely_false",
  "verified_false",
  "unknown",
] as const;
export type AttributeStatus = (typeof ATTRIBUTE_STATUSES)[number];

/** The word the UI uses for each status, in the reader's language. */
export const STATUS_WORD: Record<AttributeStatus, string> = {
  verified_true: "yes",
  likely_true: "likely",
  likely_false: "unlikely",
  verified_false: "no",
  unknown: "not known",
};

/** Default confidence when a source states none. */
export const DEFAULT_CONFIDENCE: Record<AttributeStatus, number> = {
  verified_true: 0.8,
  likely_true: 0.5,
  likely_false: 0.5,
  verified_false: 0.8,
  unknown: 0,
};

/** Below this, an attestation is a likely fact, not a verified one. */
export const VERIFIED_CONFIDENCE_FLOOR = 0.7;

export const isVerified = (s: string): s is "verified_true" | "verified_false" =>
  s === "verified_true" || s === "verified_false";
export const isLikely = (s: string): s is "likely_true" | "likely_false" =>
  s === "likely_true" || s === "likely_false";

/** Which way a status leans: true, false, or null for unknown. */
export function leans(s: string): boolean | null {
  if (s === "verified_true" || s === "likely_true") return true;
  if (s === "verified_false" || s === "likely_false") return false;
  return null;
}

/** A status of the stated lean at the stated confidence. */
export function graded(lean: boolean, confidence: number): AttributeStatus {
  if (confidence >= VERIFIED_CONFIDENCE_FLOOR) return lean ? "verified_true" : "verified_false";
  return lean ? "likely_true" : "likely_false";
}

export interface StatusBearing {
  status: string;
  confidence?: number;
}

/**
 * Old data in the new vocabulary. `unverified` becomes likely_true at no more
 * than 0.5; anything unrecognised becomes unknown; a missing confidence gets
 * the status default. Pure, non-mutating.
 */
export function normalizeStatus<T extends StatusBearing>(attr: T): T & { status: AttributeStatus; confidence: number } {
  let status: AttributeStatus;
  let confidence = attr.confidence;
  if ((ATTRIBUTE_STATUSES as readonly string[]).includes(attr.status)) {
    status = attr.status as AttributeStatus;
  } else if (attr.status === "unverified") {
    status = "likely_true";
    confidence = Math.min(confidence ?? 0.5, 0.5);
  } else {
    status = "unknown";
    confidence = 0;
  }
  return { ...attr, status, confidence: confidence ?? DEFAULT_CONFIDENCE[status] };
}
