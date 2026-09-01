import type { ProjectedEvent } from "./envelope.ts";

/**
 * WebSocket protocol. The socket authenticates with its first message
 * (Gate 3 rule 5); the welcome carries buildId + toolContractVersion so
 * clients detect stale bundles (Gate 5).
 */

export interface AuthMessage {
  type: "auth";
  token: string;
  /** buildId + toolContractVersion of the loaded page, for server-side upgrade_required checks. */
  clientBuildId: string;
  clientToolContractVersion: string;
}
export type ClientMessage = AuthMessage;

export interface WelcomeMessage {
  type: "welcome";
  buildId: string;
  toolContractVersion: string;
  revision: number;
  participantId: string;
  displayName: string;
  role: "organizer" | "member";
}
export interface EventMessage {
  type: "event";
  revision: number;
  /** Projected for THIS participant only — server-side redaction. */
  events: ProjectedEvent[];
}
export interface ErrorMessage {
  type: "error";
  code: "not_authenticated" | "upgrade_required" | "invalid_message";
  message: string;
}
/**
 * A short-lived single-use code authorizing ONE applying command
 * (CommitAgreement / ConfirmPrivateRequest) for the subject it names. It is
 * delivered only here, to the staging participant's own socket — never in a
 * command result, so it never reaches an agent surface
 * (INTERACTION-AND-BINDING.md §5.4).
 */
export interface ConfirmationMessage {
  type: "confirmation";
  kind: "agreement" | "private_request";
  /** proposalId for "agreement", requestId for "private_request". */
  subjectId: string;
  nonce: string;
  expiresInMs: number;
}
/** Who holds an open socket in the room right now; sent to a socket on
 * authentication and to the room whenever the set changes. */
export interface PresenceMessage {
  type: "presence";
  present: string[];
}
export type ServerMessage =
  | WelcomeMessage
  | EventMessage
  | ErrorMessage
  | ConfirmationMessage
  | PresenceMessage;
