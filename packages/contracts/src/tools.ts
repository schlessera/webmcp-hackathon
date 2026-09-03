import { Type, type TSchema } from "@sinclair/typebox";
import {
  AttestAttributeInput,
  ConfirmAgreementInput,
  EvaluateCandidatesInput,
  PlanArrivalInput,
  ProposeDestinationInput,
  ResolvePrivateRequestInput,
  RespondToProposalInput,
  SetReadyStateInput,
  SetRequirementActiveInput,
  SetSearchScopeInput,
  AddCandidatesInput,
  SubmitRequirementInput,
  WithdrawRequirementInput,
} from "./commands.ts";

/**
 * WebMCP tool surface — INTERACTION-AND-BINDING.md §2.3: the full static
 * 16-tool surface (8 negotiation + 8 spatial), registered once at page load.
 * Names ≤30 chars, descriptions ≤500 chars, results ≤1.5K chars. All schemas
 * additionalProperties: false. v1 names carry no version suffix.
 * ConfirmPrivateRequest and CommitAgreement are deliberately NOT bound to
 * tools: consequential steps are confirmed by the human in the page UI.
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
  },
  { additionalProperties: false },
);
export const FOCUS_DESTINATION_INPUT = Type.Object(
  {
    candidateId: Type.String({
      maxLength: 40,
      description: "Candidate to pan/highlight on this participant's map view.",
    }),
  },
  { additionalProperties: false },
);

const negotiationTools: ToolDefinition[] = [
  syncSessionTool,
  {
    name: "submit_requirement",
    description:
      "Add or update your own requirement in the shared decision. Choose " +
      "visibility: shared (room sees content), application-private (only the " +
      "app evaluates it; peers see aggregate effects), or agent-private (send " +
      "a declaration only — no payload or note; content stays with you and " +
      "you screen candidates via evaluate_candidates). Hard requirements " +
      "exclude candidates; soft ones only rank. Pass requirementId to update.",
    inputSchema: SubmitRequirementInput,
    annotations: {},
  },
  {
    name: "withdraw_requirement",
    description:
      "Withdraw one of your own requirements by requirementId. Eligibility is " +
      "recomputed immediately.",
    inputSchema: WithdrawRequirementInput,
    annotations: {},
  },
  {
    name: "set_requirement_active",
    description:
      "Set one of your own needs aside, or bring it back, without withdrawing " +
      "it. An inactive need stops ruling candidates out but keeps its place in " +
      "the brief, so the group can see what would change. Owner-only.",
    inputSchema: SetRequirementActiveInput,
    annotations: {},
  },
  {
    name: "evaluate_candidates",
    description:
      "Return bulk screening verdicts (acceptable / unacceptable / needs_info) " +
      "for candidates against your agent-private requirement. Use when your " +
      "outstanding list carries an evaluation_request. Verdicts are recorded " +
      "disposition-only: the room never learns your reason. Up to 10 per call.",
    inputSchema: EvaluateCandidatesInput,
    annotations: {},
  },
  {
    name: "respond_to_proposal",
    description:
      "Submit your stance on a proposal: accept, reject (a veto that blocks " +
      "agreement while it stands), abstain, or conditionally_accept. Vetoing " +
      "a map pin uses this same command. Accepting also marks you ready. " +
      "reason is optional and never required; agent-private stances are " +
      "disposition-only.",
    inputSchema: RespondToProposalInput,
    annotations: { untrustedContentHint: true },
  },
  {
    name: "resolve_private_request",
    description:
      "Grant or deny a private adjustment request addressed to you (see your " +
      "outstanding list). Denying is always safe. A grant within your " +
      "delegated bound applies immediately; a grant outside it is staged and " +
      "the human confirms on the page — this tool does not apply it by itself.",
    inputSchema: ResolvePrivateRequestInput,
    annotations: {},
  },
  {
    name: "set_ready_state",
    description:
      "Mark this participant as ready (done contributing) or back to " +
      "contributing. Agreement can only be staged when every participant is " +
      "ready.",
    inputSchema: SetReadyStateInput,
    annotations: {},
  },
  {
    name: "confirm_agreement",
    description:
      "Stage the group agreement on a proposal for final confirmation. " +
      "Requires organizer role, all participants ready, and no standing veto. " +
      "The human confirms on the page; this does not commit by itself.",
    inputSchema: ConfirmAgreementInput,
    annotations: {},
  },
];

const spatialTools: ToolDefinition[] = [
  {
    name: "get_spatial_context",
    description:
      "Read the current spatial situation: search scope (area, transport), " +
      "feasibility counts, candidate summary rows with eligibility and stable " +
      "candidateIds, open proposals with stance counts, and any agreement or " +
      "impasse state. Use candidateIds from here in every other spatial tool. " +
      "Read-only.",
    inputSchema: SPATIAL_CONTEXT_INPUT,
    annotations: { readOnlyHint: true, untrustedContentHint: true },
  },
  {
    name: "inspect_candidates",
    description:
      "Fetch full dossiers for 1-3 candidates: attributes with graded status " +
      "(verified_true / likely_true / likely_false / verified_false / unknown) " +
      "and confidence, " +
      "sources, freshness, hours, price level, plus links the place " +
      "publishes (website, menu, reservations), a description and any " +
      "self-published rating or award. Two or three IDs compare. Read-only.",
    inputSchema: INSPECT_CANDIDATES_INPUT,
    annotations: { readOnlyHint: true, untrustedContentHint: true },
  },
  {
    name: "set_search_scope",
    description:
      "Change the shared search scope (area circle and/or transport modes). " +
      "Organizer authority applies the change for the whole room and " +
      "eligibility is recomputed. Scope is shared state: every participant " +
      "sees the change.",
    inputSchema: SetSearchScopeInput,
    annotations: {},
  },
  {
    name: "add_candidates",
    description:
      "Bring up to 40 places from the data behind the map into the room's " +
      "pool, by the refs the explore layer reports. Additive and shared: " +
      "nothing is removed, every participant sees the new places, and the " +
      "room's pool ceiling applies.",
    inputSchema: AddCandidatesInput,
    annotations: {},
  },
  {
    name: "look_up_places",
    description:
      "Ask the server to look up 1-3 places now — their website, Wikidata, " +
      "menu and an inference over what was found — filling facts the record " +
      "left unknown as likely/unlikely with a confidence, never as verified. " +
      "Returns what is known right away; more lands on the page as it " +
      "arrives. Optionally name the attribute keys that matter.",
    inputSchema: LOOK_UP_PLACES_INPUT,
    annotations: {},
  },
  {
    name: "propose_destination",
    description:
      "Create a shared proposal on a candidate so participants can take " +
      "stances on it. A high rank is never agreement: proposals collect " +
      "explicit accepts.",
    inputSchema: ProposeDestinationInput,
    annotations: {},
  },
  {
    name: "focus_destination",
    description:
      "Pan and highlight one candidate on this participant's own map view. " +
      "Local presentation only — changes no shared session state and other " +
      "participants see nothing.",
    inputSchema: FOCUS_DESTINATION_INPUT,
    annotations: { readOnlyHint: true },
  },
  {
    name: "plan_arrival",
    description:
      "Record your arrival plan for the committed destination: transport mode " +
      "and an optional pickup note. Available once the room has agreed on a " +
      "destination.",
    inputSchema: PlanArrivalInput,
    annotations: {},
  },
  {
    name: "attest_attribute",
    description:
      "Record what you found out about a place: a fact the record marks " +
      "unknown or likely in inspect_candidates. Say what you checked in note " +
      "and how sure you are (confidence 0-1; below 0.7 it is recorded as " +
      "likely, not verified). Over an unknown fact your attestation lets the " +
      "room rule on it, labelled with your name; one that contradicts a " +
      "verified fact marks it disputed instead. Shared with the whole room.",
    inputSchema: AttestAttributeInput,
    annotations: {},
  },
  {
    name: "prepare_navigation",
    description:
      "Get one-click navigation handoff links (geo:, Google Maps, Apple Maps) " +
      "for a candidate or the committed destination, built from coordinates " +
      "the session already holds. Read-only.",
    inputSchema: PREPARE_NAVIGATION_INPUT,
    annotations: { readOnlyHint: true },
  },
];

/** The full registered tool catalog — static surface, no state-gated registration. */
export const TOOLS: ToolDefinition[] = [...negotiationTools, ...spatialTools];

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
