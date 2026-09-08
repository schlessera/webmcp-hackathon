import type { ToolError } from "./errors.ts";
import type { CapabilityManifest, Visibility } from "./manifest.ts";
import type { RoomStepView } from "./steps.ts";

/** HTTP result shapes — INTERACTION-AND-BINDING.md §3. The WebMCP binding
 * compacts successful reads and can reject on transport or unexpected errors. */

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
  /** Opaque continuation over stored events, including events omitted by the
   * viewer's projection. Pass it back to sync_session unchanged. */
  cursor?: string;
  /** Last stored revision consumed by this page. This is deliberately not
   * the room revision while `truncated` is true. */
  throughRevision?: number;
  /** Explicit escape hatch for a backlog beyond the replay safety cap;
   * callers must replace projections from a full sync instead of skipping. */
  resyncRequired?: "backlog_too_large";
}

export interface SuccessEnvelope {
  ok: true;
  revision: number;
  /** ≤200 chars */
  effect?: string;
  /** True when the command was accepted but its consequence is STAGED pending
   * in-page confirmation (agreement or an over-bound consent grant). */
  staged?: boolean;
  outstanding: OutstandingItem[];
  syncHint?: { eventsSinceYourLastSync: number };
  /** True when this envelope was served from the idempotency store: the
   * logical action already succeeded, possibly only as a staged change. */
  replayed?: true;
  /** Authoritative subject of the command, returned to its authenticated actor. */
  receipt?: {
    entity: "requirement" | "proposal";
    id: string;
    operation: "created" | "updated" | "withdrawn" | "activated" | "deactivated";
    /** Normalized requirement, never the content of an agent-private declaration. */
    requirement?: {
      visibility: Visibility;
      hardness: "hard" | "soft";
      active: boolean;
      payload?: Record<string, unknown>;
      delegation?: { mode: string; bound?: unknown };
    };
  };
  feasibility?: Feasibility;
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

/** Application-private starting position. Only the owner receives it. */
export interface ParticipantOrigin {
  lat: number;
  lng: number;
  label: string;
  source: "fixture" | "device" | "stated";
  updatedAt: string;
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
  /** Present only on the viewer's own row; omitted entirely for peers. */
  origin?: ParticipantOrigin;
}

export interface Feasibility {
  state: "feasible" | "fragile" | "infeasible" | "uncertain";
  eligible: number;
  /** Satisfy active hard needs using likely evidence (§8.2); separate from eligible. */
  likely: number;
  uncertain: number;
  /** Fail an active hard need on likely evidence; separate from excluded. */
  unlikely: number;
  excluded: number;
}

/**
 * sync_session result — NEGOTIATION-PROTOCOL.md §6.1, including the running
 * buildId and toolContractVersion. With neither sinceRevision nor cursor:
 * manifest present, delta absent. With either: delta present, manifest absent.
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

export type Eligibility = "eligible" | "likely" | "uncertain" | "unlikely" | "excluded";

export interface CandidateSummary {
  candidateId: string;
  /** Stable source ref when the place came from an area snapshot. */
  ref?: string;
  name: string;
  location: LatLng;
  category: string;
  eligibility: Eligibility;
  /** For likely / unlikely: the product of the confidences of the likely
   * facts the classification rests on (§8.2). Absent otherwise. */
  confidence?: number;
  /** Viewer-projected, ≤60 characters: may describe shared needs or the
   * viewer's own private needs. Omitted when eligibility is `eligible`. */
  why?: string;
  /** Straight-line walking estimate from this viewer's origin, falling back
   * to the current scope centre; recomputed per read, without routing. */
  walkMin: number;
  /** null when the place has no price band on record — never coerced to 0. */
  priceLevel: number | null;
  /** Image count only. Agent-facing context never receives image URLs. */
  imageCount?: number;
  /** The first stored image, only once its placeholder is available. The URL
   * is always the server's same-origin image route. */
  image?: { url: string; width: number; height: number; blurhash: string };
}

/** One participant's projected stance: the viewer's own or a shared stance.
 * A peer's private stance reads "none" here; aggregate proposal fields can
 * still report its effect, including a standing veto. */
export interface ProposalStance {
  participantId: string;
  stance: "accept" | "veto" | "none";
}

