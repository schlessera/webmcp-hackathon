import { TOOL_CONTRACT_VERSION } from "@webmcp-hackathon/contracts";
import { currentToken } from "./session.ts";
import { diagnostics } from "./diagnostics-store.ts";
import type { ExplorePlace } from "./spatial-types.ts";

/**
 * The single client command bus: UI gestures and WebMCP tool callbacks both
 * call submitCommand()/syncSession() here, so both surfaces produce identical
 * domain commands (INTERACTION-AND-BINDING.md §1 rule 4).
 */

function newCorrelationId(): string {
  return `c_${crypto.randomUUID().slice(0, 12)}`;
}

/** X3: identity of one logical mutation/turn, stable across HTTP attempts. */
export function newIdempotencyKey(): string {
  return `i_${crypto.randomUUID()}`;
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

const cancelled = {
  ok: false as const,
  error: {
    code: "temporarily_unavailable" as const,
    message: "Request cancelled before completion.",
    recovery: "Retry when the operation is still needed.",
  },
};

const ambiguousTransportResults = new WeakSet<object>([cancelled]);
const retryKeys = new Map<string, string>();
const MAX_AMBIGUOUS_OPERATIONS = 64;

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function finishLogicalAttempt(
  signature: string,
  key: string,
  result: unknown,
): void {
  if (result && typeof result === "object" && ambiguousTransportResults.has(result)) {
    retryKeys.delete(signature);
    retryKeys.set(signature, key);
    if (retryKeys.size > MAX_AMBIGUOUS_OPERATIONS) {
      retryKeys.delete(retryKeys.keys().next().value!);
    }
  } else {
    retryKeys.delete(signature);
  }
}

async function post(
  path: string,
  body: unknown,
  signal?: AbortSignal,
  idempotencyKey?: string,
): Promise<unknown> {
  const token = currentToken();
  if (!token) {
    diagnostics.log("command blocked: not_authenticated");
    return notAuthenticated;
  }
  if (signal?.aborted) return cancelled;
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
        // X3: correlation IDs identify HTTP attempts; this separate key
        // identifies the logical action and survives every retry.
        ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
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
    if (signal?.aborted || (err instanceof DOMException && err.name === "AbortError")) {
      diagnostics.log(`<- ${path} [${correlationId}] cancelled`);
      return cancelled;
    }
    diagnostics.log(`<- ${path} [${correlationId}] network error`);
    const failure = {
      ok: false,
      error: {
        // R17: transport and JSON-decoding failures say nothing about whether
        // an ID exists; `not_found` would send an agent down the wrong path.
        code: "temporarily_unavailable",
        message: `Request failed before a result was received: ${String(err).slice(0, 120)}`,
        recovery: "Wait for the live connection, then sync the room before deciding whether to try again.",
      },
    };
    ambiguousTransportResults.add(failure);
    return failure;
  }
}

/** Place images are bearer-protected like every other participant read.
 * Fetch them as blobs so an `<img>` never makes an unauthenticated request. */
export async function placeImageBlob(url: string, signal?: AbortSignal): Promise<Blob | null> {
  const token = currentToken();
  if (!token) return null;
  try {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      signal,
    });
    return response.ok ? response.blob() : null;
  } catch {
    return null;
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

export async function submitCommand(
  type: string,
  input: unknown,
  signal?: AbortSignal,
  idempotencyKey?: string,
): Promise<unknown> {
  const body = { type, input };
  const signature = stableJson({ path: "/api/commands", body });
  const key = idempotencyKey ?? retryKeys.get(signature) ?? newIdempotencyKey();
  const result = await post("/api/commands", body, signal, key);
  finishLogicalAttempt(signature, key, result);
  return result;
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

/** Ask the server to look places up now (look_up_places). The answer is the
 * dossiers as they stand; what lands later arrives on the facts frame. */
export function spatialLookupRaw(
  input: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  return post("/api/spatial/lookup", input === undefined ? {} : input, signal);
}

export function spatialNavigationRaw(
  input: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  return post("/api/spatial/navigation", input === undefined ? {} : input, signal);
}

export function landmarksRaw(input: unknown, signal?: AbortSignal): Promise<unknown> {
  const query = (input as { query?: unknown } | null)?.query;
  const token = currentToken();
  if (!token) return Promise.resolve(notAuthenticated);
  if (typeof query !== "string") {
    return Promise.resolve({ ok: false, error: { code: "invalid_input", message: "A landmark query is required." } });
  }
  return fetch(`/api/landmarks?q=${encodeURIComponent(query)}`, {
    headers: { authorization: `Bearer ${token}`, "x-correlation-id": newCorrelationId() },
    signal,
  }).then((response) => response.json());
}

export interface ExplorePlacesResponse {
  ok: true;
  places: ExplorePlace[];
  truncated: boolean;
}

/** Authenticated viewport read over the room area's already-loaded snapshot. */
export async function fetchExplorePlaces(
  roomId: string,
  bbox: [number, number, number, number],
  signal?: AbortSignal,
): Promise<ExplorePlacesResponse | typeof notAuthenticated | { ok: false; error: { code: string; message: string } }> {
  const token = currentToken();
  if (!token) return notAuthenticated;
  const correlationId = newCorrelationId();
  const path = `/api/rooms/${encodeURIComponent(roomId)}/places?bbox=${bbox.join(",")}`;
  diagnostics.log(`-> explore places [${correlationId}]`);
  try {
    const response = await fetch(path, {
      headers: {
        authorization: `Bearer ${token}`,
        "x-correlation-id": correlationId,
      },
      signal,
    });
    const body = await response.json() as ExplorePlacesResponse & { error?: string };
    if (!response.ok || body.ok !== true) {
      return {
        ok: false,
        error: {
          code: response.status === 400 ? "invalid_input" : "not_found",
          message: body.error ?? `Explore places failed (${response.status}).`,
        },
      };
    }
    diagnostics.log(`<- explore places [${correlationId}] ${body.places.length}`);
    return body;
  } catch (error) {
    if (signal?.aborted) {
      return { ok: false, error: { code: "aborted", message: "Explore request replaced." } };
    }
    diagnostics.log(`<- explore places [${correlationId}] network error`);
    return { ok: false, error: { code: "not_found", message: String(error).slice(0, 120) } };
  }
}

/**
 * The natural-language surface (docs/NL-AGENT.md), page-only. `nlSay` routes
 * a composer sentence: a need comes back as payloads the page submits itself
 * through the ordinary command bus; a question or instruction is answered by
 * the person's agent and returns a reply. `nlCondition` hands the agent a
 * condition the room never receives.
 */
export async function nlSay(
  text: string,
  scope: string,
  turnIdempotencyKey?: string,
  clarifyOf?: { said: string; question: string },
): Promise<unknown> {
  // X3: the whole routed/model/action loop is one side-effecting turn.
  const body = { text, scope, ...(clarifyOf ? { clarifyOf } : {}) };
  const signature = stableJson({ path: "/api/nl/say", body });
  const key = turnIdempotencyKey ?? retryKeys.get(signature) ?? newIdempotencyKey();
  const result = await post("/api/nl/say", body, undefined, key);
  finishLogicalAttempt(signature, key, result);
  return result;
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
