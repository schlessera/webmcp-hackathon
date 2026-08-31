import { Type } from "@sinclair/typebox";
import {
  ALLOWED_VISIBILITIES,
  ATTRIBUTE_VOCABULARY,
  HINT_TAXONOMY,
} from "./manifest.ts";

/**
 * Command input schemas (server-validated with Ajv — browser schemas are
 * guidance, not enforcement). Subset needed for the spike's gates and test
 * lanes: SyncSession, SubmitRequirement, WithdrawRequirement,
 * EvaluateCandidates, RespondToProposal, SetReadyState.
 * Every mutation carries baseRevision (NEGOTIATION-PROTOCOL.md §6.2).
 */

const VisibilityEnum = Type.Union(
  ALLOWED_VISIBILITIES.map((v) => Type.Literal(v)),
);
const HardnessEnum = Type.Union([Type.Literal("hard"), Type.Literal("soft")]);
const DelegationModeEnum = Type.Union([
  Type.Literal("locked"),
  Type.Literal("approval_required"),
  Type.Literal("negotiable"),
  Type.Literal("soft"),
]);
const HintEnum = Type.Union(HINT_TAXONOMY.map((v) => Type.Literal(v)));

/** Domain payloads (SPATIAL-PROTOCOL.md §5.1) — closed union, no free-text catch-all. */
const AttributeExpectEnum = Type.Union([
  Type.Literal("verified_true"),
  Type.Literal("verified_false"),
]);
// Closed vocabulary: keys come from the capability manifest's
// attributeVocabulary; unknown keys are invalid_input, never stored.
const AttributeKeyEnum = Type.Union(
  ATTRIBUTE_VOCABULARY.map((v) => Type.Literal(v)),
);
export const RequirementPayload = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("attribute"),
      key: AttributeKeyEnum,
      expect: AttributeExpectEnum,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("scope"),
      dimension: Type.Union([
        Type.Literal("walk_min"),
        Type.Literal("radius_m"),
      ]),
      max: Type.Number(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("budget"),
      perPersonMax: Type.Object(
        {
          amount: Type.Number({ minimum: 0 }),
          currency: Type.Literal("EUR"),
        },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("exclusion"),
      key: Type.Literal("cuisine"),
      values: Type.Array(Type.String({ maxLength: 60 }), {
        minItems: 1,
        maxItems: 8,
      }),
      lifetime: Type.Union([Type.Literal("session"), Type.Literal("durable")]),
    },
    { additionalProperties: false },
  ),
]);

const DelegationBound = Type.Object(
  {
    dimension: Type.Union([
      Type.Literal("radius_m"),
      Type.Literal("per_person_eur"),
      Type.Literal("walk_min"),
    ]),
    max: Type.Number(),
  },
  { additionalProperties: false },
);

export const SubmitRequirementInput = Type.Object(
  {
    baseRevision: Type.Integer({ minimum: 0 }),
    requirementId: Type.Optional(Type.String({ maxLength: 40 })),
    visibility: VisibilityEnum,
    hardness: HardnessEnum,
    delegation: Type.Object(
      {
        mode: DelegationModeEnum,
        bound: Type.Optional(DelegationBound),
      },
      { additionalProperties: false },
    ),
    /**
     * ABSENT when visibility = agent-private: submitting agent-private sends a
     * declaration only; the server never receives the constraint content.
     */
    payload: Type.Optional(RequirementPayload),
    scopeHint: Type.Optional(
      Type.Object(
        { affects: Type.Literal("candidate-eligibility"), category: Type.Optional(HintEnum) },
        { additionalProperties: false },
      ),
    ),
    note: Type.Optional(Type.String({ maxLength: 200 })),
  },
  { additionalProperties: false },
);

export const WithdrawRequirementInput = Type.Object(
  {
    baseRevision: Type.Integer({ minimum: 0 }),
    requirementId: Type.String({ maxLength: 40 }),
  },
  { additionalProperties: false },
);

const VerdictEnum = Type.Union([
  Type.Literal("acceptable"),
  Type.Literal("unacceptable"),
  Type.Literal("needs_info"),
]);
export const EvaluateCandidatesInput = Type.Object(
  {
    baseRevision: Type.Integer({ minimum: 0 }),
    verdicts: Type.Array(
      Type.Object(
        {
          candidateId: Type.String({ maxLength: 40 }),
          verdict: VerdictEnum,
          infoNeeded: Type.Optional(Type.String({ maxLength: 100 })),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 10 },
    ),
  },
  { additionalProperties: false },
);

const DispositionEnum = Type.Union([
  Type.Literal("accept"),
  Type.Literal("reject"),
  Type.Literal("abstain"),
  Type.Literal("conditionally_accept"),
]);
export const RespondToProposalInput = Type.Object(
  {
    baseRevision: Type.Integer({ minimum: 0 }),
    proposalId: Type.String({ maxLength: 40 }),
    disposition: DispositionEnum,
    visibility: VisibilityEnum,
    reason: Type.Optional(
      Type.Object(
        {
          kind: Type.Union([Type.Literal("history"), Type.Literal("domain")]),
          note: Type.Optional(Type.String({ maxLength: 200 })),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export const SetReadyStateInput = Type.Object(
  {
    baseRevision: Type.Integer({ minimum: 0 }),
    state: Type.Union([Type.Literal("contributing"), Type.Literal("ready")]),
  },
  { additionalProperties: false },
);

/** Command bus registry: one shared entry point for UI gestures and WebMCP tools. */
export const COMMAND_SCHEMAS = {
  SubmitRequirement: SubmitRequirementInput,
  WithdrawRequirement: WithdrawRequirementInput,
  EvaluateCandidates: EvaluateCandidatesInput,
  RespondToProposal: RespondToProposalInput,
  SetReadyState: SetReadyStateInput,
} as const;
export type CommandType = keyof typeof COMMAND_SCHEMAS;
export const COMMAND_TYPES = Object.keys(COMMAND_SCHEMAS) as CommandType[];
