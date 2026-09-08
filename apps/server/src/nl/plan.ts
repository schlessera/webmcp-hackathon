import AjvModule from "ajv";
import addFormatsModule from "ajv-formats";
import {
  AREAS,
  RequirementPayload,
  STEPS_MAX,
  STEP_CLASSES,
  stepId,
  defaultStepClass,
  preparse,
  stepClassByKey,
  type AreaDefinition,
  type Concept,
  type Facet,
  type Interpretation,
  type SpatialContextResult,
  type StepRelation,
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
import { SCHEMA, conceptFromDraft, modelInstructions, type Draft, type DraftConcept } from "./say.ts";

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
  stepId: string;
  /** 1-based, so copy can say "step 2 of 3" without arithmetic. */
  index: number;
  title: string;
  placeClass: PlanStepClass;
  /** How this step sits in the sequence. A later step is always searched
   * around where the one before it settles — that is what "then" can mean
   * for a group that has to get there. */
  relation: StepRelation;
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

/** Stage A's concept, plus the step it belongs to. The base draft shape is
 * shared with /api/nl/say, which has no steps to attribute anything to. */
type PlanDraftConcept = DraftConcept & { step?: number | null };

interface PlanDraft extends Omit<Draft, "concepts"> {
  steps: Array<{ placeClass: string | null }> | null;
  concepts: PlanDraftConcept[];
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
    items: { required: string[]; properties: { role: { enum: string[] } } };
  };
  return {
    ...(SCHEMA as unknown as Record<string, unknown>),
    required: [...base.required, "steps"],
    properties: {
      ...base.properties,
      intent: { enum: ["plan"] },
      // One entry per place the group has to end up at, in the order the
      // sentence puts them. Most goals have one.
      steps: {
        type: "array",
        minItems: 1,
        maxItems: STEPS_MAX,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["placeClass"],
          properties: { placeClass: { type: "string", maxLength: 40 } },
        },
      },
      concepts: {
        ...concepts,
        items: {
          ...concepts.items,
          required: [...concepts.items.required, "step"],
          properties: {
            ...concepts.items.properties,
            role: { enum: [...concepts.items.properties.role.enum, "subject"] },
            // Which step this concept is about, 1-based. "Dinner at eight
            // then a film" puts the time on the first and nothing on the
            // second.
            step: { type: "integer", minimum: 1, maximum: STEPS_MAX },
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
    "It states what the group wants to do. Break it into the places they have to END UP AT, in order, and return the concepts it states.",
    `Each step's placeClass is exactly one of these keys: ${table}.`,
    `Return between 1 and ${STEPS_MAX} steps. Most goals are ONE step: return one unless the sentence really names a second place to go to afterwards.`,
    "A second step needs a sequence word — then, after that, afterwards, and then, later, dann, danach, anschließend — or two separate outings named one after the other.",
    "Examples of ONE step: dinner somewhere we can all walk to; coffee and a quiet table; a dog-friendly park this afternoon; a museum with the Vermeer exhibition.",
    "Examples of TWO steps: dinner then the new MCU film -> food, cinema; erst Abendessen, dann ins Kino -> food, cinema; coffee and then a bookshop nearby -> cafe, books; a walk with the dog and afterwards a beer -> park, drinks.",
    "Buying or trying something is still one step: the place that sells it. i want to test and buy a new iPhone -> one step, and the model is a subject.",
    "If the goal names no kind of place, answer one step of class food.",
    "Every concept carries step: the 1-based number of the step it is about. A concept that belongs to the whole goal, or to no step in particular, is step 1.",
    "role subject names a particular thing the place must offer or stock — a film, an exhibition, a band, a product. Put the name in surface and a short name in gist.",
    "Examples: watch the new MCU movie -> subject the new MCU movie; die neue Marvel-Verfilmung sehen -> subject die neue Marvel-Verfilmung; buy a new iPhone -> subject a new iPhone.",
    "A word naming the class itself is not also a kind concept: cinema, park, museum, coworking space belong in placeClass only.",
  ].join("\n");
}

const facetCache = new Map<string, Facet[]>();

/**
 * What the room the goal would open already knows about its places. Read from
 * the snapshot for the step's classes inside the narrow radius, so a cuisine
 * the area records routes the same way in the preview as it will in the room.
 */
function facetsFor(area: AreaDefinition | null, stepClass: StepClass): Facet[] {
  const key = `${area?.id ?? "*"}:${stepClass.key}`;
  const cached = facetCache.get(key);
  if (cached) return cached;
  // No area yet: read every area the demo has, so a preview taken before the
  // region is chosen is not silently a preview of one of them.
  const areas = area ? [area] : AREAS;
  const rows: Array<Record<string, unknown>> = [];
  for (const source of areas) {
    const snapshot = loadSnapshot(source.id);
    if (!snapshot) continue;
    const venues = fillPlan(
      source,
      snapshot,
      source.center,
      source.radii.narrow,
      [],
      Number.MAX_SAFE_INTEGER,
      stepClass.members,
    ).batches[0] ?? [];
    for (const seed of seedsForVenues(
      `room_preview_${source.id}`,
      venues,
      snapshot.manifest.extract.timestamp,
    )) {
      rows.push({ ...seed, map_revision: rows.length });
    }
  }
  const facets = rows.length === 0
    ? []
    : computeFacets(
        rows as never,
        null,
        undefined,
        (area?.currency ?? "EUR") === "USD" ? "USD" : "EUR",
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
  area: AreaDefinition | null,
  stepClass: StepClass,
  now: Date,
  /** The organizer's own zone, when the page told us. Before a region is
   * chosen there is no area to read one from, and "tonight" still has to
   * mean tonight where they are. */
  timezone?: string,
): UnderstandInput {
  return {
    text: goal,
    scope: "shared",
    room: {
      areaId: area?.id ?? AREAS[0].id,
      timezone: timezone ?? area?.timezone ?? AREAS[0].timezone,
      currency: (area?.currency ?? "EUR") === "USD" ? "USD" : "EUR",
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
  const candidate =
    timeWords(time?.phrase) ||
    subject?.gist.trim() ||
    subject?.surface.trim() ||
    kind?.values.join(" or ").replace(/_/g, " ").trim() ||
    "";
  const title = candidate.toLocaleLowerCase();
  return title.length > 0 && title.length <= TITLE_MAX ? title : stepClass.label;
}

/** A pre-parsed time phrase keeps its connective ("for dinner", "zum
 * Mittagessen"); a title or a window label wants the noun. */
function timeWords(phrase: string | null | undefined): string {
  return (phrase ?? "").trim().replace(/^(?:open|offen|geöffnet|for|at|on|zum|zur|zu|um|am)\s+/i, "").trim();
}

function whenFor(needs: ParsedNeed[], concepts: Concept[]): PlanStep["when"] {
  // Stage B resolves relative times (lunch, Friday evening) from timeSpec;
  // read the window it produced, not the concept's raw field.
  const need = needs.find((row) => row.payload.kind === "time");
  const window = need?.payload.window as { start?: unknown; end?: unknown } | undefined;
  if (typeof window?.start === "string" && typeof window?.end === "string") {
    const phrase = typeof need?.payload.phrase === "string" ? need.payload.phrase : need?.label ?? "";
    return { start: window.start, end: window.end, phrase: timeWords(phrase).slice(0, 60) };
  }
  const time = concepts.find((concept) => concept.role === "time" && concept.window);
  if (!time?.window) return null;
  return {
    start: time.window.start,
    end: time.window.end,
    phrase: timeWords(time.phrase ?? time.surface).slice(0, 60),
  };
}

/** The one default step: what a room opens with when no goal could be read. */
export function offlinePlan(goal: string, areaId: string | null): PlanPreview {
  const stepClass = defaultStepClass();
  return {
    goal,
    offline: true,
    steps: [{
      stepId: stepId(1),
      index: 1,
      title: stepClass.label,
      placeClass: { key: stepClass.key, label: stepClass.label },
      relation: { kind: "first" },
      needs: [],
      when: null,
    }],
    classes: areaId ? areaClassCounts(areaId) : [],
    clarify: null,
    meta: { model: null, ms: 0 },
  };
}

export interface PlanPreviewOptions {
  now?: Date;
  /** The organizer's own zone, when the page sent one. Used before a region
   * has been chosen, which is the ordinary case for this screen. */
  timezone?: string;
}

export async function planPreview(
  goal: string,
  area: AreaDefinition | null,
  options: PlanPreviewOptions = {},
): Promise<PlanPreview> {
  const now = options.now ?? new Date();
  if (!config.nlEnabled) return offlinePlan(goal, area?.id ?? null);

  const currency = (area?.currency ?? "EUR") === "USD" ? "USD" : "EUR";
  const partial = preparse(goal, { currency });
  const parsed = partial.preparsedWhole ? partial : { ...partial, concepts: [], remainder: goal };
  // Everything the pre-parser found belongs to the first step: it reads
  // times, distances and budgets, and a sentence states those about the
  // outing it starts with.
  let byStep: Concept[][] = [parsed.concepts];
  let classes: StepClass[] = [defaultStepClass()];
  let meta: PlanPreview["meta"] = { model: null, ms: 0 };

  if (!parsed.preparsedWhole) {
    const reply = await respond({
      model: config.llmRouteModel,
      instructions: [
        modelInstructions(
          { facets: facetsFor(area, classes[0]) } as SpatialContextResult,
          planInput(goal, area, classes[0], now, options.timezone),
          parsed.concepts,
          parsed.remainder,
        ),
        planInstructions(),
      ].join("\n"),
      input: [{ role: "user", content: parsed.remainder || goal }],
      schema: { name: "plan", schema: PLAN_SCHEMA },
      reasoning: "low",
      maxOutputTokens: 3_000,
      timeoutMs: 30_000,
      serviceTier: "default",
    });
    const draft = parseJson<PlanDraft>(reply.text);
    const drafted = (draft?.steps ?? [])
      .slice(0, STEPS_MAX)
      .map((step) => stepClassByKey(step?.placeClass ?? "") ?? defaultStepClass());
    classes = drafted.length > 0 ? drafted : [defaultStepClass()];
    byStep = classes.map(() => [] as Concept[]);
    byStep[0] = [...parsed.concepts];
    for (const raw of draft?.concepts ?? []) {
      // A step number outside the plan the model just returned means the
      // sentence and the split disagree; the first step is where a concept
      // with nowhere to go belongs.
      const at = Number.isInteger(raw.step) && raw.step! >= 1 && raw.step! <= classes.length
        ? raw.step! - 1
        : 0;
      byStep[at].push(conceptFromDraft(raw));
    }
    byStep = byStep.map((concepts) => concepts.slice(0, 5));
    meta = { model: reply.model, ms: reply.ms };
  }

  // Stage B runs per step, unchanged: each step is read against the facets
  // its own class has, so a cuisine routes on a food step and a subject
  // becomes a question on a cinema step.
  const steps: PlanStep[] = [];
  let clarify: Clarification | null = null;
  for (const [i, stepClass] of classes.entries()) {
    const concepts = byStep[i] ?? [];
    const input = planInput(goal, area, stepClass, now, options.timezone);
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

    // The first question the plan raises is the one the organizer answers.
    // A later step's ambiguity waits until that step is the one being read.
    if (!clarify && mapped.clarify) {
      clarify = {
        ...mapped.clarify,
        mode: mapped.clarify.mode ?? "one",
        stepId: stepId(i + 1),
        choices: mapped.clarify.choices.map((choice) => ({
          ...choice,
          needs: choice.needs.filter((need) => validatePayload(need.payload)),
        })),
      };
    }

    steps.push({
      stepId: stepId(i + 1),
      index: i + 1,
      title: titleFor(concepts, stepClass),
      placeClass: { key: stepClass.key, label: stepClass.label },
      relation: i === 0 ? { kind: "first" } : { kind: "then", afterStepId: stepId(i) },
      needs,
      when: whenFor(needs, concepts),
    });
  }

  return {
    goal,
    offline: false,
    steps,
    // Counts belong to an area, and before one is chosen there are none to
    // give. The region dialog is where they arrive (GET /api/areas).
    classes: area ? areaClassCounts(area.id) : [],
    clarify,
    meta,
  };
}
