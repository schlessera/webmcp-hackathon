/**
 * Client-side types for the spatial read interface (binding contract with the
 * server; the contracts package will grow runtime schemas for these, but the
 * web client only consumes the JSON shapes).
 */

export type Eligibility = "eligible" | "uncertain" | "excluded";

export interface CandidateSummary {
  candidateId: string;
  name: string;
  location: { lat: number; lng: number };
  category: string;
  eligibility: Eligibility;
  why: string;
  walkMin: number;
  priceLevel: number | null;
}

export interface ProposalView {
  proposalId: string;
  candidateId: string;
  status: "open" | "withdrawn" | "vetoed" | "staged" | "committed";
  stanceCounts: { accept: number; reject: number; other: number };
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
  candidates: CandidateSummary[];
  proposals: ProposalView[];
  agreement?: { proposalId?: string; candidateId?: string; committedAtRevision?: number };
  arrival?: { mode?: string; pickupNote?: string };
  impasse?: { active: boolean };
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
