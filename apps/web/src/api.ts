import { TOOL_CONTRACT_VERSION } from "@webmcp-hackathon/contracts";
import { currentToken } from "./session.ts";
import { diagnostics } from "./diagnostics-store.ts";

/**
 * The single client command bus: UI gestures and WebMCP tool callbacks both
 * call submitCommand()/syncSession() here, so both surfaces produce identical
 * domain commands (INTERACTION-AND-BINDING.md §1 rule 4).
 */

function newCorrelationId(): string {
  return `c_${crypto.randomUUID().slice(0, 12)}`;
}

const notAuthenticated = {
  ok: false as const,
  error: {
    code: "not_authenticated" as const,
    message: "This session is not authenticated yet.",
    recovery:
      "The page is still exchanging its invite token. Retry in a moment.",
  },
};

async function post(
  path: string,
  body: unknown,
  signal?: AbortSignal,
  idempotent = false,
): Promise<unknown> {
  const token = currentToken();
  if (!token) {
    diagnostics.log("command blocked: not_authenticated");
    return notAuthenticated;
  }
  const correlationId = newCorrelationId();
  diagnostics.log(`-> ${path} [${correlationId}]`);
  try {
    const response = await fetch(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "x-correlation-id": correlationId,
        "x-tool-contract-version": TOOL_CONTRACT_VERSION,
        // R6: one invocation already has a unique diagnostic identity. Reuse
        // it as the mutation key so a transport retry cannot apply twice.
        ...(idempotent ? { "idempotency-key": correlationId } : {}),
      },
      body: JSON.stringify(body),
      signal,
    });
    const result = await response.json();
    diagnostics.log(
      `<- ${path} [${correlationId}] ${result.ok ? `ok rev ${result.revision}` : result.error?.code}`,
    );
    return result;
  } catch (err) {
    diagnostics.log(`<- ${path} [${correlationId}] network error`);
    return {
      ok: false,
      error: {
        code: "not_found",
        message: `Network error: ${String(err).slice(0, 120)}`,
        recovery: "Retry once the page shows a live connection.",
      },
    };
  }
}

export function syncSession(
  sinceRevision?: number,
  cursor?: string,
): Promise<unknown> {
  return post(
    "/api/sync",
    {
      ...(sinceRevision === undefined ? {} : { sinceRevision }),
      ...(cursor === undefined ? {} : { cursor }),
    },
  );
}

/**
 * Tool-callback variant: forwards the agent's argument object VERBATIM so the
 * server's Ajv pass — not client-side cherry-picking — is what accepts or
 * rejects it (schemas are guidance in the browser, enforcement on the server).
 */
export function syncSessionRaw(
  input: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  // Non-object input is forwarded as-is (only undefined becomes {}): the
  // server's Ajv pass must be the thing that rejects it — converting bad
  // input into an allowed empty object would launder validation failures
  // into first-connection syncs.
  return post("/api/sync", input === undefined ? {} : input, signal);
}

export function submitCommand(type: string, input: unknown): Promise<unknown> {
  return post("/api/commands", { type, input }, undefined, true);
}

/**
 * Spatial reads (same auth/contract-header discipline as /api/sync). The raw
 * variants forward tool arguments verbatim for the same reason syncSessionRaw
 * does: server-side Ajv is the enforcement point.
 */
/**
 * `excludeRequirementId` is the press-and-hold preview: the server answers
 * with the whole context as if that one need were inactive, so the map can
 * settle honestly instead of the page guessing. It is a route-level argument
 * on purpose — holding a row is a pointer gesture on this page, not a
 * decision an agent takes, so the WebMCP input schema stays empty.
 */
export function spatialContext(
  signal?: AbortSignal,
  excludeRequirementId?: string,
): Promise<unknown> {
  return post(
    "/api/spatial/context",
    excludeRequirementId ? { excludeRequirementId } : {},
    signal,
  );
}

export function spatialInspectRaw(
  input: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  return post("/api/spatial/inspect", input === undefined ? {} : input, signal);
}

export function spatialNavigationRaw(
  input: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  return post("/api/spatial/navigation", input === undefined ? {} : input, signal);
}

/**
 * The natural-language surface (docs/NL-AGENT.md), page-only. `nlSay` routes
 * a composer sentence: a need comes back as payloads the page submits itself
 * through the ordinary command bus; a question or instruction is answered by
 * the person's agent and returns a reply. `nlCondition` hands the agent a
 * condition the room never receives.
 */
export function nlSay(text: string, scope: string): Promise<unknown> {
  return post("/api/nl/say", { text, scope });
}

export function nlCondition(text: string): Promise<unknown> {
  return post("/api/nl/condition", { text });
}

/**
 * Before a room exists (components/Start.tsx): the area registry joined with
 * what was measured, and room creation. Neither carries a participant token;
 * the created room's invite secrets come back once, in the body.
 */
export interface AreaCoverage {
  venues: number;
  slots: number;
  decisive: number;
  decisivePct: number;
  tagCounts: Record<string, number>;
  tags: Record<string, number>;
}
export interface AreaSummary {
  id: string;
  label: string;
  city: string;
  center: { lat: number; lng: number };
  radii: { narrow: number; wide: number; max: number };
  available: boolean;
  kind: "osm-snapshot" | "curated" | null;
  source: string;
  dataAsOf: string | null;
  coverage: { measuredAt: string; city: AreaCoverage; focus: AreaCoverage; pool: AreaCoverage } | null;
}
export interface CreatedRoom {
  roomId: string;
  areaId: string;
  invites: Array<{
    participantId: string;
    displayName: string;
    role: "organizer" | "member";
    inviteSecret: string;
  }>;
}

export async function fetchAreas(): Promise<AreaSummary[]> {
  const response = await fetch("/api/areas");
  if (!response.ok) throw new Error(`areas ${response.status}`);
  return ((await response.json()) as { areas: AreaSummary[] }).areas;
}

export async function createRoom(input: {
  areaId: string;
  organizerName: string;
  memberNames: string[];
}): Promise<{ ok: true; room: CreatedRoom } | { ok: false; error: string }> {
  try {
    const response = await fetch("/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    const body = (await response.json()) as CreatedRoom & { error?: string };
    if (!response.ok) return { ok: false, error: body.error ?? `Could not open the room (${response.status}).` };
    return { ok: true, room: body };
  } catch {
    return { ok: false, error: "Could not reach the server. Try again in a moment." };
  }
}