export interface ProposalView {
  proposalId: string;
  candidateId: string;
  status: "open" | "withdrawn" | "vetoed" | "staged" | "committed";
  /** One entry per participant, in roster order. Carries the viewer's own
   * stance plus shared-visible ones; peer-private stances read "none" in
   * this field. Aggregate staging and veto fields still report their effects. */
  stances: ProposalStance[];
  /** A standing veto blocks agreement; reported as a boolean, never a count. */
  vetoStands: boolean;
  ownStance?: string;
  /**
   * The §3.7 precondition as it stands, so the page can say who staging
   * waits on instead of offering a button that fails. `notReady` names people
   * (readiness is roster-public); `unaccepted` counts participants without
   * an accept or abstain, without naming whose stance is missing.
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
 * Askable facts about the current candidate set (FACETS.md §1). Facet
 * controls use the server-authored label and branch on type. These records
 * have no category or domain field.
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
  /** `unknown` is mandatory. `likely`
   * and `unlikely` count graded facts (§8.2); absent means zero. */
  counts: { yes?: number; likely?: number; unlikely?: number; no?: number; unknown: number };
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
  /** Fact lookup identity; absent for deterministic budget and scope needs. */
  criterionId?: string;
  /** Server-composed, viewer-authorized. */
  label: string;
  /** How many in-scope places this need ALONE rules out. */
  ruledOut: number;
  /** How many come back if it were dropped from the current set. */
  wouldReturn: number;
  /** How many this need alone leaves uncertain; excludes likely/unlikely. */
  unknown: number;
  /** How many this need alone leaves as a guess FOR it (§8.2). */
  likely?: number;
  /** How many this need alone leaves as a guess AGAINST it. */
  unlikely?: number;
  /** False when the owner has set it aside; the row stays, greyed. */
  active: boolean;
  visibility: Visibility;
  hardness: "hard" | "soft";
  ownerId: string;
  /** Absolute schedule for a visible time requirement; no relative-date parsing needed. */
  window?: { start: string; end: string };
  /** A non-self place this scope need is measured from. `location` is
   * omitted when this reader is not entitled to the referent's position. */
  referent?: {
    kind: "scopeCenter" | "candidate" | "participant" | "point" | "landmark";
    label: string;
    location?: LatLng;
  };
  /** The circle this need draws on the map: what it reaches, and from where.
   * Present for a distance or time bound whose measuring point this reader
   * may see; `participantId` names the person it is anchored on, when it is
   * anchored on a person rather than a place. */
  range?: {
    radiusM: number;
    center: LatLng;
    participantId?: string;
  };
}

/**
 * A peer's private need, reduced here to its owner and ruled-out count
 * (FACETS.md §4). This record omits the predicate and removed place IDs.
 * `topic` is the owner's opt-in scope hint, omitted when they gave none.
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
 * fixtures. `dataAsOf` is the source extract timestamp, not a guarantee
 * that the recorded facts are still true or a live verification time.
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
  /** Current live pool size, and the source's named-place count within its
   * wide focus radius. */
  poolSize: number;
  focusVenues: number;
}

/**
 * The active step's live pool (SPATIAL-PROTOCOL §5.5): its current size and
 * ceiling, and whether a prepared area snapshot can supply exploration rows.
 */
export interface PoolView {
  /** Candidate rows in the active step's live pool. */
  size: number;
  /** Hard ceiling for candidate rows in the active step's live pool. */
  cap: number;
  /** Whether the area's snapshot can supply viewport exploration rows. */
  explorable: boolean;
  /** True while snapshot venues remain to be added from the current circle
   * and the room has not reached `cap`. */
  filling: boolean;
  /** Automatic fill target: at least the live size, incorporating prepared
   * places for the active step and circle, up to `cap`. */
  target: number;
}

/**
 * One prepared-area place in the map's explore layer. It may already be in
 * the live pool; `candidateId` then lets the page avoid drawing it twice.
 */
export interface ExplorePlace {
  ref: string;
  name: string;
  location: LatLng;
  category: string;
  candidateId?: string;
}
export interface ExplorePlacesResult {
  ok: true;
  places: ExplorePlace[];
  /** True when the bbox held more than the cap; zoom in to see the rest. */
  truncated: boolean;
}

