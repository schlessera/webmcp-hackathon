import { randomUUID } from "node:crypto";
import AjvModule, { type ErrorObject, type ValidateFunction } from "ajv";
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
  POOL_CAP,
  PROTECTED_ATTRIBUTE_KEYS,
  areaById,
  type CommandType,
  type FailureEnvelope,
  type SuccessEnvelope,
  type ToolResult,
  type Criterion,
  ATTRIBUTE_LABELS,
  ATTRIBUTE_VOCABULARY,
  criterionFor,
  implies,
  normalizeCuisineTokens,
  parseOpeningHours,
  windowSpanText,
} from "@webmcp-hackathon/contracts";
import { pool, withTransaction } from "./db.ts";
import type { Participant } from "./auth.ts";
import {
  consumeConfirmation,
  mintConfirmation,
  type ConfirmationSubject,
} from "./confirmation.ts";
import { buildDelta } from "./delta.ts";
import { bumpCandidateMapRevisions } from "./candidate-revisions.ts";
import {
  computeEligibility,
  feasibilityOf,
  loadEligibilityInputs,
  type ScopeState,
} from "./eligibility.ts";
import { inScope } from "./facets.ts";
import { lookupNow, lookupTargetOf } from "./enrich/index.ts";
import { impasseBracket } from "./impasse.ts";
import { outstandingFor } from "./outstanding.ts";
import {
  availableCommands,
  isCommandLegal,
  nextPhase,
  type Phase,
} from "./phase.ts";
import {
  candidatesForRefs,
  loadSnapshot,
  type CandidateSeed,
} from "./places.ts";
import { warmEnrichments, type RoomLookupTarget } from "./enrich/index.ts";
import { notifyCommit } from "./commit-notifications.ts";
import {
  insertCandidateSeeds,
  numberCandidateSeeds,
  warmTargetsFor,
} from "./candidate-write.ts";
import { startPoolFill } from "./pool-fill.ts";
import { wakeRefinement } from "./refine/worker.ts";
import { publishFacts } from "./enrich/progress.ts";
export {
  notifyCommit,
  onCommit,
  type CommitNotification,
} from "./commit-notifications.ts";

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

export interface CommandIdempotency {
  key: string;
  requestHash: string;
}

async function storedIdempotencyOutcome(
  q: pg.PoolClient | pg.Pool,
  actorId: string,
  idempotency: CommandIdempotency,
): Promise<ToolResult | null> {
  const row = (
    await q.query(
      `SELECT request_hash, response
         FROM command_idempotency
        WHERE participant_id = $1 AND idempotency_key = $2
          AND expires_at > now()`,
      [actorId, idempotency.key],
    )
  ).rows[0] as { request_hash: string; response: ToolResult } | undefined;
  if (!row) return null;
  return row.request_hash === idempotency.requestHash
    ? row.response
    : failure(
        "invalid_input",
        "Idempotency-Key was already used with a different mutation.",
        "Generate a new key for a different command body.",
      );
}

