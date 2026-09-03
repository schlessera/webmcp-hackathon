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
/**
 * Which place this page has open right now (null: none). Presence only — it
 * never touches room state, and it is the one message a socket may send
 * after authenticating. Peers see it as a small mark on that place.
 */
export interface ViewingMessage {
  type: "viewing";
  candidateId: string | null;
}
export type ClientMessage = AuthMessage | ViewingMessage;

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
  /** R10: revision immediately preceding this ordered frame. Older clients
   * ignore it; newer clients use it to detect gaps and reorderings. */
  fromRevision?: number;
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
  /** Who has which place open right now; one row per participant that does.
   * Omitted rows mean "nothing open". Presence, never room state. */
  viewing: Array<{ participantId: string; candidateId: string }>;
  /** Live coordinates for present participants who opted in. The private
   * origin label never travels on this channel. */
  positions: Array<{
    participantId: string;
    lat: number;
    lng: number;
    updatedAt: string;
  }>;
}
/**
 * Which places the server is looking up right now (a venue site, Wikidata,
 * a menu, an inference), for THIS room. Sent to a socket on authentication
 * and to the room whenever the set changes, coalesced. Presentation only —
 * the page draws a busy ring on those places; it never changes room state
 * and is never revisioned. An empty `pending` clears every ring.
 */
export interface LookupsMessage {
  type: "lookups";
  /** Compatibility field retained for one release. */
  pending: string[];
  /** Why they are being looked up, for the count block ("checking 12 places
   * for step-free access"). Absent for a warm-up nobody asked for. */
  reason?: { kind: "need" | "place" | "pool" | "refine"; label?: string };
  /**
   * Per-place stage of the pipeline (docs/ENRICHMENT-SOURCES.md "The
   * pipeline"): queued (work planned, nothing started), fetching (a site,
   * search or asset read in flight), processing (evidence with the model or
   * waiting for a matrix). Additive beside `pending` for one release; a
   * place in `pending` without a stage reads as fetching.
   */
  stages?: Array<{ candidateId: string; stage: PipelineStage }>;
}
export type PipelineStage = "queued" | "fetching" | "processing";
/**
 * How much of the room's pipeline is outstanding for the ACTIVE needs, and
 * how much is in flight: the count block's progress ring. Coalesced ≤ 4/s.
 * Presentation only, never revisioned. `etaMs` is an estimate the page may
 * read but does not draw (§10: counts, never a fabricated time).
 */
export interface PipelineMessage {
  type: "pipeline";
  /** Process-local scheduler frames may name their room before fan-out. */
  roomId?: string;
  outstanding: { fetch: number; process: number };
  inFlight: { fetch: number; process: number };
  /** Places settled for this need set, this run. */
  done: number;
  /** done + outstanding + in flight, deduped by place — never the pool size. */
  total: number;
  etaMs?: number;
  paused?: "budget" | "idle" | null;
  /** Optional per-place stage deltas (`null`: the place left the pipeline). */
  stages?: Array<{ candidateId: string; stage: PipelineStage | null }>;
  /** True when `stages` is the whole set, not a delta. */
  reset?: boolean;
  reason?: { kind: "need" | "place" | "pool" | "refine"; label?: string };
}
/**
 * Facts about places changed outside the event stream (a lookup landed, an
 * inference was made, a pool grew). Not a negotiation event: it carries no
 * revision bump and no baseRevision discipline. The page re-reads the
 * spatial context and any open dossier among `candidateIds`.
 */
export interface FactsMessage {
  type: "facts";
  candidateIds: string[];
  reason: "lookup" | "inference" | "pool" | "confirmation";
}
/**
 * Application-level keepalive, every few seconds to every authenticated
 * socket. Browsers answer protocol pings silently, so the page cannot see
 * them; this frame is what lets the page notice a half-open socket (no
 * frame for ten seconds) and say the map is as of when the link dropped.
 * Presentation only, never revisioned, never logged.
 */
export interface PingMessage {
  type: "ping";
  at: string;
}
export type ServerMessage =
  | WelcomeMessage
  | EventMessage
  | ErrorMessage
  | ConfirmationMessage
  | PresenceMessage
  | LookupsMessage
  | PipelineMessage
  | FactsMessage
  | PipelineMessage
  | PingMessage;
