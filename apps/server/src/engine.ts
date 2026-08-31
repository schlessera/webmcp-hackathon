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
  PROTECTED_ATTRIBUTE_KEYS,
  type CommandType,
  type FailureEnvelope,
  type SuccessEnvelope,
  type ToolResult,
} from "@webmcp-hackathon/contracts";
import { withTransaction } from "./db.ts";
import type { Participant } from "./auth.ts";
import { buildDelta } from "./delta.ts";
import { computeEligibility, feasibilityOf, type ScopeState } from "./eligibility.ts";
import { impasseBracket } from "./impasse.ts";
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
  /** Command accepted but its consequence awaits in-page confirmation. */
  staged?: boolean;
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

    // Impasse bracket (NEGOTIATION-PROTOCOL.md §7.2): detect entry into or
    // recovery from an impasse after every eligibility-perturbing command.
    outcome.events.push(...(await impasseBracket(client, actor.roomId, after)));

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
      ...(outcome.staged ? { staged: true } : {}),
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
    case "SetSearchScope":
      return setSearchScope(client, actor, input as never);
    case "ProposeDestination":
      return proposeDestination(client, actor, input as never);
    case "PlanArrival":
      return planArrival(client, actor, input as never);
    case "ResolvePrivateRequest":
      return resolvePrivateRequest(client, actor, input as never);
    case "ConfirmPrivateRequest":
      return confirmPrivateRequest(client, actor, input as never);
    case "ConfirmAgreement":
      return confirmAgreement(client, actor, input as never);
    case "CommitAgreement":
      return commitAgreement(client, actor, input as never);
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

  // Protected-category defaulting (§3.3): accessibility-class needs are
  // forced to hard + locked server-side, whatever the client sent — the
  // council prefers scope changes over relaxing a protected need.
  if (
    cmd.payload?.kind === "attribute" &&
    (PROTECTED_ATTRIBUTE_KEYS as readonly string[]).includes(
      String(cmd.payload.key),
    )
  ) {
    cmd.hardness = "hard";
    cmd.delegation = { mode: "locked" };
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
    `INSERT INTO requirements (id, room_id, owner_id, visibility, hardness, delegation, payload, scope_hint, note, withdrawn, created_at_revision)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, false,
             (SELECT revision + 1 FROM rooms WHERE id = $2))
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
      `SELECT pr.id, pr.candidate_id, pr.status, c.name AS candidate_name FROM proposals pr
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
    await client.query("SELECT revision, phase FROM rooms WHERE id = $1", [
      actor.roomId,
    ])
  ).rows[0];
  // Committed and withdrawn are absorbing (§7.3), and no stance may touch a
  // room already in arrival — a member must not be able to erase a committed
  // destination (audit finding 1). Staged agreements are protected too: the
  // organizer aborts or commits on the page.
  if (room.phase === "arrival") {
    return errorOutcome(
      "phase_unavailable",
      "The destination is committed; stances are closed.",
      "Use plan_arrival and prepare_navigation in the arrival phase.",
    );
  }
  if (proposal.status !== "open" && proposal.status !== "vetoed") {
    return errorOutcome(
      "phase_unavailable",
      `Proposal is ${proposal.status}; stances apply to open or vetoed proposals only.`,
      proposal.status === "staged"
        ? "The agreement is staged: the organizer confirms or aborts it on the page."
        : "Choose an open proposal from get_spatial_context.",
    );
  }
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
    await client.query(
      "UPDATE proposals SET status = 'vetoed' WHERE id = $1 AND status = 'open'",
      [cmd.proposalId],
    );
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