async function rememberNonMutatingOutcome(
  actorId: string,
  idempotency: CommandIdempotency | undefined,
  outcome: ToolResult,
): Promise<ToolResult> {
  if (!idempotency) return outcome;
  await pool.query(
    `DELETE FROM command_idempotency
      WHERE participant_id = $1 AND idempotency_key = $2
        AND expires_at <= now()`,
    [actorId, idempotency.key],
  );
  const inserted = await pool.query(
    `INSERT INTO command_idempotency
       (participant_id, idempotency_key, request_hash, response, expires_at)
     VALUES ($1, $2, $3, $4, now() + interval '10 minutes')
     ON CONFLICT (participant_id, idempotency_key) DO NOTHING`,
    [actorId, idempotency.key, idempotency.requestHash, outcome],
  );
  if (inserted.rowCount === 1) return outcome;
  return (await storedIdempotencyOutcome(pool, actorId, idempotency)) ?? outcome;
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
  /** Mint a confirmation nonce for this subject once the transaction commits. */
  confirm?: ConfirmationSubject;
  /** Snapshot-backed places to warm only after the transaction commits. */
  warmTargets?: RoomLookupTarget[];
  /** The committed scope changed its circle; resume whole-area filling. */
  poolFill?: boolean;
  error?: FailureEnvelope;
  /** A criterion-bearing need that should start an opportunistic lookup after commit. */
  lookup?: {
    criterion: Criterion;
    label: string;
    visibility: SubmitRequirementCmd["visibility"];
  };
  /** An active criterion changed and the continuous queue must be re-ranked. */
  refine?: boolean;
  /** Presentation refreshes for every room sharing a globally changed ref. */
  factRooms?: Array<{ roomId: string; candidateIds: string[] }>;
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
  idempotency?: CommandIdempotency,
): Promise<ToolResult> {
  if (idempotency) {
    const replay = await storedIdempotencyOutcome(pool, actor.id, idempotency);
    if (replay) return replay;
  }
  if (!validators.has(type as CommandType)) {
    return rememberNonMutatingOutcome(
      actor.id,
      idempotency,
      failure("invalid_input", `Unknown command type "${type}".`,
        `Use one of: ${[...validators.keys()].join(", ")}.`),
    );
  }
  const validate = validators.get(type as CommandType)!;
  if (type === "EvaluateCandidates" && input !== null && typeof input === "object") {
    const verdicts = (input as { verdicts?: unknown }).verdicts;
    const missingInfo = Array.isArray(verdicts) && verdicts.some((verdict) =>
      verdict !== null && typeof verdict === "object" &&
      (verdict as { verdict?: unknown }).verdict === "needs_info" &&
      (typeof (verdict as { infoNeeded?: unknown }).infoNeeded !== "string" ||
        (verdict as { infoNeeded: string }).infoNeeded.length === 0));
    if (missingInfo) {
      return rememberNonMutatingOutcome(
        actor.id,
        idempotency,
        failure(
          "invalid_input",
          "Invalid infoNeeded: needs_info verdicts require a non-empty infoNeeded string.",
          "Name the missing information for every needs_info verdict.",
        ),
      );
    }
  }
  if (!validate(input)) {
    return rememberNonMutatingOutcome(
      actor.id,
      idempotency,
      actionableValidationFailure(input, validate.errors ?? []),
    );
  }
  if (type === "EvaluateCandidates") {
    const verdicts = (input as { verdicts: Array<{ candidateId: string }> }).verdicts;
    const seen = new Set<string>();
    const duplicate = verdicts.find(({ candidateId }) => {
      if (seen.has(candidateId)) return true;
      seen.add(candidateId);
      return false;
    });
    if (duplicate) {
      return rememberNonMutatingOutcome(
        actor.id,
        idempotency,
        failure(
          "invalid_input",
          `Duplicate verdict candidateId ${JSON.stringify(duplicate.candidateId)}.`,
          "Send at most one verdict for each candidateId.",
        ),
      );
    }
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
    const phase = room.phase as Phase;

    if (idempotency) {
      const replay = await storedIdempotencyOutcome(client, actor.id, idempotency);
      if (replay) {
        return {
          success: replay,
          storedRevisions: [],
          revision: replay.ok ? replay.revision : current,
          replayed: true as const,
        };
      }
      // An expired row must stop owning the primary key before this request
      // records its fresh outcome.
      await client.query(
        `DELETE FROM command_idempotency
          WHERE participant_id = $1 AND idempotency_key = $2
            AND expires_at <= now()`,
        [actor.id, idempotency.key],
      );
    }

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

    // Phase gating (NEGOTIATION-PROTOCOL.md §7.1) ahead of every handler, so
    // no handler carries its own copy of the rule. After the revision check,
    // not before: a stale caller needs the delta — phase_unavailable carries
    // none, and reading the delta is how it learns the phase moved.
    if (!isCommandLegal(type as CommandType, phase)) {
      throw new CommandFailure(
        failure(
          "phase_unavailable",
          `${type} is not available while the session is in phase "${phase}".`,
          `Available now: ${availableCommands(phase).join(", ")}.`,
        ),
      );
    }

    const before = await computeEligibility(client, actor.roomId);
    const outcome = await dispatch(client, actor, type as CommandType, input);
    // Rollback, not commit: a handler may have written before discovering the
    // error.
    if (outcome.error) throw new CommandFailure(outcome.error);

    // Append eligibility-shift aggregate event when ANY classification
    // changed (eligible -> uncertain matters as much as -> excluded).
    const after = await computeEligibility(client, actor.roomId);
    const eligibleNow = after.filter((c) => c.eligibility === "eligible").length;
    const beforeByCandidate = new Map(before.map((c) => [c.candidateId, c.eligibility]));
    const newlyExcluded = after.filter(
      (c) =>
        c.eligibility === "excluded" &&
        beforeByCandidate.has(c.candidateId) &&
        beforeByCandidate.get(c.candidateId) !== "excluded",
    ).length;
    const classificationChanged = after.some(
      (c) => beforeByCandidate.get(c.candidateId) !== c.eligibility,
    );
    if (classificationChanged) {
      outcome.events.push({
        type: "candidates_updated",
        actorId: null,
        visibility: "shared",
        payload: {
          newlyExcluded,
          eligible: eligibleNow,
        },
      });
    }

    // Impasse bracket (NEGOTIATION-PROTOCOL.md §7.2): detect entry into or
    // recovery from an impasse after every eligibility-perturbing command.
    outcome.events.push(...(await impasseBracket(client, actor.roomId, after)));

    // Phase transition last: it folds over everything this command produced,
    // impasse-bracket events included.
    const derivedPhase = nextPhase(phase, outcome.events.map((e) => e.type));
    if (derivedPhase !== phase) {
      await client.query("UPDATE rooms SET phase = $2 WHERE id = $1", [
        actor.roomId,
        derivedPhase,
      ]);
      outcome.events.push({
        type: "phase_changed",
        actorId: null,
        visibility: "shared",
        payload: { phase: derivedPhase, previousPhase: phase },
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
      ...(outcome.staged ? { staged: true } : {}),
      outstanding,
    };
    if (idempotency) {
      // R6: stored in the same transaction as the mutation. Once the command
      // is durable, its replay record is durable too; ambiguous HTTP delivery
      // cannot create a second event sequence during the ten-minute window.
      await client.query(
        `INSERT INTO command_idempotency
           (participant_id, idempotency_key, request_hash, response, expires_at)
         VALUES ($1, $2, $3, $4, now() + interval '10 minutes')`,
        [actor.id, idempotency.key, idempotency.requestHash, success],
      );
    }
    return {
      success,
      storedRevisions,
      revision,
      confirm: outcome.confirm,
      lookup: outcome.lookup,
      refine: outcome.refine ?? false,
      warmTargets: outcome.warmTargets ?? [],
      poolFill: outcome.poolFill ?? false,
      factRooms: outcome.factRooms ?? [],
      replayed: false as const,
    };
    });
  } catch (err) {
    if (err instanceof CommandFailure) {
      // R6: failures mutate nothing because the transaction rolled back, so
      // they can be recorded immediately afterward and replayed exactly too.
      return rememberNonMutatingOutcome(
        actor.id,
        idempotency,
        err.envelope as ToolResult,
      );
    }
    // R17: database and programming failures must not escape the shared tool
    // envelope. withTransaction has already rolled back, so retry may succeed.
    console.error("command engine failed:", err);
    return failure(
      "temporarily_unavailable",
      "The command could not be completed.",
      "Sync the room to check the outcome before deciding whether to try again.",
    );
  }

  // A replay returns the byte-equivalent domain outcome and deliberately has
  // no second notification or nonce: it did not commit a second mutation.
  if (result.replayed) return result.success;

  // Mint only after the write is durable, so a rolled-back stage leaves no
  // usable nonce behind. The grant rides the commit notification to the
  // realtime channel and is deliberately absent from `result.success`, which
  // is what a WebMCP tool result carries back to an agent.
  const confirmations = result.confirm
    ? [
        {
          participantId: actor.id,
          ...mintConfirmation(actor.roomId, actor.id, result.confirm),
        },
      ]
    : [];

  notifyCommit({
    roomId: actor.roomId,
    revision: result.revision,
    storedRevisions: result.storedRevisions,
    confirmations,
  });
  for (const room of result.factRooms) {
    publishFacts(room.roomId, {
      type: "facts",
      candidateIds: room.candidateIds,
      reason: "confirmation",
    });
  }
  if (result.refine) wakeRefinement(actor.roomId);
  if (result.lookup) {
    // The command is already durable. Lookup selection and every downstream
    // fetch/model failure are intentionally detached from command success.
    void triggerNeedLookup(
      actor.roomId,
      result.lookup.criterion,
      result.lookup.label,
      result.lookup.visibility,
    ).catch((err) => {
      console.error("need-triggered lookup failed:", err);
    });
  }
  if (result.warmTargets.length > 0) {
    warmEnrichments(pool, actor.roomId, result.warmTargets);
  }
  if (result.poolFill) startPoolFill(actor.roomId, true);
  return result.success;
}

