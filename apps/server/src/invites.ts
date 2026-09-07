import { randomBytes } from "node:crypto";
import { areaById } from "@webmcp-hackathon/contracts";
import { pool, withTransaction } from "./db.ts";
import { sha256, type Participant } from "./auth.ts";
import { notifyCommit } from "./commit-notifications.ts";
import { nextPhase, isPhase } from "./phase.ts";
import { readPlan } from "./steps.ts";

/**
 * Invite links: how someone joins a room that already exists.
 *
 * The room opens with one person in it. Everyone else arrives through a link
 * that person hands out — a message, a copied URL, a QR code held up across a
 * table. A link is single-use in the sense that matters: the first person to
 * claim it becomes the participant it made, and after that it is *their* way
 * back in and nobody else's. Minting another link does not revoke the ones
 * already out, because an organizer who sent three invitations should not
 * have to explain why only the last one works.
 *
 * The device binding is not an identity and is never shown. It is what makes
 * "your link" mean something on a machine with no accounts: the browser that
 * claimed a link keeps its hash, so a reload, a new tab, or a closed laptop
 * all come back to the same person, and a forwarded link does not.
 *
 * A refusal names nobody. "This link is already in use" is the whole message
 * a stranger gets; who is using it is the room's business, not the internet's.
 */

/** Unclaimed links stop working after this. Not configurable: a demo that
 * hands out links in a room should not hand out links that outlive it. */
export const INVITE_TTL_MS = 60 * 60_000;

const NAME_MAX = 40;
const DEVICE_ID = /^[A-Za-z0-9_-]{8,128}$/;

export type InviteState = "unused" | "claimed" | "expired";

export interface MintedInvite {
  inviteId: string;
  /** Raw secret. Travels once, to whoever minted it, and is never stored. */
  inviteSecret: string;
  expiresAt: string;
}

export interface InviteRow {
  inviteId: string;
  state: InviteState;
  createdAt: string;
  expiresAt: string;
  /** Who took it. Only ever sent to people already in the room. */
  claimedBy: string | null;
}

/** What a room shows someone who has not joined it yet. */
export interface InviteContext {
  goal: string;
  organizer: { displayName: string };
  participantCount: number;
  area: { id: string; label: string } | null;
  steps: Array<{ title: string; placeClass: { label: string } }>;
  claimable: boolean;
  reason: "expired" | "in_use" | null;
}

export type ClaimResult =
  | {
      ok: true;
      token: string;
      participant: Participant;
      /** False when the device was returning to a link it already claimed. */
      joined: boolean;
    }
  | { ok: false; status: 400 | 404 | 409 | 410; error: string };

function cleanName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim().replace(/\s+/g, " ");
  return name.length === 0 || name.length > NAME_MAX ? null : name;
}

