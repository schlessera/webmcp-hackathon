/**
 * A room's plan: the sequence of places a goal decomposes into.
 *
 * "Dinner, then the new film" is two steps. The room runs one at a time —
 * the active step owns the pool, the map and the needs — and a step that has
 * been agreed keeps the place it settled on, so the ones behind you stay
 * readable while the one in front is still open.
 *
 * Nothing here names a domain (CLAUDE.md §1). A step's `placeClass` carries
 * the label the client renders; the key is only ever data. `title` is
 * composed server-side from what the sentence said, never assembled in the
 * client.
 *
 * A room with an empty `steps` array is a room as they were before plans
 * existed, and behaves exactly as it did: one pool, one scope category.
 */

/** How a step sits in the sequence. */
export type StepRelation =
  | { kind: "first" }
  /** Runs after `afterStepId`, and is searched around where that step settled. */
  | { kind: "then"; afterStepId: string };

export type StepStatus = "pending" | "active" | "settled";

/** Where a settled step ended up — the room's own decision, kept on the step. */
export interface StepSettlement {
  candidateId: string;
  name: string;
  lat: number;
  lng: number;
}

/** The window a step named, if it named one. */
export interface StepWhen {
  start: string;
  end: string;
  phrase: string;
}

/** A step as the wire carries it. */
export interface RoomStepView {
  stepId: string;
  /** 1-based position, so copy can say "step 2 of 3" without arithmetic. */
  index: number;
  /** What this step is for, in the goal's own words where it had any. */
  title: string;
  placeClass: { key: string; label: string };
  relation: StepRelation;
  when: StepWhen | null;
  status: StepStatus;
  settled: StepSettlement | null;
}

/** A step as the server stores it: the view, plus what it still owes the room. */
export interface RoomStep extends RoomStepView {
  /**
   * Criteria the goal already stated for this step, applied as the
   * organizer's shared needs when the step activates — through the ordinary
   * SubmitRequirement path, so they are rows like any other. Emptied once
   * applied, so activating twice cannot double them.
   */
  pendingNeeds: Array<{ payload: Record<string, unknown> }>;
}

export const STEPS_MAX = 3;
export const STEP_TITLE_MAX = 40;

export function stepId(index: number): string {
  return `s${index}`;
}

/** The step a room is on, or null for a room without a plan. */
export function activeStep<T extends RoomStepView>(
  steps: readonly T[],
  activeStepId: string | null | undefined,
): T | null {
  if (!activeStepId) return null;
  return steps.find((step) => step.stepId === activeStepId) ?? null;
}

/** The step after `stepId`, or null when this was the last one. */
export function nextStep<T extends RoomStepView>(
  steps: readonly T[],
  fromStepId: string,
): T | null {
  const at = steps.findIndex((step) => step.stepId === fromStepId);
  if (at < 0) return null;
  return steps[at + 1] ?? null;
}

/**
 * Where a step is searched from: the place the step it follows settled on,
 * else the room's own centre. A "then" step whose anchor has not settled yet
 * has no centre of its own and is not activatable.
 */
export function stepAnchor(
  steps: readonly RoomStepView[],
  step: RoomStepView,
): StepSettlement | null {
  if (step.relation.kind !== "then") return null;
  const after = step.relation.afterStepId;
  return steps.find((s) => s.stepId === after)?.settled ?? null;
}