async function triggerNeedLookup(
  roomId: string,
  criterion: Criterion,
  label: string,
  visibility: SubmitRequirementCmd["visibility"],
): Promise<void> {
  const inputs = await loadEligibilityInputs(pool, roomId);
  const cuisineValues = criterion.kind === "key" && criterion.key === "cuisine"
    ? normalizeCuisineTokens(
        inputs.requirements.flatMap((requirement) => {
          const payload = requirement.payload;
          return requirement.active !== false &&
            (payload?.kind === "inclusion" || payload?.kind === "exclusion") &&
            payload.key === "cuisine"
            ? payload.values ?? []
            : [];
        }),
      )
    : [];
  const unknown = inScope(inputs.candidates, inputs.scope)
    .filter((candidate) => {
      const key = criterion.kind === "key" ? criterion.key : criterion.id;
      if (criterion.kind === "key" && criterion.key.startsWith("open:")) {
        const hours = candidate.attributes.find((item) => item.key === "hours");
        if (
          hours?.status === "verified_true" &&
          hours.source === "osm:opening_hours" &&
          candidate.hours?.length
        ) return false;
        return parseOpeningHours(candidate.website_hours?.join("; ")) === null;
      }
      const attribute = candidate.attributes.find((item) => item.key === key);
      if (criterion.kind === "question") return (attribute?.status ?? "unknown") === "unknown";
      if (criterion.key !== "cuisine") return (attribute?.status ?? "unknown") === "unknown";
      const recorded = typeof attribute?.value === "string"
        ? normalizeCuisineTokens(attribute.value)
        : [];
      if (recorded.length > 0 && attribute?.status !== "unknown") return false;
      // Some snapshots use a dish as their category. A taxonomy implication
      // already supplies cuisine evidence, so those places are not lookup gaps.
      return !normalizeCuisineTokens(candidate.category).some(
        (token) =>
          cuisineValues.includes(token) ||
          implies(token).some(({ cuisine }) => cuisineValues.includes(cuisine)),
      );
    })
    .sort((a, b) => a.walk_min - b.walk_min || a.id.localeCompare(b.id))
    .slice(0, 24);
  const targets = unknown.flatMap((candidate) => {
    const target = lookupTargetOf(candidate);
    return target ? [{ candidateId: candidate.id, ...target }] : [];
  });
  await lookupNow(pool, roomId, targets, {
    intent: "interactive",
    keys: criterion.kind === "key" ? [criterion.key] : [],
    criteria: [criterion],
    reason: {
      kind: "need",
      ...(visibility === "shared" ? { label } : {}),
    },
  });
}

function pointerValue(input: unknown, instancePath: string): unknown {
  if (!instancePath) return input;
  return instancePath
    .split("/")
    .slice(1)
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))
    .reduce<unknown>((value, key) =>
      value !== null && typeof value === "object"
        ? (value as Record<string, unknown>)[key]
        : undefined, input);
}

/** R17: return the concrete closed values Ajv rejected so a caller can repair
 * its request without consulting prose that may have drifted. */
