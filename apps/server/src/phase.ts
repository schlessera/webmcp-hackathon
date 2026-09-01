import { COMMAND_TYPES, type CommandType } from "@webmcp-hackathon/contracts";

/**
 * Session phase machine — NEGOTIATION-PROTOCOL.md §7.1.
 *
 * Two narrowings of the spec, both recorded there:
 *  - `impasse` is not a phase. The spec calls it "a flag on deliberation
 *    rather than an exclusive lock", and it is stored as `rooms.impasse_active`.
 *    Reaching an impasse is what moves a still-gathering room into
 *    `deliberation`: the room has stopped collecting and started resolving.
 *  - `agreed` and `arrival` are distinct. Committing an agreement enters
 *    `agreed` (the destination is settled); the first arrival plan enters
 *    `arrival` (people are working out how they get there).
 *
 * `setup` and `closed` are defined but unreachable in v1: rooms are seeded
 * with their participants already joined, and no command closes a session.
 */

export const PHASES = [
  "setup",
  "gathering",
  "deliberation",
  "agreed",
  "arrival",
  "closed",
] as const;
export type Phase = (typeof PHASES)[number];

export function isPhase(value: string): value is Phase {
  return (PHASES as readonly string[]).includes(value);
}

/** Which commands each phase accepts. Everything else is phase_unavailable. */
export const PHASE_GATES: Record<CommandType, readonly Phase[]> = {
  SubmitRequirement: ["gathering", "deliberation"],
  WithdrawRequirement: ["gathering", "deliberation"],
  EvaluateCandidates: ["gathering", "deliberation"],
  RespondToProposal: ["gathering", "deliberation"],
  SetSearchScope: ["gathering", "deliberation"],
  ProposeDestination: ["gathering", "deliberation"],
  ResolvePrivateRequest: ["gathering", "deliberation"],
  ConfirmPrivateRequest: ["gathering", "deliberation"],
  // Staging and committing need a proposal to exist, and the first proposal is
  // itself what enters deliberation.
  ConfirmAgreement: ["deliberation"],
  CommitAgreement: ["deliberation"],
  PlanArrival: ["agreed", "arrival"],
  // Readiness is a participant's own status, not a negotiation move: legal
  // wherever the room is live, so the always-visible UI toggle never errors.
  SetReadyState: ["setup", "gathering", "deliberation", "agreed", "arrival"],
};

interface Transition {
  from: Phase;
  /** The event type that triggers it. */
  on: string;
  to: Phase;
}

const TRANSITIONS: readonly Transition[] = [
  { from: "setup", on: "participant_joined", to: "gathering" },
  { from: "gathering", on: "proposal_created", to: "deliberation" },
  { from: "gathering", on: "impasse_detected", to: "deliberation" },
  { from: "deliberation", on: "agreement_committed", to: "agreed" },
  { from: "agreed", on: "arrival_plan_updated", to: "arrival" },
];

/**
 * Fold one command's events over the machine. Chaining is intentional: a
 * single command can produce several triggering events, and each is applied
 * against the phase the previous one left behind.
 */
export function nextPhase(
  current: Phase,
  eventTypes: readonly string[],
): Phase {
  let phase = current;
  for (const type of eventTypes) {
    const transition = TRANSITIONS.find((t) => t.from === phase && t.on === type);
    if (transition) phase = transition.to;
  }
  return phase;
}

export function isCommandLegal(type: CommandType, phase: Phase): boolean {
  return PHASE_GATES[type].includes(phase);
}

export function availableCommands(phase: Phase): CommandType[] {
  return COMMAND_TYPES.filter((type) => isCommandLegal(type, phase));
}

/** The destination is settled: negotiation is over for this room. */
export function isDecided(phase: Phase): boolean {
  return phase === "agreed" || phase === "arrival" || phase === "closed";
}
