import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { withTransaction, pool } from "./db.ts";
import { demoInviteSecret, sha256 } from "./auth.ts";
import {
  PROTOCOL_VERSIONS,
  AGREEMENT_RULE,
  ALLOWED_VISIBILITIES,
} from "@webmcp-hackathon/contracts";
import { haversineMeters } from "./eligibility.ts";

/**
 * Idempotent demo seeder: transactionally upserts one stable scenario — one
 * Berlin Mitte room, organizer + Sarah + Joe, three participant-scoped invite
 * secrets, and the full curated venue dataset. No seeded requirements or
 * proposals: the demo builds them live. Never wipes the volume; running it
 * twice is a no-op. Destructive reset lives in `make demo-reset` only
 * (--reset flag), which clears just the named demo room.
 */

const ROOM_ID = "room_demo";
const GOAL = "Dinner tonight in Berlin Mitte";
const PARTICIPANTS = [
  { id: "p_org", name: "Alex", role: "organizer" },
  { id: "p_sarah", name: "Sarah", role: "member" },
  { id: "p_joe", name: "Joe", role: "member" },
] as const;

interface VenueFile {
  manifest: {
    demoCenter: { lat: number; lng: number };
    demoRadii: { narrow: number; wide: number };
  };
  venues: Array<{
    candidateId: string;
    name: string;
    location: { lat: number; lng: number };
    category: string;
    priceLevel: number | null;
    hours: Array<{ day: string; open: string; close: string }>;
    attributes: Array<Record<string, unknown>>;
  }>;
}

const dataPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..", "..", "..", "packages", "contracts", "data", "berlin-mitte-venues.json",
);
const dataset = JSON.parse(readFileSync(dataPath, "utf8")) as VenueFile;
// The manifest center carries an annotation field; the scope holds bare coords.
const center = {
  lat: dataset.manifest.demoCenter.lat,
  lng: dataset.manifest.demoCenter.lng,
};

const WALK_SPEED_M_PER_MIN = 4500 / 60;

const reset = process.argv.includes("--reset");

