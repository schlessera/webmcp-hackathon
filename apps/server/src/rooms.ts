import { randomBytes } from "node:crypto";
import {
  AGREEMENT_RULE,
  ALLOWED_VISIBILITIES,
  PROTOCOL_VERSIONS,
  areaById,
} from "@webmcp-hackathon/contracts";
import { withTransaction } from "./db.ts";
import { sha256 } from "./auth.ts";
import { candidatesFor, type DataSource } from "./places.ts";
import { pool } from "./db.ts";
import { warmEnrichments } from "./enrich/index.ts";

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
}

export interface CreatedInvite {
  participantId: string;
  displayName: string;
  role: "organizer" | "member";
  /** Raw secret — travels once, to the creator, in the response body. */
  inviteSecret: string;
}

export type CreateRoomResult =
  | { ok: true; roomId: string; areaId: string; invites: CreatedInvite[]; dataSource: DataSource }
  | { ok: false; status: 400 | 503; error: string };

const NAME_MAX = 40;
const MEMBERS_MAX = 5;

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

  const roomId = `room_${randomBytes(4).toString("hex")}`;
  const set = candidatesFor(roomId, area, center);
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
  const goal = `Somewhere in ${area.label}`;

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
          category: "food",
        }),
        area.id,
        JSON.stringify(set.dataSource),
      ],
    );
    for (const [i, p] of people.entries()) {
      await client.query(
        `INSERT INTO participants (id, room_id, display_name, role) VALUES ($1, $2, $3, $4)`,
        [p.id, roomId, p.name, p.role],
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
    set.candidates.flatMap((c) => {
      const extras = (c.extras ?? {}) as { website?: string; wikidata?: string };
      return c.osmRef && (extras.website || extras.wikidata)
        ? [{ candidateId: c.id, osmRef: c.osmRef, ...(extras.website ? { website: extras.website } : {}), ...(extras.wikidata ? { wikidata: extras.wikidata } : {}) }]
        : [];
    }),
  );
  return { ok: true, roomId, areaId: area.id, invites, dataSource: set.dataSource };
}
