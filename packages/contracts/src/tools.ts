import { Type, type TSchema } from "@sinclair/typebox";

/**
 * WebMCP tool surface — VALIDATION-SPIKE-1 Gate 1 registers exactly one tool:
 * sync_session (INTERACTION-AND-BINDING.md §2.3). Names ≤30 chars,
 * descriptions ≤500 chars, results ≤1.5K chars. All schemas
 * additionalProperties: false. v1 names carry no version suffix.
 */

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  untrustedContentHint?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: TSchema;
  annotations: ToolAnnotations;
}

export const SYNC_SESSION_INPUT = Type.Object(
  {
    sinceRevision: Type.Optional(
      Type.Integer({
        minimum: 0,
        description:
          "Revision from your last sync. Omit on first connection to receive the capability manifest.",
      }),
    ),
  },
  { additionalProperties: false },
);

export const syncSessionTool: ToolDefinition = {
  name: "sync_session",
  description:
    "The first tool to call on this planning page. Connects you to the shared " +
    "planning session as one participant and returns your identity, protocol " +
    "versions, current revision, privacy rules, a brief of what happened, and " +
    "your outstanding decisions. Call without sinceRevision on first connection " +
    "to receive the capability manifest; call with sinceRevision from your last " +
    "sync to receive the delta of missed events. Read-only.",
  inputSchema: SYNC_SESSION_INPUT,
  annotations: { readOnlyHint: true, untrustedContentHint: true },
};

/** The full registered tool catalog. Gate 1: exactly one tool. */
export const TOOLS: ToolDefinition[] = [syncSessionTool];

/** Chrome budget guidance (INTERACTION-AND-BINDING.md §2.3). */
export const BUDGETS = {
  toolNameMax: 30,
  toolDescriptionMax: 500,
  paramDescriptionMax: 150,
  resultMax: 1500,
  effectMax: 200,
  briefMax: 400,
  noteMax: 200,
} as const;
