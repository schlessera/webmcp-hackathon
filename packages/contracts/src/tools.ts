import { Type, type TSchema } from "@sinclair/typebox";
import {
  AttestAttributeInput,
  ConfirmFactInput,
  ConfirmAgreementInput,
  EvaluateCandidatesInput,
  PlanArrivalInput,
  ProposeDestinationInput,
  ResolvePrivateRequestInput,
  RespondToProposalInput,
  SetOriginInput,
  SetReadyStateInput,
  SetRequirementActiveInput,
  SetSearchScopeInput,
  AddCandidatesInput,
  SubmitRequirementInput,
  WithdrawRequirementInput,
} from "./commands.ts";

/**
 * WebMCP tool surface — INTERACTION-AND-BINDING.md §2.3: the full static
 * 24-tool surface, registered once at page load (see TOOLS for the split).
 * Names ≤30 chars, descriptions ≤500 chars, results ≤1.5K chars except the
 * 8K allowance for sync/delta results. All schemas additionalProperties: false. v1
 * names carry no version suffix.
 * ConfirmPrivateRequest and CommitAgreement are deliberately NOT bound to
 * tools: their applying commands require a page confirmation nonce.
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
          "Last fully consumed event revision. Omit both sinceRevision and cursor on first connection to receive the manifest.",
      }),
    ),
    cursor: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 512,
        description:
          "Opaque delta continuation. Return unchanged until delta.truncated is false; omit with sinceRevision for the first manifest.",
      }),
    ),
  },
  { additionalProperties: false },
);

export const syncSessionTool: ToolDefinition = {
  name: "sync_session",
  description:
    "Read the authenticated room as your participant: identity, revisions, " +
    "privacy rules, brief, roster and outstanding work. Omit both sinceRevision " +
    "and cursor for the capability manifest; otherwise read missed events. " +
    "Continue truncated deltas with cursor before acting. The room revision can " +
    "exceed throughRevision. Before a room exists, use describe_regions then " +
    "open_room.",
  inputSchema: SYNC_SESSION_INPUT,
  annotations: { readOnlyHint: true, untrustedContentHint: true },
};

/** Spatial read inputs (no baseRevision: reads never conflict). */
export const SPATIAL_CONTEXT_INPUT = Type.Object(
  {},
  { additionalProperties: false },
);
export const INSPECT_CANDIDATES_INPUT = Type.Object(
  {
    candidateIds: Type.Array(
      Type.String({
        maxLength: 40,
        description: "Stable candidateId from get_spatial_context.",
      }),
      { minItems: 1, maxItems: 3 },
    ),
    intent: Type.Optional(
      Type.Union(
        [Type.Literal("open"), Type.Literal("read")],
        {
          description:
            "read: start no lookup. open: return cache and start bounded work. Omit for lookup with a bounded wait.",
        },
      ),
    ),
    force: Type.Optional(
      Type.Boolean({
        description: "With intent open, request another pass even if this need set was already checked. Source caches and provider budgets still apply.",
      }),
    ),
  },
  { additionalProperties: false },
);
export const LOOK_UP_PLACES_INPUT = Type.Object(
  {
    candidateIds: Type.Array(
      Type.String({
        maxLength: 40,
        description: "Stable candidateId from get_spatial_context.",
      }),
      { minItems: 1, maxItems: 3 },
    ),
    keys: Type.Optional(
      Type.Array(Type.String({ maxLength: 40, description: "Attribute keys to focus on (facet keys)." }), {
        minItems: 1,
        maxItems: 6,
      }),
    ),
    force: Type.Optional(
      Type.Boolean({
        description:
          "Request an interactive refresh of sources and inference for keys. Source caches, failures and provider budgets still apply.",
      }),
    ),
  },
  { additionalProperties: false },
);
export const PREPARE_NAVIGATION_INPUT = Type.Object(
  {
    candidateId: Type.Optional(
      Type.String({
        maxLength: 40,
        description:
          "Destination to navigate to. Omit to use the committed agreement.",
      }),
    ),
    from: Type.Optional(
      Type.Object(
        {
          lat: Type.Number({ minimum: -90, maximum: 90 }),
          lng: Type.Number({ minimum: -180, maximum: 180 }),
        },
        {
          additionalProperties: false,
          description: "Starting position for directions. Omit to use your saved origin when available.",
        },
      ),
    ),
  },
  { additionalProperties: false },
);
export const FOCUS_DESTINATION_INPUT = Type.Object(
  {
    candidateId: Type.String({
      maxLength: 40,
      description: "Known candidate to select and pan/highlight; the page shares viewing presence and starts evidence work.",
    }),
  },
  { additionalProperties: false },
);
export const FIND_LANDMARKS_INPUT = Type.Object(
  {
    query: Type.String({
      minLength: 1,
      maxLength: 100,
      description: "Landmark or public place name to resolve in this room's area.",
    }),
  },
  { additionalProperties: false },
);