export async function mintInvite(actor: Participant): Promise<MintedInvite> {
  const inviteId = `inv_${randomBytes(6).toString("hex")}`;
  const inviteSecret = randomBytes(16).toString("hex");
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
  await pool.query(
    `INSERT INTO room_invites (id, room_id, secret_hash, created_by, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [inviteId, actor.roomId, sha256(inviteSecret), actor.id, expiresAt],
  );
  return { inviteId, inviteSecret, expiresAt: expiresAt.toISOString() };
}

export async function listInvites(actor: Participant): Promise<InviteRow[]> {
  const rows = (
    await pool.query(
      `SELECT i.id, i.created_at, i.expires_at, i.claimed_at, p.display_name
         FROM room_invites i
         LEFT JOIN participants p ON p.id = i.participant_id
        WHERE i.room_id = $1
        ORDER BY i.created_at DESC`,
      [actor.roomId],
    )
  ).rows as Array<{
    id: string;
    created_at: Date;
    expires_at: Date;
    claimed_at: Date | null;
    display_name: string | null;
  }>;
  const now = Date.now();
  return rows.map((row) => ({
    inviteId: row.id,
    state: row.claimed_at
      ? "claimed"
      : row.expires_at.getTime() <= now
        ? "expired"
        : "unused",
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    claimedBy: row.display_name,
  }));
}

/**
 * What the room looks like from outside it, to someone holding a link.
 *
 * Deliberately thin: the goal, who started it, how many are in, where. No
 * participant list, no places, no ids that are useful without a token. It is
 * enough to decide whether you meant to click this, and nothing more.
 */
export async function inviteContext(inviteSecret: string): Promise<InviteContext | null> {
  const row = (
    await pool.query(
      `SELECT r.id AS room_id, i.expires_at, i.claimed_at, r.goal, r.area_id, r.steps
         FROM room_invites i JOIN rooms r ON r.id = i.room_id
        WHERE i.secret_hash = $1`,
      [sha256(inviteSecret)],
    )
  ).rows[0] as
    | {
        room_id: string;
        expires_at: Date;
        claimed_at: Date | null;
        goal: string;
        area_id: string | null;
        steps: unknown;
      }
    | undefined;
  if (!row) return null;
  const roomId = row.room_id;

  const people = (
    await pool.query(
      "SELECT display_name, role FROM participants WHERE room_id = $1 ORDER BY role DESC, id",
      [roomId],
    )
  ).rows as Array<{ display_name: string; role: string }>;
  const organizer = people.find((person) => person.role === "organizer");
  const area = areaById(String(row.area_id ?? ""));
  const { steps } = readPlan({ steps: row.steps });

  const expired = !row.claimed_at && row.expires_at.getTime() <= Date.now();
  return {
    goal: row.goal,
    organizer: { displayName: organizer?.display_name ?? "the organizer" },
    participantCount: people.length,
    area: area ? { id: area.id, label: area.label } : null,
    steps: steps.map((step) => ({
      title: step.title,
      placeClass: { label: step.placeClass.label },
    })),
    // A claimed link can still be claimable — by the device that claimed it.
    // The page finds that out by trying; saying so here would tell a stranger
    // more than they should learn from a URL alone.
    claimable: !expired,
    reason: expired ? "expired" : null,
  };
}

/**
 * Take a link, or come back through one already taken.
 *
 * The whole transaction is one statement's worth of decision: the row is
 * locked, and either it has no participant (a new person joins) or it has one
 * and the device must match. Both paths mint a fresh token, because a token
 * is a session and a person may start several.
 */
export async function claimInvite(
  inviteSecret: string,
  rawName: unknown,
  rawDeviceId: unknown,
): Promise<ClaimResult> {
  const displayName = cleanName(rawName);
  if (!displayName) {
    return { ok: false, status: 400, error: "A name of 1–40 characters is needed to join." };
  }
  const deviceId = typeof rawDeviceId === "string" ? rawDeviceId : "";
  if (!DEVICE_ID.test(deviceId)) {
    return { ok: false, status: 400, error: "deviceId required." };
  }
  const deviceHash = sha256(deviceId);

  const outcome = await withTransaction(async (client) => {
    const invite = (
      await client.query(
        `SELECT id, room_id, expires_at, claimed_at, participant_id, device_hash
           FROM room_invites WHERE secret_hash = $1 FOR UPDATE`,
        [sha256(inviteSecret)],
      )
    ).rows[0] as
      | {
          id: string;
          room_id: string;
          expires_at: Date;
          claimed_at: Date | null;
          participant_id: string | null;
          device_hash: string | null;
        }
      | undefined;
    if (!invite) return { kind: "unknown" as const };

    if (invite.claimed_at && invite.participant_id) {
      if (invite.device_hash !== deviceHash) return { kind: "in_use" as const };
      const participant = (
        await client.query(
          "SELECT id, room_id, display_name, role, ready_state FROM participants WHERE id = $1",
          [invite.participant_id],
        )
      ).rows[0] as
        | { id: string; room_id: string; display_name: string; role: string; ready_state: string }
        | undefined;
      if (!participant) return { kind: "unknown" as const };
      const token = randomBytes(32).toString("hex");
      await client.query(
        "INSERT INTO participant_tokens (token_hash, participant_id) VALUES ($1, $2)",
        [sha256(token), participant.id],
      );
      return { kind: "returning" as const, token, participant };
    }

    if (invite.expires_at.getTime() <= Date.now()) return { kind: "expired" as const };

    const room = (
      await client.query("SELECT phase, revision FROM rooms WHERE id = $1 FOR UPDATE", [
        invite.room_id,
      ])
    ).rows[0] as { phase: string; revision: number } | undefined;
    if (!room) return { kind: "unknown" as const };

    const size = (await client.query("SELECT count(*)::int AS n FROM participants WHERE room_id = $1", [invite.room_id])).rows[0].n as number;
    if (size >= 24) return { kind: "full" as const };

    const participantId = `p_${randomBytes(4).toString("hex")}`;
    await client.query(
      "INSERT INTO participants (id, room_id, display_name, role) VALUES ($1, $2, $3, 'member')",
      [participantId, invite.room_id, displayName],
    );
    await client.query(
      `UPDATE room_invites
          SET claimed_at = now(), participant_id = $2, device_hash = $3
        WHERE id = $1`,
      [invite.id, participantId, deviceHash],
    );

    const revision = Number(room.revision) + 1;
    await client.query(
      `INSERT INTO events (room_id, revision, type, actor_id, visibility, payload)
       VALUES ($1, $2, 'participant_joined', $3, 'shared', $4)`,
      [invite.room_id, revision, participantId, JSON.stringify({ actorName: displayName })],
    );
    // The machine already knew this transition; nothing reached it until now.
    const phase = isPhase(room.phase)
      ? nextPhase(room.phase, ["participant_joined"])
      : room.phase;
    await client.query("UPDATE rooms SET revision = $2, phase = $3 WHERE id = $1", [
      invite.room_id,
      revision,
      phase,
    ]);

    const token = randomBytes(32).toString("hex");
    await client.query(
      "INSERT INTO participant_tokens (token_hash, participant_id) VALUES ($1, $2)",
      [sha256(token), participantId],
    );
    return {
      kind: "joined" as const,
      token,
      revision,
      participant: {
        id: participantId,
        room_id: invite.room_id,
        display_name: displayName,
        role: "member",
        ready_state: "contributing",
      },
    };
  });

  switch (outcome.kind) {
    case "full":
      return { ok: false, status: 409, error: "room_full" };
    case "unknown":
      return { ok: false, status: 404, error: "unknown_invite" };
    case "expired":
      return { ok: false, status: 410, error: "invite_expired" };
    case "in_use":
      // Names nobody. A stranger with a spent link learns that it is spent.
      return { ok: false, status: 409, error: "invite_in_use" };
    default: {
      const participant: Participant = {
        id: outcome.participant.id,
        roomId: outcome.participant.room_id,
        displayName: outcome.participant.display_name,
        role: outcome.participant.role as Participant["role"],
        readyState: outcome.participant.ready_state as Participant["readyState"],
      };
      if (outcome.kind === "joined") {
        // Everyone already in the room finds out the way they find out
        // about any other change: the room moved to a new revision.
        notifyCommit({
          roomId: participant.roomId,
          revision: outcome.revision,
          storedRevisions: [outcome.revision],
          confirmations: [],
        });
      }
      return {
        ok: true,
        token: outcome.token,
        participant,
        joined: outcome.kind === "joined",
      };
    }
  }
}
