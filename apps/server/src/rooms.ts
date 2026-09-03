import { randomBytes } from "node:crypto";
import {
  AGREEMENT_RULE,
  ALLOWED_VISIBILITIES,
  PROTOCOL_VERSIONS,
  areaById,
  defaultStepClass,
  stepClassByKey,
  type StepClass,
} from "@webmcp-hackathon/contracts";
import { withTransaction } from "./db.ts";
import { sha256, type Participant } from "./auth.ts";
import { submitCommand } from "./engine.ts";
import { candidatesFor, type DataSource } from "./places.ts";
import { pool } from "./db.ts";
import { warmEnrichments } from "./enrich/index.ts";
import { startPoolFill } from "./pool-fill.ts";
import { warmTargetsFor } from "./candidate-write.ts";
import { noteRefinementPresence, startRefinement } from "./refine/worker.ts";

/**
 * Room creation from the area picker: one organizer, up to five members,
 * per-participant invite secrets (the same credential shape room_demo
 * uses, minted randomly instead of HMAC-derived), and a candidate pool drawn
 * from the area's snapshot around the chosen centre. The room opens in
 * `gathering`, exactly as the seeded demo room does, so everything after
 * this point is the existing negotiation flow.
 *
 * room_demo is untouched by any of this (apps/server/src/seed.ts).
 */

export interface CreateRoomInput {
  areaId: string;
  organizerName: string;
  memberNames: string[];
  /** Optional: anywhere inside the area's bbox. Defaults to the area centre. */
  center?: { lat: number; lng: number };
  /** What the group said they want, verbatim. Absent: "Somewhere in <area>". */
  goal?: string;
  /**
   * The room's one step (UNDERSTANDING-ARCH.md §10, D1). Its class decides
   * what may enter the pool; its needs are submitted as the organizer's
   * shared needs through the ordinary command path, once the room exists.
   */
  step?: { placeClass?: unknown; needs?: unknown };
}

/** A need the preview proposed, as the composer would submit it. */
interface SeedNeed {
  payload: Record<string, unknown>;
}

export interface CreatedInvite {
  participantId: string;
  displayName: string;
  role: "organizer" | "member";
  /** Raw secret — travels once, to the creator, in the response body. */
  inviteSecret: string;
}

export type CreateRoomResult =
  | {
      ok: true;
      roomId: string;
      areaId: string;
      invites: CreatedInvite[];
      dataSource: DataSource;
      goal: string;
      step: { placeClass: { key: string; label: string }; seeded: number };
    }
  | { ok: false; status: 400 | 503; error: string };

const NAME_MAX = 40;
const MEMBERS_MAX = 5;
const GOAL_MAX = 300;
const SEED_NEEDS_MAX = 8;

function cleanGoal(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const goal = value.trim().replace(/\s+/g, " ");
  return goal.length === 0 || goal.length > GOAL_MAX ? null : goal;
}

/** Payload-bearing entries only; anything else is skipped, never fatal. */
function seedNeeds(value: unknown): SeedNeed[] {
  if (!Array.isArray(value)) return [];
  const needs: SeedNeed[] = [];
  for (const row of value.slice(0, SEED_NEEDS_MAX)) {
    const payload = (row as { payload?: unknown } | null)?.payload;
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      needs.push({ payload: payload as Record<string, unknown> });
    }
  }
  return needs;
}

/**
 * The organizer's needs, applied exactly as a typed one would be: the same
 * command, the same validation, the same events — so each arrives as an
 * ordinary row that can be dropped, held to preview, and counted. An invalid
 * payload is skipped; the room is already open and stays open.
 */
async function applySeedNeeds(
  organizer: Participant,
  needs: SeedNeed[],
): Promise<number> {
  let seeded = 0;
  for (const need of needs) {
    const room = (await pool.query("SELECT revision FROM rooms WHERE id = $1", [organizer.roomId]))
      .rows[0] as { revision: number } | undefined;
    const result = await submitCommand(organizer, "SubmitRequirement", {
      baseRevision: Number(room?.revision ?? 0),
      visibility: "shared",
      hardness: "hard",
      delegation: { mode: "approval_required" },
      payload: need.payload,
    });
    if (result.ok) seeded += 1;
  }
  return seeded;
}

function cleanName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim().replace(/\s+/g, " ");
  if (name.length === 0 || name.length > NAME_MAX) return null;
  return name;
}