const negotiationTools: ToolDefinition[] = [
  syncSessionTool,
  {
    name: "submit_requirement",
    description:
      "Add or update your own need; pass requirementId to update. shared publishes " +
      "content; application-private stores it for the app and owner, with reduced " +
      "peer projections; agent-private sends only a declaration, with no payload or " +
      "note, and you screen via evaluate_candidates. Hard needs affect eligibility; " +
      "soft needs are stored but do not rank or exclude. Private ownership and " +
      "decision effects can remain visible.",
    inputSchema: SubmitRequirementInput,
    annotations: {},
  },
  {
    name: "withdraw_requirement",
    description:
      "Withdraw one of your own needs by requirementId. It stops affecting " +
      "eligibility, which the server recomputes. Its stored history remains subject " +
      "to the same visibility rules.",
    inputSchema: WithdrawRequirementInput,
    annotations: {},
  },
  {
    name: "set_requirement_active",
    description:
      "Set aside or restore one of your own current-step needs without withdrawing " +
      "it. An inactive need stops affecting eligibility but keeps its row, " +
      "visibility and history. A need belonging to an already settled step cannot " +
      "be restored with this tool.",
    inputSchema: SetRequirementActiveInput,
    annotations: {},
  },
  {
    name: "evaluate_candidates",
    description:
      "Record up to 10 candidate verdicts covering all your agent-private needs " +
      "together, not one requirement. Use candidate IDs from outstanding " +
      "evaluation_request items. Send verdict: acceptable, unacceptable or " +
      "needs_info, and each dossier " +
      "mapRevision as screenedMapRevision; missing or old revisions stay stale. " +
      "needs_info requires infoNeeded, which the server receives. Keep private " +
      "condition text out of that field. Each new verdict replaces your prior " +
      "verdict for that candidate.",
    inputSchema: EvaluateCandidatesInput,
    annotations: {},
  },
  {
    name: "respond_to_proposal",
    description:
      "Set your stance on an open or vetoed proposal: accept, reject, abstain or " +
      "conditionally_accept. A rejection blocks agreement while it stands. " +
      "Accepting also marks you ready; abstaining does not. conditionally_accept " +
      "carries no condition and blocks commit until replaced. reason is optional; " +
      "omit it for agent-private stances. Staged, committed and withdrawn proposals " +
      "reject new stances.",
    inputSchema: RespondToProposalInput,
    annotations: { untrustedContentHint: true },
  },
  {
    name: "resolve_private_request",
    description:
      "Grant or deny an adjustment request addressed to you in outstanding. A grant " +
      "within its delegated bound applies immediately; an outside-bound grant " +
      "returns staged: true and requires page confirmation before applying. Denial " +
      "closes the request. This tool answers an existing adjustment; it does not " +
      "change its terms or implement disclosure escalation.",
    inputSchema: ResolvePrivateRequestInput,
    annotations: {},
  },
  {
    name: "set_ready_state",
    description:
      "Mark yourself ready or contributing. Staging agreement also requires every " +
      "participant to accept or abstain on the proposal, with no veto or " +
      "conditional stance. Disconnected participants still count. Readiness carries " +
      "into subsequent plan steps; each proposal requires its own stances.",
    inputSchema: SetReadyStateInput,
    annotations: {},
  },
  {
    name: "set_origin",
    description:
      "Set your starting position and optional label. The stored origin is visible " +
      "to the application and you; the page separately controls live sharing, off " +
      "by default. Your position can affect shared eligibility even while live " +
      "sharing is off. This does not change the shared search circle.",
    inputSchema: SetOriginInput,
    annotations: {},
  },
  {
    name: "confirm_agreement",
    description:
      "Stage an open proposal for final page confirmation. Organizer only: every " +
      "participant must be ready and have accepted or abstained, with no veto or " +
      "conditional stance. Returns staged: true; it does not commit. The page " +
      "commit rechecks these conditions, then settles the current plan step or " +
      "opens final arrival planning.",
    inputSchema: ConfirmAgreementInput,
    annotations: {},
  },
];

