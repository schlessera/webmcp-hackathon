import AjvModule from "ajv";
import addFormatsModule from "ajv-formats";
import {
  RequirementPayload,
  STEP_CLASSES,
  defaultStepClass,
  preparse,
  stepClassByKey,
  type AreaDefinition,
  type Concept,
  type Facet,
  type Interpretation,
  type SpatialContextResult,
  type StepClass,
} from "@webmcp-hackathon/contracts";
import { config } from "../config.ts";
import { computeFacets } from "../facets.ts";
import {
  areaClassCounts,
  fillPlan,
  loadSnapshot,
  seedsForVenues,
  type AreaClassCount,
} from "../places.ts";
import { parseJson, respond } from "./llm.ts";
import { mapInterpretation, type UnderstandInput } from "./understand/map.ts";
import { resolveConceptReferent } from "./understand/resolvers.ts";
import type { Clarification, ParsedNeed } from "./understand/types.ts";
import { SCHEMA, conceptFromDraft, modelInstructions, type Draft } from "./say.ts";

/**
 * Goal-first room creation (UNDERSTANDING-ARCH.md §10, D1).
 *
 * One sentence typed before a room exists becomes one step: what kind of
 * place the group is converging on, and the criteria the sentence already
 * states, shown as pending rows the organizer can drop. Nothing here writes
 * anything; the preview is stateless and the room is created afterwards by
 * the ordinary POST /api/rooms path.
 *
 * Stage A is the same call `/api/nl/say` makes — the same schema and the same
 * instructions, with the plan intent, the `subject` role and the step-class
 * table added — and stage B is `mapInterpretation`, unchanged. What differs
 * is only the room the concepts are read against: there isn't one yet.
 */

export interface PlanStepClass {
  key: string;
  label: string;
}

export interface PlanStep {
  stepId: "s1";
  title: string;
  placeClass: PlanStepClass;
  needs: ParsedNeed[];
  when: { start: string; end: string; phrase: string } | null;
}

export interface PlanPreview {
  goal: string;
  offline: boolean;
  steps: PlanStep[];
  classes: AreaClassCount[];
  clarify: Clarification | null;
  meta: { model: string | null; ms: number };
}

const Ajv = ((AjvModule as never as { default?: unknown }).default ??
  AjvModule) as typeof AjvModule.default;
const addFormats = ((addFormatsModule as never as { default?: unknown })
  .default ?? addFormatsModule) as typeof addFormatsModule.default;
const payloadAjv = new Ajv({ strict: false });
addFormats(payloadAjv);
const validatePayload = payloadAjv.compile(RequirementPayload);

const TITLE_MAX = 40;

interface PlanDraft extends Draft {
  placeClass: string | null;
}

/** Stage A's shape, plus the one field a goal must decide and the one extra
 * role a goal can state. Derived from the shared schema so the two stages
 * cannot drift apart. */
const PLAN_SCHEMA = (() => {
  const base = SCHEMA as unknown as {
    required: string[];
    properties: Record<string, unknown>;
  };
  const concepts = base.properties.concepts as {
    items: { properties: { role: { enum: string[] } } };
  };
  return {
    ...(SCHEMA as unknown as Record<string, unknown>),
    required: [...base.required, "placeClass"],
    properties: {
      ...base.properties,
      intent: { enum: ["plan"] },
      placeClass: { type: "string", maxLength: 40 },
      concepts: {
        ...concepts,
        items: {
          ...concepts.items,
          properties: {
            ...concepts.items.properties,
            role: { enum: [...concepts.items.properties.role.enum, "subject"] },
          },
        },
      },
    },
  };
})();

function planInstructions(): string {
  const table = STEP_CLASSES
    .map((stepClass) => `${stepClass.key} — ${stepClass.label}`)
    .join("; ");
  return [
    "This sentence is the GOAL a person typed to open a new room, not a message inside one. Return intent plan.",
    "It states what the group wants to do. Return the concepts it states, exactly as above, and one class of place.",
    `placeClass is exactly one of these keys: ${table}.`,
    "Choose the class the goal is about. If the goal names no kind of place, answer food.",
    "If the goal names several places one after another, answer the class of the FIRST one and return only its concepts.",
    "Examples: go for a walk with the dogs -> park; catch the new film -> cinema; coworking with a quiet room -> coworking; let's have lunch -> food; mit den Hunden spazieren gehen -> park; erst Abendessen -> food.",
    "role subject names a particular thing the place must offer — a film, an exhibition, a band, a screening. Put the name in surface and a short name in gist.",
    "Examples: watch the new MCU movie -> subject the new MCU movie; die neue Marvel-Verfilmung sehen -> subject die neue Marvel-Verfilmung.",
    "A word naming the class itself is not also a kind concept: cinema, park, museum, coworking space belong in placeClass only.",
  ].join("\n");
}

