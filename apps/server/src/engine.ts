import { randomUUID } from "node:crypto";
import AjvModule, { type ValidateFunction } from "ajv";
import addFormatsModule from "ajv-formats";

// CJS/ESM interop: ajv publishes CJS; under Node ESM the class may sit on
// .default depending on the loader.
const Ajv = ((AjvModule as never as { default?: unknown }).default ??
  AjvModule) as typeof AjvModule.default;
const addFormats = ((addFormatsModule as never as { default?: unknown })
  .default ?? addFormatsModule) as typeof addFormatsModule.default;
import type pg from "pg";
import {
  COMMAND_SCHEMAS,
  type CommandType,
  type FailureEnvelope,
  type SuccessEnvelope,
  type ToolResult,
} from "@webmcp-hackathon/contracts";
import { withTransaction } from "./db.ts";
import type { Participant } from "./auth.ts";
import { buildDelta } from "./delta.ts";
import { computeEligibility, feasibilityOf } from "./eligibility.ts";
import { outstandingFor } from "./outstanding.ts";

/**
 * The single command bus (INTERACTION-AND-BINDING.md §1 rule 4): UI gestures
 * and WebMCP tool callbacks both land here via POST /api/commands. Every
 * mutation carries baseRevision; stale mutations are ALWAYS rejected with
 * sync_required + delta (spike resolution of the §6.2 rebase question).
 */

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
const validators = new Map<CommandType, ValidateFunction>(
  (Object.entries(COMMAND_SCHEMAS) as [CommandType, object][]).map(
    ([type, schema]) => [type, ajv.compile(schema)],
  ),
);

export interface CommitNotification {
  roomId: string;
  revision: number;
  storedRevisions: number[];
}
type CommitListener = (n: CommitNotification) => void;
const listeners: CommitListener[] = [];
export function onCommit(listener: CommitListener): void {
  listeners.push(listener);
}

interface AppendedEvent {
  type: string;
  actorId: string | null;
  visibility: string;
  payload: Record<string, unknown>;
}

interface HandlerOutcome {
  events: AppendedEvent[];
  effect: string;
  error?: FailureEnvelope;
}

/** Thrown inside the command transaction so failures ROLL BACK any writes a
 * handler made before erroring, instead of silently committing them. */
class CommandFailure extends Error {
  envelope: FailureEnvelope & { delta?: unknown };
  constructor(envelope: FailureEnvelope & { delta?: unknown }) {
    super(envelope.error.message);
    this.envelope = envelope;
  }
}

