/**
 * Client-side types for the spatial read interface (binding contract with the
 * server; the contracts package will grow runtime schemas for these, but the
 * web client only consumes the JSON shapes).
 */

export type Eligibility = "eligible" | "likely" | "uncertain" | "unlikely" | "excluded";

export type Visibility = "shared" | "application-private" | "agent-private";

export interface ParticipantOrigin {
  lat: number;
  lng: number;
  label: string;
  source: "fixture" | "device" | "stated";
  updatedAt: string;
}

export interface ParticipantSummary {
  participantId: string;
  displayName: string;
  role: "organizer" | "member";
  readyState: "contributing" | "ready";
  /** Has opened the room at least once. */
  arrived: boolean;
  /** Looking right now (open realtime socket). */
  present: boolean;
  /** The viewer's own application-private origin; absent on every peer row. */
  origin?: ParticipantOrigin;
}

/** Ephemeral, opt-in coordinates from the presence channel. Labels remain
 * private in ParticipantOrigin and never enter this shape. */
export interface SharedPosition {
  participantId: string;
  lat: number;
  lng: number;
  updatedAt: string;
}

export interface CandidateSummary {
  candidateId: string;
  /** Stable area-snapshot ref, when this place has one. */
  ref?: string;
  name: string;
  location: { lat: number; lng: number };
  category: string;
  eligibility: Eligibility;
  /** Redacted explanation, composed per viewer. */
  why: string;
  /** Minutes on foot from the viewer's origin, or the scope centre fallback. */
  walkMin: number;
  /** null when the place has no price band on record. */
  priceLevel: number | null;
  imageCount?: number;
  /** The place's first image with a blurhash placeholder, when it has one. */
  image?: { url: string; width: number; height: number; blurhash: string };
}

/** What is askable about the current results (FACETS.md §1). The client
 * renders `label` verbatim and branches on `type` — never on domain. */
export interface FacetValueCount {
  value: string;
  label: string;
  count: number;
}
export interface Facet {
  key: string;
  label: string;
  type: "boolean" | "enum" | "numeric" | "temporal" | "text";
  counts: { yes?: number; likely?: number; unlikely?: number; no?: number; unknown: number };
  values?: FacetValueCount[];
  unit?: string;
  range?: { min: number; max: number };
  histogram?: number[];
  salience?: number;
}

/** A need the viewer may see, with its counterfactual deltas (FACETS.md §2). */
export interface ActiveNeed {
  id: string;
  label: string;
  ruledOut: number;
  wouldReturn: number;
  unknown: number;
  /** How many this need alone leaves as a guess for it (§8.2). */
  likely?: number;
  /** How many this need alone leaves as a guess against it. */
  unlikely?: number;
  active: boolean;
  visibility: Visibility;
  hardness: "hard" | "soft";
  ownerId: string;
  /** The criterion this need reads; `q:<hash>` for a question the room asks
   * of the data, a vocabulary key otherwise (contracts criteria). */
  criterionId?: string;
  referent?: {
    kind: "scopeCenter" | "candidate" | "participant" | "point" | "landmark";
    label: string;
    location?: { lat: number; lng: number };
  };
}

/** A peer's private need, reduced to its effect (FACETS.md §4). Never the
 * predicate, the value, or the places it removed. */
export interface PrivateEffect {
  owner: string;
  ruledOut: number;
  topic?: string;
}

export interface ProposalView {
  proposalId: string;
  candidateId: string;
  status: "open" | "withdrawn" | "vetoed" | "staged" | "committed";
  /** One entry per participant. A stance the viewer may not see reads
   * "none", indistinguishable from silence. */
  stances: Array<{ participantId: string; stance: "accept" | "veto" | "none" }>;
  vetoStands: boolean;
  ownStance?: string;
  /** What staging waits on (server-computed, so a private accept stays
   * silent): names for readiness, a count for missing acceptances. */
  staging?: { ready: boolean; notReady: string[]; unaccepted: number; vetoStands: boolean };
}

export interface SpatialScope {
  scopeId: string;
  area: { kind: "circle"; center: { lat: number; lng: number }; radiusM: number };
  transport: string[];
  category: string;
}

/** Where the room's places came from (server-authored; see contracts AreaView). */
export interface AreaView {
  areaId: string;
  label: string;
  kind: "osm-snapshot" | "curated";
  source: string;
  dataAsOf: string;
  poolSize: number;
  focusVenues: number;
}

export interface PoolView {
  size: number;
  cap: number;
  explorable: boolean;
  filling: boolean;
  target: number;
}

export interface ExplorePlace {
  ref: string;
  name: string;
  location: { lat: number; lng: number };
  category: string;
  /** Optimistic local state after a successful bring-in, until the read path
   * supplies the real candidateId. Never masquerades as a candidate id. */
  added?: boolean;
  candidateId?: string;
}