async function setSearchScope(
  client: pg.PoolClient,
  actor: Participant,
  cmd: {
    area?: { kind: "circle"; center: { lat: number; lng: number }; radiusM: number };
    transport?: string[];
  },
): Promise<HandlerOutcome> {
  // v1 POC simplification: only the organizer holds scope authority; a
  // member's scope wish would route through negotiation (not implemented).
  if (actor.role !== "organizer") {
    return errorOutcome(
      "not_authorized",
      "Only the organizer can change the shared search scope in this version.",
      "Ask the organizer, or propose an adjustment during an impasse.",
    );
  }
  if (!cmd.area && !cmd.transport) {
    return errorOutcome(
      "invalid_input",
      "Nothing to change: provide area and/or transport.",
      "Pass an area circle and/or a transport mode list.",
    );
  }
  const room = (
    await client.query("SELECT scope, scope_seq FROM rooms WHERE id = $1", [
      actor.roomId,
    ])
  ).rows[0];
  const previous = (room.scope ?? null) as ScopeState | null;
  const seq = (room.scope_seq as number) + 1;
  const next: ScopeState = {
    scopeId: `scope_${seq}`,
    area: cmd.area ?? previous?.area ?? {
      kind: "circle",
      center: { lat: 0, lng: 0 },
      radiusM: 1000,
    },
    transport: cmd.transport ?? previous?.transport ?? ["walk"],
    category: previous?.category ?? "food",
  };
  await client.query(
    "UPDATE rooms SET scope = $2, scope_seq = $3 WHERE id = $1",
    [actor.roomId, JSON.stringify(next), seq],
  );
  const summary = `${next.area.radiusM} m around the center; ${next.transport.join("/")}`;
  return {
    events: [
      {
        type: "scope_change_proposed",
        actorId: actor.id,
        visibility: "shared",
        payload: { actorName: actor.displayName, scopeId: next.scopeId, summary },
      },
      {
        // Organizer authority: proposed and applied in one step.
        type: "scope_change_applied",
        actorId: actor.id,
        visibility: "shared",
        payload: { actorName: actor.displayName, scopeId: next.scopeId, summary, scope: next },
      },
    ],
    effect: `Search scope is now ${summary}.`,
  };
}

async function proposeDestination(
  client: pg.PoolClient,
  actor: Participant,
  cmd: { candidateId: string },
): Promise<HandlerOutcome> {
  const phase = (
    await client.query("SELECT phase FROM rooms WHERE id = $1", [actor.roomId])
  ).rows[0].phase;
  if (phase === "arrival") {
    return errorOutcome(
      "phase_unavailable",
      "The destination is committed; no new proposals.",
      "Use plan_arrival and prepare_navigation in the arrival phase.",
    );
  }
  const candidate = (
    await client.query(
      "SELECT id, name FROM candidates WHERE id = $1 AND room_id = $2",
      [cmd.candidateId, actor.roomId],
    )
  ).rows[0];
  if (!candidate) {
    return errorOutcome(
      "not_found",
      "Unknown candidateId.",
      "Call get_spatial_context to refresh candidate IDs.",
    );
  }
  const duplicate = (
    await client.query(
      `SELECT id FROM proposals WHERE room_id = $1 AND candidate_id = $2
        AND status IN ('open', 'vetoed', 'staged')`,
      [actor.roomId, cmd.candidateId],
    )
  ).rows[0];
  if (duplicate) {
    return errorOutcome(
      "invalid_input",
      `${candidate.name} already has proposal ${duplicate.id}.`,
      `Respond to proposal ${duplicate.id} instead of creating a duplicate.`,
    );
  }
  const count = (
    await client.query(
      "SELECT count(*)::int AS n FROM proposals WHERE room_id = $1",
      [actor.roomId],
    )
  ).rows[0].n as number;
  const room = (
    await client.query("SELECT revision FROM rooms WHERE id = $1", [actor.roomId])
  ).rows[0];
  // proposals.id is a global PK: scope the deterministic counter by room.
  const id = `prop_${actor.roomId.replace(/^room_/, "")}_${count + 1}`;
  await client.query(
    `INSERT INTO proposals (id, room_id, candidate_id, created_by, created_at_revision, status)
     VALUES ($1, $2, $3, $4, $5, 'open')`,
    [id, actor.roomId, cmd.candidateId, actor.id, room.revision + 1],
  );
  return {
    events: [
      {
        type: "proposal_created",
        actorId: actor.id,
        visibility: "shared",
        payload: {
          actorName: actor.displayName,
          proposalId: id,
          candidateId: cmd.candidateId,
          candidateName: candidate.name,
        },
      },
    ],
    effect: `Proposed ${candidate.name} (${id}).`,
  };
}

