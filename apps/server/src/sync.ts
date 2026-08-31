import {
  BUDGETS,
  CAPABILITY_MANIFEST,
  TOOL_CONTRACT_VERSION,
  type SyncSessionResponse,
} from "@webmcp-hackathon/contracts";
import { withTransaction } from "./db.ts";
import type { Participant } from "./auth.ts";
import { buildDelta } from "./delta.ts";
import { computeEligibility, feasibilityOf } from "./eligibility.ts";
import { outstandingFor } from "./outstanding.ts";
import { config } from "./config.ts";

/**
 * sync_session — NEGOTIATION-PROTOCOL.md §6.1. Read-only; no baseRevision.
 * Without sinceRevision: first-connection result with the capability manifest.
 * With sinceRevision: delta + brief + outstanding.
 */
export async function syncSession(
  actor: Participant,
  sinceRevision?: number,
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

  const eligibilityRows = await computeEligibility(client, actor.roomId);
  const feasibility = feasibilityOf(eligibilityRows);
  const outstanding = await outstandingFor(client, actor.roomId, actor.id);

  const firstConnection = sinceRevision === undefined;
  const delta = firstConnection
    ? undefined
    : await buildDelta(client, actor.roomId, actor.id, sinceRevision);

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
    "UPDATE participants SET last_synced_revision = $2 WHERE id = $1",
    [actor.id, room.revision],
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
  };
  });
}
