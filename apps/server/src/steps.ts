import type pg from "pg";
import {
  areaById,
  nextStep,
  stepClassByKey,
  type RoomStep,
  type RoomStepView,
  type StepSettlement,
} from "@webmcp-hackathon/contracts";
import { candidatesFor } from "./places.ts";
import { insertCandidateSeeds, numberCandidateSeeds } from "./candidate-write.ts";

/**
 * Steps on the server: what belongs to the step the room is on, and what
 * happens when the room finishes one and starts the next.
 *
 * Which rows are live is one rule, and it lives in `live-pool.ts` so that a
 * query which enumerates a pool without mentioning it is visibly a query
 * that has forgotten steps exist.
 */

export interface RoomPlan {
  steps: RoomStep[];
  activeStepId: string | null;
}

/** A room's plan as stored, tolerant of a row written before plans existed. */
export function readPlan(row: {
  steps?: unknown;
  active_step_id?: unknown;
}): RoomPlan {
  const steps = Array.isArray(row.steps) ? (row.steps as RoomStep[]) : [];
  const activeStepId =
    typeof row.active_step_id === "string" ? row.active_step_id : null;
  return { steps, activeStepId };
}

/** The view the wire carries: everything except what the step still owes. */
export function stepViews(steps: readonly RoomStep[]): RoomStepView[] {
  return steps.map(({ pendingNeeds: _pendingNeeds, ...view }) => view);
}

export async function loadPlan(
  q: Pick<pg.PoolClient, "query">,
  roomId: string,
): Promise<RoomPlan> {
  const row = (
    await q.query("SELECT steps, active_step_id FROM rooms WHERE id = $1", [roomId])
  ).rows[0];
  return row ? readPlan(row) : { steps: [], activeStepId: null };
}

/**
 * Finish the active step and open the one after it.
 *
 * Runs inside the command transaction that committed the agreement, so a
 * room can never be seen having agreed a place without having moved on from
 * it. Returns the needs the new step owes the room — they are submitted
 * afterwards, through the ordinary command path, because they are ordinary
 * rows (droppable, hold-to-preview, counted) and must not be smuggled in as
 * a side effect of someone else's command.
 */
export interface StepAdvance {
  settledStep: RoomStepView;
  openedStep: RoomStepView;
  /** Where the new step is searched from. */
  center: { lat: number; lng: number };
  /** How many places the new step's pool starts with. */
  poolSize: number;
  /** How many steps the plan has in all, so copy can say "2 of 3". */
  total: number;
  /** Needs to submit as the organizer once the transaction has committed. */
  pendingNeeds: Array<{ payload: Record<string, unknown> }>;
}

export async function settleAndAdvance(
  client: pg.PoolClient,
  roomId: string,
  settlement: StepSettlement,
): Promise<StepAdvance | null> {
  const room = (
    await client.query(
      "SELECT steps, active_step_id, area_id, scope, scope_seq FROM rooms WHERE id = $1 FOR UPDATE",
      [roomId],
    )
  ).rows[0];
  if (!room) return null;
  const { steps, activeStepId } = readPlan(room);
  if (steps.length === 0 || !activeStepId) return null;

  const at = steps.findIndex((step) => step.stepId === activeStepId);
  if (at < 0) return null;
  const settled: RoomStep = { ...steps[at], status: "settled", settled: settlement };
  const updated = [...steps];
  updated[at] = settled;

  const upcoming = nextStep(updated, activeStepId);
  if (!upcoming) {
    // The last step: record where it landed and leave the room agreed.
    await client.query("UPDATE rooms SET steps = $2 WHERE id = $1", [
      roomId,
      JSON.stringify(updated),
    ]);
    return null;
  }

  const area = areaById(String(room.area_id ?? ""));
  if (!area) return null;
  const stepClass = stepClassByKey(upcoming.placeClass.key);
  if (!stepClass) return null;

  // A later step is searched around where the step before it settled: that
  // is what "then" means for a group that has to get there.
  const center = { lat: settlement.lat, lng: settlement.lng };
  const set = candidatesFor(roomId, area, center, stepClass.members);
  // An empty pool still opens the step. A room whose next step has nothing on
  // record around the place it just agreed on is a room that needs to widen
  // its scope, not a room that silently stops halfway through its own plan.
  if (!set) return null;

  // The step keeps what it owes until each need has actually been submitted
  // (recordPendingNeeds, from the post-commit half). Emptying it here would
  // lose the goal's own criteria to any failure in that window.
  const opened: RoomStep = { ...upcoming, status: "active" };
  const at2 = updated.findIndex((step) => step.stepId === upcoming.stepId);
  updated[at2] = opened;

  // The scope circle follows the decision, not a filter (CLAUDE.md §8): the
  // room is now looking around the place it just agreed on.
  const seq = Number(room.scope_seq ?? 0) + 1;
  const previous = room.scope as
    | { transport?: string[]; area?: { radiusM?: number } }
    | null;
  const scope = {
    scopeId: `scope_${seq}`,
    area: { kind: "circle", center, radiusM: area.radii.narrow },
    transport: previous?.transport ?? ["walk", "bike", "car"],
    category: stepClass.key,
  };

  await client.query(
    `UPDATE rooms SET steps = $2, active_step_id = $3, scope = $4, scope_seq = $5
      WHERE id = $1`,
    [roomId, JSON.stringify(updated), opened.stepId, JSON.stringify(scope), seq],
  );

  // The step behind stops classifying: its needs keep their rows, their ids
  // and their history, exactly as setting a need aside does (migration 005).
  await client.query(
    "UPDATE requirements SET active = false WHERE room_id = $1 AND step_id = $2",
    [roomId, settled.stepId],
  );

  // Candidate ids are a per-room sequence, and the step behind keeps its
  // rows: continue the numbering rather than restarting it at 001.
  const existingIds = (
    await client.query("SELECT id FROM candidates WHERE room_id = $1", [roomId])
  ).rows.map((row) => row.id as string);
  numberCandidateSeeds(roomId, set.candidates, existingIds);
  // The room's active step is already the opened one, and that is where
  // insertCandidateSeeds reads the step from.
  await insertCandidateSeeds(client, roomId, set.candidates);

  return {
    settledStep: view(settled),
    openedStep: view(opened),
    center,
    poolSize: set.candidates.length,
    total: updated.length,
    pendingNeeds: upcoming.pendingNeeds ?? [],
  };
}

function view(step: RoomStep): RoomStepView {
  const { pendingNeeds: _pendingNeeds, ...rest } = step;
  return rest;
}

/**
 * What a step still owes, after some of it has been submitted.
 *
 * Written back one success at a time, so a failure in the post-commit window
 * leaves the unsubmitted needs on the step rather than dropping them. Read
 * under the row lock, because ordinary commands are writing `steps` too.
 */
export async function recordPendingNeeds(
  q: Pick<pg.PoolClient, "query">,
  roomId: string,
  stepId: string,
  remaining: Array<{ payload: Record<string, unknown> }>,
): Promise<void> {
  const row = (
    await q.query("SELECT steps FROM rooms WHERE id = $1 FOR UPDATE", [roomId])
  ).rows[0];
  if (!row) return;
  const { steps } = readPlan(row);
  const at = steps.findIndex((step) => step.stepId === stepId);
  if (at < 0) return;
  steps[at] = { ...steps[at], pendingNeeds: remaining };
  await q.query("UPDATE rooms SET steps = $2 WHERE id = $1", [
    roomId,
    JSON.stringify(steps),
  ]);
}
