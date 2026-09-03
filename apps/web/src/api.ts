import { TOOL_CONTRACT_VERSION } from "@webmcp-hackathon/contracts";
import { currentToken } from "./session.ts";
import { trim, utf8Bytes, wire } from "./wire-store.ts";
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

/** `x-server-ms`, when the serving process stamps it (older builds do not). */
function serverMs(response: Response): number | undefined {
  const raw = response.headers.get("x-server-ms");
  if (raw === null) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Read the body as text first, so the timeline knows its size, then parse.
 * An empty or unparsable body throws, exactly as `response.json()` did, so
 * every caller's transport-failure path stays what it was.
 */
export async function readJson(response: Response): Promise<{ body: unknown; bytes: number }> {
  const text = await response.text();
  if (!text) throw new SyntaxError("Empty response body");
  return { body: JSON.parse(text), bytes: utf8Bytes(text) };
}

/** Timeline label for a route: the method and the path after `/api/`. */
export function routeLabel(method: string, path: string): string {
  const route = path.replace(/^\/api\//, "").replace(/\?.*$/, "");
  return `${method} ${route}`;
}

function wasAborted(signal: AbortSignal | undefined, err: unknown): boolean {
  return Boolean(signal?.aborted) || (err instanceof DOMException && err.name === "AbortError");
}

async function post(
  path: string,
  body: unknown,
  signal?: AbortSignal,
  idempotencyKey?: string,
): Promise<unknown> {
  const token = currentToken();
  if (!token) {
    wire.mark({
      lane: "http",
      label: routeLabel("POST", path),
      note: "not_authenticated",
      outcome: "blocked",
      parentId: wire.parentFor(signal),
    });
    return notAuthenticated;
  }
  if (signal?.aborted) return cancelled;
  const correlationId = newCorrelationId();
  const span = wire.begin({
    lane: "http",
    label: routeLabel("POST", path),
    correlationId,
    idempotencyKey,
    parentId: wire.parentFor(signal),
  });
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
    const { body: parsed, bytes } = await readJson(response);
    const result = parsed as {
      ok?: boolean;
      revision?: number;
      replayed?: boolean;
      staged?: boolean;
      effect?: string;
      error?: { code?: string; message?: string; recovery?: string };
    } | null;
    const ok = result?.ok === true;
    const revision = typeof result?.revision === "number" ? result.revision : undefined;
    const verdict = ok
      ? `${result?.replayed ? "replay" : "ok"}${revision !== undefined ? ` rev ${revision}` : ""}`
      : String(result?.error?.code ?? `http ${response.status}`);
    wire.end(span, {
      outcome: ok ? "ok" : "error",
      note: `${verdict}${result?.staged ? " · staged" : ""}`,
      serverMs: serverMs(response),
      revision,
      replayed: result?.replayed === true,
      bytes,
      detail: {
        path,
        correlation: correlationId,
        idempotency: idempotencyKey,
        effect: trim(result?.effect, 120),
        error: trim(result?.error?.message, 120),
        recovery: trim(result?.error?.recovery, 120),
      },
    });
    return parsed;
  } catch (err) {
    if (wasAborted(signal, err)) {
      wire.end(span, { outcome: "cancelled", note: "cancelled" });
      return cancelled;
    }
    wire.end(span, {
      outcome: "error",
      note: "network",
      detail: { path, correlation: correlationId, error: trim(err, 120) },
    });
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
  const span = wire.begin({ lane: "http", label: "GET image", parentId: wire.parentFor(signal) });
  try {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      signal,
    });
    const blob = response.ok ? await response.blob() : null;
    wire.end(span, {
      outcome: response.ok ? "ok" : "error",
      note: String(response.status),
      serverMs: serverMs(response),
      bytes: blob?.size,
    });
    return blob;
  } catch (err) {
    const aborted = wasAborted(signal, err);
    wire.end(span, { outcome: aborted ? "cancelled" : "error", note: aborted ? "cancelled" : "network" });
    return null;
  }
}

