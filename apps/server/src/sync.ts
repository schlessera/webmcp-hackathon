import {
  BUDGETS,
  CAPABILITY_MANIFEST,
  TOOL_CONTRACT_VERSION,
  type SyncSessionResponse,
} from "@webmcp-hackathon/contracts";
import { withTransaction } from "./db.ts";
import type { Participant } from "./auth.ts";
import { buildDelta, InvalidDeltaCursor } from "./delta.ts";
import { computeEligibility, feasibilityOf } from "./eligibility.ts";
import { outstandingFor } from "./outstanding.ts";
import { presentIn } from "./presence.ts";
import { config } from "./config.ts";

/**
 * sync_session — NEGOTIATION-PROTOCOL.md §6.1. Read-only; no baseRevision.
 * Without sinceRevision: first-connection result with the capability manifest.
 * With sinceRevision: delta + brief + outstanding.
 */
export async function syncSession(
  actor: Participant,
  sinceRevision?: number,
  cursor?: string,
): Promise<SyncSessionResponse> {
  // One consistent snapshot: FOR SHARE on the room row keeps a concurrent
  // command's revision bump (FOR UPDATE) out of the read window, so revision,
  // eligibility, delta, and outstanding all describe the same state.
  return withTransaction(async (client) => {
  const room = (
    await client.query("SELECT revision, phase FROM rooms WHERE id = $1 FOR SHARE", [
      actor.roomId,
    ])
  ).rows[0];
  if (!room) {
    return {
      ok: false,
      error: {
        code: "not_found",
        message: "Session not found.",
        recovery: "Reopen the invitation link.",
      },
    };
  }
  if (sinceRevision !== undefined && sinceRevision > Number(room.revision)) {
    return {
      ok: false,
      error: {
        code: "invalid_input",
        message: `sinceRevision ${sinceRevision} is ahead of room revision ${room.revision}.`,
        recovery: `Use a revision from 0 through ${room.revision}.`,
      },
    };
  }

  const eligibilityRows = await computeEligibility(client, actor.roomId);
  const present = presentIn(actor.roomId);
  const participantRows = (
    await client.query(
      `SELECT id, display_name, role, ready_state, arrived_at, last_synced_revision
         FROM participants
        WHERE room_id = $1 ORDER BY role <> 'organizer', id`,
      [actor.roomId],
    )
  ).rows;
  const participants = participantRows.map((p) => ({
    participantId: p.id as string,
    displayName: p.display_name as string,
    role: p.role as "organizer" | "member",
    readyState: p.ready_state as "contributing" | "ready",
    // This very sync is the caller's arrival.
    arrived: p.id === actor.id || p.arrived_at !== null,
    present: present.has(p.id as string),
  }));
  // Read BEFORE this sync stamps it: it is what the caller had seen. A
  // never-arrived participant has no such revision — 0 would mean "saw the
  // empty room", which is a different fact.
  const self = participantRows.find((p) => p.id === actor.id);
  const lastSyncedRevision =
    self && self.arrived_at !== null ? Number(self.last_synced_revision) : null;
  const feasibility = feasibilityOf(eligibilityRows);
  const outstanding = await outstandingFor(client, actor.roomId, actor.id);

  const firstConnection = sinceRevision === undefined && cursor === undefined;
  let delta;
  try {
    delta = firstConnection
      ? undefined
      : await buildDelta(
          client,
          actor.roomId,
          actor.id,
          sinceRevision,
          cursor,
          Number(room.revision),
        );
  } catch (err) {
    if (!(err instanceof InvalidDeltaCursor)) throw err;
    return {
      ok: false,
      error: {
        code: "invalid_input",
        message: err.message,
        recovery: "Restart catch-up with sinceRevision from your last completed sync.",
      },
    };
  }

  const briefParts = [
    `${feasibility.eligible} candidate${feasibility.eligible === 1 ? "" : "s"} remain eligible.`,
  ];
  if (delta) {
    for (const event of delta.events.slice(0, 3)) briefParts.push(event.text);
  } else {
    briefParts.push(
      `You are ${actor.displayName} (${actor.role}) in phase "${room.phase}".`,
    );
  }
  if (outstanding.length > 0) {
    briefParts.push(
      `${outstanding.length} decision${outstanding.length === 1 ? "" : "s"} pending for you.`,
    );
  }
  const brief = briefParts.join(" ").slice(0, BUDGETS.briefMax);

  await client.query(
    `UPDATE participants
        SET last_synced_revision = $2, arrived_at = COALESCE(arrived_at, now())
      WHERE id = $1`,
    // R1: a truncated page has consumed only throughRevision. Recording the
    // room head here would claim omitted history had been seen.
    [actor.id, delta?.throughRevision ?? room.revision],
  );

  return {
    ok: true,
    revision: room.revision,
    buildId: config.buildId,
    toolContractVersion: TOOL_CONTRACT_VERSION,
    phase: room.phase,
    identity: {
      participantId: actor.id,
      displayName: actor.displayName,
      role: actor.role,
    },
    ...(firstConnection ? { manifest: CAPABILITY_MANIFEST } : {}),
    feasibility,
    brief,
    ...(delta ? { delta } : {}),
    outstanding,
    participants,
    lastSyncedRevision,
  };
  });
}
