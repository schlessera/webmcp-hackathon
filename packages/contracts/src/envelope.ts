import type { ToolError } from "./errors.ts";
import type { CapabilityManifest, Visibility } from "./manifest.ts";

/** Shared result envelope — INTERACTION-AND-BINDING.md §3. Tools always resolve, never reject. */

export interface OutstandingEvaluationRequest {
  type: "evaluation_request";
  candidateIds: string[];
  issuedAtRevision: number;
}
export interface OutstandingStanceNeeded {
  type: "stance_needed";
  proposalId: string;
}
export interface OutstandingAdjustmentRequest {
  type: "adjustment_request";
  requestId: string;
  issuedAtRevision: number;
}
export type OutstandingItem =
  | OutstandingEvaluationRequest
  | OutstandingStanceNeeded
  | OutstandingAdjustmentRequest;

/** One event projected for one viewer (NEGOTIATION-PROTOCOL.md §4.1). */
export type ProjectionLevel = "full" | "existence" | "aggregate";
export interface ProjectedEvent {
  revision: number;
  type: string;
  level: ProjectionLevel;
  /** Server-composed template string; never raw peer text at existence/aggregate. */
  text: string;
  /** Present only at level "full" (viewer-authorized content). */
  payload?: unknown;
}

export interface Delta {
  fromRevision: number;
  events: ProjectedEvent[];
  truncated: boolean;
  cursor?: string;
}

export interface SuccessEnvelope {
  ok: true;
  revision: number;
  /** ≤200 chars */
  effect?: string;
  outstanding: OutstandingItem[];
  syncHint?: { eventsSinceYourLastSync: number };
}

export interface FailureEnvelope {
  ok: false;
  error: ToolError;
  /** Included for sync_required. */
  delta?: Delta;
}

export type ToolResult = SuccessEnvelope | FailureEnvelope;

export interface ParticipantIdentity {
  participantId: string;
  displayName: string;
  role: "organizer" | "member";
}

export interface Feasibility {
  state: "feasible" | "fragile" | "infeasible" | "uncertain";
  eligible: number;
  uncertain: number;
  excluded: number;
}

/**
 * sync_session result — NEGOTIATION-PROTOCOL.md §6.1 extended with the
 * environment versions Gate 5 needs (buildId, toolContractVersion).
 * Without sinceRevision: manifest present, delta absent (first connection).
 * With sinceRevision: delta present, manifest absent.
 */
export interface SyncSessionResult {
  ok: true;
  revision: number;
  buildId: string;
  toolContractVersion: string;
  phase: string;
  identity: ParticipantIdentity;
  manifest?: CapabilityManifest;
  feasibility?: Feasibility;
  /** ≤400 chars natural-language summary. */
  brief: string;
  delta?: Delta;
  outstanding: OutstandingItem[];
}

export type SyncSessionResponse = SyncSessionResult | FailureEnvelope;

export type { Visibility };