function actionableValidationFailure(
  input: unknown,
  errors: ErrorObject[],
): FailureEnvelope {
  const allowedByPath = new Map<string, unknown[]>();
  for (const error of errors) {
    const allowed = error.keyword === "const"
      ? [(error.params as { allowedValue: unknown }).allowedValue]
      : error.keyword === "enum"
        ? (error.params as { allowedValues: unknown[] }).allowedValues
        : [];
    if (allowed.length === 0) continue;
    const values = allowedByPath.get(error.instancePath) ?? [];
    for (const value of allowed) {
      if (!values.some((item) => JSON.stringify(item) === JSON.stringify(value))) values.push(value);
    }
    allowedByPath.set(error.instancePath, values);
  }
  const enumFailure = [...allowedByPath.entries()]
    .sort((a, b) => b[1].length - a[1].length)[0];
  if (enumFailure) {
    const [path, allowed] = enumFailure;
    const field = path.split("/").at(-1) || "input";
    const received = JSON.stringify(pointerValue(input, path));
    const values = allowed.map((value) => JSON.stringify(value)).join(", ");
    return failure(
      "invalid_input",
      `Invalid ${field}: received ${received ?? "undefined"}; allowed values: ${values}.`,
      `Use one of these values for ${field}: ${values}.`,
    );
  }
  const first = errors[0];
  const missing = first?.keyword === "required"
    ? (first.params as { missingProperty: string }).missingProperty
    : undefined;
  const additional = first?.keyword === "additionalProperties"
    ? (first.params as { additionalProperty: string }).additionalProperty
    : undefined;
  const field = missing ?? additional ?? first?.instancePath.split("/").at(-1) ?? "input";
  const received = missing ? "missing" : JSON.stringify(pointerValue(input, first?.instancePath ?? ""));
  return failure(
    "invalid_input",
    `Invalid ${field}: received ${received ?? "undefined"}; ${first?.message ?? "validation failed"}.`,
    `Correct ${field} and retry.`,
  );
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
    case "SetRequirementActive":
      return setRequirementActive(client, actor, input as never);
    case "EvaluateCandidates":
      return evaluateCandidates(client, actor, input as never);
    case "RespondToProposal":
      return respondToProposal(client, actor, input as never);
    case "SetReadyState":
      return setReadyState(client, actor, input as never);
    case "SetOrigin":
      return setOrigin(client, actor, input as never);
    case "SetSearchScope":
      return setSearchScope(client, actor, input as never);
    case "AddCandidates":
      return addCandidates(client, actor, input as never);
    case "ProposeDestination":
      return proposeDestination(client, actor, input as never);
    case "PlanArrival":
      return planArrival(client, actor, input as never);
    case "AttestAttribute":
      return attestAttribute(client, actor, input as never);
    case "ConfirmFact":
      return confirmFact(client, actor, input as never);
    case "UnconfirmFact":
      return unconfirmFact(client, actor, input as never);
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
  if (cmd.payload?.kind === "time") {
    const window = cmd.payload.window as { start?: unknown; end?: unknown } | undefined;
    const start = typeof window?.start === "string" ? Date.parse(window.start) : Number.NaN;
    const end = typeof window?.end === "string" ? Date.parse(window.end) : Number.NaN;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      return errorOutcome(
        "invalid_input",
        "A time need must end after it starts.",
        "Provide an ISO-8601 window whose end is later than its start.",
      );
    }
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
  const criterion = criterionFor(cmd.payload as never);
  return {
    events,
    effect: `Requirement ${existing ? "updated" : "recorded"}.`,
    refine: Boolean(criterion),
    ...(criterion
      ? {
          lookup: {
            criterion,
            visibility: cmd.visibility,
            label: cmd.payload?.kind === "attribute" && cmd.payload.expect === "verified_false"
                ? `no ${ATTRIBUTE_LABELS[cmd.payload.key as keyof typeof ATTRIBUTE_LABELS] ?? cmd.payload.key}`
                : criterion.label,
          },
        }
      : {}),
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

/**
 * Set one of your own needs aside, or bring it back. Reversible by design:
 * the row, its id and its history survive, so the brief can keep showing it
 * greyed and say what turning it back on would cost. Owner-only — a shared
 * need is still its author's to silence.
 */
async function setRequirementActive(
  client: pg.PoolClient,
  actor: Participant,
  cmd: { requirementId: string; active: boolean },
): Promise<HandlerOutcome> {
  const row = (
    await client.query(
      `SELECT owner_id, visibility, active, payload FROM requirements
        WHERE id = $1 AND room_id = $2 AND NOT withdrawn`,
      [cmd.requirementId, actor.roomId],
    )
  ).rows[0];
  // Same not_found for unknown and for someone else's — never confirm a
  // foreign requirement exists (existence oracle). There is no not_owner code
  // in the error model, and inventing one would be the oracle.
  if (!row || row.owner_id !== actor.id) {
    return errorOutcome(
      "not_found",
      "Unknown requirementId.",
      "Call sync_session to refresh IDs; you can only set aside your own needs.",
    );
  }
  if (row.active === cmd.active) {
    // Idempotent: no write, no event, no revision bump.
    return {
      events: [],
      effect: `Need already ${cmd.active ? "active" : "set aside"}.`,
    };
  }
  await client.query("UPDATE requirements SET active = $2 WHERE id = $1", [
    cmd.requirementId,
    cmd.active,
  ]);
  if (!cmd.active) {
    // A council offer to relax this need is an offer about a need that is now
    // out of force. Expire it the same way recovery from an impasse does, so
    // it leaves the owner's outstanding list instead of sitting there able to
    // mutate a set-aside requirement on a later grant.
    await client.query(
      `UPDATE adjustments SET status = 'expired'
        WHERE room_id = $1 AND kind = 'requirement_relaxation'
          AND target->>'requirementId' = $2
          AND status IN ('proposed', 'staged_grant')`,
      [actor.roomId, cmd.requirementId],
    );
  }
  const criterion = criterionFor(row.payload as never);
  return {
    events: [
      {
        type: "requirement_toggled",
        actorId: actor.id,
        // Matches the requirement's own visibility, so the projector redacts
        // a private toggle exactly as it redacts the submission.
        visibility: row.visibility,
        payload: {
          actorName: actor.displayName,
          requirementId: cmd.requirementId,
          active: cmd.active,
          ...(row.payload ? { summary: summarizePayload(row.payload) } : {}),
        },
      },
    ],
    effect: cmd.active ? "Need reapplied." : "Need set aside.",
    refine: Boolean(criterion),
    ...(cmd.active && criterion
      ? {
          lookup: {
            criterion,
            visibility: row.visibility,
            label: row.payload?.kind === "attribute" && row.payload.expect === "verified_false"
                ? `no ${ATTRIBUTE_LABELS[row.payload.key as keyof typeof ATTRIBUTE_LABELS] ?? row.payload.key}`
                : criterion.label,
          },
        }
      : {}),
  };
}

async function evaluateCandidates(
  client: pg.PoolClient,
  actor: Participant,
  cmd: {
    verdicts: Array<{
      candidateId: string;
      verdict: string;
      infoNeeded?: string;
      screenedMapRevision?: number;
    }>;
  },
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
  const candidateRevisions = new Map<string, number>(
    (
      await client.query("SELECT id, map_revision FROM candidates WHERE room_id = $1", [
        actor.roomId,
      ])
    ).rows.map((r) => [r.id as string, Number(r.map_revision)]),
  );
  const known = new Set(candidateRevisions.keys());
  const unknown = cmd.verdicts.find((v) => !known.has(v.candidateId));
  if (unknown) {
    return errorOutcome(
      "not_found",
      `Unknown candidateId "${unknown.candidateId}".`,
      "Call sync_session or get_spatial_context to refresh candidate IDs.",
    );
  }
  const ahead = cmd.verdicts.find(
    (v) =>
      v.screenedMapRevision !== undefined &&
      v.screenedMapRevision > candidateRevisions.get(v.candidateId)!,
  );
  if (ahead) {
    return errorOutcome(
      "invalid_input",
      `screenedMapRevision ${ahead.screenedMapRevision} is ahead of candidate ${ahead.candidateId}.`,
      "Inspect the candidate again and send the mapRevision from that dossier.",
    );
  }
  const room = (
    await client.query("SELECT revision FROM rooms WHERE id = $1", [actor.roomId])
  ).rows[0];
  for (const v of cmd.verdicts) {
    await client.query(
      `INSERT INTO verdicts
         (room_id, owner_id, candidate_id, verdict, info_needed,
          recorded_at_revision, screened_map_revision)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (room_id, owner_id, candidate_id)
       DO UPDATE SET verdict = $4, info_needed = $5,
                     recorded_at_revision = $6, screened_map_revision = $7`,
      [
        actor.roomId,
        actor.id,
        v.candidateId,
        v.verdict,
        v.infoNeeded ?? null,
        room.revision + 1,
        // X2: never bless an old judgment with a revision read during this
        // write. Legacy callers may omit the additive field; -1 records that
        // verdict as already stale while preserving input compatibility.
        v.screenedMapRevision ?? -1,
      ],
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
    await client.query("SELECT revision FROM rooms WHERE id = $1", [
      actor.roomId,
    ])
  ).rows[0];
  // Committed and withdrawn are absorbing (§7.3). A room past deliberation is
  // already closed to stances by the phase gate, so this guard is only about
  // one proposal's own lifecycle: a staged agreement is the organizer's to
  // abort or commit on the page.
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
  const events: AppendedEvent[] = [
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
  ];
  // Accepting a place is the strongest "I'm done adding" a person can say:
  // it marks them ready, so staging (§3.7) does not wait on a separate
  // toggle nobody was told about. Readiness stays a participant's own status
  // — set_ready_state can still take it back.
  if (cmd.disposition === "accept") {
    const flipped = await client.query(
      "UPDATE participants SET ready_state = 'ready' WHERE id = $1 AND ready_state <> 'ready'",
      [actor.id],
    );
    if (flipped.rowCount) {
      events.push({
        type: "ready_state_changed",
        actorId: actor.id,
        visibility: "shared",
        payload: { actorName: actor.displayName, state: "ready" },
      });
    }
  }
  return {
    events,
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

async function setOrigin(
  client: pg.PoolClient,
  actor: Participant,
  cmd: {
    position: { lat: number; lng: number };
    label?: string;
    source: "device" | "stated";
  },
): Promise<HandlerOutcome> {
  const updatedAt = new Date().toISOString();
  const origin = {
    lat: cmd.position.lat,
    lng: cmd.position.lng,
    label: cmd.label?.trim() || (cmd.source === "device" ? "your location" : "chosen point"),
    source: cmd.source,
    updatedAt,
  };
  // Identity comes from the authenticated actor. There is intentionally no
  // target participant in the command or the write predicate.
  await client.query("UPDATE participants SET origin = $2 WHERE id = $1", [
    actor.id,
    JSON.stringify(origin),
  ]);
  return {
    events: [
      {
        type: "origin_updated",
        actorId: actor.id,
        visibility: "application-private",
        payload: { actorName: actor.displayName, origin },
      },
    ],
    effect: "Starting point updated.",
  };
}

async function addCandidates(
  client: pg.PoolClient,
  actor: Participant,
  cmd: { refs: string[] },
): Promise<HandlerOutcome> {
  const room = (
    await client.query("SELECT area_id, scope FROM rooms WHERE id = $1", [actor.roomId])
  ).rows[0] as { area_id: string | null; scope: ScopeState | null };
  const area = room.area_id ? areaById(room.area_id) : undefined;
  const snapshot = area ? loadSnapshot(area.id) : null;
  if (!area || !snapshot) {
    return errorOutcome(
      "invalid_input",
      "There are no more places available for this room.",
      "Use the places already in the room.",
    );
  }
  const center = room.scope?.area.center ?? area.center;
  const resolved = candidatesForRefs(actor.roomId, snapshot, cmd.refs, center);
  if (!resolved) {
    return errorOutcome(
      "not_found",
      "One or more of those places are no longer available.",
      "Choose the places again from the map and retry.",
    );
  }
  const existingRows = (
    await client.query("SELECT id, osm_ref FROM candidates WHERE room_id = $1 ORDER BY id", [actor.roomId])
  ).rows as Array<{ id: string; osm_ref: string | null }>;
  const existingRefs = new Set(
    existingRows.map((row) => row.osm_ref).filter((ref): ref is string => ref !== null),
  );
  const novel = resolved.filter((seed) => !existingRefs.has(seed.osmRef!));
  if (existingRows.length + novel.length > POOL_CAP) {
    return errorOutcome(
      "invalid_input",
      `The room can hold at most ${POOL_CAP} places.`,
      `Bring in at most ${Math.max(0, POOL_CAP - existingRows.length)} more places.`,
    );
  }
  numberCandidateSeeds(actor.roomId, novel, existingRows.map((row) => row.id));
  await insertCandidateSeeds(client, actor.roomId, novel);
  if (novel.length === 0) {
    return { events: [], effect: "Those places are already in the room." };
  }
  return {
    events: [candidatesAddedEvent(actor, novel)],
    effect: `${novel.length} place${novel.length === 1 ? "" : "s"} brought into the room.`,
    warmTargets: warmTargetsFor(novel),
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
    poolFill: cmd.area !== undefined,
  };
}

function candidatesAddedEvent(actor: Participant, seeds: CandidateSeed[]): AppendedEvent {
  return {
    type: "candidates_added",
    actorId: actor.id,
    visibility: "shared",
    payload: {
      actorName: actor.displayName,
      count: seeds.length,
      names: seeds.slice(0, 3).map((seed) => seed.name),
    },
  };
}

async function proposeDestination(
  client: pg.PoolClient,
  actor: Participant,
  cmd: { candidateId: string },
): Promise<HandlerOutcome> {
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

async function attestAttribute(
  client: pg.PoolClient,
  actor: Participant,
  cmd: {
    candidateId: string;
    key: string;
    status: "verified_true" | "verified_false";
    confidence: number;
    note: string;
    sourceUrl?: string;
  },
): Promise<HandlerOutcome> {
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
  const room = (
    await client.query("SELECT revision FROM rooms WHERE id = $1", [actor.roomId])
  ).rows[0];
  // One attestation per person per fact per place: saying it again replaces.
  await client.query(
    `INSERT INTO attestations
       (room_id, candidate_id, key, participant_id, status, confidence, note, source_url, at_revision)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (room_id, candidate_id, key, participant_id) DO UPDATE SET
       status = EXCLUDED.status, confidence = EXCLUDED.confidence, note = EXCLUDED.note,
       source_url = EXCLUDED.source_url, at_revision = EXCLUDED.at_revision, created_at = now()`,
    [
      actor.roomId, cmd.candidateId, cmd.key, actor.id, cmd.status, cmd.confidence,
      cmd.note, cmd.sourceUrl ?? null, room.revision + 1,
    ],
  );
  // R3: the attestation changed the candidate's merged facts. The shared
  // revision helper couples every mapRevision bump to private re-screening,
  // so future fact producers inherit the same invalidation discipline.
  const screeningEvents = await bumpCandidateMapRevisions(
    client,
    actor.roomId,
    [cmd.candidateId],
  );
  // A q: key is shared evidence, but its sentence may be application-private.
  // The event therefore uses neutral copy; authorized dossiers recover the
  // label from their matching requirement, never from this shared frame.
  const label = cmd.key.startsWith("q:")
    ? "a question"
    : ATTRIBUTE_LABELS[cmd.key as keyof typeof ATTRIBUTE_LABELS] ?? cmd.key;
  const answer = cmd.status === "verified_true" ? "yes" : "no";
  return {
    events: [
      {
        type: "attribute_attested",
        actorId: actor.id,
        visibility: "shared",
        payload: {
          actorName: actor.displayName,
          candidateId: cmd.candidateId,
          candidateName: candidate.name,
          key: cmd.key,
          label,
          status: cmd.status,
          confidence: cmd.confidence,
        },
      },
      ...screeningEvents,
    ],
    effect: `Attested ${label}: ${answer} for ${candidate.name}.`,
  };
}

const QUESTION_CRITERION = /^q:[0-9a-f]{40}$/;

function confirmableCriterion(criterionId: string): boolean {
  return (ATTRIBUTE_VOCABULARY as readonly string[]).includes(criterionId) ||
    QUESTION_CRITERION.test(criterionId);
}

/** Event/storage privacy for question criteria. A matching private need makes
 * optional free-form confirmation metadata non-storable, even when a caller
 * tries to repeat the sentence there. */
async function confirmedCriterionPresentation(
  client: pg.PoolClient,
  actor: Participant,
  criterionId: string,
): Promise<{ label: string; privateQuestion: boolean }> {
  const vocabulary = ATTRIBUTE_LABELS[criterionId as keyof typeof ATTRIBUTE_LABELS];
  if (vocabulary) return { label: vocabulary, privateQuestion: false };
  const requirements = (
    await client.query(
      `SELECT payload, visibility, owner_id FROM requirements
        WHERE room_id = $1 AND NOT withdrawn`,
      [actor.roomId],
    )
  ).rows as Array<{
    payload: Record<string, unknown> | null;
    visibility: string;
    owner_id: string;
  }>;
  let sharedLabel: string | undefined;
  let privateQuestion = false;
  for (const requirement of requirements) {
    const criterion = criterionFor(requirement.payload as never);
    if (criterion?.id !== criterionId) continue;
    if (requirement.visibility === "shared") sharedLabel = criterion.label;
    else if (requirement.owner_id === actor.id) privateQuestion = true;
  }
  return {
    label: sharedLabel ?? "a question",
    privateQuestion,
  };
}

interface ConfirmFactCmd {
  candidateId: string;
  criterionId: string;
  lean: boolean;
  note?: string;
  sourceUrl?: string;
}

async function confirmedCandidate(
  client: pg.PoolClient,
  actor: Participant,
  candidateId: string,
): Promise<{ id: string; name: string; osm_ref: string } | HandlerOutcome> {
  const candidate = (
    await client.query(
      "SELECT id, name, osm_ref FROM candidates WHERE id = $1 AND room_id = $2",
      [candidateId, actor.roomId],
    )
  ).rows[0] as { id: string; name: string; osm_ref: string | null } | undefined;
  if (!candidate) {
    return errorOutcome(
      "not_found",
      "Unknown candidateId.",
      "Call get_spatial_context to refresh candidate IDs.",
    );
  }
  if (!candidate.osm_ref) {
    return errorOutcome(
      "invalid_input",
      "This place has no permanent record reference.",
      "Use a place backed by the shared map record.",
    );
  }
  return { ...candidate, osm_ref: candidate.osm_ref };
}

async function bumpConfirmedFactCandidates(
  client: pg.PoolClient,
  actor: Participant,
  candidate: { id: string; osm_ref: string },
): Promise<{
  events: AppendedEvent[];
  factRooms: Array<{ roomId: string; candidateIds: string[] }>;
}> {
  const affected = (
    await client.query(
      "SELECT room_id, id FROM candidates WHERE osm_ref = $1 ORDER BY room_id, id",
      [candidate.osm_ref],
    )
  ).rows as Array<{ room_id: string; id: string }>;
  const localEvents = await bumpCandidateMapRevisions(client, actor.roomId, [candidate.id]);
  // The fact is global, so stale private verdicts in every other room must
  // stop being authoritative even though only this room receives the event.
  await client.query(
    `UPDATE candidates SET map_revision = map_revision + 1
      WHERE osm_ref = $1 AND room_id <> $2`,
    [candidate.osm_ref, actor.roomId],
  );
  const grouped = new Map<string, string[]>();
  for (const row of affected) {
    const ids = grouped.get(row.room_id) ?? [];
    ids.push(row.id);
    grouped.set(row.room_id, ids);
  }
  return {
    events: localEvents,
    factRooms: [...grouped].map(([roomId, candidateIds]) => ({ roomId, candidateIds })),
  };
}

async function confirmFact(
  client: pg.PoolClient,
  actor: Participant,
  cmd: ConfirmFactCmd,
): Promise<HandlerOutcome> {
  // Defence in depth behind the generated schema: neither time-window ids,
  // value-specific synthetic ids nor question text can reach shared storage.
  if (!confirmableCriterion(cmd.criterionId)) {
    return errorOutcome(
      "invalid_input",
      "criterionId must be a vocabulary key or q:<sha1>; open:* windows cannot be confirmed.",
      "Use the criterionId supplied by an eligible vocabulary or question need.",
    );
  }
  const candidate = await confirmedCandidate(client, actor, cmd.candidateId);
  if ("events" in candidate) return candidate;
  const presentation = await confirmedCriterionPresentation(client, actor, cmd.criterionId);
  await client.query(
    `INSERT INTO confirmed_facts
       (osm_ref, criterion_id, lean, note, source_url, confirmed_by_name,
        confirmed_by_participant, room_id, confirmed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
     ON CONFLICT (osm_ref, criterion_id) DO UPDATE SET
       lean = EXCLUDED.lean, note = EXCLUDED.note, source_url = EXCLUDED.source_url,
       confirmed_by_name = EXCLUDED.confirmed_by_name,
       confirmed_by_participant = EXCLUDED.confirmed_by_participant,
       room_id = EXCLUDED.room_id, confirmed_at = now()`,
    [
      candidate.osm_ref,
      cmd.criterionId,
      cmd.lean,
      presentation.privateQuestion ? null : (cmd.note ?? null),
      presentation.privateQuestion ? null : (cmd.sourceUrl ?? null),
      actor.displayName,
      actor.id,
      actor.roomId,
    ],
  );
  const bumped = await bumpConfirmedFactCandidates(client, actor, candidate);
  const label = presentation.label;
  return {
    events: [
      {
        type: "attribute_attested",
        actorId: actor.id,
        visibility: "shared",
        payload: {
          actorName: actor.displayName,
          candidateId: candidate.id,
          candidateName: candidate.name,
          key: cmd.criterionId,
          label,
          status: cmd.lean ? "verified_true" : "verified_false",
          confidence: 0.95,
          confirmed: true,
        },
      },
      ...bumped.events,
    ],
    effect: `${actor.displayName} confirmed ${label} at ${candidate.name}.`,
    factRooms: bumped.factRooms,
  };
}

async function unconfirmFact(
  client: pg.PoolClient,
  actor: Participant,
  cmd: Pick<ConfirmFactCmd, "candidateId" | "criterionId">,
): Promise<HandlerOutcome> {
  if (!confirmableCriterion(cmd.criterionId)) {
    return errorOutcome(
      "invalid_input",
      "criterionId must be a vocabulary key or q:<sha1>; open:* windows cannot be confirmed.",
      "Use the criterionId stored on the confirmed fact.",
    );
  }
  const candidate = await confirmedCandidate(client, actor, cmd.candidateId);
  if ("events" in candidate) return candidate;
  const existing = (
    await client.query(
      `SELECT confirmed_by_participant FROM confirmed_facts
        WHERE osm_ref = $1 AND criterion_id = $2 FOR UPDATE`,
      [candidate.osm_ref, cmd.criterionId],
    )
  ).rows[0] as { confirmed_by_participant: string | null } | undefined;
  if (!existing) {
    return errorOutcome(
      "not_found",
      "No confirmed fact matches that place and criterion.",
      "Refresh the place details before trying again.",
    );
  }
  if (existing.confirmed_by_participant !== actor.id && actor.role !== "organizer") {
    return errorOutcome(
      "not_authorized",
      "Only the confirmer or the organizer can undo this confirmation.",
      "Ask the confirmer or the room organizer to withdraw it.",
    );
  }
  await client.query(
    "DELETE FROM confirmed_facts WHERE osm_ref = $1 AND criterion_id = $2",
    [candidate.osm_ref, cmd.criterionId],
  );
  const bumped = await bumpConfirmedFactCandidates(client, actor, candidate);
  const label = (await confirmedCriterionPresentation(client, actor, cmd.criterionId)).label;
  return {
    events: [
      {
        type: "attribute_attested",
        actorId: actor.id,
        visibility: "shared",
        payload: {
          actorName: actor.displayName,
          candidateId: candidate.id,
          candidateName: candidate.name,
          key: cmd.criterionId,
          label,
          withdrawn: true,
          confirmed: true,
        },
      },
      ...bumped.events,
    ],
    effect: `Withdrew the confirmation of ${label} at ${candidate.name}.`,
    factRooms: bumped.factRooms,
  };
}

async function planArrival(
  client: pg.PoolClient,
  actor: Participant,
  cmd: { mode: "walk" | "bike" | "car"; pickupNote?: string },
): Promise<HandlerOutcome> {
  const room = (
    await client.query("SELECT revision FROM rooms WHERE id = $1", [
      actor.roomId,
    ])
  ).rows[0];
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
      // R12: staging is durable room state. The owner-only event advances the
      // revision and wakes every one of this addressee's tabs without leaking
      // the private adjustment's content to peers.
      events: [
        {
          type: "adjustment_grant_staged",
          actorId: actor.id,
          visibility: "application-private",
          payload: {
            targetParticipantId: actor.id,
            adjustmentId: adj.id,
          },
        },
      ],
      staged: true,
      confirm: { kind: "private_request", subjectId: adj.id },
      effect:
        "Grant staged. This exceeds your delegated bound: confirm on the page to apply it.",
    };
  }
  return applyAdjustment(client, actor, adj);
}

async function confirmPrivateRequest(
  client: pg.PoolClient,
  actor: Participant,
  cmd: { requestId: string; confirmationNonce: string },
): Promise<HandlerOutcome> {
  // Nonce first, before any lookup: a caller without one learns nothing about
  // which requests exist or who they are addressed to.
  if (
    !consumeConfirmation(
      actor.roomId,
      actor.id,
      { kind: "private_request", subjectId: cmd.requestId },
      cmd.confirmationNonce,
    )
  ) {
    return unverifiedConfirmation("grant");
  }
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

/**
 * The applying commands are reachable over plain HTTP with a participant's own
 * bearer token, so the binding-layer "no tool route" control is backed by a
 * nonce the page can only have received on its realtime channel
 * (INTERACTION-AND-BINDING.md §5.4).
 */
function unverifiedConfirmation(what: "grant" | "commit"): HandlerOutcome {
  return errorOutcome(
    "consent_required",
    `This ${what} carries no valid confirmation code.`,
    "Confirm on the Spokes page: staging sends the page a short-lived, single-use code over its live channel, and only that page gesture can apply it.",
  );
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
        "SELECT owner_id, payload, visibility, active FROM requirements WHERE id = $1 AND room_id = $2 AND NOT withdrawn",
        [requirementId, actor.roomId],
      )
    ).rows[0];
    // Withdrawn or set aside: either way the need is no longer in force, so
    // the grant must not mutate it. Defence in depth behind the toggle's own
    // expiry, for an offer written between the toggle and the grant. The
    // failure rolls the whole command back — including the status write above
    // — which is why the adjustment is retired at toggle time, not here.
    if (!req || req.active === false) {
      return errorOutcome(
        "not_found",
        "The target requirement is no longer in force.",
        "Call sync_session; the need was withdrawn or set aside.",
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
    confirm: { kind: "agreement", subjectId: cmd.proposalId },
    effect: `Agreement on ${proposal.candidate_name} staged. The organizer confirms on the page.`,
  };
}

async function commitAgreement(
  client: pg.PoolClient,
  actor: Participant,
  cmd: { proposalId: string; confirmationNonce: string },
): Promise<HandlerOutcome> {
  if (actor.role !== "organizer") {
    return errorOutcome(
      "not_authorized",
      "Only the organizer can commit the agreement.",
      "Set your stance and ready state; the organizer commits.",
    );
  }
  if (
    !consumeConfirmation(
      actor.roomId,
      actor.id,
      { kind: "agreement", subjectId: cmd.proposalId },
      cmd.confirmationNonce,
    )
  ) {
    return unverifiedConfirmation("commit");
  }
  const room = (
    await client.query("SELECT revision FROM rooms WHERE id = $1", [
      actor.roomId,
    ])
  ).rows[0];
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
  // The phase move to "agreed" is the machine's (phase.ts), not this
  // handler's — it derives from the agreement_committed event below.
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
    effect: `Agreement committed: ${proposal.candidate_name}. Arrival planning is open.`,
  };
}

/** Human line for feeds and requirement cards; the raw payload stays on the
 * wire and in the wire view — this is presentation, not the record. */
function summarizePayload(payload: Record<string, unknown>): string {
  switch (payload.kind) {
    case "attribute": {
      const need = String(payload.key).replace(/-/g, " ");
      return payload.expect === "verified_true"
        ? need
        : `${need} (${String(payload.expect).replace(/_/g, " ")})`;
    }
    case "scope":
      return `within ${payload.max} ${String(payload.dimension).replace(/M$/, " m")}`;
    case "budget": {
      const b = payload.perPersonMax as { amount: number; currency: string };
      const symbol = b.currency === "EUR" ? "€" : `${b.currency} `;
      return `budget ≤ ${symbol}${b.amount} per person`;
    }
    case "time": {
      const window = payload.window as { start?: string; end?: string } | undefined;
      if (typeof payload.phrase === "string") return payload.phrase;
      return window?.start && window.end
        ? `open ${windowSpanText({ start: window.start, end: window.end })}`
        : "open at the requested time";
    }
    case "text":
      return String(payload.text);
    case "exclusion": {
      const values = (payload.values as string[])
        .map((v) => v.charAt(0).toUpperCase() + v.slice(1))
        .join(", ");
      return `no ${values}${payload.key === "cuisine" ? " food" : ""}`;
    }
    case "inclusion": {
      const values = (payload.values as string[])
        .map((v) => v.charAt(0).toUpperCase() + v.slice(1))
        .join(" or ");
      return `${values}${payload.key === "cuisine" ? " food" : ""} only`;
    }
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
