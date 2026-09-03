import {
  ATTRIBUTE_LABELS,
  ATTRIBUTE_VOCABULARY,
  HINT_TAXONOMY,
  areaById,
  normalizeCuisineTokens,
  type Facet,
  type SpatialContextResult,
} from "@webmcp-hackathon/contracts";
import { config } from "../config.ts";
import { parseJson, respond } from "./openai.ts";
import { findLandmarks } from "../landmarks.ts";

/**
 * The fast tier. One sentence from the composer becomes either a set of need
 * payloads the page then submits through the ordinary command bus, or a
 * question / instruction handed to the smart tier (agent.ts).
 *
 * Bounded, schema-shaped, latency-bound: exactly the job the fast model is
 * for. It never acts, never sees a peer's private content (the context it
 * gets is the caller's own view), and every payload it proposes is validated
 * by the same Ajv pass as a hand-typed one.
 */

export type Intent = "need" | "ask" | "act" | "unclear";
const MAX_TEXT_NEED_CHARS = 120;

export interface ParsedNeed {
  payload: Record<string, unknown>;
  /** Coarse topic the owner may let a private need carry (FACETS.md §4). */
  topic?: (typeof HINT_TAXONOMY)[number];
  /** What the sentence meant, for the record — server labels do the rendering. */
  gist: string;
}

export interface SayOutcome {
  intent: Intent;
  needs: ParsedNeed[];
  /** For `unclear`: what would help. */
  reply: string | null;
  /** Small page-private disambiguation set; choosing one submits its payload. */
  choices?: Array<{ label: string; payload: Record<string, unknown> }>;
  meta: { model: string; ms: number };
}

function landmarkDistance(
  text: string,
): { dimension: "walk_min" | "radius_m"; max: number; query: string } | null {
  const metres = /^\s*(\d+(?:[.,]\d+)?)\s*(m|km)\s+(?:from|of)\s+(.+?)\s*$/i.exec(text);
  if (metres) {
    const amount = Number(metres[1].replace(",", "."));
    const max = metres[2].toLowerCase() === "km" ? amount * 1000 : amount;
    return Number.isFinite(max) && max > 0
      ? { dimension: "radius_m", max: Math.round(max), query: metres[3] }
      : null;
  }
  const minutes = /^\s*within\s+(\d+(?:[.,]\d+)?)\s*(?:min|mins|minutes?)\s+(?:walk\s+)?(?:from|of)\s+(.+?)\s*$/i.exec(text);
  if (minutes) {
    const max = Number(minutes[1].replace(",", "."));
    return Number.isFinite(max) && max > 0
      ? { dimension: "walk_min", max: Math.round(max), query: minutes[2] }
      : null;
  }
  const near = /^\s*near\s+(.+?)\s*$/i.exec(text);
  return near ? { dimension: "walk_min", max: 10, query: near[1] } : null;
}

function landmarkNeed(
  text: string,
  context: SpatialContextResult,
): SayOutcome | null {
  const parsed = landmarkDistance(text);
  const areaId = context.area?.areaId;
  if (!parsed || !areaId) return null;
  const matches = findLandmarks(areaId, parsed.query);
  if (matches.length === 0) return null;
  const payload = (landmarkId: string) => ({
    kind: "scope",
    dimension: parsed.dimension,
    max: parsed.max,
    referent: { kind: "landmark", landmarkId },
  });
  const top = matches[0].score;
  const plausible = matches.filter((match) => match.score === top).slice(0, 3);
  const meta = { model: "landmark-index", ms: 0 };
  if (plausible.length === 1) {
    return {
      intent: "need",
      needs: [{
        payload: payload(plausible[0].id),
        topic: "distance",
        gist: `${parsed.dimension === "walk_min" ? "near" : "distance from"} ${plausible[0].name}`.slice(0, 80),
      }],
      reply: null,
      meta,
    };
  }
  return {
    intent: "unclear",
    needs: [],
    reply: `Which ${parsed.query.trim()} did you mean?`,
    choices: plausible.map((match) => ({
      label: `${match.name} · ${match.kindLabel}`,
      payload: payload(match.id),
    })),
    meta,
  };
}