export interface SpatialContextResult {
  ok: true;
  revision: number;
  phase: string;
  identity?: ParticipantIdentity;
  timezone?: string;
  /** Outstanding work from the same database snapshot as this context. */
  outstanding?: OutstandingItem[];
  /** The room's stored goal, when present. */
  goal?: string;
  /** The room's plan: ordered steps, their status and any settled destination.
   * Omitted for rooms without a plan; the active step owns the live pool. */
  steps?: RoomStepView[];
  activeStepId?: string | null;
  scope: ScopeView | null;
  area?: AreaView;
  pool?: PoolView;
  /** Process-local background fact refinement, when available. */
  refine?: {
    active: boolean;
    /** Places still needing work for active needs. General vocabulary and
     * stale-fact sweeps are excluded; changing facts or needs can change it. */
    queued: number;
    /** The same number under its earlier name, kept for existing readers. */
    tier1Queued: number;
    checkedToday: number;
    /** Reported pause reason: model budget or idle room; null otherwise. */
    paused: "budget" | "idle" | null;
    budgetLeft: { calls: number; searches: number };
  };
  feasibility: Feasibility;
  /** Places inside the current scope — the denominator of "N of TOTAL". The
   * candidates array carries more: out-of-scope places are returned excluded
   * so the map can fade them in place rather than re-layout. */
  total: number;
  /** In-scope places classified eligible against every active hard need. */
  matching: number;
  /** In-scope places satisfying active hard needs using likely evidence (§8.2). */
  likely: number;
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

/** A link the place panel offers; `label` is server-authored. */
export interface DossierLinkView {
  kind: string;
  label: string;
  url: string;
  source: string;
}

/** A rating from a place's own website or a configured Google listing source.
 * The source and label identify where it was observed. */
export interface DossierRating {
  value: number;
  best: number;
  count?: number;
  source: string;
  /** Server-authored attribution, e.g. "as published by the place" or "on Google". */
  label: string;
}

export interface CandidateDossier {
  candidateId: string;
  name: string;
  location: LatLng;
  category: string;
  timezone?: string;
  asOf?: string;
  priceLevel: number | null;
  hours: Array<{ day: string; open: string; close: string }>;
  /** Current status in the area's timezone. Absent with no hours; null when
   * hours exist but cannot answer. */
  openNow?: boolean | null;
  /** Clock-only status details in the area's timezone. Additive so older
   * readers can continue using `openNow` alone. */
  openUntil?: string;
  nextOpen?: string;
  links?: DossierLinkView[];
  description?: { text: string; source: string };
  rating?: DossierRating;
  awards?: Array<{ label: string; source: string }>;
  images?: Array<{
    /** Same-origin server route, never a third-party URL. */
    url: string;
    width: number;
    height: number;
    blurhash?: string;
    source: string;
    credit?: string;
    license?: string;
    pageUrl?: string;
  }>;
  attributes: Array<{
    key: string;
    /** Reader-facing name for a non-vocabulary fact, such as the question a lookup answered. */
    label?: string;
    value?: string | number;
    status: string;
    source: string;
    observedAt: string;
    confidence: number;
    /** Participant who supplied an attestation, when this fact is attested. */
    attestedBy?: string;
    /** Present when a named person confirmation in this room decided it. */
    confirmedByName?: string;
    confirmedByParticipant?: string;
    confirmedAt?: string;
    /** Why the source says so: a rule's reason, a verbatim evidence span an
     * inference rests on, an attester's note. Rendered in the ledger. */
    note?: string;
    /** Optional evidence link supplied with an attestation. */
    sourceUrl?: string;
  }>;
  /** The record's street address and contact, when the data carries them. */
  address?: string;
  phone?: string;
  /**
   * How this place stands against each need the viewer may see, composed
   * server-side so the page never parses a label. Every peer-private need
   * collapses into ONE row with `private: true`, no `requirementId` and no
   * label, carrying the worst verdict any of them reaches (CLAUDE.md §5: the
   * effect is public, the content is not). `verdict` follows §8.2:
   * yes / likely / unlikely / no / unknown.
   */
  needs?: CandidateNeedVerdict[];
  /** Places the server is looking up right now include this one. */
  lookupPending?: boolean;
  /** When the server last looked this place up (site, Wikidata or an
   * inference), ISO time; absent when it never has. */
  lookedUpAt?: string;
  mapRevision: number;
  /** Public source observations, including facility scope and original date.
   * Reports remain likely; fetchedAt is not an observation date. */
  sourceEvidence?: Array<{
    source: string;
    sourceUrl: string;
    license: string;
    licenseUrl?: string;
    placeId: string;
    placeName: string;
    relation: "at_place" | "nearby";
    distanceM?: number;
    fetchedAt: string;
    facts: Array<{
      key: string;
      value: boolean | null;
      subject: "place" | "entrance" | "toilet";
      subjectId?: string;
      qualifiers: string[];
      observedAt?: string;
    }>;
  }>;
}

export interface CandidateNeedVerdict {
  /** Absent on the single aggregate row that stands for every peer-private
   * need: naming one would let a reader pair a verdict with a need. */
  requirementId?: string;
  criterionId?: string;
  label?: string;
  private?: true;
  verdict: "yes" | "likely" | "unlikely" | "no" | "unknown";
  confidence?: number;
  /** Reader-facing, ≤60 chars, never wire vocabulary. */
  why?: string;
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
