import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import AjvModule from "ajv";
import addFormatsModule from "ajv-formats";
import {
  BUDGETS,
  CAPABILITY_MANIFEST,
  COMMAND_SCHEMAS,
  ERROR_CODES,
  PROTOCOL_VERSIONS,
  SYNC_SESSION_INPUT,
  TOOLS,
  TOOL_CONTRACT_VERSION,
} from "@webmcp-hackathon/contracts";
import {
  canonicalStringify,
  contractHash,
  RESULT_SCHEMAS,
} from "@webmcp-hackathon/contracts/hash";

const Ajv = ((AjvModule as never as { default?: unknown }).default ??
  AjvModule) as typeof AjvModule.default;
const addFormats = ((addFormatsModule as never as { default?: unknown }).default ??
  addFormatsModule) as typeof addFormatsModule.default;
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);

describe("tool schemas (lane 1)", () => {
  const validate = ajv.compile(SYNC_SESSION_INPUT);

  it("accepts valid arguments", () => {
    expect(validate({})).toBe(true);
    expect(validate({ sinceRevision: 0 })).toBe(true);
    expect(validate({ sinceRevision: 42 })).toBe(true);
  });

  it("rejects extra arguments (additionalProperties: false)", () => {
    expect(validate({ sinceRevision: 1, actorId: "p_joe" })).toBe(false);
    expect(validate({ unexpected: true })).toBe(false);
  });

  it("rejects malformed arguments", () => {
    expect(validate({ sinceRevision: "42" })).toBe(false);
    expect(validate({ sinceRevision: -1 })).toBe(false);
    expect(validate({ sinceRevision: 1.5 })).toBe(false);
  });

  it("every command schema closes additionalProperties and requires baseRevision", () => {
    for (const [name, schema] of Object.entries(COMMAND_SCHEMAS)) {
      const s = schema as unknown as {
        additionalProperties?: boolean;
        required?: string[];
      };
      expect(s.additionalProperties, name).toBe(false);
      expect(s.required, name).toContain("baseRevision");
    }
  });

  it("additively admits a SHA-1 question key for attestations", () => {
    const validate = ajv.compile(COMMAND_SCHEMAS.AttestAttribute);
    expect(validate({
      baseRevision: 0,
      candidateId: "c1",
      key: `q:${"a".repeat(40)}`,
      status: "verified_true",
      confidence: 0.8,
      note: "checked directly",
    })).toBe(true);
    expect(validate({
      baseRevision: 0,
      candidateId: "c1",
      key: "q:not-a-sha1",
      status: "verified_true",
      confidence: 0.8,
      note: "checked directly",
    })).toBe(false);
    expect(TOOL_CONTRACT_VERSION).toBe("3");
  });

  it("rejects oversized arguments (verdict batch cap, note cap)", () => {
    const evaluate = ajv.compile(COMMAND_SCHEMAS.EvaluateCandidates);
    const oversized = {
      baseRevision: 0,
      verdicts: Array.from({ length: 11 }, (_, i) => ({
        candidateId: `place_${i}`,
        verdict: "acceptable",
      })),
    };
    expect(evaluate(oversized)).toBe(false);

    const submit = ajv.compile(COMMAND_SCHEMAS.SubmitRequirement);
    expect(
      submit({
        baseRevision: 0,
        visibility: "shared",
        hardness: "hard",
        delegation: { mode: "approval_required" },
        payload: { kind: "attribute", key: "cuisine", expect: "verified_true" },
        note: "x".repeat(201),
      }),
    ).toBe(false);
  });

  it("accepts offset time windows and rejects malformed timestamps", () => {
    const submit = ajv.compile(COMMAND_SCHEMAS.SubmitRequirement);
    const base = {
      baseRevision: 0,
      visibility: "shared",
      hardness: "hard",
      delegation: { mode: "approval_required" },
    };
    expect(submit({
      ...base,
      payload: {
        kind: "time",
        window: {
          start: "2026-09-04T12:00:00+02:00",
          end: "2026-09-04T14:00:00+02:00",
        },
      },
    })).toBe(true);
    expect(submit({
      ...base,
      payload: { kind: "time", window: { start: "tomorrow", end: "later" } },
    })).toBe(false);
  });

  it("no tool argument accepts an actor identity", () => {
    for (const tool of TOOLS) {
      const props = (tool.inputSchema as { properties?: Record<string, unknown> })
        .properties ?? {};
      for (const key of Object.keys(props)) {
        expect(key).not.toMatch(/actor|participantId|role/i);
      }
    }
  });

  it("teaches revision recovery on every mutation input", () => {
    for (const [name, schema] of Object.entries(COMMAND_SCHEMAS)) {
      const base = (schema as unknown as {
        properties: { baseRevision: { description?: string } };
      }).properties.baseRevision;
      expect(base.description, name).toBe(
        "Use the revision from your last sync; on sync_required, read the delta before retrying.",
      );
    }
  });
});