export function syncSession(
  sinceRevision?: number,
  cursor?: string,
  signal?: AbortSignal,
): Promise<unknown> {
  return post(
    "/api/sync",
    {
      ...(sinceRevision === undefined ? {} : { sinceRevision }),
      ...(cursor === undefined ? {} : { cursor }),
    },
    signal,
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

export async function landmarksRaw(input: unknown, signal?: AbortSignal): Promise<unknown> {
  const query = (input as { query?: unknown } | null)?.query;
  const token = currentToken();
  if (!token) return notAuthenticated;
  if (typeof query !== "string") {
    return { ok: false, error: { code: "invalid_input", message: "A landmark query is required." } };
  }
  const correlationId = newCorrelationId();
  const span = wire.begin({
    lane: "http",
    label: "GET landmarks",
    correlationId,
    parentId: wire.parentFor(signal),
    detail: { correlation: correlationId },
  });
  try {
    const response = await fetch(`/api/landmarks?q=${encodeURIComponent(query)}`, {
      headers: { authorization: `Bearer ${token}`, "x-correlation-id": correlationId },
      signal,
    });
    const { body, bytes } = await readJson(response);
    const result = body as { ok?: boolean; error?: { code?: string } } | null;
    const ok = result?.ok === true;
    wire.end(span, {
      outcome: ok ? "ok" : "error",
      note: ok ? "ok" : String(result?.error?.code ?? `http ${response.status}`),
      serverMs: serverMs(response),
      bytes,
    });
    return body;
  } catch (err) {
    const aborted = wasAborted(signal, err);
    wire.end(span, { outcome: aborted ? "cancelled" : "error", note: aborted ? "cancelled" : "network" });
    throw err;
  }
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
  const span = wire.begin({
    lane: "http",
    label: "GET places",
    correlationId,
    parentId: wire.parentFor(signal),
    detail: { correlation: correlationId, bbox: bbox.map((v) => v.toFixed(4)).join(",") },
  });
  try {
    const response = await fetch(path, {
      headers: {
        authorization: `Bearer ${token}`,
        "x-correlation-id": correlationId,
      },
      signal,
    });
    const { body: parsed, bytes } = await readJson(response);
    const body = parsed as ExplorePlacesResponse & { error?: string };
    if (!response.ok || body.ok !== true) {
      wire.end(span, {
        outcome: "error",
        note: `http ${response.status}`,
        serverMs: serverMs(response),
        bytes,
      });
      return {
        ok: false,
        error: {
          code: response.status === 400 ? "invalid_input" : "not_found",
          message: body.error ?? `Explore places failed (${response.status}).`,
        },
      };
    }
    wire.end(span, {
      outcome: "ok",
      note: `${body.places.length} places${body.truncated ? " · truncated" : ""}`,
      serverMs: serverMs(response),
      bytes,
    });
    return body;
  } catch (error) {
    if (signal?.aborted) {
      wire.end(span, { outcome: "cancelled", note: "replaced" });
      return { ok: false, error: { code: "aborted", message: "Explore request replaced." } };
    }
    wire.end(span, { outcome: "error", note: "network" });
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
  signal?: AbortSignal,
): Promise<unknown> {
  // X3: the whole routed/model/action loop is one side-effecting turn.
  const body = { text, scope, ...(clarifyOf ? { clarifyOf } : {}) };
  const signature = stableJson({ path: "/api/nl/say", body });
  const key = turnIdempotencyKey ?? retryKeys.get(signature) ?? newIdempotencyKey();
  const result = await post("/api/nl/say", body, signal, key);
  finishLogicalAttempt(signature, key, result);
  return result;
}

export function nlCondition(text: string, signal?: AbortSignal): Promise<unknown> {
  return post("/api/nl/condition", { text }, signal);
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
  /** Server-authored place classes available inside the area's narrow radius. */
  classes?: StepClassSummary[];
}
export interface StepClassSummary {
  key: string;
  label: string;
  count: number;
}
export interface ParsedNeed {
  payload: Record<string, unknown>;
  label: string;
  gist: string;
  topic?: string;
  assumed?: string;
}
export interface PlanClarification {
  question: string;
  choices: Array<{ id: string; label: string; needs: ParsedNeed[] }>;
  allowFreeText: true;
  said: string;
}
export interface PlanPreview {
  goal: string;
  offline: boolean;
  steps: Array<{
    stepId: "s1";
    title: string;
    placeClass: { key: string; label: string };
    needs: ParsedNeed[];
    when: { start: string; end: string; phrase: string } | null;
  }>;
  classes: StepClassSummary[];
  clarify: PlanClarification | null;
  meta: { model: string | null; ms: number };
}
export interface CreatedRoom {
  roomId: string;
  areaId: string;
  goal: string;
  step: {
    placeClass: { key: string; label: string };
    seeded: number;
  };
  invites: Array<{
    participantId: string;
    displayName: string;
    role: "organizer" | "member";
    inviteSecret: string;
  }>;
}

export async function fetchAreas(): Promise<AreaSummary[]> {
  const span = wire.begin({ lane: "http", label: "GET areas" });
  try {
    const response = await fetch("/api/areas");
    if (!response.ok) {
      wire.end(span, { outcome: "error", note: `http ${response.status}`, serverMs: serverMs(response) });
      throw new Error(`areas ${response.status}`);
    }
    const { body, bytes } = await readJson(response);
    wire.end(span, { outcome: "ok", note: "ok", serverMs: serverMs(response), bytes });
    return (body as { areas: AreaSummary[] }).areas;
  } catch (err) {
    // The status branch above closed the span itself; a throw before or
    // after it (transport, non-JSON body) closes it here.
    if (wire.isOpen(span)) wire.end(span, { outcome: "error", note: "network" });
    throw err;
  }
}

/** A best-effort read before a room exists. Any failure is the offline path. */
export async function previewPlan(
  input: { areaId: string; goal: string },
  timeoutMs = 12_000,
): Promise<PlanPreview | null> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch("/api/plans/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return (await response.json()) as PlanPreview;
  } catch {
    return null;
  } finally {
    window.clearTimeout(timeout);
  }
}

export async function createRoom(input: {
  areaId: string;
  organizerName: string;
  memberNames: string[];
  goal?: string;
  step?: { placeClass: string; needs?: ParsedNeed[] };
}): Promise<{ ok: true; room: CreatedRoom } | { ok: false; error: string }> {
  // The invite secrets in the answer never reach the timeline: size only.
  const span = wire.begin({ lane: "http", label: "POST rooms" });
  try {
    const response = await fetch("/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    // Parsed inside the try: a non-JSON body closes the span through the catch.
    const { body: parsed, bytes } = await readJson(response);
    const body = parsed as CreatedRoom & { error?: string };
    wire.end(span, {
      outcome: response.ok ? "ok" : "error",
      note: response.ok ? "ok" : `http ${response.status}`,
      serverMs: serverMs(response),
      bytes,
    });
    if (!response.ok) return { ok: false, error: body.error ?? `Could not open the room (${response.status}).` };
    return { ok: true, room: body };
  } catch {
    wire.end(span, { outcome: "error", note: "network" });
    return { ok: false, error: "Could not reach the server. Try again in a moment." };
  }
}