export async function createRoom(input: CreateRoomInput): Promise<CreateRoomResult> {
  const area = areaById(input.areaId);
  if (!area) return { ok: false, status: 400, error: "Unknown areaId." };
  const organizerName = cleanName(input.organizerName);
  if (!organizerName) return { ok: false, status: 400, error: "organizerName required (1–40 characters)." };
  if (!Array.isArray(input.memberNames) || input.memberNames.length > MEMBERS_MAX) {
    return { ok: false, status: 400, error: `memberNames must be an array of at most ${MEMBERS_MAX}.` };
  }
  const memberNames: string[] = [];
  for (const raw of input.memberNames) {
    const name = cleanName(raw);
    if (!name) return { ok: false, status: 400, error: "Every member name needs 1–40 characters." };
    memberNames.push(name);
  }
  let center = area.center;
  if (input.center !== undefined) {
    const c = input.center;
    const [s, w, n, e] = area.bbox;
    if (
      typeof c?.lat !== "number" || typeof c?.lng !== "number" ||
      !Number.isFinite(c.lat) || !Number.isFinite(c.lng) ||
      c.lat < s || c.lat > n || c.lng < w || c.lng > e
    ) {
      return { ok: false, status: 400, error: "center must lie inside the area." };
    }
    center = { lat: c.lat, lng: c.lng };
  }
  const rawClass = input.step?.placeClass;
  let stepClass: StepClass;
  if (rawClass === undefined || rawClass === null) {
    stepClass = defaultStepClass();
  } else {
    const found = typeof rawClass === "string" ? stepClassByKey(rawClass) : undefined;
    if (!found) return { ok: false, status: 400, error: "Unknown step placeClass." };
    stepClass = found;
  }
  const needs = seedNeeds(input.step?.needs);

  const roomId = `room_${randomBytes(4).toString("hex")}`;
  const set = candidatesFor(roomId, area, center, stepClass.members);
  if (!set || set.candidates.length === 0) {
    return { ok: false, status: 503, error: "No place data is available for this area right now." };
  }

  const people = [
    { id: `p_${randomBytes(4).toString("hex")}`, name: organizerName, role: "organizer" as const },
    ...memberNames.map((name) => ({
      id: `p_${randomBytes(4).toString("hex")}`,
      name,
      role: "member" as const,
    })),
  ];
  const invites: CreatedInvite[] = people.map((p) => ({
    participantId: p.id,
    displayName: p.name,
    role: p.role,
    inviteSecret: randomBytes(16).toString("hex"),
  }));
  // The goal is the group's own sentence and is stored exactly as typed.
  const goal = cleanGoal(input.goal) ?? `Somewhere in ${area.label}`;

  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO rooms (id, goal, phase, domain, revision, policy, scope, scope_seq, area_id, data_source)
       VALUES ($1, $2, 'gathering', $3, 0, $4, $5, 1, $6, $7)`,
      [
        roomId,
        goal,
        PROTOCOL_VERSIONS.domain,
        JSON.stringify({
          agreementRule: AGREEMENT_RULE,
          allowedVisibilities: ALLOWED_VISIBILITIES,
          guestAccess: true,
        }),
        JSON.stringify({
          scopeId: "scope_1",
          area: { kind: "circle", center, radiusM: area.radii.narrow },
          transport: ["walk", "bike", "car"],
          // The step's class is what the room pools from (places.ts
          // roomPoolClasses). "food" is the default and today's six classes.
          category: stepClass.key,
        }),
        area.id,
        JSON.stringify(set.dataSource),
      ],
    );
    for (const [i, p] of people.entries()) {
      const fixture = area.fixtureOrigins[i];
      const origin = {
        lat: fixture?.lat ?? center.lat,
        lng: fixture?.lng ?? center.lng,
        label: fixture?.label ?? "the area centre",
        source: "fixture",
        updatedAt: new Date().toISOString(),
      };
      await client.query(
        `INSERT INTO participants (id, room_id, display_name, role, origin) VALUES ($1, $2, $3, $4, $5)`,
        [p.id, roomId, p.name, p.role, JSON.stringify(origin)],
      );
      await client.query(
        `INSERT INTO invite_secrets (secret_hash, participant_id, room_id) VALUES ($1, $2, $3)`,
        [sha256(invites[i].inviteSecret), p.id, roomId],
      );
    }
    for (const c of set.candidates) {
      await client.query(
        `INSERT INTO candidates (id, room_id, name, category, price_level, walk_min, location, attributes, hours, osm_ref, extras)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          c.id, roomId, c.name, c.category, c.price_level, c.walk_min,
          JSON.stringify(c.location), JSON.stringify(c.attributes), JSON.stringify(c.hours),
          c.osmRef ?? null, JSON.stringify(c.extras ?? {}),
        ],
      );
    }
    await client.query(
      `INSERT INTO events (room_id, revision, type, actor_id, visibility, payload)
       VALUES ($1, 0, 'session_created', NULL, 'shared', $2)`,
      [roomId, JSON.stringify({ actorName: "System", goal })],
    );
  });

  // Look the pool up in the background (docs/ENRICHMENT-SOURCES.md): the
  // first place panel someone opens should already be warm.
  warmEnrichments(
    pool,
    roomId,
    warmTargetsFor(set.candidates),
  );
  // Creation returns after the deterministic seed. The rest of the current
  // scope circle arrives under the ordinary room write lock in the background.
  startPoolFill(roomId);
  // Creation is itself a lifecycle signal: begin filling the scheduler now,
  // even before the first page authenticates, then apply the ordinary
  // ten-minute no-presence stop policy.
  if (startRefinement(roomId)) noteRefinementPresence(roomId, new Set());
  // Needs the goal already stated arrive after the room exists, through the
  // ordinary command path, so they are rows like any other.
  const organizer: Participant = {
    id: people[0].id,
    roomId,
    displayName: people[0].name,
    role: "organizer",
    readyState: "contributing",
  };
  const seeded = needs.length > 0 ? await applySeedNeeds(organizer, needs) : 0;
  return {
    ok: true,
    roomId,
    areaId: area.id,
    invites,
    dataSource: set.dataSource,
    goal,
    step: { placeClass: { key: stepClass.key, label: stepClass.label }, seeded },
  };
}
