import { withTransaction, pool } from "./db.ts";
import { demoInviteSecret, sha256 } from "./auth.ts";
import { PROTOCOL_VERSIONS, AGREEMENT_RULE, ALLOWED_VISIBILITIES } from "@webmcp-hackathon/contracts";

/**
 * Idempotent demo seeder (Gate 3): transactionally upserts one stable scenario
 * — one room, organizer + Sarah + Joe, three participant-scoped invite
 * secrets, and prepared curated candidates. Never wipes the volume; running it
 * twice is a no-op. Destructive reset lives in `make demo-reset` only
 * (--reset flag), which clears just the named demo room.
 */

const ROOM_ID = "room_demo";
const PARTICIPANTS = [
  { id: "p_org", name: "Alex", role: "organizer" },
  { id: "p_sarah", name: "Sarah", role: "member" },
  { id: "p_joe", name: "Joe", role: "member" },
] as const;

const CANDIDATES = [
  {
    id: "place_42",
    name: "Garden Cafe Window",
    category: "cafe",
    priceLevel: 2,
    walkMin: 6,
    location: { lat: 52.4981, lng: 13.4262 },
    attributes: [
      { key: "vegetarian-options", status: "verified_true", source: "curated:berlin-kreuzberg-2026-08", observedAt: "2026-08-31T10:00:00Z", confidence: 0.9 },
      { key: "outdoor-seating", status: "verified_true", source: "curated:berlin-kreuzberg-2026-08", observedAt: "2026-08-31T10:00:00Z", confidence: 0.9 },
      { key: "dog-friendly", status: "verified_true", source: "curated:berlin-kreuzberg-2026-08", observedAt: "2026-08-31T10:00:00Z", confidence: 0.9 },
    ],
  },
  {
    id: "place_17",
    name: "Cedar Table",
    category: "restaurant",
    priceLevel: 3,
    walkMin: 12,
    location: { lat: 52.4952, lng: 13.4211 },
    attributes: [
      { key: "vegetarian-options", status: "verified_true", source: "curated:berlin-kreuzberg-2026-08", observedAt: "2026-08-31T10:00:00Z", confidence: 0.9 },
      { key: "wheelchair-accessible", status: "unverified", source: "curated:berlin-kreuzberg-2026-08", observedAt: "2026-08-31T10:00:00Z", confidence: 0.4 },
    ],
  },
  {
    id: "place_29",
    name: "Brick Lane Diner",
    category: "restaurant",
    priceLevel: 1,
    walkMin: 9,
    location: { lat: 52.5009, lng: 13.4301 },
    attributes: [
      { key: "vegetarian-options", status: "verified_false", source: "curated:berlin-kreuzberg-2026-08", observedAt: "2026-08-31T10:00:00Z", confidence: 0.9 },
    ],
  },
  {
    id: "place_51",
    name: "Kanal Garten",
    category: "beer-garden",
    priceLevel: 2,
    walkMin: 14,
    location: { lat: 52.4933, lng: 13.4402 },
    attributes: [
      { key: "vegetarian-options", status: "verified_true", source: "curated:berlin-kreuzberg-2026-08", observedAt: "2026-08-31T10:00:00Z", confidence: 0.8 },
      { key: "outdoor-seating", status: "verified_true", source: "curated:berlin-kreuzberg-2026-08", observedAt: "2026-08-31T10:00:00Z", confidence: 0.9 },
    ],
  },
] as const;

const reset = process.argv.includes("--reset");

await withTransaction(async (client) => {
  if (reset) {
    // Destructive path, explicitly named: clears only the demo room.
    for (const table of [
      "stances", "proposals", "verdicts", "requirements", "events",
      "invite_secrets", "participant_tokens", "candidates",
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

  await client.query(
    `INSERT INTO rooms (id, goal, phase, domain, revision, policy)
     VALUES ($1, $2, 'gathering', $3, 0, $4)
     ON CONFLICT (id) DO NOTHING`,
    [
      ROOM_ID,
      "Dinner tonight near Kreuzberg",
      PROTOCOL_VERSIONS.domain,
      JSON.stringify({
        agreementRule: AGREEMENT_RULE,
        allowedVisibilities: ALLOWED_VISIBILITIES,
        guestAccess: true,
      }),
    ],
  );

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

  for (const c of CANDIDATES) {
    await client.query(
      `INSERT INTO candidates (id, room_id, name, category, price_level, walk_min, location, attributes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING`,
      [
        c.id, ROOM_ID, c.name, c.category, c.priceLevel, c.walkMin,
        JSON.stringify(c.location), JSON.stringify(c.attributes),
      ],
    );
  }

  // One open proposal so the stance/veto path (§4.3) is live from the start.
  await client.query(
    `INSERT INTO proposals (id, room_id, candidate_id, created_by, created_at_revision, status)
     VALUES ('prop_1', $1, 'place_42', 'p_org', 0, 'open')
     ON CONFLICT (id) DO NOTHING`,
    [ROOM_ID],
  );

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
      [ROOM_ID, JSON.stringify({ actorName: "System", goal: "Dinner tonight near Kreuzberg" })],
    );
  }
});

const base = process.env.APP_URL ?? "http://127.0.0.1:4173";
console.log("demo room seeded (idempotent).");
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