export async function submitCommand(
  actor: Participant,
  type: string,
  input: unknown,
): Promise<ToolResult> {
  if (!validators.has(type as CommandType)) {
    return failure("invalid_input", `Unknown command type "${type}".`,
      `Use one of: ${[...validators.keys()].join(", ")}.`);
  }
  const validate = validators.get(type as CommandType)!;
  if (!validate(input)) {
    const first = validate.errors?.[0];
    const field = first?.instancePath?.replace(/^\//, "") || first?.params?.additionalProperty || "input";
    return failure(
      "invalid_input",
      `Invalid ${String(field)}: ${first?.message ?? "validation failed"}.`,
      "Correct the named field to the documented closed value set and retry.",
    );
  }
  const cmd = input as { baseRevision: number };

  let result;
  try {
    result = await withTransaction(async (client) => {
    const room = (
      await client.query(
        "SELECT revision, phase FROM rooms WHERE id = $1 FOR UPDATE",
        [actor.roomId],
      )
    ).rows[0];
    if (!room) {
      throw new CommandFailure(
        failure("not_found", "Session not found.", "Call sync_session to refresh."),
      );
    }
    const current: number = room.revision;

    if (cmd.baseRevision !== current) {
      const delta = await buildDelta(client, actor.roomId, actor.id, cmd.baseRevision);
      throw new CommandFailure({
        ok: false as const,
        error: {
          code: "sync_required" as const,
          message: `Session moved from revision ${cmd.baseRevision} to ${current}.`,
          recovery: `Review the delta, then retry with baseRevision ${current}.`,
        },
        delta,
      });
    }

    const before = await computeEligibility(client, actor.roomId);
    const outcome = await dispatch(client, actor, type as CommandType, input);
    // Rollback, not commit: a handler may have written before discovering the
    // error.
    if (outcome.error) throw new CommandFailure(outcome.error);

    // Append eligibility-shift aggregate event when ANY classification
    // changed (eligible -> uncertain matters as much as -> excluded).
    const after = await computeEligibility(client, actor.roomId);
    const beforeExcluded = before.filter((c) => c.eligibility === "excluded").length;
    const afterExcluded = after.filter((c) => c.eligibility === "excluded").length;
    const eligibleNow = after.filter((c) => c.eligibility === "eligible").length;
    const beforeByCandidate = new Map(before.map((c) => [c.candidateId, c.eligibility]));
    const classificationChanged = after.some(
      (c) => beforeByCandidate.get(c.candidateId) !== c.eligibility,
    );
    if (classificationChanged) {
      outcome.events.push({
        type: "candidates_updated",
        actorId: null,
        visibility: "shared",
        payload: {
          newlyExcluded: Math.max(0, afterExcluded - beforeExcluded),
          eligible: eligibleNow,
        },
      });
    }

    let revision = current;
    const storedRevisions: number[] = [];
    for (const event of outcome.events) {
      revision += 1;
      storedRevisions.push(revision);
      await client.query(
        `INSERT INTO events (room_id, revision, type, actor_id, visibility, payload)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [actor.roomId, revision, event.type, event.actorId, event.visibility, event.payload],
      );
    }
    await client.query("UPDATE rooms SET revision = $2 WHERE id = $1", [
      actor.roomId,
      revision,
    ]);

    const outstanding = await outstandingFor(client, actor.roomId, actor.id);
    const feasibility = feasibilityOf(after);
    const success: SuccessEnvelope = {
      ok: true,
      revision,
      effect: `${outcome.effect} ${feasibility.eligible} candidate${feasibility.eligible === 1 ? "" : "s"} eligible.`.slice(0, 200),
      outstanding,
    };
    return { success, storedRevisions, revision };
    });
  } catch (err) {
    if (err instanceof CommandFailure) {
      return err.envelope as ToolResult;
    }
    throw err;
  }

  // WebSocket notifications only after the transaction commits (Gate 4).
  // A listener failure must never fail the committed command.
  for (const listener of listeners) {
    try {
      listener({
        roomId: actor.roomId,
        revision: result.revision,
        storedRevisions: result.storedRevisions,
      });
    } catch (err) {
      console.error("commit listener failed:", err);
    }
  }
  return result.success;
}

async function dispatch(
  client: pg.PoolClient,
  actor: Participant,
  type: CommandType,
  input: unknown,
): Promise<HandlerOutcome> {
  switch (type) {
    case "SubmitRequirement":
      return submitRequirement(client, actor, input as never);
    case "WithdrawRequirement":
      return withdrawRequirement(client, actor, input as never);
    case "EvaluateCandidates":
      return evaluateCandidates(client, actor, input as never);
    case "RespondToProposal":
      return respondToProposal(client, actor, input as never);
    case "SetReadyState":
      return setReadyState(client, actor, input as never);
  }
}

interface SubmitRequirementCmd {
  requirementId?: string;
  visibility: "shared" | "application-private" | "agent-private";
  hardness: "hard" | "soft";
  delegation: { mode: string; bound?: unknown };
  payload?: Record<string, unknown>;
  scopeHint?: Record<string, unknown>;
  note?: string;
}

async function submitRequirement(
  client: pg.PoolClient,
  actor: Participant,
  cmd: SubmitRequirementCmd,
): Promise<HandlerOutcome> {
  const agentPrivate = cmd.visibility === "agent-private";
  if (agentPrivate && (cmd.payload || cmd.note)) {
    // Declarations are content-free: neither payload nor free-text note may
    // reach server storage (invariant 5).
    return errorOutcome(
      "invalid_input",
      "agent-private requirements carry no payload or note.",
      "Submit a declaration only: omit payload and note; content stays in your context.",
    );
  }
  if (!agentPrivate && !cmd.payload) {
    return errorOutcome(
      "invalid_input",
      `payload is required for ${cmd.visibility} requirements.`,
      "Provide a domain payload (attribute, scope, budget, or exclusion).",
    );
  }

  const id = cmd.requirementId ?? `req_${randomUUID().slice(0, 8)}`;
  // IDs are globally unique but caller-controlled: the lookup is deliberately
  // NOT room-filtered, so an ID owned by another room/participant can never be
  // hijacked through the upsert. The generic error leaks nothing about the
  // colliding requirement.
  const existing = (
    await client.query("SELECT owner_id, room_id FROM requirements WHERE id = $1", [id])
  ).rows[0];
  // not_found, not not_authorized: an authorization error would confirm the
  // ID exists somewhere (existence oracle — §3 "never leaks target's
  // existence details").
  if (existing && (existing.owner_id !== actor.id || existing.room_id !== actor.roomId)) {
    return errorOutcome(
      "not_found",
      "Unknown requirementId.",
      "Submit without requirementId to create a new requirement, or call sync_session to refresh IDs.",
    );
  }

  const upserted = await client.query(
    `INSERT INTO requirements (id, room_id, owner_id, visibility, hardness, delegation, payload, scope_hint, note, withdrawn)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, false)
     ON CONFLICT (id) DO UPDATE SET visibility = $4, hardness = $5,
       delegation = $6, payload = $7, scope_hint = $8, note = $9, withdrawn = false
     WHERE requirements.room_id = $2 AND requirements.owner_id = $3`,
    [
      id,
      actor.roomId,
      actor.id,
      cmd.visibility,
      cmd.hardness,
      JSON.stringify(cmd.delegation),
      agentPrivate ? null : JSON.stringify(cmd.payload),
      cmd.scopeHint ? JSON.stringify(cmd.scopeHint) : null,
      cmd.note ?? null,
    ],
  );
  if (upserted.rowCount === 0) {
    // Concurrent cross-room ID collision hit the guarded ON CONFLICT clause.
    return errorOutcome(
      "not_found",
      "Unknown requirementId.",
      "Submit without requirementId to create a new requirement.",
    );
  }

  const events: AppendedEvent[] = [];
  if (agentPrivate) {
    events.push({
      type: "private_requirement_declared",
      actorId: actor.id,
      visibility: "agent-private",
      payload: {
        actorName: actor.displayName,
        requirementId: id,
        hardness: cmd.hardness,
        ...(cmd.scopeHint ? { scopeHint: cmd.scopeHint } : {}),
      },
    });
    // The hidden constraint may have changed: verdicts recorded against the
    // previous declaration are no longer trustworthy. Clear and re-screen.
    await client.query(
      "DELETE FROM verdicts WHERE room_id = $1 AND owner_id = $2",
      [actor.roomId, actor.id],
    );
    // Council reaction: affected candidates are uncertain; ask the owner's
    // agent to screen (batched <= 10).
    const pending = (
      await client.query(
        `SELECT c.id FROM candidates c
          LEFT JOIN verdicts v ON v.room_id = c.room_id
           AND v.candidate_id = c.id AND v.owner_id = $2
         WHERE c.room_id = $1 AND v.verdict IS NULL ORDER BY c.id LIMIT 10`,
        [actor.roomId, actor.id],
      )
    ).rows.map((r) => r.id);
    if (pending.length > 0) {
      events.push({
        type: "evaluation_requested",
        actorId: null,
        visibility: "application-private",
        payload: { targetParticipantId: actor.id, candidateIds: pending },
      });
    }
    return { events, effect: "Private requirement declared; screening requested." };
  }

  events.push({
    type: existing ? "requirement_updated" : "requirement_submitted",
    actorId: actor.id,
    visibility: cmd.visibility,
    payload: {
      actorName: actor.displayName,
      requirementId: id,
      visibility: cmd.visibility,
      hardness: cmd.hardness,
      summary: summarizePayload(cmd.payload!),
      payload: cmd.payload,
      ...(cmd.note ? { note: cmd.note } : {}),
    },
  });
  return {
    events,
    effect: `Requirement ${existing ? "updated" : "recorded"}.`,
  };
}

async function withdrawRequirement(
  client: pg.PoolClient,
  actor: Participant,
  cmd: { requirementId: string },
): Promise<HandlerOutcome> {
  const row = (
    await client.query(
      "SELECT owner_id, visibility FROM requirements WHERE id = $1 AND room_id = $2 AND NOT withdrawn",
      [cmd.requirementId, actor.roomId],
    )
  ).rows[0];
  if (!row) {
    return errorOutcome(
      "not_found",
      "Unknown requirementId.",
      "Call sync_session to refresh IDs.",
    );
  }
  if (row.owner_id !== actor.id) {
    // Same not_found as an unknown ID — never confirm a foreign requirement
    // exists (existence oracle).
    return errorOutcome(
      "not_found",
      "Unknown requirementId.",
      "Call sync_session to refresh IDs.",
    );
  }
  await client.query("UPDATE requirements SET withdrawn = true WHERE id = $1", [
    cmd.requirementId,
  ]);
  return {
    events: [
      {
        type: "requirement_withdrawn",
        actorId: actor.id,
        visibility: row.visibility,
        payload: { actorName: actor.displayName, requirementId: cmd.requirementId },
      },
    ],
    effect: "Requirement withdrawn.",
  };
}

async function evaluateCandidates(
  client: pg.PoolClient,
  actor: Participant,
  cmd: { verdicts: Array<{ candidateId: string; verdict: string; infoNeeded?: string }> },
): Promise<HandlerOutcome> {
  const declared = (
    await client.query(
      `SELECT 1 FROM requirements WHERE room_id = $1 AND owner_id = $2
        AND visibility = 'agent-private' AND NOT withdrawn LIMIT 1`,
      [actor.roomId, actor.id],
    )
  ).rowCount;
  if (!declared) {
    return errorOutcome(
      "not_authorized",
      "No agent-private declaration on record for you.",
      "Declare an agent-private requirement first; screening verdicts fold into it.",
    );
  }
  const known = new Set(
    (
      await client.query("SELECT id FROM candidates WHERE room_id = $1", [
        actor.roomId,
      ])
    ).rows.map((r) => r.id as string),
  );
  const unknown = cmd.verdicts.find((v) => !known.has(v.candidateId));
  if (unknown) {
    return errorOutcome(
      "not_found",
      `Unknown candidateId "${unknown.candidateId}".`,
      "Call sync_session or get_spatial_context to refresh candidate IDs.",
    );
  }
  const room = (
    await client.query("SELECT revision FROM rooms WHERE id = $1", [actor.roomId])
  ).rows[0];
  for (const v of cmd.verdicts) {
    await client.query(
      `INSERT INTO verdicts (room_id, owner_id, candidate_id, verdict, info_needed, recorded_at_revision)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (room_id, owner_id, candidate_id)
       DO UPDATE SET verdict = $4, info_needed = $5, recorded_at_revision = $6`,
      [actor.roomId, actor.id, v.candidateId, v.verdict, v.infoNeeded ?? null, room.revision + 1],
    );
  }
  return {
    events: [
      {
        // Disposition-only recording: verdict payloads never name a reason.
        type: "evaluation_recorded",
        actorId: actor.id,
        visibility: "agent-private",
        payload: { actorName: actor.displayName, verdictCount: cmd.verdicts.length },
      },
    ],
    effect: `Recorded ${cmd.verdicts.length} screening verdicts.`,
  };
}

async function respondToProposal(
  client: pg.PoolClient,
  actor: Participant,
  cmd: {
    proposalId: string;
    disposition: string;
    visibility: string;
    reason?: { kind: string; note?: string };
  },
): Promise<HandlerOutcome> {
  if (cmd.visibility === "agent-private" && cmd.reason) {
    // Agent-private stances reach the council disposition-only (§3.5).
    return errorOutcome(
      "invalid_input",
      "agent-private stances are disposition-only.",
      "Omit reason, or use shared/application-private visibility for it.",
    );
  }
  const proposal = (
    await client.query(
      `SELECT pr.id, pr.candidate_id, c.name AS candidate_name FROM proposals pr
        LEFT JOIN candidates c ON c.id = pr.candidate_id
       WHERE pr.id = $1 AND pr.room_id = $2`,
      [cmd.proposalId, actor.roomId],
    )
  ).rows[0];
  if (!proposal) {
    return errorOutcome(
      "not_found",
      "Unknown proposalId.",
      "Call sync_session to refresh IDs.",
    );
  }
  const room = (
    await client.query("SELECT revision FROM rooms WHERE id = $1", [actor.roomId])
  ).rows[0];
  await client.query(
    `INSERT INTO stances (room_id, participant_id, proposal_id, disposition, visibility, reason, at_revision)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (room_id, participant_id, proposal_id)
     DO UPDATE SET disposition = $4, visibility = $5, reason = $6, at_revision = $7`,
    [
      actor.roomId,
      actor.id,
      cmd.proposalId,
      cmd.disposition,
      cmd.visibility,
      cmd.reason ? JSON.stringify(cmd.reason) : null,
      room.revision + 1,
    ],
  );
  if (cmd.disposition === "reject") {
    await client.query("UPDATE proposals SET status = 'vetoed' WHERE id = $1", [
      cmd.proposalId,
    ]);
  } else {
    // A veto blocks only while it stands (§7.3): reopen when no standing
    // reject remains after this stance change.
    await client.query(
      `UPDATE proposals SET status = 'open'
        WHERE id = $1 AND status = 'vetoed' AND NOT EXISTS
          (SELECT 1 FROM stances
            WHERE proposal_id = $1 AND disposition = 'reject')`,
      [cmd.proposalId],
    );
  }
  return {
    events: [
      {
        type: "stance_submitted",
        actorId: actor.id,
        visibility: cmd.visibility,
        payload: {
          actorName: actor.displayName,
          proposalId: cmd.proposalId,
          candidateName: proposal.candidate_name,
          disposition: cmd.disposition,
          ...(cmd.reason?.note && cmd.visibility === "shared"
            ? { note: cmd.reason.note }
            : {}),
        },
      },
    ],
    effect: `Stance "${cmd.disposition}" recorded on ${proposal.candidate_name ?? cmd.proposalId}.`,
  };
}

async function setReadyState(
  client: pg.PoolClient,
  actor: Participant,
  cmd: { state: "contributing" | "ready" },
): Promise<HandlerOutcome> {
  await client.query("UPDATE participants SET ready_state = $2 WHERE id = $1", [
    actor.id,
    cmd.state,
  ]);
  return {
    events: [
      {
        type: "ready_state_changed",
        actorId: actor.id,
        visibility: "shared",
        payload: { actorName: actor.displayName, state: cmd.state },
      },
    ],
    effect: `Ready state set to "${cmd.state}".`,
  };
}

function summarizePayload(payload: Record<string, unknown>): string {
  switch (payload.kind) {
    case "attribute":
      return `requires ${payload.key} = ${payload.expect}`;
    case "scope":
      return `max ${payload.dimension} ${payload.max}`;
    case "budget": {
      const b = payload.perPersonMax as { amount: number; currency: string };
      return `budget <= ${b.amount} ${b.currency} per person`;
    }
    case "exclusion":
      return `excludes ${payload.key}: ${(payload.values as string[]).join(", ")}`;
    default:
      return "requirement";
  }
}

function errorOutcome(
  code: FailureEnvelope["error"]["code"],
  message: string,
  recovery: string,
): HandlerOutcome {
  return { events: [], effect: "", error: failure(code, message, recovery) };
}

function failure(
  code: FailureEnvelope["error"]["code"],
  message: string,
  recovery: string,
): FailureEnvelope {
  return { ok: false, error: { code, message, recovery } };
}
