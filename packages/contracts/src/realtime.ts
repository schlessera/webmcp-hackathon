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
export type ServerMessage = WelcomeMessage | EventMessage | ErrorMessage;
