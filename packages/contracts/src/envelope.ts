import type { ToolError } from "./errors.ts";
import type { CapabilityManifest, Visibility } from "./manifest.ts";

/** Shared result envelope — INTERACTION-AND-BINDING.md §3. Tools always resolve, never reject. */

export interface OutstandingEvaluationRequest {
  type: "evaluation_request";
  candidateIds: string[];
  issuedAtRevision: number;
  /** The page's own agent holds this person's condition and screens for
   * them (docs/NL-AGENT.md); present only then, so the page can keep the
   * "places to screen" card for an agent that is elsewhere. */
  heldByPageAgent?: true;
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
  /** The addressee's own delegated ceiling for the targeted need, when one
   * was stated, so the consent copy can name the number. Absent for scope
   * changes (organizer authority carries no bound). */
  delegatedBound?: { dimension: "radius_m" | "per_person_eur" | "walk_min"; max: number };
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
  /** The acting participant, only at level "full" and only for events a
   * person (not the council) authored. Peers of a private move never get it. */
  actorId?: string;
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

/** One participant in the room's roster (shared, non-sensitive presence). */
export interface ParticipantSummary {
  participantId: string;
  displayName: string;
  role: "organizer" | "member";
  readyState: "contributing" | "ready";
  /** Has opened the room at least once (first sync on any surface). */
  arrived: boolean;
  /** Holds an open realtime socket right now. */
  present: boolean;
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
  /** Everyone in the room — the header's presence row. */
  participants: ParticipantSummary[];
  /** The revision this participant's previous sync (any surface, any tab)
   * had seen; null when this is their first arrival. Revision 0 is a real
   * value — an empty room they opened and left. What "while you were away"
   * spans. */
  lastSyncedRevision: number | null;
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
  /** Minutes on foot from the CURRENT scope centre, recomputed per read. */
  walkMin: number;
  /** null when the place has no price band on record — never coerced to 0. */
  priceLevel: number | null;
}

/** One participant's PUBLIC stance on a proposal. A stance the viewer may not
 * see (a peer's private one) reads "none", exactly like no stance at all —
 * the veto boolean is what carries a private rejection. */
export interface ProposalStance {
  participantId: string;
  stance: "accept" | "veto" | "none";
}

export interface ProposalView {
  proposalId: string;
  candidateId: string;
  status: "open" | "withdrawn" | "vetoed" | "staged" | "committed";
  /** One entry per participant, in roster order. Carries the viewer's own
   * stance plus shared-visible ones; everything else reads "none", so private
   * stances stay indistinguishable from silence. */
  stances: ProposalStance[];
  /** A standing veto blocks agreement; reported as a boolean, never a count. */
  vetoStands: boolean;
  ownStance?: string;
  /**
   * The §3.7 precondition as it stands, so the page can say who staging
   * waits on instead of offering a button that fails. `notReady` names people
   * (readiness is roster-public); `unaccepted` is a count only, because a
   * private stance must stay indistinguishable from silence.
   */
  staging: { ready: boolean; notReady: string[]; unaccepted: number; vetoStands: boolean };
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

/**
 * What is askable about the current candidate set (FACETS.md §1). Every
 * control in the UI is generated from these: the client renders `label`
 * verbatim and branches on `type`, never on domain. There is deliberately no
 * category or domain field.
 */
export interface FacetValueCount {
  value: string;
  label: string;
  count: number;
}
export interface Facet {
  /** Stable, machine-readable, never rendered. Round-trips into a requirement
   * payload, so it stays inside ATTRIBUTE_VOCABULARY where one applies. */
  key: string;
  /** The only string the UI shows. Server-authored, lowercase, domain-natural. */
  label: string;
  type: "boolean" | "enum" | "numeric" | "temporal" | "text";
  /** `unknown` is mandatory: unverified is a state the UI draws. */
  counts: { yes?: number; no?: number; unknown: number };
  /** enum only. */
  values?: FacetValueCount[];
  /** numeric only. */
  unit?: string;
  range?: { min: number; max: number };
  histogram?: number[];
  /** Optional 0-1 ordering hint. Absent: the array is already in render order. */
  salience?: number;
}

/**
 * One need the viewer may see (their own, or shared), with the counterfactual
 * deltas the brief rows and the delta chip need (FACETS.md §2). Peers' private
 * needs are never here — they surface as PrivateEffect instead.
 */
export interface ActiveNeed {
  id: string;
  /** Server-composed, viewer-authorized. */
  label: string;
  /** How many in-scope places this need ALONE rules out. */
  ruledOut: number;
  /** How many come back if it were dropped from the current set. */
  wouldReturn: number;
  /** How many this need alone leaves unverified. */
  unknown: number;
  /** False when the owner has set it aside; the row stays, greyed. */
  active: boolean;
  visibility: Visibility;
  hardness: "hard" | "soft";
  ownerId: string;
}

/**
 * A peer's private need, reduced to its effect (FACETS.md §4 / invariant 5):
 * never the predicate, the value, or the places it removed. `topic` is the
 * owner's opt-in scope hint, omitted when they gave none.
 */
export interface PrivateEffect {
  /** participantId of the owner. */
  owner: string;
  ruledOut: number;
  topic?: string;
}

/**
 * Where the room's places came from, so the page can say so. Present when
 * the room was seeded from an area (docs/DATA-QUALITY.md); absent for bare
 * fixtures. `dataAsOf` is the extract timestamp: the moment the facts were
 * true in OpenStreetMap, never the moment they were read.
 */
export interface AreaView {
  areaId: string;
  label: string;
  /** "osm-snapshot": the area snapshot; "curated": the shipped demo dataset
   * (real tags plus a curated overlay whose provenance every attribute
   * names). */
  kind: "osm-snapshot" | "curated";
  source: string;
  dataAsOf: string;
  /** How many places the room started with, and how many named places the
   * data holds within the wide radius of its centre. */
  poolSize: number;
  focusVenues: number;
}

export interface SpatialContextResult {
  ok: true;
  revision: number;
  phase: string;
  scope: ScopeView | null;
  area?: AreaView;
  feasibility: Feasibility;
  /** Places inside the current scope — the denominator of "N of TOTAL". The
   * candidates array carries more: out-of-scope places are returned excluded
   * so the map can fade them in place rather than re-layout. */
  total: number;
  /** Places currently satisfying every active need. */
  matching: number;
  candidates: CandidateSummary[];
  facets: Facet[];
  activeNeeds: ActiveNeed[];
  privateEffects: PrivateEffect[];
  participants: ParticipantSummary[];
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
  priceLevel: number | null;
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