interface Draft {
  intent: Intent;
  needs: Array<{
    kind: "attribute" | "budget" | "walk" | "time" | "exclusion" | "inclusion" | "text";
    attributeKey: string | null;
    expect: "verified_true" | "verified_false" | null;
    amountEur: number | null;
    walkMin: number | null;
    radiusM: number | null;
    excludeValues: string[];
    includeValues: string[];
    text: string | null;
    window: { start: string; end: string } | null;
    phrase: string | null;
    topic: string | null;
    gist: string;
  }>;
  reply: string | null;
}

const NULLABLE_STRING = { type: ["string", "null"] };
const NULLABLE_NUMBER = { type: ["number", "null"] };

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["intent", "needs", "reply"],
  properties: {
    intent: { type: "string", enum: ["need", "ask", "act", "unclear"] },
    needs: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "kind", "attributeKey", "expect", "amountEur", "walkMin", "radiusM",
          "excludeValues", "includeValues", "text", "window", "phrase", "topic", "gist",
        ],
        properties: {
          kind: { type: "string", enum: ["attribute", "budget", "walk", "time", "exclusion", "inclusion", "text"] },
          attributeKey: NULLABLE_STRING,
          expect: { type: ["string", "null"], enum: ["verified_true", "verified_false", null] },
          amountEur: NULLABLE_NUMBER,
          walkMin: NULLABLE_NUMBER,
          radiusM: NULLABLE_NUMBER,
          excludeValues: { type: "array", items: { type: "string" } },
          includeValues: { type: "array", items: { type: "string" } },
          text: NULLABLE_STRING,
          window: {
            anyOf: [
              {
                type: "object",
                additionalProperties: false,
                required: ["start", "end"],
                properties: {
                  start: { type: "string", format: "date-time", maxLength: 40 },
                  end: { type: "string", format: "date-time", maxLength: 40 },
                },
              },
              { type: "null" },
            ],
          },
          phrase: NULLABLE_STRING,
          topic: { type: ["string", "null"], enum: [...HINT_TAXONOMY, null] },
          gist: { type: "string" },
        },
      },
    },
    reply: NULLABLE_STRING,
  },
};

function enumValues(facets: Facet[], key: string): Set<string> {
  const facet = facets.find((f) => f.key === key && f.type === "enum");
  return new Set((facet?.values ?? []).map((v) => v.value));
}

