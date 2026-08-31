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

/** Spatial mutations — SPATIAL-PROTOCOL.md §6. */

const CircleArea = Type.Object(
  {
    kind: Type.Literal("circle"),
    center: Type.Object(
      {
        lat: Type.Number({ minimum: -90, maximum: 90 }),
        lng: Type.Number({ minimum: -180, maximum: 180 }),
      },
      { additionalProperties: false },
    ),
    radiusM: Type.Integer({ minimum: 100, maximum: 5000 }),
  },
  { additionalProperties: false },
);
const TransportEnum = Type.Union([
  Type.Literal("walk"),
  Type.Literal("bike"),
  Type.Literal("car"),
]);

export const SetSearchScopeInput = Type.Object(
  {
    baseRevision: Type.Integer({ minimum: 0 }),
    area: Type.Optional(CircleArea),
    transport: Type.Optional(
      Type.Array(TransportEnum, { minItems: 1, maxItems: 3, uniqueItems: true }),
    ),
  },
  { additionalProperties: false },
);

export const ProposeDestinationInput = Type.Object(
  {
    baseRevision: Type.Integer({ minimum: 0 }),
    candidateId: Type.String({ maxLength: 40 }),
  },
  { additionalProperties: false },
);

export const PlanArrivalInput = Type.Object(
  {
    baseRevision: Type.Integer({ minimum: 0 }),
    mode: TransportEnum,
    pickupNote: Type.Optional(Type.String({ maxLength: 200 })),
  },
  { additionalProperties: false },
);

/** Adjustment/consent — NEGOTIATION-PROTOCOL.md §3.6. */
export const ResolvePrivateRequestInput = Type.Object(
  {
    baseRevision: Type.Integer({ minimum: 0 }),
    requestId: Type.String({ maxLength: 40 }),
    decision: Type.Union([Type.Literal("grant"), Type.Literal("deny")]),
  },
  { additionalProperties: false },
);

/**
 * UI-only: applies a staged grant after the human confirms on the page. In
 * COMMAND_SCHEMAS but bound to no WebMCP tool — the page's executeTool switch
 * has no route to it, which is the binding-layer enforcement of "the human
 * confirms on the page" (INTERACTION-AND-BINDING.md §5.4).
 */
export const ConfirmPrivateRequestInput = Type.Object(
  {
    baseRevision: Type.Integer({ minimum: 0 }),
    requestId: Type.String({ maxLength: 40 }),
  },
  { additionalProperties: false },
);

export const ConfirmAgreementInput = Type.Object(
  {
    baseRevision: Type.Integer({ minimum: 0 }),
    proposalId: Type.String({ maxLength: 40 }),
  },
  { additionalProperties: false },
);

/** UI-only: commits a staged agreement (same enforcement as ConfirmPrivateRequest). */
export const CommitAgreementInput = Type.Object(
  {
    baseRevision: Type.Integer({ minimum: 0 }),
    proposalId: Type.String({ maxLength: 40 }),
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
  SetSearchScope: SetSearchScopeInput,
  ProposeDestination: ProposeDestinationInput,
  PlanArrival: PlanArrivalInput,
  ResolvePrivateRequest: ResolvePrivateRequestInput,
  ConfirmPrivateRequest: ConfirmPrivateRequestInput,
  ConfirmAgreement: ConfirmAgreementInput,
  CommitAgreement: CommitAgreementInput,
} as const;
export type CommandType = keyof typeof COMMAND_SCHEMAS;
export const COMMAND_TYPES = Object.keys(COMMAND_SCHEMAS) as CommandType[];