const spatialTools: ToolDefinition[] = [
  {
    name: "find_landmarks",
    description:
      "Find named landmarks in this room's prepared area before submitting a " +
      "distance need. Returns stable landmark IDs, names, place-type labels and " +
      "locations ranked by name match. Use a returned landmarkId in a scope " +
      "referent. This is a landmark search, not worldwide venue discovery.",
    inputSchema: FIND_LANDMARKS_INPUT,
    annotations: { readOnlyHint: true },
  },
  {
    name: "get_spatial_context",
    description:
      "Read compact scope, feasibility, candidate rows, proposals, agreement and " +
      "outstanding work. Starts with at most eight candidates ordered by " +
      "eligibility then walking estimate; further budget compaction may omit rows " +
      "or fields. Proposal accepts counts only stances visible to you, not every " +
      "private accept. Use returned candidateIds for inspection and actions. " +
      "Detailed needs, coordinates and plan fields are omitted. May resume pool " +
      "fill and preview evidence.",
    inputSchema: SPATIAL_CONTEXT_INPUT,
    annotations: { readOnlyHint: true, untrustedContentHint: true },
  },
  {
    name: "inspect_candidates",
    description:
      "Read compact records for 1-3 candidates: graded attributes, brief " +
      "provenance, need verdicts, mapRevision and available links/metadata. Full " +
      "hours, coordinates, detailed evidence and image URLs are omitted. intent: " +
      "read starts no lookup; open returns cached records and starts bounded fact " +
      "work. Omitting intent starts lookup with a bounded wait. Several IDs read a " +
      "comparison but do not open the page's comparison panel. Results may be " +
      "further compacted.",
    inputSchema: INSPECT_CANDIDATES_INPUT,
    annotations: { readOnlyHint: true, untrustedContentHint: true },
  },
  {
    name: "set_search_scope",
    description:
      "Organizer only: change the shared circle and/or walk/bike/car transport " +
      "modes. Provide area, transport or both. The change applies to the room and " +
      "recomputes eligibility without collecting affected members' consent. Circle " +
      "radii are 100-5000 metres. This does not calculate routes or set a planning " +
      "time.",
    inputSchema: SetSearchScopeInput,
    annotations: {},
  },
  {
    name: "add_candidates",
    description:
      "Add up to 40 source refs from the page's explore/search places to the active " +
      "step's shared candidate pool. The page is the discovery path for refs. " +
      "Already-present refs are ignored; the live pool ceiling applies. This adds " +
      "places without removing existing ones or moving other participants' " +
      "viewports.",
    inputSchema: AddCandidatesInput,
    annotations: {},
  },
  {
    name: "look_up_places",
    description:
      "Start evidence lookup for 1-3 candidates using configured sources and " +
      "models; this can spend provider budget and write caches. Validated explicit " +
      "venue statements may become verified; other evidence can remain likely or " +
      "unknown. Returns compact records after a bounded wait; unfinished work " +
      "continues on the page. Optionally focus on keys or request an interactive " +
      "refresh with force. Refresh does not guarantee new facts.",
    inputSchema: LOOK_UP_PLACES_INPUT,
    annotations: {},
  },
  {
    name: "propose_destination",
    description:
      "Create a shared proposal on a candidate in the current plan step's live pool " +
      "so participants can take stances. Uncertain or excluded candidates can also " +
      "be proposed; classification is advice, not agreement. A candidate with an " +
      "existing live proposal must use that proposal instead.",
    inputSchema: ProposeDestinationInput,
    annotations: {},
  },
  {
    name: "focus_destination",
    description:
      "Select, pan to and highlight a candidate on your page. The page publishes " +
      "your viewing presence to the room and starts bounded evidence work for the " +
      "selected place. Other participants can see which place you are viewing; " +
      "resulting facts may be shared. This does not submit a proposal or stance, or " +
      "change the shared search circle.",
    inputSchema: FOCUS_DESTINATION_INPUT,
    annotations: { readOnlyHint: true },
  },
  {
    name: "plan_arrival",
    description:
      "Record your walk, bike or car arrival mode and optional pickupNote after the " +
      "final destination is agreed. The mode is shared; the note is private to the " +
      "application and you. The first plan enters the arrival phase. This stores " +
      "coordination details; it does not calculate routes, book transport or create " +
      "a meeting point.",
    inputSchema: PlanArrivalInput,
    annotations: {},
  },
  {
    name: "confirm_fact",
    description:
      "Record a fact you verified for a place with a permanent source reference. " +
      "Use a vocabulary criterionId or q:<sha1> and boolean lean; open:* time " +
      "windows and synthetic value IDs are not accepted. The named confirmation " +
      "applies only in this room and may dispute a verified record. " +
      "Your private-question note/sourceUrl are discarded. Withdrawal is a page action " +
      "for the confirmer or organizer.",
    inputSchema: ConfirmFactInput,
    annotations: {},
  },
  {
    name: "attest_attribute",
    description:
      "Add shared, named evidence for a boolean vocabulary key (not price-level or " +
      "cuisine) or q:<sha1>. Supply verified_true/verified_false, confidence 0-1 " +
      "and a note stating what you checked. Below 0.7 the answer is likely. " +
      "Contradictions with verified facts or disagreeing attesters become " +
      "disputed/unknown. Notes are shared: do not include a private condition. This " +
      "changes evidence, not a requirement or stance.",
    inputSchema: AttestAttributeInput,
    annotations: {},
  },
  {
    name: "prepare_navigation",
    description:
      "Return geo:, Google Maps and Apple Maps handoff links from stored " +
      "coordinates. Pass candidateId to navigate before agreement, or omit it to " +
      "use the committed destination. Optional from overrides your saved origin. " +
      "Returning links does not navigate or calculate a route; opening one sends " +
      "its coordinates to the selected map application.",
    inputSchema: PREPARE_NAVIGATION_INPUT,
    annotations: { readOnlyHint: true },
  },
];

