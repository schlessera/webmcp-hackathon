/**
 * Copy and formatting helpers. Every string the app authors goes through here
 * or through a component; none of them may name a domain (CLAUDE.md §1,
 * COPY.md "the one rule"). Server-supplied labels are rendered verbatim.
 */

const NUMBER_WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
];

/** "three" up to ten, then the numeral. Used in sentences, never in counts. */
export function numberWord(n: number): string {
  return NUMBER_WORDS[n] ?? String(n);
}

/** "6 still work" / "1 still works" — the verb agrees (COPY.md counting). */
export function stillWorkVerb(n: number): string {
  return n === 1 ? "still works" : "still work";
}

/** Signed, with a real minus sign. Deltas are never percentages. */
export function signed(n: number): string {
  return n < 0 ? `−${Math.abs(n)}` : `+${n}`;
}

/** A need's cost, always negative-shaped: "−19". Zero renders as an em dash. */
export function ruledOutLabel(n: number): string {
  return n > 0 ? `−${n}` : "—";
}

/** Round-robin person colour by roster position (tokens.css --spoke-person-N). */
export function personColor(index: number): string {
  return `var(--spoke-person-${(index % 5) + 1})`;
}

/** Two-letter monogram from a display name. Never an avatar image. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Deterministic sticker tilt in −3°…+3°, excluding 0 so every sticker is
 * visibly hand-placed. Derived from the id, so a place keeps its angle across
 * renders — the map must never reshuffle (CLAUDE.md §8).
 */
const TILTS = [-3, 2, -1.5, 3, -2, 1.5];
export function tiltFor(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return TILTS[h % TILTS.length];
}

/** Avatar tilt alternates −4° / 3° / −2° down the row (SPOKES-UI §2). */
const AVATAR_TILTS = [-4, 3, -2];
export function avatarTilt(index: number): number {
  return AVATAR_TILTS[index % AVATAR_TILTS.length];
}

/**
 * Provenance in the reader's language. The mapping is over source *prefixes*
 * the server sets, not over domains.
 */
export function sourceLabel(source: string): string {
  if (source.startsWith("osm:")) return "from OpenStreetMap";
  if (source.startsWith("curated:")) return "checked by the room's data";
  if (!source) return "unknown";
  return source;
}

/** "unknown" is a state we draw, never a failure (CLAUDE.md §4). */
export const UNKNOWN_SOURCE = "nobody could confirm";

/**
 * Attribute values render as words, never as invented icons.
 *
 * The dossier's `status` is the claim; `value` is optional detail — a boolean
 * attribute carries status alone. Reading the value first would print
 * "not known" over a verified yes, so status leads.
 */
export function attributeValue(value: unknown, status: string): string {
  const written =
    value === null || value === undefined
      ? null
      : typeof value === "boolean"
        ? value
          ? "yes"
          : "no"
        : String(value).replace(/_/g, " ");
  if (status === "verified_true") return written ?? "yes";
  if (status === "verified_false") return written ?? "no";
  if (status === "unverified") return written ? `${written}, unverified` : "not verified";
  return "not known";
}

/** Empty and error states, verbatim from COPY.md. */
export const COPY = {
  emptyRoom:
    "Nothing yet. Say anything that would rule a place in or out — a condition, a time, how far you can get — and choose who gets to see it.",
  noCandidates: "Nothing here fits yet. Widen the area, or drop a need.",
  stale: "This room is running an older version. Reload to catch up.",
  quiet: "Quiet so far.",
  verdictClears: "Clears every need the room has stated",
  holdHint: "hold to preview without",
  reassurance: "nothing here is needed to use the app",
} as const;
