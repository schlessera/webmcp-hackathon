/**
 * Client-side types for the spatial read interface (binding contract with the
 * server; the contracts package will grow runtime schemas for these, but the
 * web client only consumes the JSON shapes).
 */

export type Eligibility = "eligible" | "uncertain" | "excluded";

export type Visibility = "shared" | "application-private" | "agent-private";

export interface ParticipantSummary {
  participantId: string;
  displayName: string;
  role: "organizer" | "member";
  readyState: "contributing" | "ready";
}

export interface CandidateSummary {
  candidateId: string;
  name: string;
  location: { lat: number; lng: number };
  category: string;
  eligibility: Eligibility;
  /** Redacted explanation, composed per viewer. */
  why: string;
  /** Minutes on foot from the current scope centre. */
  walkMin: number;
  /** null when the place has no price band on record. */
  priceLevel: number | null;
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
  counts: { yes?: number; no?: number; unknown: number };
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
  active: boolean;
  visibility: Visibility;
  hardness: "hard" | "soft";
  ownerId: string;
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
}

export interface SpatialScope {
  scopeId: string;
  area: { kind: "circle"; center: { lat: number; lng: number }; radiusM: number };
  transport: string[];
  category: string;
}

export interface SpatialContext {
  ok: true;
  revision: number;
  phase: string;
  scope: SpatialScope;
  feasibility: {
    state: "feasible" | "fragile" | "infeasible" | "uncertain";
    eligible: number;
    uncertain: number;
    excluded: number;
  };
  /** In-scope places: the denominator of "N of TOTAL". */
  total: number;
  /** In-scope places satisfying every active need. */
  matching: number;
  candidates: CandidateSummary[];
  facets: Facet[];
  activeNeeds: ActiveNeed[];
  privateEffects: PrivateEffect[];
  participants: ParticipantSummary[];
  proposals: ProposalView[];
  agreement?: { proposalId?: string; candidateId?: string; committedAtRevision?: number };
  arrival?: { mode?: string; pickupNote?: string };
  impasse?: { active: true; text: string };
}

export interface DossierAttribute {
  key: string;
  value?: unknown;
  status: "verified_true" | "verified_false" | "unverified" | "unknown";
  source: string;
  observedAt: string;
  confidence: number;
}

export interface CandidateDossier {
  candidateId: string;
  name: string;
  location: { lat: number; lng: number };
  category: string;
  priceLevel: number | null;
  hours?: Array<{ day: string; open: string; close: string }>;
  attributes: DossierAttribute[];
  mapRevision: number;
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
  /** A grant outside delegated bounds succeeded but awaits in-page confirmation. */
  staged?: boolean;
}

export type OutstandingItem =
  | OutstandingAdjustment
  | { type: "evaluation_request"; candidateIds: string[]; issuedAtRevision?: number }
  | { type: "stance_needed"; proposalId: string };

export interface CommandEnvelope {
  ok: boolean;
  revision?: number;
  effect?: string;
  outstanding?: OutstandingItem[];
  error?: { code: string; message: string; recovery?: string };
}