async function planArrival(
  client: pg.PoolClient,
  actor: Participant,
  cmd: { mode: "walk" | "bike" | "car"; pickupNote?: string },
): Promise<HandlerOutcome> {
  const room = (
    await client.query("SELECT phase, revision FROM rooms WHERE id = $1", [
      actor.roomId,
    ])
  ).rows[0];
  if (room.phase !== "arrival") {
    return errorOutcome(
      "phase_unavailable",
      `Arrival plans open once a destination is committed (phase is "${room.phase}").`,
      "Reach agreement first; then plan_arrival becomes available.",
    );
  }
  await client.query(
    `INSERT INTO arrival_plans (room_id, participant_id, mode, pickup_note, at_revision)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (room_id, participant_id)
     DO UPDATE SET mode = $3, pickup_note = $4, at_revision = $5`,
    [actor.roomId, actor.id, cmd.mode, cmd.pickupNote ?? null, room.revision + 1],
  );
  return {
    events: [
      {
        // The mode is shared coordination state; the pickup note may carry
        // personal detail and stays out of the event payload (own plan is
        // read back via /api/spatial/context).
        type: "arrival_plan_updated",
        actorId: actor.id,
        visibility: "shared",
        payload: { actorName: actor.displayName, mode: cmd.mode },
      },
    ],
    effect: `Arrival plan recorded (${cmd.mode}).`,
  };
}

interface AdjustmentRow {
  id: string;
  kind: "scope_change" | "requirement_relaxation";
  target: { requirementId?: string; dimension?: string };
  change: { dimension?: string; from?: unknown; to?: unknown };
  projected_gain: { newCandidates: number };
  requires_consent_of: string;
  within_delegated_bound: boolean;
  status: string;
}

async function loadAdjustment(
  client: pg.PoolClient,
  roomId: string,
  requestId: string,
  actorId: string,
): Promise<AdjustmentRow | HandlerOutcome> {
  const row = (
    await client.query(
      "SELECT * FROM adjustments WHERE id = $1 AND room_id = $2",
      [requestId, roomId],
    )
  ).rows[0] as AdjustmentRow | undefined;
  // Same not_found for foreign addressees as for unknown IDs — never confirm
  // a private request exists for someone else (existence oracle).
  if (!row || row.requires_consent_of !== actorId) {
    return errorOutcome(
      "not_found",
      "No private request with that ID is addressed to you.",
      "Check your outstanding list via sync_session.",
    );
  }
  return row;
}

async function resolvePrivateRequest(
  client: pg.PoolClient,
  actor: Participant,
  cmd: { requestId: string; decision: "grant" | "deny" },
): Promise<HandlerOutcome> {
  const adj = await loadAdjustment(client, actor.roomId, cmd.requestId, actor.id);
  if ("events" in adj) return adj;
  if (adj.status !== "proposed" && adj.status !== "staged_grant") {
    return errorOutcome(
      "phase_unavailable",
      `This request is already ${adj.status}.`,
      "Call sync_session for your current outstanding decisions.",
    );
  }

  if (cmd.decision === "deny") {
    await client.query("UPDATE adjustments SET status = 'denied' WHERE id = $1", [
      adj.id,
    ]);
    return {
      events: [resolvedEvent(actor, adj, "denied")],
      effect: "Adjustment declined. Denying is always safe.",
    };
  }

  if (!adj.within_delegated_bound) {
    // Consent beyond the delegated envelope needs the human, on the page.
    await client.query(
      "UPDATE adjustments SET status = 'staged_grant' WHERE id = $1",
      [adj.id],
    );
    return {
      events: [],
      staged: true,
      effect:
        "Grant staged. This exceeds your delegated bound: confirm on the page to apply it.",
    };
  }
  return applyAdjustment(client, actor, adj);
}