const facetCache = new Map<string, Facet[]>();

/**
 * What the room the goal would open already knows about its places. Read from
 * the snapshot for the step's classes inside the narrow radius, so a cuisine
 * the area records routes the same way in the preview as it will in the room.
 */
function facetsFor(area: AreaDefinition, stepClass: StepClass): Facet[] {
  const key = `${area.id}:${stepClass.key}`;
  const cached = facetCache.get(key);
  if (cached) return cached;
  const snapshot = loadSnapshot(area.id);
  if (!snapshot) {
    facetCache.set(key, []);
    return [];
  }
  const venues = fillPlan(
    area,
    snapshot,
    area.center,
    area.radii.narrow,
    [],
    Number.MAX_SAFE_INTEGER,
    stepClass.members,
  ).batches[0] ?? [];
  const rows = seedsForVenues("room_preview", venues, snapshot.manifest.extract.timestamp)
    .map((seed, index) => ({ ...seed, map_revision: index }));
  const facets = computeFacets(
    rows as never,
    null,
    undefined,
    area.currency === "USD" ? "USD" : "EUR",
  );
  facetCache.set(key, facets);
  return facets;
}

/** Test seam: a swapped snapshot must not be read through a stale facet set. */
export function resetPlanCaches(): void {
  facetCache.clear();
}

function planInput(
  goal: string,
  area: AreaDefinition,
  stepClass: StepClass,
  now: Date,
): UnderstandInput {
  return {
    text: goal,
    scope: "shared",
    room: {
      areaId: area.id,
      timezone: area.timezone,
      currency: area.currency === "USD" ? "USD" : "EUR",
      now,
      // Nobody has said where they start yet, so a distance is measured from
      // the area centre and says so (map.ts assumedFor).
      hasOwnOrigin: false,
      transport: ["walk", "bike", "car"],
      facets: facetsFor(area, stepClass),
      activeNeeds: [],
      candidateWalkMinutes: [],
      candidateNames: [],
      participantNames: [],
      proposalCandidateIds: [],
    },
  };
}

/**
 * Referents before the room exists.
 *
 * "Sarah's subway station" names a participant who has not arrived and a
 * station only she could point at. The area's landmark index is keyed by
 * name, not by kind, so there is no list of stations to offer and the
 * design's "Which station?" has no answers to show. The decision (documented
 * in docs/NL-AGENT.md): such a referent drops to `self` and the need says so
 * in its `assumed` note. A referent the index CAN place still resolves, and
 * one it places ambiguously still clarifies, so the clarify path stays live.
 */
function groundReferents(
  concepts: Concept[],
  input: UnderstandInput,
): { concepts: Concept[]; dropped: Map<string, string> } {
  const dropped = new Map<string, string>();
  const grounded = concepts.map((concept) => {
    if (concept.role !== "distance" && concept.role !== "travel_time") return concept;
    if (concept.referent?.kind !== "named") return concept;
    const resolved = resolveConceptReferent(concept, input.room);
    if (resolved.referent || (resolved.choices?.length ?? 0) > 0) return concept;
    const name = concept.referent.name?.trim() ?? "";
    if (name) dropped.set(concept.gist, name);
    return { ...concept, referent: { kind: "self" as const, name: null } };
  });
  return { concepts: grounded, dropped };
}

function subjectNeed(concept: Concept): ParsedNeed | null {
  const subject = concept.surface.trim();
  if (!subject) return null;
  return {
    payload: { kind: "text", text: `does this place offer ${subject}?`.slice(0, 200) },
    label: subject.slice(0, 60),
    gist: (concept.gist || subject).toLocaleLowerCase().slice(0, 40),
  };
}

