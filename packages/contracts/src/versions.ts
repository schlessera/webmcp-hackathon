/**
 * Three independent version concepts (VALIDATION-SPIKE-1 Gate 2):
 * - buildId: changes with every deployed bundle (injected at build time, not here)
 * - toolContractVersion: changes when tool names, schemas, or result contracts change
 * - domain versions: negotiation and spatial versions evolve independently
 */
// 2: the facets contract (FACETS.md) — spatial context gained total/matching/
// facets/activeNeeds/privateEffects/participants, ProposalView replaced the
// anonymized stanceCounts with named public stances, and SetRequirementActive
// joined the command bus. Breaking: stanceCounts is gone.
export const TOOL_CONTRACT_VERSION = "2";

export const PROTOCOL_VERSIONS = {
  negotiation: "v1",
  domain: "spatial-destination/v1",
} as const;