async function confirmPrivateRequest(
  client: pg.PoolClient,
  actor: Participant,
  cmd: { requestId: string },
): Promise<HandlerOutcome> {
  const adj = await loadAdjustment(client, actor.roomId, cmd.requestId, actor.id);
  if ("events" in adj) return adj;
  if (adj.status !== "staged_grant") {
    return errorOutcome(
      "phase_unavailable",
      `No staged grant to confirm (request is ${adj.status}).`,
      "Stage a grant first via resolve_private_request.",
    );
  }
  return applyAdjustment(client, actor, adj);
}

async function applyAdjustment(
  client: pg.PoolClient,
  actor: Participant,
  adj: AdjustmentRow,
): Promise<HandlerOutcome> {
  await client.query("UPDATE adjustments SET status = 'granted' WHERE id = $1", [
    adj.id,
  ]);
  const events: AppendedEvent[] = [];

  if (adj.kind === "scope_change") {
    const room = (
      await client.query("SELECT scope, scope_seq FROM rooms WHERE id = $1", [
        actor.roomId,
      ])
    ).rows[0];
    const previous = room.scope as ScopeState | null;
    if (!previous) {
      return errorOutcome(
        "invalid_input",
        "No scope to adjust.",
        "The room has no search scope; set one via set_search_scope.",
      );
    }
    const seq = (room.scope_seq as number) + 1;
    const next: ScopeState = {
      ...previous,
      scopeId: `scope_${seq}`,
      area: { ...previous.area, radiusM: Number(adj.change.to) },
    };
    await client.query(
      "UPDATE rooms SET scope = $2, scope_seq = $3 WHERE id = $1",
      [actor.roomId, JSON.stringify(next), seq],
    );
    events.push({
      type: "scope_change_applied",
      actorId: null,
      visibility: "shared",
      payload: {
        scopeId: next.scopeId,
        summary: `${next.area.radiusM} m around the center; ${next.transport.join("/")}`,
        scope: next,
      },
    });
  } else {
    const requirementId = adj.target.requirementId!;
    const req = (
      await client.query(
        "SELECT owner_id, payload, visibility FROM requirements WHERE id = $1 AND room_id = $2 AND NOT withdrawn",
        [requirementId, actor.roomId],
      )
    ).rows[0];
    if (!req) {
      return errorOutcome(
        "not_found",
        "The target requirement no longer exists.",
        "Call sync_session; the impasse may already be resolved.",
      );
    }
    if (adj.change.dimension === "per_person_eur") {
      const payload = req.payload as { perPersonMax: { amount: number } };
      payload.perPersonMax.amount = Number(adj.change.to);
      await client.query("UPDATE requirements SET payload = $2 WHERE id = $1", [
        requirementId,
        JSON.stringify(payload),
      ]);
    } else {
      // Exclusion relaxation: the requirement is dropped entirely.
      await client.query(
        "UPDATE requirements SET withdrawn = true WHERE id = $1",
        [requirementId],
      );
    }
    events.push({
      type: "requirement_relaxed",
      actorId: actor.id,
      visibility: req.visibility,
      payload: {
        actorName: actor.displayName,
        requirementId,
        change: adj.change,
      },
    });
  }

  events.push(resolvedEvent(actor, adj, "granted"));
  return {
    events,
    effect: `Adjustment applied: ${describeChange(adj)}.`,
  };
}

function resolvedEvent(
  actor: Participant,
  adj: AdjustmentRow,
  decision: "granted" | "denied",
): AppendedEvent {
  return {
    type: "adjustment_resolved",
    actorId: actor.id,
    visibility: "application-private",
    payload: {
      actorName: actor.displayName,
      targetParticipantId: actor.id,
      adjustmentId: adj.id,
      kind: adj.kind,
      decision,
      // For peers the projection collapses this to an ownerless aggregate;
      // the gain number is safe to publish.
      newCandidates: adj.projected_gain?.newCandidates ?? 0,
    },
  };
}

