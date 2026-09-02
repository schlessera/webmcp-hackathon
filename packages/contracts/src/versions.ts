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
// 3: the pool grows (SPATIAL-PROTOCOL §5.5) — AddCandidates joined the
// command bus with the add_candidates tool, look_up_places asks for facts on
// demand, spatial context gained `pool`, dossiers gained address / phone /
// per-need verdicts / a note per attribute, and the realtime channel gained
// the presentation-only `lookups` and `facts` frames. Additive on the wire;
// bumped because the tool catalog changed. Protocol reliability then added
// optional sync continuation/result fields and event `fromRevision` without
// another bump (R1/R10; additive under INTERACTION-AND-BINDING.md §6).
export const TOOL_CONTRACT_VERSION = "3";

export const PROTOCOL_VERSIONS = {
  negotiation: "v1",
  domain: "spatial-destination/v1",
} as const;