/**
 * Opening tools answer before authentication. open_room runs the automatic
 * planner and creation calls, accepts its result without the page's review
 * flow, and schedules navigation after returning the opening result.
 */

export const DESCRIBE_REGIONS_INPUT = Type.Object({}, { additionalProperties: false });

export const OPEN_ROOM_INPUT = Type.Object(
  {
    goal: Type.String({
      minLength: 1,
      maxLength: 300,
      description:
        "The user's goal in ordinary words. The planner accepts steps automatically here, without a separate review or clarification turn.",
    }),
    organizerName: Type.String({
      minLength: 1,
      maxLength: 40,
      description: "The name of the person opening the room, as others should see it.",
    }),
    regionId: Type.String({
      maxLength: 40,
      description:
        "Which prepared region to run in. Call describe_regions first and choose " +
        "the one whose data suits the goal.",
    }),
  },
  { additionalProperties: false },
);

const onboardingTools: ToolDefinition[] = [
  {
    name: "describe_regions",
    description:
      "List prepared regions this demo can open, with place-class counts and fact " +
      "coverage when available. Discovery is bounded to these local extracts. Call " +
      "this before open_room and use a returned regionId. No participant token is " +
      "required; result compaction can omit detail.",
    inputSchema: DESCRIBE_REGIONS_INPUT,
    annotations: { readOnlyHint: true },
  },
  {
    name: "open_room",
    description:
      "Create a planning room from the user's goal. Automatically accepts the " +
      "planner's steps without a separate plan review or clarification turn; falls " +
      "back to a food step if preview is unavailable. Returns the steps and an " +
      "invitation link when one is minted, then schedules page navigation/reload. " +
      "Wait for the room to load before sync_session. No participant token is " +
      "required.",
    inputSchema: OPEN_ROOM_INPUT,
    annotations: {},
  },
];

/** The full registered tool catalog — static surface, no state-gated registration. */
export const TOOLS: ToolDefinition[] = [...onboardingTools, ...negotiationTools, ...spatialTools];

/** Application string-length budgets (INTERACTION-AND-BINDING.md §3). */
export const BUDGETS = {
  toolNameMax: 30,
  toolDescriptionMax: 500,
  paramDescriptionMax: 150,
  resultMax: 1500,
  // Sync manifests and every delta-bearing result receive this allowance.
  // Oversized protocol pages fail explicitly instead of losing state to the
  // generic structural compactor.
  syncResultMax: 8000,
  effectMax: 200,
  briefMax: 400,
  noteMax: 200,
} as const;
