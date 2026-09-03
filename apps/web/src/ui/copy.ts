import { ATTRIBUTE_LABELS } from "@webmcp-hackathon/contracts";

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

/** "Sarah and Joe", "Sarah, Joe and Max" — for sentences about people. */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
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
  if (source.startsWith("agent:")) return "checked by someone in the room";
  if (source.startsWith("disputed:")) return "disputed in the room";
  if (source.startsWith("web:")) return "published by the place";
  if (source.startsWith("wikidata:")) return "from Wikidata";
  if (source.startsWith("guess:")) return "a guess from the kind of place";
  if (source.startsWith("menu:")) return "read from the menu";
  if (source.startsWith("infer:")) return "a guess from what the place publishes";
  if (!source) return "unknown";
  return source;
}

/**
 * Confidence as a word, never a number (COPY.md confidence): the source would
 * nearly verify it / a reasoned guess / thin evidence.
 */
export function confidenceWord(confidence: number): string {
  if (confidence >= 0.65) return "fairly sure";
  if (confidence >= 0.45) return "likely";
  return "a guess";
}

/**
 * The classifier's `why` is written for agent surfaces. Where the main UI
 * still has to show one (no per-need verdicts on the dossier yet), the
 * protocol's own words become the reader's: attribute keys become their
 * manifest labels, the status vocabulary becomes plain words. This maps
 * over protocol tokens, never over domains.
 */
export function readableWhy(why: string): string {
  let text = why;
  for (const [key, label] of Object.entries(ATTRIBUTE_LABELS)) {
    text = text.replace(new RegExp(`\\b${key}\\b`, "g"), label);
  }
  return text
    // The classifier's pending phrases (eligibility.ts), one by one.
    .replace(/your private screening is pending/g, "your agent hasn't said")
    .replace(/your screening verdict: unacceptable/g, "your agent ruled it out")
    .replace(/private evidence pending/g, "a private condition not yet checked")
    .replace(/excluded by a private requirement/g, "ruled out by a private condition")
    .replace(/scope evidence pending/g, "distance not yet checked")
    .replace(/budget evidence pending/g, "price not yet checked")
    .replace(/(inclusion|exclusion) evidence pending/g, "the kind of place not yet checked")
    .replace(/unevaluated requirement/g, "a need not yet checked")
    .replace(/\bunverified\b/g, "not confirmed")
    .replace(/\bverified_true\b/g, "yes")
    .replace(/\bverified_false\b/g, "no")
    .replace(/\blikely_true\b/g, "likely")
    .replace(/\blikely_false\b/g, "unlikely")
    .replace(/\bprobably\b/g, "likely")
    .replace(/; /g, " · ")
    .replace(/^\w/, (c) => c.toUpperCase());
}

const DAY_SHORT: Record<string, string> = {
  mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun",
};
const DAY_ORDER = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/**
 * Opening hours as lines: consecutive days with the same times fold into a
 * range ("Mon–Fri 9:00–18:00"). Data in, words out; nothing domain-shaped.
 */
export function hoursLines(
  hours: Array<{ day: string; open: string; close: string }>,
): Array<{ days: string; times: string }> {
  const byDay = new Map<string, string[]>();
  for (const h of hours) {
    const day = h.day.toLowerCase().slice(0, 3);
    if (!DAY_ORDER.includes(day)) continue;
    const list = byDay.get(day) ?? [];
    list.push(`${h.open}–${h.close}`);
    byDay.set(day, list);
  }
  const out: Array<{ days: string; times: string }> = [];
  let runStart: string | null = null;
  let runEnd: string | null = null;
  let runTimes = "";
  const flush = () => {
    if (!runStart || !runEnd) return;
    out.push({
      days: runStart === runEnd ? DAY_SHORT[runStart] : `${DAY_SHORT[runStart]}–${DAY_SHORT[runEnd]}`,
      times: runTimes,
    });
  };
  for (const day of DAY_ORDER) {
    const times = byDay.get(day)?.join(", ") ?? null;
    if (times !== null && times === runTimes && runEnd !== null) {
      runEnd = day;
      continue;
    }
    flush();
    runStart = times === null ? null : day;
    runEnd = times === null ? null : day;
    runTimes = times ?? "";
  }
  flush();
  return out;
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
  // A guess says so out loud (CLAUDE.md §4): the word is the honesty.
  if (status === "likely_true") return written ? `likely (${written})` : "likely";
  if (status === "likely_false") return written ? `unlikely (${written})` : "unlikely";
  if (status === "unverified") return written ? `likely (${written})` : "likely";
  return "not known";
}

/** "31 Aug 2026" — when the facts were true, in the reader's locale. */
export function asOf(iso: string | null | undefined): string {
  if (!iso) return "an unknown date";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** The provenance line under the brief: where the places came from. */
export function provenanceLine(area: {
  kind: "osm-snapshot" | "curated";
  source: string;
  dataAsOf: string;
}): string {
  const base = `Places from ${area.source}, as of ${asOf(area.dataAsOf)}`;
  return area.kind === "curated" ? `${base}; some facts checked by the room's data.` : `${base}.`;
}

/** Empty and error states, verbatim from COPY.md. */
export const COPY = {
  emptyRoom:
    "Nothing yet. Say anything that would rule a place in or out — a condition, a time, how far you can get — and choose who gets to see it.",
  noCandidates: "Nothing here fits yet. Widen the area, or drop a need.",
  stale: "This room is running an older version. Reload to catch up.",
  quiet: "Quiet so far.",
  verdictClears: "Clears every need the room has stated",
  holdHint: "hold a need to preview without it",
  reassurance: "nothing here is needed to use the app",
  agentBusy: "your agent is on it",
  agentReading: "reading what you said…",
  lookingUp: "looking it up…",
  readingRecord: "reading the record…",
  recordRead: "what the record says",
  pendingAgentOnly: "a condition your agent holds",
  agentUnclear: "Say what would rule a place in or out, or ask about the room.",
  agentHolds: "Your agent holds it. The room learns only that a condition exists.",
  agentRetry: "Your agent could not finish that. Your words are still here so you can try again.",
  startLede:
    "Pick an area. The places come from OpenStreetMap, and what it knows about them differs by city. The room shows that difference instead of hiding it.",
  startUnknown:
    "What the data does not know shows as unsure, never as a no. Thin data is where an agent can look things up.",
  /** "updating 40 places…" — the agent's second phase (COPY.md in progress). */
  agentApplying: (places: number) => `updating ${places} place${places === 1 ? "" : "s"}…`,
} as const;
