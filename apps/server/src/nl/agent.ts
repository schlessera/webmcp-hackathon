import {
  TOOLS,
  type CandidateDossier,
  type OutstandingItem,
  type SpatialContextResult,
  type ToolResult,
} from "@webmcp-hackathon/contracts";
import type { Participant } from "../auth.ts";
import { config } from "../config.ts";
import { pool } from "../db.ts";
import { submitCommand } from "../engine.ts";
import { outstandingFor } from "../outstanding.ts";
import { inspectCandidates, prepareNavigation, spatialContext } from "../spatial.ts";
import { respond, type FunctionTool, type InputItem } from "./openai.ts";

/**
 * The smart tier: a person's own agent, acting for exactly that person over
 * the same tool surface a ChatGPT-side agent would use, through the same
 * command bus (INTERACTION-AND-BINDING.md §1 rule 4). It sees only what its
 * person sees — every read runs as their actor — and it can never commit or
 * confirm: those two commands have no tool route here either.
 *
 * Why the smart model: a turn here is open-ended (read state, weigh, act,
 * explain), and a wrong move changes a shared room. That is not a job for the
 * fast tier, whose strength is bounded shape-filling at low latency.
 */

export interface AgentAction {
  tool: string;
  ok: boolean;
  effect: string;
}

export interface AgentOutcome {
  reply: string;
  actions: AgentAction[];
  meta: { model: string; ms: number; rounds: number };
}

const MAX_ROUNDS = 8;
const REPLY_MAX = 320;

/** Tool name -> command type, for the mutating tools (mirrors webmcp.ts). */
const MUTATIONS: Record<string, string> = {
  submit_requirement: "SubmitRequirement",
  withdraw_requirement: "WithdrawRequirement",
  set_requirement_active: "SetRequirementActive",
  evaluate_candidates: "EvaluateCandidates",
  respond_to_proposal: "RespondToProposal",
  resolve_private_request: "ResolvePrivateRequest",
  set_ready_state: "SetReadyState",
  confirm_agreement: "ConfirmAgreement",
  set_search_scope: "SetSearchScope",
  propose_destination: "ProposeDestination",
  plan_arrival: "PlanArrival",
  attest_attribute: "AttestAttribute",
};

/** The page-local and session-bootstrap tools have no meaning on the server. */
const OMITTED = new Set(["sync_session", "focus_destination"]);

/** Same catalog as the page registers, minus baseRevision (injected here). */
function tools(): FunctionTool[] {
  return TOOLS.filter((t) => !OMITTED.has(t.name)).map((t) => {
    const schema = JSON.parse(JSON.stringify(t.inputSchema)) as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    if (schema.properties) delete schema.properties.baseRevision;
    if (schema.required) schema.required = schema.required.filter((r) => r !== "baseRevision");
    return {
      type: "function",
      name: t.name,
      description: t.description,
      parameters: schema,
      strict: false,
    };
  });
}

async function currentRevision(roomId: string): Promise<number> {
  const row = (await pool.query("SELECT revision FROM rooms WHERE id = $1", [roomId])).rows[0];
  return Number(row?.revision ?? 0);
}

/** The room as this person sees it, sized for a prompt. */
export function snapshot(
  context: SpatialContextResult,
  outstanding: OutstandingItem[],
  actor: Participant,
): Record<string, unknown> {
  const name = (id: string) =>
    context.participants.find((p) => p.participantId === id)?.displayName ?? "someone";
  // Every place, so a name the person uses always resolves to an id; the
  // why-string only for the ones in the running, to keep the prompt small.
  const order = { eligible: 0, uncertain: 1, excluded: 2 } as const;
  const shown = [...context.candidates]
    .sort((a, b) => order[a.eligibility] - order[b.eligibility] || a.walkMin - b.walkMin)
    .map((c, i) => ({
      candidateId: c.candidateId,
      name: c.name,
      eligibility: c.eligibility,
      walkMin: c.walkMin,
      ...(i < 14 ? { priceLevel: c.priceLevel, why: c.why.slice(0, 80) } : {}),
    }));
  return {
    you: { participantId: actor.id, name: actor.displayName, role: actor.role },
    phase: context.phase,
    scope: {
      radiusM: context.scope?.area.radiusM,
      transport: context.scope?.transport,
    },
    counts: {
      inScope: context.total,
      stillWork: context.matching,
      unsure: context.feasibility.uncertain,
    },
    needs: context.activeNeeds.map((n) => ({
      requirementId: n.id,
      label: n.label,
      owner: n.ownerId === actor.id ? "you" : name(n.ownerId),
      visibility: n.visibility,
      active: n.active,
      rulesOut: n.ruledOut,
      wouldReturnIfDropped: n.wouldReturn,
      unknown: n.unknown,
    })),
    // Effects only, unattributed: the room's own rows do not name the owner
    // of a private need (COPY.md), so neither does the agent.
    privateNeedsOfOthers: context.privateEffects.map((e) => ({
      rulesOut: e.ruledOut,
      topic: e.topic,
    })),
    people: context.participants.map((p) => ({
      participantId: p.participantId,
      name: p.participantId === actor.id ? `${p.displayName} (you)` : p.displayName,
      role: p.role,
      ready: p.readyState === "ready",
      here: p.present,
      arrived: p.arrived,
    })),
    proposals: context.proposals.map((p) => ({
      proposalId: p.proposalId,
      place: context.candidates.find((c) => c.candidateId === p.candidateId)?.name,
      candidateId: p.candidateId,
      status: p.status,
      inFavour: p.stances.filter((s) => s.stance === "accept").map((s) => name(s.participantId)),
      vetoStands: p.vetoStands,
      yourStance: p.ownStance ?? "none",
      staging: p.staging,
    })),
    agreement: context.agreement,
    impasse: context.impasse ? "nothing works for everyone right now" : undefined,
    places: shown,
    yourOutstandingDecisions: outstanding,
  };
}