export interface SpatialContext {
  ok: true;
  revision: number;
  phase: string;
  scope: SpatialScope;
  area?: AreaView;
  pool?: PoolView;
  /** Background fact refinement, when the server runs it for this room. */
  refine?: RefineView;
  feasibility: {
    state: "feasible" | "fragile" | "infeasible" | "uncertain";
    eligible: number;
    likely: number;
    uncertain: number;
    unlikely: number;
    excluded: number;
  };
  /** In-scope places: the denominator of "N of TOTAL". */
  total: number;
  /** In-scope places satisfying every active need. */
  matching: number;
  /** In-scope places that likely satisfy every active need. */
  likely: number;
  candidates: CandidateSummary[];
  facets: Facet[];
  activeNeeds: ActiveNeed[];
  privateEffects: PrivateEffect[];
  participants: ParticipantSummary[];
  proposals: ProposalView[];
  agreement?: {
    proposalId?: string;
    candidateId?: string;
    status?: "staged" | "committed";
    committedAtRevision?: number;
  };
  arrival?: { mode?: string; pickupNote?: string };
  impasse?: { active: true; text: string };
}

export interface DossierAttribute {
  key: string;
  value?: unknown;
  status: "verified_true" | "likely_true" | "likely_false" | "verified_false" | "unknown";
  source: string;
  observedAt: string;
  confidence: number;
  /** Present when someone in the room attested (or disputed) this fact. */
  attestedBy?: string;
  /** Permanent person confirmation provenance. */
  confirmedByName?: string;
  confirmedByParticipant?: string;
  confirmedAt?: string;
  /** Why the source says so: a rule's reason, an evidence span, a note. */
  note?: string;
  sourceUrl?: string;
  /** A question the room asked of the data (`q:` keys): the reader's label. */
  label?: string;
}

/** How this place stands against one need the viewer may see, composed
 * server-side (contracts CandidateNeedVerdict). A peer's private need is a
 * row with `private` and no label. */
export interface CandidateNeedVerdict {
  requirementId: string;
  label?: string;
  private?: true;
  verdict: "yes" | "likely" | "unlikely" | "no" | "unknown";
  confidence?: number;
  why?: string;
}

export interface CandidateDossier {
  candidateId: string;
  name: string;
  location: { lat: number; lng: number };
  category: string;
  priceLevel: number | null;
  hours?: Array<{ day: string; open: string; close: string }>;
  /** Current opening state and server-composed wall-clock details. Absent or
   * null remains unknown; the page must not infer it from weekly rows. */
  openNow?: boolean | null;
  openUntil?: string;
  nextOpen?: string;
  attributes: DossierAttribute[];
  mapRevision: number;
  /** Server-authored labels; the client renders them verbatim. */
  links?: Array<{ kind: string; label: string; url: string; source: string }>;
  description?: { text: string; source: string };
  rating?: { value: number; best: number; count?: number; source: string; label: string };
  awards?: Array<{ label: string; source: string }>;
  images?: Array<{
    url: string;
    width: number;
    height: number;
    source: string;
    credit?: string;
    license?: string;
    pageUrl?: string;
    blurhash?: string;
  }>;
  address?: string;
  phone?: string;
  needs?: CandidateNeedVerdict[];
  /** The server is looking this place up right now. */
  lookupPending?: boolean;
  /** When the server last looked this place up, ISO time; absent when never. */
  lookedUpAt?: string;
}

/** What the refinement worker is doing for this room (contracts). */
export interface RefineView {
  active: boolean;
  queued: number;
  checkedToday: number;
  budgetLeft: { calls: number; searches: number };
  /** Why work is not advancing. Older servers omit this field. */
  paused?: "budget" | "idle" | null;
  /** Places still needing work for an ACTIVE need, excluding the background
   * sweeps. Older servers omit it; `queued` is the fallback. */
  tier1Queued?: number;
}

/** The room's pool of places as it stands (contracts PoolView). */
export interface PoolView {
  size: number;
  cap: number;
  explorable: boolean;
  filling: boolean;
  target: number;
}

export interface NavigationLinks {
  target: { candidateId: string; name: string };
  links: { geo: string; googleMaps: string; appleMaps: string };
}

export interface OutstandingAdjustment {
  type: "adjustment_request";
  requestId: string;
  kind: string;
  change: Record<string, unknown>;
  projectedGain?: { newCandidates?: number };
  withinDelegatedBound?: boolean;
  /** The viewer's own stated ceiling for the targeted need, when there is one. */
  delegatedBound?: { dimension: "radius_m" | "per_person_eur" | "walk_min"; max: number };
  /** A grant outside delegated bounds succeeded but awaits in-page confirmation. */
  staged?: boolean;
}

export type OutstandingItem =
  | OutstandingAdjustment
  | {
      type: "evaluation_request";
      candidateIds: string[];
      issuedAtRevision?: number;
      /** The page's own agent screens for this person; the card is not needed. */
      heldByPageAgent?: true;
    }
  | { type: "stance_needed"; proposalId: string };

export interface CommandEnvelope {
  ok: boolean;
  revision?: number;
  effect?: string;
  outstanding?: OutstandingItem[];
  error?: { code: string; message: string; recovery?: string };
}
