import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import AjvModule from "ajv";
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
} from "@webmcp-hackathon/contracts/hash";

const Ajv = ((AjvModule as never as { default?: unknown }).default ??
  AjvModule) as typeof AjvModule.default;
const ajv = new Ajv({ strict: false, allErrors: true });

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

  it("no tool argument accepts an actor identity", () => {
    for (const tool of TOOLS) {
      const props = (tool.inputSchema as { properties?: Record<string, unknown> })
        .properties ?? {};
      for (const key of Object.keys(props)) {
        expect(key).not.toMatch(/actor|participantId|role/i);
      }
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

  it("conduct string stays short enough to ride in a tool result", () => {
    expect(CAPABILITY_MANIFEST.conduct.length).toBeLessThanOrEqual(400);
  });
});

describe("contract hash and version bump policy (Gate 2)", () => {
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
});

describe("error model", () => {
  it("error codes form the documented closed enum", () => {
    expect([...ERROR_CODES].sort()).toEqual(
      [
        "bound_exceeded", "consent_required", "invalid_input",
        "not_authenticated", "not_authorized", "not_found",
        "phase_unavailable", "sync_required", "upgrade_required",
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
