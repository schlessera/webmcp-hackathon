import { randomBytes } from "node:crypto";
import type pg from "pg";
import type { Participant } from "./auth.ts";

/**
 * Confirmation nonces for the two applying commands, CommitAgreement and
 * ConfirmPrivateRequest (INTERACTION-AND-BINDING.md §5.4).
 *
 * A stage mints one; it reaches the participant ONLY over their page's
 * realtime channel, never in the command result the agent surface sees. The
 * applying command must carry it back, and the server verifies room,
 * participant, kind, and subject before consuming it.
 *
 * Deliberately in-memory: a 120-second single-use code has no reason to be
 * written to disk, and dying with the process is correct — a restart mints a
 * new buildId, which already forces every page through a reload.
 */

export const CONFIRMATION_TTL_MS = 120_000;

export type ConfirmationKind = "agreement" | "private_request";

/** What a stage awaits: proposalId for "agreement", requestId otherwise. */
export interface ConfirmationSubject {
  kind: ConfirmationKind;
  subjectId: string;
}

export interface ConfirmationGrant extends ConfirmationSubject {
  nonce: string;
  expiresInMs: number;
}

interface Entry extends ConfirmationSubject {
  roomId: string;
  participantId: string;
  expiresAt: number;
}

const live = new Map<string, Entry>();

export function mintConfirmation(
  roomId: string,
  participantId: string,
  subject: ConfirmationSubject,
  now = Date.now(),
): ConfirmationGrant {
  sweep(now);
  // R12: restaging or reconnecting replaces the credential for the same
  // subject. Keeping the earlier nonce live would permit two confirmations
  // for one currently staged decision.
  for (const [existingNonce, entry] of live) {
    if (
      entry.roomId === roomId &&
      entry.participantId === participantId &&
      entry.kind === subject.kind &&
      entry.subjectId === subject.subjectId
    ) {
      live.delete(existingNonce);
    }
  }
  const nonce = randomBytes(24).toString("hex");
  live.set(nonce, {
    roomId,
    participantId,
    kind: subject.kind,
    subjectId: subject.subjectId,
    expiresAt: now + CONFIRMATION_TTL_MS,
  });
  return { ...subject, nonce, expiresInMs: CONFIRMATION_TTL_MS };
}

/** Re-send a staged subject to a newly authenticated tab without revoking
 * the credential another live tab already holds. Only a real restage calls
 * mintConfirmation and replaces it. */
export function reissueConfirmation(
  roomId: string,
  participantId: string,
  subject: ConfirmationSubject,
  now = Date.now(),
): ConfirmationGrant {
  sweep(now);
  for (const [nonce, entry] of live) {
    if (
      entry.roomId === roomId &&
      entry.participantId === participantId &&
      entry.kind === subject.kind &&
      entry.subjectId === subject.subjectId
    ) {
      // X5: reconnect/authentication is delivery, not a new stage.
      return { ...subject, nonce, expiresInMs: entry.expiresAt - now };
    }
  }
  return mintConfirmation(roomId, participantId, subject, now);
}

export function consumeConfirmation(
  roomId: string,
  participantId: string,
  subject: ConfirmationSubject,
  nonce: unknown,
  now = Date.now(),
): boolean {
  if (typeof nonce !== "string" || nonce.length === 0) return false;
  const entry = live.get(nonce);
  if (!entry) return false;
  // Single use, spent on presentation rather than on success: a presented
  // value cannot be re-tried against a second subject.
  live.delete(nonce);
  if (entry.expiresAt <= now) return false;
  return (
    entry.roomId === roomId &&
    entry.participantId === participantId &&
    entry.kind === subject.kind &&
    entry.subjectId === subject.subjectId
  );
}

function sweep(now: number): void {
  for (const [nonce, entry] of live) {
    if (entry.expiresAt <= now) live.delete(nonce);
  }
}

/**
 * Everything currently staged and awaiting this participant's in-page
 * confirmation. A reconnecting page may have lost its nonce delivery, so the
 * realtime channel re-issues from this list on welcome — without it a dropped
 * socket would wedge a staged agreement for good.
 */
export async function pendingConfirmations(
  q: pg.PoolClient | pg.Pool,
  participant: Participant,
): Promise<ConfirmationSubject[]> {
  const subjects: ConfirmationSubject[] = [];
  if (participant.role === "organizer") {
    const staged = await q.query(
      "SELECT id FROM proposals WHERE room_id = $1 AND status = 'staged' ORDER BY id",
      [participant.roomId],
    );
    for (const row of staged.rows) {
      subjects.push({ kind: "agreement", subjectId: row.id as string });
    }
  }
  const grants = await q.query(
    `SELECT id FROM adjustments
      WHERE room_id = $1 AND requires_consent_of = $2 AND status = 'staged_grant'
      ORDER BY id`,
    [participant.roomId, participant.id],
  );
  for (const row of grants.rows) {
    subjects.push({ kind: "private_request", subjectId: row.id as string });
  }
  return subjects;
}
