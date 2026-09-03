import {
  ATTRIBUTE_LABELS,
  ATTRIBUTE_VOCABULARY,
  HINT_TAXONOMY,
  normalizeCuisineTokens,
  type Facet,
  type SpatialContextResult,
} from "@webmcp-hackathon/contracts";
import { config } from "../config.ts";
import { parseJson, respond } from "./openai.ts";

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
  meta: { model: string; ms: number };
}

interface Draft {
  intent: Intent;
  needs: Array<{
    kind: "attribute" | "budget" | "walk" | "exclusion" | "inclusion" | "text";
    attributeKey: string | null;
    expect: "verified_true" | "verified_false" | null;
    amountEur: number | null;
    walkMin: number | null;
    excludeValues: string[];
    includeValues: string[];
    text: string | null;
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
          "kind", "attributeKey", "expect", "amountEur", "walkMin",
          "excludeValues", "includeValues", "text", "topic", "gist",
        ],
        properties: {
          kind: { type: "string", enum: ["attribute", "budget", "walk", "exclusion", "inclusion", "text"] },
          attributeKey: NULLABLE_STRING,
          expect: { type: ["string", "null"], enum: ["verified_true", "verified_false", null] },
          amountEur: NULLABLE_NUMBER,
          walkMin: NULLABLE_NUMBER,
          excludeValues: { type: "array", items: { type: "string" } },
          includeValues: { type: "array", items: { type: "string" } },
          text: NULLABLE_STRING,
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

function instructions(context: SpatialContextResult, scope: string): string {
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
    "- kind walk: a maximum walking time in minutes (walkMin). 'close by' means 10, 'not far' 15.",
    `- kind exclusion: cuisines the person wants to AVOID ("no Italian", "not sushi", "anything but pizza"), only from: ${cuisines || "(none known)"}. Put the matching values in excludeValues.`,
    `- kind inclusion: cuisines the person WANTS ("Asian please", "let's do Italian", "I fancy ramen"), from the same list. Put the matching values in includeValues. Wanting a cuisine is never an exclusion of it; when the wanted cuisine is not in the list, use kind text.`,
    "- kind text: anything else, verbatim in `text` (max 120 chars). It rules nothing out until checked, so prefer a typed kind whenever one honestly fits.",
    "- topic: the coarse category of the need, from the allowed list; null when none fits.",
    "- gist: the need in at most six words, lowercase, no domain jargon.",
    `The person chose visibility "${scope}" for what they say; that does not change the intent.`,
    `Needs already stated in the room: ${needs}. Places currently on the table: ${proposals}. People: ${people}.`,
    "Never invent keys or cuisine values. A cuisine value must be the one the person named or its plain synonym, never a broader family (sushi is not asian, pizza is not italian); a cuisine missing from the list becomes kind text. Never answer the question yourself. Output only the JSON.",
  ].join("\n");
}

export async function say(
  text: string,
  scope: string,
  context: SpatialContextResult,
): Promise<SayOutcome> {
  const reply = await respond({
    model: config.nlFastModel,
    instructions: instructions(context, scope),
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
    } else if (n.kind === "walk" && n.walkMin && n.walkMin > 0) {
      needs.push({
        ...base,
        payload: { kind: "scope", dimension: "walk_min", max: Math.round(n.walkMin) },
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
      } else {
        needs.push({ ...base, payload: { kind: "text", text: (n.text ?? text).slice(0, 200) } });
      }
    } else {
      const t = (n.text ?? text).trim().slice(0, 200);
      if (t) needs.push({ ...base, payload: { kind: "text", text: t } });
    }
  }
  const intent: Intent =
    draft.intent === "need" && needs.length === 0 ? "unclear" : draft.intent;
  return { intent, needs: intent === "need" ? needs : [], reply: draft.reply, meta };
}
