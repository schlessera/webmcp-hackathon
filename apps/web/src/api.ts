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

export function syncSession(sinceRevision?: number): Promise<unknown> {
  return post(
    "/api/sync",
    sinceRevision === undefined ? {} : { sinceRevision },
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
  return post("/api/commands", { type, input });
}

/**
 * Spatial reads (same auth/contract-header discipline as /api/sync). The raw
 * variants forward tool arguments verbatim for the same reason syncSessionRaw
 * does: server-side Ajv is the enforcement point.
 */
export function spatialContext(signal?: AbortSignal): Promise<unknown> {
  return post("/api/spatial/context", {}, signal);
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
