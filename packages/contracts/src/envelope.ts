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
  kind: "scope_change" | "requirement_relaxation";
  /** Domain change payload, e.g. { dimension: "radius_m", from: 800, to: 1400 }. */
  change: Record<string, unknown>;
  projectedGain: { newCandidates: number };
  withinDelegatedBound: boolean;
  /** True when a grant awaits the human's in-page confirmation. */
  staged: boolean;
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
  /** True when the command was accepted but its consequence is STAGED pending
   * the human's in-page confirmation (over-bound consent grants). */
  staged?: boolean;
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

/** Spatial read results — SPATIAL-PROTOCOL.md §4.1/§6/§9. Reads carry no baseRevision. */

export interface LatLng {
  lat: number;
  lng: number;
}

export interface ScopeView {
  scopeId: string;
  area: { kind: "circle"; center: LatLng; radiusM: number };
  transport: string[];
  category: string;
}

export interface CandidateSummary {
  candidateId: string;
  name: string;
  location: LatLng;
  category: string;
  eligibility: "eligible" | "uncertain" | "excluded";
  /** Redacted: cites evidence status and shared requirements only. */
  why: string;
  walkMin: number;
  priceLevel: number;
}

export interface ProposalView {
  proposalId: string;
  candidateId: string;
  status: "open" | "withdrawn" | "vetoed" | "staged" | "committed";
  /** Counts over the viewer's own stance plus shared-visible stances only —
   * raw totals would de-anonymize private stances by subtraction. */
  stanceCounts: { accept: number; other: number };
  /** A standing veto blocks agreement; reported as a boolean, never a count. */
  vetoStands: boolean;
  ownStance?: string;
}

export interface AgreementView {
  proposalId: string;
  candidateId: string;
  status: "staged" | "committed";
  committedAtRevision?: number;
}

export interface ArrivalPlanView {
  mode: "walk" | "bike" | "car";
  pickupNote?: string;
}

export interface SpatialContextResult {
  ok: true;
  revision: number;
  phase: string;
  scope: ScopeView | null;
  feasibility: Feasibility;
  candidates: CandidateSummary[];
  proposals: ProposalView[];
  agreement?: AgreementView;
  /** The caller's own plan only — peers' plans are never returned here. */
  arrival?: ArrivalPlanView;
  impasse?: { active: true; text: string };
}

export interface CandidateDossier {
  candidateId: string;
  name: string;
  location: LatLng;
  category: string;
  priceLevel: number;
  hours: Array<{ day: string; open: string; close: string }>;
  attributes: Array<{
    key: string;
    value?: string | number;
    status: string;
    source: string;
    observedAt: string;
    confidence: number;
  }>;
  mapRevision: number;
}

export interface InspectCandidatesResult {
  ok: true;
  revision: number;
  candidates: CandidateDossier[];
}

export interface PrepareNavigationResult {
  ok: true;
  target: { candidateId: string; name: string; location: LatLng };
  links: { geo: string; googleMaps: string; appleMaps: string };
}

export type SpatialContextResponse = SpatialContextResult | FailureEnvelope;
export type InspectCandidatesResponse = InspectCandidatesResult | FailureEnvelope;
export type PrepareNavigationResponse = PrepareNavigationResult | FailureEnvelope;

export type { Visibility };