describe("character budgets (Chrome guidance)", () => {
  it("tool names, descriptions, and param descriptions fit budgets", () => {
    for (const tool of TOOLS) {
      expect(tool.name.length).toBeLessThanOrEqual(BUDGETS.toolNameMax);
      expect(tool.description.length).toBeLessThanOrEqual(
        BUDGETS.toolDescriptionMax,
      );
      const props =
        (tool.inputSchema as {
          properties?: Record<string, { description?: string }>;
        }).properties ?? {};
      for (const [key, prop] of Object.entries(props)) {
        if (prop.description) {
          expect(prop.description.length, `${tool.name}.${key}`)
            .toBeLessThanOrEqual(BUDGETS.paramDescriptionMax);
        }
      }
    }
  });

  it("sync_session carries readOnlyHint and untrustedContentHint", () => {
    const tool = TOOLS.find((t) => t.name === "sync_session")!;
    expect(tool.annotations.readOnlyHint).toBe(true);
    expect(tool.annotations.untrustedContentHint).toBe(true);
  });

  it("does not claim look_up_places is read-only", () => {
    const tool = TOOLS.find((t) => t.name === "look_up_places")!;
    expect(tool.annotations.readOnlyHint).toBeUndefined();
  });

  it("conduct string stays short enough to ride in a tool result", () => {
    expect(CAPABILITY_MANIFEST.conduct.length).toBeLessThanOrEqual(400);
  });

  it("advertises the implemented 20-tool surface without meeting points", () => {
    expect(TOOLS).toHaveLength(20);
    expect(CAPABILITY_MANIFEST.capabilities).not.toContain("meeting-points");
    expect(TOOLS.find((tool) => tool.name === "set_search_scope")?.description)
      .toContain("Organizer only");
    expect(TOOLS.find((tool) => tool.name === "respond_to_proposal")?.description)
      .toContain("carries no condition");
  });
});

