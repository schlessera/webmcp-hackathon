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

// R16: revision recovery is central enough to teach at every mutation field,
// not only in a tool description an agent may no longer have in context.
const BaseRevision = Type.Integer({
  minimum: 0,
  description:
    "Use the revision from your last sync; on sync_required, read the delta before retrying.",
});

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
      kind: Type.Literal("time"),
      window: Type.Object(
        {
          start: Type.String({ format: "date-time", maxLength: 40 }),
          end: Type.String({ format: "date-time", maxLength: 40 }),
        },
        { additionalProperties: false },
      ),
      phrase: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    },
    { additionalProperties: false },
  ),
  /**
   * Free text the app cannot verify against any dossier field. Accepted so a
   * person can state a need in their own words instead of being pushed into a
   * vocabulary; it classifies EVERY candidate as uncertain and excludes none,
   * because nothing about it has been checked (attribute honesty).
   */
  Type.Object(
    {
      kind: Type.Literal("text"),
      text: Type.String({ minLength: 1, maxLength: 200 }),
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
  /**
   * The positive twin of an exclusion: the place's cuisine must include one
   * of these values. A place whose cuisine is on record and matches none is
   * ruled out; one with no cuisine on record is uncertain, never ruled out
   * (attribute honesty). Without this kind, "Asian please" had only the
   * exclusion shape to land in — and landed inverted.
   */
  Type.Object(
    {
      kind: Type.Literal("inclusion"),
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
    baseRevision: BaseRevision,
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
    baseRevision: BaseRevision,
    requirementId: Type.String({ maxLength: 40 }),
  },
  { additionalProperties: false },
);

/**
 * Set one of YOUR OWN needs aside without withdrawing it: an inactive need
 * stops classifying candidates but keeps its row, its id, and its history.
 * Owner-only — a shared need is still its author's to silence.
 */
export const SetRequirementActiveInput = Type.Object(
  {
    baseRevision: BaseRevision,
    requirementId: Type.String({ maxLength: 40 }),
    active: Type.Boolean(),
  },
  { additionalProperties: false },
);

const CandidateVerdict = Type.Union([
  Type.Object(
    {
      candidateId: Type.String({ maxLength: 40 }),
      verdict: Type.Union([Type.Literal("acceptable"), Type.Literal("unacceptable")]),
      infoNeeded: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
      screenedMapRevision: Type.Optional(Type.Integer({
        minimum: 0,
        description: "mapRevision from the inspected dossier; omission records a legacy verdict as stale.",
      })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      candidateId: Type.String({ maxLength: 40 }),
      verdict: Type.Literal("needs_info"),
      infoNeeded: Type.String({ minLength: 1, maxLength: 100 }),
      screenedMapRevision: Type.Optional(Type.Integer({
        minimum: 0,
        description: "mapRevision from the inspected dossier; omission records a legacy verdict as stale.",
      })),
    },
    { additionalProperties: false },
  ),
]);
export const EvaluateCandidatesInput = Type.Object(
  {
    baseRevision: BaseRevision,
    verdicts: Type.Array(CandidateVerdict, {
      minItems: 1,
      maxItems: 10,
      uniqueItems: true,
    }),
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
    baseRevision: BaseRevision,
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
    baseRevision: BaseRevision,
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
    baseRevision: BaseRevision,
    area: Type.Optional(CircleArea),
    transport: Type.Optional(
      Type.Array(TransportEnum, { minItems: 1, maxItems: 3, uniqueItems: true }),
    ),
  },
  { additionalProperties: false },
);

/**
 * Bring places from the data behind the map into the room's pool
 * (SPATIAL-PROTOCOL §5.5). Additive and shared: any participant may add,
 * nothing is ever removed, and the pool has a ceiling the server enforces.
 */
export const AddCandidatesInput = Type.Object(
  {
    baseRevision: BaseRevision,
    refs: Type.Array(
      Type.String({ maxLength: 40, description: "A `ref` from the explore layer (GET /api/rooms/:id/places)." }),
      { minItems: 1, maxItems: 40, uniqueItems: true },
    ),
  },
  { additionalProperties: false },
);

export const ProposeDestinationInput = Type.Object(
  {
    baseRevision: BaseRevision,
    candidateId: Type.String({ maxLength: 40 }),
  },
  { additionalProperties: false },
);

export const PlanArrivalInput = Type.Object(
  {
    baseRevision: BaseRevision,
    mode: TransportEnum,
    pickupNote: Type.Optional(Type.String({ maxLength: 200 })),
  },
  { additionalProperties: false },
);

/** Adjustment/consent — NEGOTIATION-PROTOCOL.md §3.6. */
export const ResolvePrivateRequestInput = Type.Object(
  {
    baseRevision: BaseRevision,
    requestId: Type.String({ maxLength: 40 }),
    decision: Type.Union([Type.Literal("grant"), Type.Literal("deny")]),
  },
  { additionalProperties: false },
);

/**
 * Short-lived single-use code the server mints when a stage happens and
 * delivers ONLY over the participant's realtime channel. It never rides in a
 * command result, so the agent surface never sees one. Shaped as a plain
 * capped string (no minLength) so a missing code fails as consent_required —
 * the honest reason — rather than invalid_input.
 */
const ConfirmationNonce = Type.String({ maxLength: 64 });

/**
 * UI-only: applies a staged grant after the human confirms on the page. In
 * COMMAND_SCHEMAS but bound to no WebMCP tool — the page's executeTool switch
 * has no route to it, which is the binding-layer enforcement of "the human
 * confirms on the page" (INTERACTION-AND-BINDING.md §5.4). The nonce closes
 * the raw-bearer-token path around that binding-layer control.
 */
export const ConfirmPrivateRequestInput = Type.Object(
  {
    baseRevision: BaseRevision,
    requestId: Type.String({ maxLength: 40 }),
    confirmationNonce: ConfirmationNonce,
  },
  { additionalProperties: false },
);

export const ConfirmAgreementInput = Type.Object(
  {
    baseRevision: BaseRevision,
    proposalId: Type.String({ maxLength: 40 }),
  },
  { additionalProperties: false },
);

/** UI-only: commits a staged agreement (same enforcement as ConfirmPrivateRequest). */
export const CommitAgreementInput = Type.Object(
  {
    baseRevision: BaseRevision,
    proposalId: Type.String({ maxLength: 40 }),
    confirmationNonce: ConfirmationNonce,
  },
  { additionalProperties: false },
);

/**
 * Record what a participant found out about a place that the map data did
 * not know (SPATIAL-PROTOCOL.md §8, attestations). Shared with the room and
 * labelled with the attester; a verified source fact is never overwritten,
 * only disputed. Boolean facts only — price and cuisine are read from the
 * record as they are. A q:<sha1> question criterion is also attestable; its
 * reader-facing label remains governed by the matching requirement.
 */
const AttestableKeyEnum = Type.Union(
  [
    ...ATTRIBUTE_VOCABULARY.filter((k) => k !== "price-level" && k !== "cuisine").map((v) =>
      Type.Literal(v),
    ),
    Type.String({ pattern: "^q:[0-9a-f]{40}$", maxLength: 42 }),
  ],
);
export const AttestAttributeInput = Type.Object(
  {
    baseRevision: BaseRevision,
    candidateId: Type.String({ maxLength: 40 }),
    key: AttestableKeyEnum,
    status: Type.Union([Type.Literal("verified_true"), Type.Literal("verified_false")]),
    /** 0–1: how sure the attester is. Shown, never used to rank. */
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
    /** What was checked — the room reads this next to the fact. */
    note: Type.String({ minLength: 1, maxLength: 200 }),
    sourceUrl: Type.Optional(Type.String({ maxLength: 300, format: "uri" })),
  },
  { additionalProperties: false },
);

/**
 * A permanent, cross-room fact verified by a person. Only vocabulary keys and
 * opaque question commitments are accepted: absolute open:* windows expire by
 * meaning, and a private question's words must never enter shared storage.
 */
const ConfirmableCriterionEnum = Type.Union([
  ...ATTRIBUTE_VOCABULARY.map((v) => Type.Literal(v)),
  Type.String({ pattern: "^q:[0-9a-f]{40}$", maxLength: 42 }),
]);
export const ConfirmFactInput = Type.Object(
  {
    baseRevision: BaseRevision,
    candidateId: Type.String({ maxLength: 40 }),
    criterionId: ConfirmableCriterionEnum,
    lean: Type.Boolean(),
    note: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    sourceUrl: Type.Optional(Type.String({ maxLength: 300, format: "uri" })),
  },
  { additionalProperties: false },
);

export const UnconfirmFactInput = Type.Object(
  {
    baseRevision: BaseRevision,
    candidateId: Type.String({ maxLength: 40 }),
    criterionId: ConfirmableCriterionEnum,
  },
  { additionalProperties: false },
);

/** Command bus registry: one shared entry point for UI gestures and WebMCP tools. */
export const COMMAND_SCHEMAS = {
  SubmitRequirement: SubmitRequirementInput,
  WithdrawRequirement: WithdrawRequirementInput,
  SetRequirementActive: SetRequirementActiveInput,
  EvaluateCandidates: EvaluateCandidatesInput,
  RespondToProposal: RespondToProposalInput,
  SetReadyState: SetReadyStateInput,
  SetSearchScope: SetSearchScopeInput,
  AddCandidates: AddCandidatesInput,
  ProposeDestination: ProposeDestinationInput,
  PlanArrival: PlanArrivalInput,
  AttestAttribute: AttestAttributeInput,
  ConfirmFact: ConfirmFactInput,
  UnconfirmFact: UnconfirmFactInput,
  ResolvePrivateRequest: ResolvePrivateRequestInput,
  ConfirmPrivateRequest: ConfirmPrivateRequestInput,
  ConfirmAgreement: ConfirmAgreementInput,
  CommitAgreement: CommitAgreementInput,
} as const;
export type CommandType = keyof typeof COMMAND_SCHEMAS;
export const COMMAND_TYPES = Object.keys(COMMAND_SCHEMAS) as CommandType[];