function localIso(now: Date, timezone: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset",
  }).formatToParts(now).map((part) => [part.type, part.value]));
  const offset = parts.timeZoneName === "GMT"
    ? "+00:00"
    : parts.timeZoneName?.replace("GMT", "") ?? "+00:00";
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`;
}

function roomClock(context: SpatialContextResult, now: Date): { timezone: string; localNow: string } {
  const timezone = areaById(context.area?.areaId ?? "")?.timezone ?? "UTC";
  return { timezone, localNow: localIso(now, timezone) };
}

function instructions(
  context: SpatialContextResult,
  scope: string,
  clock: { timezone: string; localNow: string },
): string {
  const vocab = ATTRIBUTE_VOCABULARY.filter((k) => k !== "price-level" && k !== "cuisine")
    .map((k) => `${k} ("${ATTRIBUTE_LABELS[k]}")`)
    .join(", ");
  const cuisines = [...enumValues(context.facets, "cuisine")].join(", ");
  const needs = context.activeNeeds.map((n) => `"${n.label}"`).join(", ") || "none";
  const proposals = context.proposals
    .filter((p) => p.status !== "withdrawn")
    .map((p) => context.candidates.find((c) => c.candidateId === p.candidateId)?.name ?? p.candidateId)
    .join(", ") || "none";
  const people = context.participants.map((p) => p.displayName).join(", ");
  return [
    "You route one sentence a person typed into a shared planning room where a small group is choosing a place to meet.",
    "Decide the intent:",
    "- need: the sentence states something that would rule places in or out (a condition, a budget, how far they can go, something to avoid, a kind of place they want). One sentence often carries several: extract every distinct one, up to five, each as its own need.",
    "- act: the sentence asks for a move in the room — propose or put a place forward, accept or rule out a proposal, widen the area, set a need aside or bring it back, withdraw a need, mark done.",
    "- ask: the sentence is a question about the room, the places, what changed, or what to do.",
    "- unclear: nothing above fits; say in `reply` (one short sentence, no exclamation mark) what would help.",
    "For needs:",
    `- kind attribute: only for these keys: ${vocab}. expect verified_true for wanting it, verified_false for wanting its absence.`,
    "- kind budget: a per-person ceiling in euros (amountEur). Words like cheap mean 15, mid-range 25, splurge 40.",
    "- kind walk: distance from the person. Use a maximum walking time in minutes (walkMin), or metres (radiusM), never both. 'not more than 20 min from me' is walkMin 20; 'close to me' is walkMin 10; 'within 2 km of me' is radiusM 2000. Phrases without 'me' such as 'close by' still mean walkMin 10.",
    `Area timezone: ${clock.timezone}.`,
    `Current local date/time: ${clock.localNow}.`,
    "- kind time: when the sentence names a date, weekday, meal, part of day, clock time, or 'open now'. Return an absolute window in `window`, and copy the time words the person actually said into `phrase`. Never turn a sentence that names a time into kind text.",
    "- Resolve time only from words the person supplied, using the area clock above. `window.start` and `window.end` must be ISO-8601 date-times with the area's numeric offset (`±HH:MM`, never `Z`). Never invent a time need when the sentence names no time.",
    "- Date anchors: today is the current civil date; tomorrow is the next civil date; a named weekday is its next occurrence on or after today. Combine that date with the stated meal or clock time. A bare date or weekday covers 00:00 to 00:00 the next civil day.",
    "- Time windows: lunch 12:00–14:00; dinner 18:00–21:00; brunch 10:00–13:00; evening 18:00–21:00; tonight 18:00–23:00 on today's date. An explicit 'at' time spans one hour before through one hour after it, so 'at 7pm' is 18:00–20:00. 'open now' starts at the exact current local date/time and ends two hours later.",
    `- kind exclusion: cuisines the person wants to AVOID ("no Italian", "not sushi", "anything but pizza"), only from: ${cuisines || "(none known)"}. Put the matching values in excludeValues. If none is listed, use unclear rather than kind text.`,
    `- kind inclusion: cuisines the person WANTS ("Asian please", "let's do Italian", "I fancy ramen"), from the same list. Put the matching values in includeValues. Wanting a cuisine is never an exclusion of it; when the wanted cuisine is not in the list, use kind text.`,
    "- kind text: anything else, verbatim in `text` (max 120 chars). It rules nothing out until checked, so prefer a typed kind whenever one honestly fits.",
    "- topic: the coarse category of the need, from the allowed list; null when none fits.",
    "- gist: the need in at most six words, lowercase, no domain jargon.",
    `The person chose visibility "${scope}" for what they say; that does not change the intent.`,
    `Needs already stated in the room: ${needs}. Places currently on the table: ${proposals}. People: ${people}.`,
    "Never invent keys or cuisine values. A cuisine value must be the one the person named or its plain synonym, never a broader family (sushi is not asian, pizza is not italian). A missing wanted cuisine becomes kind text; a missing avoided cuisine is unclear. Never answer the question yourself. Output only the JSON.",
  ].join("\n");
}

export async function say(
  text: string,
  scope: string,
  context: SpatialContextResult,
  now = new Date(),
): Promise<SayOutcome> {
  const indexed = landmarkNeed(text, context);
  if (indexed) return indexed;
  const clock = roomClock(context, now);
  const reply = await respond({
    model: config.nlFastModel,
    instructions: instructions(context, scope, clock),
    input: [{ role: "user", content: text }],
    schema: { name: "composer_route", schema: SCHEMA },
    reasoning: "low",
    maxOutputTokens: 600,
    timeoutMs: 15_000,
  });
  const draft = parseJson<Draft>(reply.text);
  const meta = { model: reply.model, ms: reply.ms };
  if (!draft) return { intent: "unclear", needs: [], reply: null, meta };

  const cuisines = enumValues(context.facets, "cuisine");
  const needs: ParsedNeed[] = [];
  for (const n of draft.needs ?? []) {
    const topic = HINT_TAXONOMY.includes(n.topic as never)
      ? (n.topic as ParsedNeed["topic"])
      : undefined;
    const base = { gist: n.gist || text.slice(0, 40), ...(topic ? { topic } : {}) };
    if (
      n.kind === "attribute" &&
      n.attributeKey &&
      (ATTRIBUTE_VOCABULARY as readonly string[]).includes(n.attributeKey) &&
      n.attributeKey !== "price-level" &&
      n.attributeKey !== "cuisine"
    ) {
      needs.push({
        ...base,
        payload: { kind: "attribute", key: n.attributeKey, expect: n.expect ?? "verified_true" },
      });
    } else if (n.kind === "budget" && n.amountEur && n.amountEur > 0) {
      needs.push({
        ...base,
        payload: { kind: "budget", perPersonMax: { amount: Math.round(n.amountEur), currency: "EUR" } },
      });
    } else if (n.kind === "walk" && n.radiusM && n.radiusM > 0) {
      needs.push({
        ...base,
        payload: { kind: "scope", dimension: "radius_m", max: Math.round(n.radiusM) },
      });
    } else if (n.kind === "walk" && n.walkMin && n.walkMin > 0) {
      needs.push({
        ...base,
        payload: { kind: "scope", dimension: "walk_min", max: Math.round(n.walkMin) },
      });
    } else if (n.kind === "time") {
      const startText = n.window?.start;
      const endText = n.window?.end;
      const hasOffset = (value: unknown): value is string =>
        typeof value === "string" && /[+-]\d{2}:\d{2}$/.test(value);
      const start = hasOffset(startText) ? Date.parse(startText) : Number.NaN;
      const end = hasOffset(endText) ? Date.parse(endText) : Number.NaN;
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
      const proposedPhrase = n.phrase?.trim();
      const phrase = proposedPhrase && text.toLocaleLowerCase().includes(proposedPhrase.toLocaleLowerCase())
        ? proposedPhrase
        : text.trim();
      needs.push({
        ...base,
        payload: {
          kind: "time",
          window: { start: startText, end: endText },
          ...(phrase ? { phrase: phrase.slice(0, 200) } : {}),
        },
      });
    } else if (n.kind === "exclusion" || n.kind === "inclusion") {
      const source = n.kind === "exclusion" ? n.excludeValues : n.includeValues;
      const values = [...new Set((source ?? []).flatMap((value) =>
        normalizeCuisineTokens(value).filter((token) => cuisines.has(token)),
      ))].slice(0, 8);
      if (values.length) {
        needs.push({
          ...base,
          payload: { kind: n.kind, key: "cuisine", values, lifetime: "session" },
        });
      } else if (n.kind === "inclusion") {
        const t = (n.text ?? text).trim().slice(0, MAX_TEXT_NEED_CHARS);
        if (t) needs.push({ ...base, payload: { kind: "text", text: t } });
      }
    } else {
      const t = (n.text ?? text).trim().slice(0, MAX_TEXT_NEED_CHARS);
      if (t) needs.push({ ...base, payload: { kind: "text", text: t } });
    }
  }
  const intent: Intent =
    draft.intent === "need" && needs.length === 0 ? "unclear" : draft.intent;
  return { intent, needs: intent === "need" ? needs : [], reply: draft.reply, meta };
}