function compactDossier(d: CandidateDossier) {
  return {
    candidateId: d.candidateId,
    name: d.name,
    category: d.category,
    priceLevel: d.priceLevel,
    attributes: d.attributes.map(
      (a) => `${a.key}=${a.status}${a.value !== undefined ? `(${String(a.value)})` : ""} [${a.source.split(":")[0]}]`,
    ),
  };
}

async function execute(
  actor: Participant,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "get_spatial_context": {
      const ctx = await spatialContext(actor);
      if (!ctx.ok) return ctx;
      return snapshot(ctx, await outstandingFor(pool, actor.roomId, actor.id), actor);
    }
    case "inspect_candidates": {
      const ids = Array.isArray(args.candidateIds) ? (args.candidateIds as string[]).slice(0, 3) : [];
      const result = await inspectCandidates(actor, ids);
      if (!result.ok) return result;
      return { ok: true, candidates: result.candidates.map(compactDossier) };
    }
    case "prepare_navigation":
      return prepareNavigation(actor, typeof args.candidateId === "string" ? args.candidateId : undefined);
    default: {
      const type = MUTATIONS[name];
      if (!type) {
        return { ok: false, error: { code: "not_found", message: `Unknown tool ${name}.`, recovery: "Use a listed tool." } };
      }
      // Revision discipline as the page keeps it: the freshest revision goes
      // in, and one sync_required is retried against the moved room.
      let result = await submitCommand(actor, type, {
        ...args,
        baseRevision: await currentRevision(actor.roomId),
      });
      if (!result.ok && result.error.code === "sync_required") {
        result = await submitCommand(actor, type, {
          ...args,
          baseRevision: await currentRevision(actor.roomId),
        });
      }
      return result;
    }
  }
}

function instructions(actor: Participant, held: string | null): string {
  return [
    `You are ${actor.displayName}'s own agent in a shared planning room where a small group is choosing one place to meet. You act for exactly this one person (${actor.role}) and nobody else.`,
    "You see only what they see. Other people's private needs reach you as counts, never as content or owner — say 'a private condition', never whose, and never guess at it.",
    held
      ? `A condition ${actor.displayName} gave you in confidence, which the room never receives: "${held}". Weigh it when you act; never state it, its topic, or the places it removes in your reply.`
      : "",
    "Read the snapshot first. Use tools only to change the room or to fetch detail you do not have; do not re-read the context unless a tool result told you the room moved.",
    "Rules of the room: a place is 'ruled out' by a need, never 'filtered'; an agreement needs everyone in favour, everyone ready, and no standing veto; only the organizer stages, and only the human confirms on the page — you cannot settle anything yourself.",
    "When asked to do something, do it with the tools, then confirm what changed. When asked a question, answer from the snapshot.",
    "Reply in plain sentences, at most three, under 300 characters. Sentence case, no exclamation marks, no emoji, no tool names, no ids, no JSON. Never write 'I', 'me' or 'my': the app has no voice of its own, so write as a note to the person ('Chén Ché is on the table now', 'Chén Ché could not be put forward: it is outside the current area'). Address the person as 'you'. Name places by name and give the numbers that matter ('12 still work of 21'). If you could not do something, say what stands in the way in one sentence.",
    "A place outside the current area is still a place: say so and ask whether to widen the area, rather than refusing.",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function runAgent(
  actor: Participant,
  text: string,
  held: string | null,
): Promise<AgentOutcome> {
  const started = Date.now();
  const context = await spatialContext(actor);
  const outstanding = await outstandingFor(pool, actor.roomId, actor.id);
  const initial = context.ok ? snapshot(context, outstanding, actor) : { unavailable: true };

  const input: InputItem[] = [
    { role: "user", content: `Room snapshot:\n${JSON.stringify(initial)}` },
    { role: "user", content: text },
  ];
  const actions: AgentAction[] = [];
  let reply = "";
  let rounds = 0;
  let model = config.nlSmartModel;

  while (rounds < MAX_ROUNDS) {
    rounds += 1;
    const turn = await respond({
      model: config.nlSmartModel,
      instructions: instructions(actor, held),
      input,
      tools: tools(),
      reasoning: "medium",
      maxOutputTokens: 1200,
      timeoutMs: 45_000,
    });
    model = turn.model;
    if (turn.toolCalls.length === 0) {
      reply = (turn.text ?? "").trim();
      break;
    }
    // Feed the model's own items back, then every call's result.
    input.push(...(turn.outputItems as InputItem[]));
    for (const call of turn.toolCalls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.arguments) as Record<string, unknown>;
      } catch {
        /* the server-side validator answers with invalid_input */
      }
      const result = await execute(actor, call.name, args);
      const envelope = result as ToolResult;
      if (call.name in MUTATIONS) {
        actions.push({
          tool: call.name,
          ok: envelope.ok,
          effect: envelope.ok
            ? (envelope.effect ?? "done").slice(0, 160)
            : `${envelope.error.code}: ${envelope.error.message}`.slice(0, 160),
        });
      }
      input.push({
        type: "function_call_output",
        call_id: call.callId,
        output: JSON.stringify(result).slice(0, 6000),
      });
    }
  }
  if (!reply) {
    reply = actions.some((a) => a.ok)
      ? "Done. The map shows the change."
      : "Nothing changed. Try saying it another way.";
  }
  return {
    reply: reply.slice(0, REPLY_MAX),
    actions,
    meta: { model, ms: Date.now() - started, rounds },
  };
}
