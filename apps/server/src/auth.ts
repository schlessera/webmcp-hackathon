import { createHash, createHmac, randomBytes } from "node:crypto";
import type pg from "pg";
import { pool } from "./db.ts";
import { config } from "./config.ts";

export interface Participant {
  id: string;
  roomId: string;
  displayName: string;
  role: "organizer" | "member";
  readyState: "contributing" | "ready";
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Deterministic HMAC-derived demo invite secret — local development only. */
export function demoInviteSecret(participantId: string): string {
  return createHmac("sha256", config.demoSecretKey)
    .update(`invite:${participantId}`)
    .digest("hex")
    .slice(0, 32);
}

/**
 * Gate 3: the invite secret arrives in the URL fragment, page JS exchanges it
 * for a participant token stored in sessionStorage (tab-scoped identity).
 */
export async function exchangeInviteSecret(
  inviteSecret: string,
): Promise<{ token: string; participant: Participant } | null> {
  const row = (
    await pool.query(
      `SELECT p.id, p.room_id, p.display_name, p.role, p.ready_state
         FROM invite_secrets s JOIN participants p ON p.id = s.participant_id
        WHERE s.secret_hash = $1`,
      [sha256(inviteSecret)],
    )
  ).rows[0];
  if (!row) return null;
  const token = randomBytes(32).toString("hex");
  await pool.query(
    "INSERT INTO participant_tokens (token_hash, participant_id) VALUES ($1, $2)",
    [sha256(token), row.id],
  );
  return { token, participant: rowToParticipant(row) };
}

/** Actor identity is always derived server-side from the bearer token. */
export async function authenticateToken(
  token: string,
  client?: pg.PoolClient,
): Promise<Participant | null> {
  const q = client ?? pool;
  const row = (
    await q.query(
      `SELECT p.id, p.room_id, p.display_name, p.role, p.ready_state
         FROM participant_tokens t JOIN participants p ON p.id = t.participant_id
        WHERE t.token_hash = $1`,
      [sha256(token)],
    )
  ).rows[0];
  return row ? rowToParticipant(row) : null;
}

function rowToParticipant(row: Record<string, string>): Participant {
  return {
    id: row.id,
    roomId: row.room_id,
    displayName: row.display_name,
    role: row.role as Participant["role"],
    readyState: row.ready_state as Participant["readyState"],
  };
}