await withTransaction(async (client) => {
  if (reset) {
    // Destructive path, explicitly named: clears only the demo room.
    for (const table of [
      "stances", "proposals", "verdicts", "requirements", "adjustments",
      "arrival_plans", "events", "invite_secrets", "participant_tokens",
      "candidates",
    ]) {
      if (table === "participant_tokens") {
        await client.query(
          `DELETE FROM participant_tokens WHERE participant_id IN
             (SELECT id FROM participants WHERE room_id = $1)`,
          [ROOM_ID],
        );
      } else if (table === "invite_secrets") {
        await client.query("DELETE FROM invite_secrets WHERE room_id = $1", [ROOM_ID]);
      } else {
        await client.query(`DELETE FROM ${table} WHERE room_id = $1`, [ROOM_ID]);
      }
    }
    await client.query("DELETE FROM participants WHERE room_id = $1", [ROOM_ID]);
    await client.query("DELETE FROM rooms WHERE id = $1", [ROOM_ID]);
  }

  const demoScope = JSON.stringify({
    scopeId: "scope_1",
    area: {
      kind: "circle",
      center,
      radiusM: dataset.manifest.demoRadii.narrow,
    },
    transport: ["walk", "bike", "car"],
    category: "food",
  });
  await client.query(
    `INSERT INTO rooms (id, goal, phase, domain, revision, policy, scope, scope_seq)
     VALUES ($1, $2, 'gathering', $3, 0, $4, $5, 1)
     ON CONFLICT (id) DO UPDATE SET
       goal = $2,
       -- Upgrade path for a pre-scope room_demo: backfill the scope exactly
       -- once; a live room's widened scope is never clobbered.
       scope = COALESCE(rooms.scope, EXCLUDED.scope),
       scope_seq = GREATEST(rooms.scope_seq, 1)`,
    [
      ROOM_ID,
      GOAL,
      PROTOCOL_VERSIONS.domain,
      JSON.stringify({
        agreementRule: AGREEMENT_RULE,
        allowedVisibilities: ALLOWED_VISIBILITIES,
        guestAccess: true,
      }),
      demoScope,
    ],
  );

  // Upgrade path: drop demo candidates that are not part of the current
  // dataset (the pre-slice seed shipped 4 Kreuzberg venues). Their verdicts
  // go with them, and proposals pointing at a vanished venue are withdrawn.
  const datasetIds = dataset.venues.map((v) => v.candidateId);
  const stale = (
    await client.query(
      "SELECT id FROM candidates WHERE room_id = $1 AND id <> ALL($2)",
      [ROOM_ID, datasetIds],
    )
  ).rows.map((r) => r.id as string);
  if (stale.length > 0) {
    await client.query(
      "DELETE FROM verdicts WHERE room_id = $1 AND candidate_id = ANY($2)",
      [ROOM_ID, stale],
    );
    await client.query(
      `UPDATE proposals SET status = 'withdrawn'
        WHERE room_id = $1 AND candidate_id = ANY($2) AND status <> 'withdrawn'`,
      [ROOM_ID, stale],
    );
    await client.query(
      "DELETE FROM candidates WHERE room_id = $1 AND id = ANY($2)",
      [ROOM_ID, stale],
    );
  }

  for (const p of PARTICIPANTS) {
    await client.query(
      `INSERT INTO participants (id, room_id, display_name, role)
       VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
      [p.id, ROOM_ID, p.name, p.role],
    );
    const secret = demoInviteSecret(p.id);
    await client.query(
      `INSERT INTO invite_secrets (secret_hash, participant_id, room_id)
       VALUES ($1, $2, $3) ON CONFLICT (secret_hash) DO NOTHING`,
      [sha256(secret), p.id, ROOM_ID],
    );
  }

  for (const v of dataset.venues) {
    const walkMin = Math.max(
      1,
      Math.round(haversineMeters(v.location, center) / WALK_SPEED_M_PER_MIN),
    );
    await client.query(
      `INSERT INTO candidates (id, room_id, name, category, price_level, walk_min, location, attributes, hours)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (id) DO NOTHING`,
      [
        // null stays null: an unknown price is uncertain under a budget need,
        // never a silently invented band (migration 006).
        v.candidateId, ROOM_ID, v.name, v.category, v.priceLevel, walkMin,
        JSON.stringify(v.location), JSON.stringify(v.attributes),
        JSON.stringify(v.hours ?? []),
      ],
    );
  }
  // candidates.id is a global PK: a bare place_N held by another room would
  // make ON CONFLICT silently under-seed the demo. Fail loudly instead.
  const seeded = (
    await client.query(
      "SELECT count(*)::int AS n FROM candidates WHERE room_id = $1",
      [ROOM_ID],
    )
  ).rows[0].n as number;
  if (seeded !== dataset.venues.length) {
    throw new Error(
      `demo seed incomplete: ${seeded}/${dataset.venues.length} venues landed — ` +
      "another room holds colliding candidate IDs; clean stale rooms and reseed.",
    );
  }

  const hasEvents = (
    await client.query(
      "SELECT 1 FROM events WHERE room_id = $1 LIMIT 1",
      [ROOM_ID],
    )
  ).rowCount;
  if (!hasEvents) {
    await client.query(
      `INSERT INTO events (room_id, revision, type, actor_id, visibility, payload)
       VALUES ($1, 0, 'session_created', NULL, 'shared', $2)`,
      [ROOM_ID, JSON.stringify({ actorName: "System", goal: GOAL })],
    );
  }
});

const base = process.env.APP_URL ?? "http://127.0.0.1:4173";
console.log(
  `demo room seeded (idempotent): ${dataset.venues.length} Berlin Mitte venues, ` +
  `scope ${dataset.manifest.demoRadii.narrow} m around ${center.lat},${center.lng}.`,
);
console.log("");
console.log("Invite URLs (secret rides in the URL fragment):");
for (const p of PARTICIPANTS) {
  const surface = p.role === "organizer" ? "?surface=chatgpt" : "";
  console.log(
    `  ${p.name.padEnd(6)} ${p.role.padEnd(10)} ${base}/${surface}#invite=${demoInviteSecret(p.id)}`,
  );
}
console.log("");
console.log("Open the organizer URL in ChatGPT's built-in browser.");
await pool.end();
