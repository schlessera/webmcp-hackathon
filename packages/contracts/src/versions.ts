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
// bumped because the tool catalog changed. The lookup tool's read-only hint
// was later removed within v3 because it performs cache writes and paid I/O.
// Protocol reliability then added
// optional sync continuation/result fields and event `fromRevision` without
// another bump (R1/R10; additive under INTERACTION-AND-BINDING.md §6). The
// page-private NL response later gained optional `partial` and
// `failureCategory` fields (R7), also additive and outside registered tools.
// Pass 3 added result-budget omission markers, `temporarily_unavailable`, and
// stricter validation of already-invalid inputs (R15/R17); it also corrected
// the manifest by withdrawing the never-implemented meeting-points claim and
// replaced the incomplete field mirror with generated result schemas (R16/R18).
// Protocol fixes then added optional verdict `screenedMapRevision` and a
// sync-specific 8K result allowance; both only add accepted input/room for
// existing output, so TOOL_CONTRACT_VERSION remains v3 (X1/X2).
// No callable field or tool was removed, so the additive policy keeps v3.
export const TOOL_CONTRACT_VERSION = "3";

export const PROTOCOL_VERSIONS = {
  negotiation: "v1",
  domain: "spatial-destination/v1",
} as const;