function describeChange(adj: AdjustmentRow): string {
  if (adj.kind === "scope_change") {
    return `search radius ${adj.change.from} m -> ${adj.change.to} m`;
  }
  if (adj.change.dimension === "per_person_eur") {
    return `budget ${adj.change.from} -> ${adj.change.to} EUR`;
  }
  return "requirement relaxed";
}

/** Shared §3.7 precondition check for staging and committing agreement. */
async function agreementBlockers(
  client: pg.PoolClient,
  roomId: string,
  proposalId: string,
): Promise<string | null> {
  const participants = (
    await client.query(
      "SELECT id, ready_state FROM participants WHERE room_id = $1",
      [roomId],
    )
  ).rows as Array<{ id: string; ready_state: string }>;
  const notReady = participants.filter((p) => p.ready_state !== "ready");
  if (notReady.length > 0) {
    return `${notReady.length} participant${notReady.length === 1 ? " is" : "s are"} not ready yet`;
  }
  const stances = (
    await client.query(
      "SELECT participant_id, disposition FROM stances WHERE room_id = $1 AND proposal_id = $2",
      [roomId, proposalId],
    )
  ).rows as Array<{ participant_id: string; disposition: string }>;
  const byParticipant = new Map(stances.map((s) => [s.participant_id, s.disposition]));
  if (stances.some((s) => s.disposition === "reject")) {
    return "a standing veto blocks this proposal";
  }
  if (stances.some((s) => s.disposition === "conditionally_accept")) {
    return "conditional acceptances must be resolved by re-stancing before commit";
  }
  const missing = participants.filter((p) => {
    const d = byParticipant.get(p.id);
    return d !== "accept" && d !== "abstain";
  });
  if (missing.length > 0) {
    return `${missing.length} participant${missing.length === 1 ? " has" : "s have"} not accepted or abstained`;
  }
  return null;
}

async function confirmAgreement(
  client: pg.PoolClient,
  actor: Participant,
  cmd: { proposalId: string },
): Promise<HandlerOutcome> {
  if (actor.role !== "organizer") {
    return errorOutcome(
      "not_authorized",
      "Only the organizer can stage the agreement.",
      "Set your stance and ready state; the organizer commits.",
    );
  }
  const phase = (
    await client.query("SELECT phase FROM rooms WHERE id = $1", [actor.roomId])
  ).rows[0].phase;
  if (phase === "arrival") {
    return errorOutcome(
      "phase_unavailable",
      "A destination is already committed.",
      "Use plan_arrival and prepare_navigation in the arrival phase.",
    );
  }
  const proposal = (
    await client.query(
      `SELECT pr.id, pr.status, c.name AS candidate_name FROM proposals pr
        LEFT JOIN candidates c ON c.id = pr.candidate_id
       WHERE pr.id = $1 AND pr.room_id = $2`,
      [cmd.proposalId, actor.roomId],
    )
  ).rows[0];
  if (!proposal) {
    return errorOutcome("not_found", "Unknown proposalId.", "Call sync_session to refresh IDs.");
  }
  if (proposal.status !== "open") {
    return errorOutcome(
      "phase_unavailable",
      `Proposal is ${proposal.status}, not open.`,
      proposal.status === "staged"
        ? "Already staged: the organizer confirms the commit on the page."
        : "Choose an open proposal.",
    );
  }
  const blocker = await agreementBlockers(client, actor.roomId, cmd.proposalId);
  if (blocker) {
    return errorOutcome(
      "consent_required",
      `Cannot stage agreement: ${blocker}.`,
      "Every participant must be ready with an accept or abstain stance and no standing veto.",
    );
  }
  await client.query("UPDATE proposals SET status = 'staged' WHERE id = $1", [
    cmd.proposalId,
  ]);
  return {
    events: [
      {
        type: "agreement_staged",
        actorId: actor.id,
        visibility: "shared",
        payload: {
          actorName: actor.displayName,
          proposalId: cmd.proposalId,
          candidateName: proposal.candidate_name,
        },
      },
    ],
    staged: true,
    effect: `Agreement on ${proposal.candidate_name} staged. The organizer confirms on the page.`,
  };
}