describe("contract hash and version bump policy (Gate 2)", () => {
  it("pins the compiler that derives the committed result schemas", () => {
    for (const path of ["../../package.json", "../../packages/contracts/package.json"]) {
      const pkg = JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as {
        devDependencies: { typescript: string };
      };
      expect(pkg.devDependencies.typescript, path).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it("committed manifest snapshot matches the live contract", async () => {
    const committed = JSON.parse(
      readFileSync(
        new URL(
          "../../packages/contracts/contract-manifest.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const liveHash = await contractHash();
    expect(committed.sha256,
      "Contract changed without regenerating contract-manifest.json. " +
      "Run `pnpm --filter @webmcp-hackathon/contracts generate:manifest` " +
      "and bump toolContractVersion if the change is not purely additive.",
    ).toBe(liveHash);
    expect(committed.toolContractVersion).toBe(TOOL_CONTRACT_VERSION);
  });

  it("canonical stringify is key-order independent", () => {
    expect(canonicalStringify({ b: 1, a: { d: 2, c: 3 } })).toBe(
      canonicalStringify({ a: { c: 3, d: 2 }, b: 1 }),
    );
  });

  it("generated result schemas cover every path in maximal live fixtures", () => {
    const fixtures: Record<string, unknown[]> = {
      ToolResult: [{
        ok: true,
        revision: 4,
        effect: "changed",
        staged: true,
        outstanding: [{
          type: "adjustment_request",
          requestId: "adj_1",
          issuedAtRevision: 3,
          kind: "requirement_relaxation",
          change: { dimension: "radius_m", from: 10, to: 20 },
          projectedGain: { newCandidates: 2 },
          withinDelegatedBound: false,
          delegatedBound: { dimension: "radius_m", max: 15 },
          staged: true,
        }],
        syncHint: { eventsSinceYourLastSync: 2 },
      }, {
        ok: false,
        error: { code: "sync_required", message: "moved", recovery: "sync" },
        delta: {
          fromRevision: 1,
          events: [{
            revision: 2,
            type: "event",
            level: "full",
            text: "changed",
            payload: { id: "x" },
            actorId: "p_1",
          }],
          truncated: true,
          cursor: "cursor",
          throughRevision: 2,
          resyncRequired: "backlog_too_large",
        },
      }],
      SyncSessionResponse: [{
        ok: true,
        revision: 4,
        buildId: "build",
        toolContractVersion: "3",
        phase: "gathering",
        identity: { participantId: "p_1", displayName: "A", role: "organizer" },
        manifest: CAPABILITY_MANIFEST,
        feasibility: { state: "fragile", eligible: 1, likely: 2, uncertain: 3, unlikely: 4, excluded: 5 },
        brief: "brief",
        delta: { fromRevision: 0, events: [], truncated: false, throughRevision: 4 },
        outstanding: [{ type: "evaluation_request", candidateIds: ["c_1"], issuedAtRevision: 3, heldByPageAgent: true }],
        participants: [{ participantId: "p_1", displayName: "A", role: "organizer", readyState: "ready", arrived: true, present: true }],
        lastSyncedRevision: 3,
      }],
      SpatialContextResponse: [{
        ok: true,
        revision: 4,
        phase: "gathering",
        scope: { scopeId: "s_1", area: { kind: "circle", center: { lat: 1, lng: 2 }, radiusM: 800 }, transport: ["walk"], category: "category" },
        area: { areaId: "a", label: "area", kind: "curated", source: "source", dataAsOf: "now", poolSize: 3, focusVenues: 2 },
        pool: { size: 3, cap: 2500, explorable: true, filling: true, target: 12 },
        feasibility: { state: "fragile", eligible: 1, likely: 2, uncertain: 3, unlikely: 4, excluded: 5 },
        total: 15,
        matching: 1,
        likely: 2,
        candidates: [{ candidateId: "c", name: "Place", location: { lat: 1, lng: 2 }, category: "category", eligibility: "likely", confidence: 0.8, why: "why", walkMin: 4, priceLevel: 2 }],
        facets: [{ key: "k", label: "label", type: "numeric", counts: { yes: 1, likely: 2, unlikely: 3, no: 4, unknown: 5 }, values: [{ value: "v", label: "V", count: 1 }], unit: "m", range: { min: 1, max: 2 }, histogram: [1], salience: 0.5 }],
        activeNeeds: [{ id: "n", label: "need", ruledOut: 1, wouldReturn: 2, unknown: 3, likely: 4, unlikely: 5, active: true, visibility: "shared", hardness: "hard", ownerId: "p" }],
        privateEffects: [{ owner: "p", ruledOut: 1, topic: "topic" }],
        participants: [{ participantId: "p", displayName: "P", role: "member", readyState: "ready", arrived: true, present: true }],
        proposals: [{ proposalId: "pr", candidateId: "c", status: "open", stances: [{ participantId: "p", stance: "accept" }], vetoStands: false, ownStance: "accept", staging: { ready: true, notReady: [], unaccepted: 0, vetoStands: false } }],
        agreement: { proposalId: "pr", candidateId: "c", status: "committed", committedAtRevision: 4 },
        arrival: { mode: "walk", pickupNote: "outside" },
        impasse: { active: true, text: "none work" },
      }],
      InspectCandidatesResponse: [{
        ok: true,
        revision: 4,
        candidates: [{
          candidateId: "c",
          name: "Place",
          location: { lat: 1, lng: 2 },
          category: "category",
          priceLevel: 2,
          hours: [{ day: "mon", open: "09:00", close: "17:00" }],
          links: [{ kind: "site", label: "Website", url: "https://example.test", source: "web" }],
          description: { text: "description", source: "web" },
          rating: { value: 4, best: 5, count: 10, source: "place", label: "published" },
          awards: [{ label: "award", source: "record" }],
          attributes: [{ key: "k", value: "v", status: "likely_true", source: "web", observedAt: "now", confidence: 0.8, attestedBy: "p", note: "note", sourceUrl: "https://example.test/evidence" }],
          address: "Street 1",
          phone: "+1",
          needs: [{ requirementId: "r", label: "need", private: true, verdict: "likely", confidence: 0.8, why: "why" }],
          lookupPending: true,
          mapRevision: 2,
        }],
      }],
      PrepareNavigationResponse: [{
        ok: true,
        target: { candidateId: "c", name: "Place", location: { lat: 1, lng: 2 } },
        links: { geo: "geo:1,2", googleMaps: "https://maps.google.test", appleMaps: "https://maps.apple.test" },
      }],
      ClientMessage: [
        { type: "auth", token: "token", clientBuildId: "build", clientToolContractVersion: "3" },
        { type: "viewing", candidateId: "c" },
      ],
      ServerMessage: [
        { type: "welcome", buildId: "build", toolContractVersion: "3", revision: 1, participantId: "p", displayName: "P", role: "member" },
        { type: "event", revision: 1, fromRevision: 0, events: [] },
        { type: "error", code: "invalid_message", message: "bad" },
        { type: "confirmation", kind: "agreement", subjectId: "pr", nonce: "n", expiresInMs: 1 },
        { type: "presence", present: ["p"], viewing: [{ participantId: "p", candidateId: "c" }] },
        { type: "lookups", pending: ["c"], reason: { kind: "need", label: "need" } },
        { type: "facts", candidateIds: ["c"], reason: "lookup" },
      ],
    };
    for (const [schemaName, values] of Object.entries(fixtures)) {
      const schemaPaths = collectSchemaPaths(RESULT_SCHEMAS[schemaName]);
      for (const value of values) {
        for (const path of collectValuePaths(value)) {
          const covered = schemaPaths.has(path) || [...schemaPaths].some(
            (declared) => declared.endsWith(".*") && path.startsWith(declared.slice(0, -1)),
          );
          expect(covered, `${schemaName} is missing ${path}`).toBe(true);
        }
      }
    }
  });
});

function collectValuePaths(value: unknown, prefix = ""): Set<string> {
  const paths = new Set<string>();
  if (Array.isArray(value)) {
    for (const item of value) {
      for (const path of collectValuePaths(item, `${prefix}[]`)) paths.add(path);
    }
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${key}` : key;
      paths.add(path);
      for (const child of collectValuePaths(item, path)) paths.add(child);
    }
  }
  return paths;
}

function collectSchemaPaths(schema: unknown, prefix = ""): Set<string> {
  const paths = new Set<string>();
  if (!schema || typeof schema !== "object") return paths;
  const record = schema as {
    properties?: Record<string, unknown>;
    items?: unknown;
    anyOf?: unknown[];
    additionalProperties?: unknown;
  };
  if (Object.keys(record).length === 0 && prefix) paths.add(`${prefix}.*`);
  for (const branch of record.anyOf ?? []) {
    for (const path of collectSchemaPaths(branch, prefix)) paths.add(path);
  }
  for (const [key, child] of Object.entries(record.properties ?? {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    paths.add(path);
    for (const nested of collectSchemaPaths(child, path)) paths.add(nested);
  }
  if (record.items) {
    for (const path of collectSchemaPaths(record.items, `${prefix}[]`)) paths.add(path);
  }
  if (record.additionalProperties && prefix) paths.add(`${prefix}.*`);
  return paths;
}

describe("error model", () => {
  it("error codes form the documented closed enum", () => {
    expect([...ERROR_CODES].sort()).toEqual(
      [
        "bound_exceeded", "consent_required", "invalid_input",
        "not_authenticated", "not_authorized", "not_found",
        "phase_unavailable", "sync_required", "upgrade_required",
        "temporarily_unavailable",
      ].sort(),
    );
  });

  it("manifest field names follow the protocol documents exactly", () => {
    // outstanding (not outstandingActions), protocols.domain (not protocols.spatial)
    expect(CAPABILITY_MANIFEST.protocols).toHaveProperty("domain");
    expect(CAPABILITY_MANIFEST.protocols).not.toHaveProperty("spatial");
    expect(PROTOCOL_VERSIONS.domain).toBe("spatial-destination/v1");
    expect(PROTOCOL_VERSIONS.negotiation).toBe("v1");
  });

  it("v1 tool names carry no version suffix", () => {
    for (const tool of TOOLS) {
      expect(tool.name).not.toMatch(/_v\d+$/);
    }
  });
});
