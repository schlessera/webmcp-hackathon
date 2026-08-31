import { ERROR_CODES } from "./errors.ts";
import { CAPABILITY_MANIFEST } from "./manifest.ts";
import { TOOLS } from "./tools.ts";
import { COMMAND_SCHEMAS } from "./commands.ts";
import { PROTOCOL_VERSIONS, TOOL_CONTRACT_VERSION } from "./versions.ts";

/** Deterministic JSON: object keys sorted recursively. */
export function canonicalStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalStringify).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonicalStringify(
            (value as Record<string, unknown>)[k],
          )}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Output contracts are TypeScript interfaces with no runtime schema, so their
 * field lists are mirrored here — edit this descriptor together with the
 * interface (envelope.ts / realtime.ts) so response-shape changes move the
 * contract hash too.
 */
export const RESULT_CONTRACT = {
  successEnvelope: ["ok", "revision", "effect", "staged", "outstanding", "syncHint"],
  failureEnvelope: ["ok", "error.code", "error.message", "error.recovery", "delta"],
  syncSessionResult: [
    "ok", "revision", "buildId", "toolContractVersion", "phase", "identity",
    "manifest", "feasibility", "brief", "delta", "outstanding",
  ],
  delta: ["fromRevision", "events", "truncated", "cursor"],
  projectedEvent: ["revision", "type", "level", "text", "payload"],
  outstandingAdjustmentRequest: [
    "type", "requestId", "issuedAtRevision", "kind", "change",
    "projectedGain", "withinDelegatedBound", "staged",
  ],
  spatialContextResult: [
    "ok", "revision", "phase", "scope", "feasibility", "candidates",
    "proposals", "agreement", "arrival", "impasse",
  ],
  candidateSummary: [
    "candidateId", "name", "location", "category", "eligibility", "why",
    "walkMin", "priceLevel",
  ],
  proposalView: ["proposalId", "candidateId", "status", "stanceCounts", "vetoStands", "ownStance"],
  inspectCandidatesResult: ["ok", "revision", "candidates"],
  prepareNavigationResult: ["ok", "target", "links.geo", "links.googleMaps", "links.appleMaps"],
  realtime: {
    auth: ["type", "token", "clientBuildId", "clientToolContractVersion"],
    welcome: [
      "type", "buildId", "toolContractVersion", "revision",
      "participantId", "displayName", "role",
    ],
    event: ["type", "revision", "events"],
    error: ["type", "code", "message"],
  },
} as const;

/**
 * The canonical contract manifest (Gate 2): everything whose change must bump
 * toolContractVersion. CI fails when the hash changes without a bump.
 */
export function contractManifestObject() {
  return {
    toolContractVersion: TOOL_CONTRACT_VERSION,
    protocols: PROTOCOL_VERSIONS,
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: t.annotations,
    })),
    commands: COMMAND_SCHEMAS,
    errorCodes: ERROR_CODES,
    capabilityManifest: CAPABILITY_MANIFEST,
    results: RESULT_CONTRACT,
  };
}

export async function contractHash(): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256")
    .update(canonicalStringify(contractManifestObject()))
    .digest("hex");
}