async function commitAgreement(
  client: pg.PoolClient,
  actor: Participant,
  cmd: { proposalId: string },
): Promise<HandlerOutcome> {
  if (actor.role !== "organizer") {
    return errorOutcome(
      "not_authorized",
      "Only the organizer can commit the agreement.",
      "Set your stance and ready state; the organizer commits.",
    );
  }
  const room = (
    await client.query("SELECT revision, phase FROM rooms WHERE id = $1", [
      actor.roomId,
    ])
  ).rows[0];
  // A committed room commits nothing further: single active agreement.
  if (room.phase === "arrival") {
    return errorOutcome(
      "phase_unavailable",
      "A destination is already committed.",
      "Use plan_arrival and prepare_navigation in the arrival phase.",
    );
  }
  const proposal = (
    await client.query(
      `SELECT pr.id, pr.status, pr.candidate_id, c.name AS candidate_name FROM proposals pr
        LEFT JOIN candidates c ON c.id = pr.candidate_id
       WHERE pr.id = $1 AND pr.room_id = $2`,
      [cmd.proposalId, actor.roomId],
    )
  ).rows[0];
  if (!proposal) {
    return errorOutcome("not_found", "Unknown proposalId.", "Call sync_session to refresh IDs.");
  }
  if (proposal.status !== "staged") {
    return errorOutcome(
      "phase_unavailable",
      `Proposal is ${proposal.status}, not staged.`,
      "Stage via confirm_agreement first.",
    );
  }
  // Invariant 4: the precondition must hold at commit revision too, not only
  // at staging — a stance may have changed in between. The abort is a
  // SUCCESSFUL state transition (rolling it back would restore 'staged' and
  // wedge the room), reported as an event.
  const blocker = await agreementBlockers(client, actor.roomId, cmd.proposalId);
  if (blocker) {
    await client.query("UPDATE proposals SET status = 'open' WHERE id = $1", [
      cmd.proposalId,
    ]);
    return {
      events: [
        {
          type: "agreement_stage_aborted",
          actorId: actor.id,
          visibility: "shared",
          payload: {
            actorName: actor.displayName,
            proposalId: cmd.proposalId,
            candidateName: proposal.candidate_name,
            blocker,
          },
        },
      ],
      effect: `Stage aborted: ${blocker}. The proposal is open again.`,
    };
  }
  await client.query(
    "UPDATE proposals SET status = 'committed', committed_at_revision = $2 WHERE id = $1",
    [cmd.proposalId, room.revision + 1],
  );
  // Retire every competing proposal: exactly one destination survives commit.
  const retired = await client.query(
    `UPDATE proposals SET status = 'withdrawn'
      WHERE room_id = $1 AND id <> $2 AND status IN ('open', 'vetoed', 'staged')`,
    [actor.roomId, cmd.proposalId],
  );
  await client.query("UPDATE rooms SET phase = 'arrival' WHERE id = $1", [
    actor.roomId,
  ]);
  const events: AppendedEvent[] = [
    {
      type: "agreement_committed",
      actorId: actor.id,
      visibility: "shared",
      payload: {
        actorName: actor.displayName,
        proposalId: cmd.proposalId,
        candidateId: proposal.candidate_id,
        candidateName: proposal.candidate_name,
        committedAtRevision: room.revision + 1,
      },
    },
    {
      type: "phase_changed",
      actorId: null,
      visibility: "shared",
      payload: { phase: "arrival" },
    },
  ];
  if ((retired.rowCount ?? 0) > 0) {
    events.push({
      type: "proposal_withdrawn",
      actorId: null,
      visibility: "shared",
      payload: { count: retired.rowCount },
    });
  }
  return {
    events,
    effect: `Agreement committed: ${proposal.candidate_name}. Arrival phase open.`,
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