/** A short noun phrase for the step, from what the sentence actually said. */
function titleFor(concepts: Concept[], stepClass: StepClass): string {
  const time = concepts.find((concept) => concept.role === "time");
  const subject = concepts.find((concept) => concept.role === "subject");
  const kind = concepts.find((concept) => concept.role === "kind" && concept.polarity === "include");
  // A pre-parsed time phrase keeps its connective ("for dinner", "zum
  // Mittagessen"); a title wants the noun.
  const timeWords = time?.phrase?.trim().replace(/^(?:open|offen|geöffnet|for|at|on|zum|zur|zu|um|am)\s+/i, "").trim();
  const candidate =
    timeWords ||
    subject?.gist.trim() ||
    subject?.surface.trim() ||
    kind?.values.join(" or ").replace(/_/g, " ").trim() ||
    "";
  const title = candidate.toLocaleLowerCase();
  return title.length > 0 && title.length <= TITLE_MAX ? title : stepClass.label;
}

function whenFor(concepts: Concept[]): PlanStep["when"] {
  const time = concepts.find((concept) => concept.role === "time" && concept.window);
  if (!time?.window) return null;
  return {
    start: time.window.start,
    end: time.window.end,
    phrase: (time.phrase ?? time.surface).slice(0, 60),
  };
}

/** The one default step: what a room opens with when no goal could be read. */
export function offlinePlan(goal: string, areaId: string): PlanPreview {
  const stepClass = defaultStepClass();
  return {
    goal,
    offline: true,
    steps: [{
      stepId: "s1",
      title: stepClass.label,
      placeClass: { key: stepClass.key, label: stepClass.label },
      needs: [],
      when: null,
    }],
    classes: areaClassCounts(areaId),
    clarify: null,
    meta: { model: null, ms: 0 },
  };
}

export async function planPreview(
  goal: string,
  area: AreaDefinition,
  now = new Date(),
): Promise<PlanPreview> {
  if (!config.nlEnabled) return offlinePlan(goal, area.id);

  const currency = area.currency === "USD" ? "USD" : "EUR";
  const parsed = preparse(goal, { currency });
  let concepts: Concept[] = parsed.concepts;
  let stepClass = defaultStepClass();
  let meta: PlanPreview["meta"] = { model: null, ms: 0 };

  if (!parsed.preparsedWhole) {
    const reply = await respond({
      model: config.llmRouteModel,
      instructions: [
        modelInstructions(
          { facets: facetsFor(area, stepClass) } as SpatialContextResult,
          planInput(goal, area, stepClass, now),
          parsed.concepts,
          parsed.remainder,
        ),
        planInstructions(),
      ].join("\n"),
      input: [{ role: "user", content: parsed.remainder || goal }],
      schema: { name: "plan", schema: PLAN_SCHEMA },
      reasoning: "low",
      maxOutputTokens: 1_500,
      timeoutMs: 30_000,
      serviceTier: "default",
    });
    const draft = parseJson<PlanDraft>(reply.text);
    stepClass = stepClassByKey(draft?.placeClass ?? "") ?? defaultStepClass();
    concepts = [...parsed.concepts, ...(draft?.concepts ?? []).map(conceptFromDraft)].slice(0, 5);
    meta = { model: reply.model, ms: reply.ms };
  }

  const input = planInput(goal, area, stepClass, now);
  const subjects = concepts.filter((concept) => concept.role === "subject");
  const grounded = groundReferents(
    concepts.filter((concept) => concept.role !== "subject"),
    input,
  );
  const interpretation: Interpretation = {
    intent: "need",
    concepts: grounded.concepts,
    confidence: 1,
    reply: null,
    meta: { model: meta.model, ms: meta.ms, preparsedWhole: parsed.preparsedWhole },
  };
  const mapped = mapInterpretation(interpretation, input);

  const needs = [
    ...subjects.flatMap((concept) => {
      const need = subjectNeed(concept);
      return need ? [need] : [];
    }),
    ...mapped.needs.map((need) => {
      const name = grounded.dropped.get(need.gist);
      return name
        ? { ...need, assumed: `measured from where you start, not ${name}`.slice(0, 80) }
        : need;
    }),
  ].filter((need) => validatePayload(need.payload));

  const clarify = mapped.clarify
    ? {
        ...mapped.clarify,
        choices: mapped.clarify.choices.map((choice) => ({
          ...choice,
          needs: choice.needs.filter((need) => validatePayload(need.payload)),
        })),
      }
    : null;

  return {
    goal,
    offline: false,
    steps: [{
      stepId: "s1",
      title: titleFor(concepts, stepClass),
      placeClass: { key: stepClass.key, label: stepClass.label },
      needs,
      when: whenFor(concepts),
    }],
    classes: areaClassCounts(area.id),
    clarify,
    meta,
  };
}
