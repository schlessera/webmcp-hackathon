/** Content-free request diagnostics. No prompts, URLs, headers or bodies. */
export const WIRE_SERVER_SPAN_LIMIT = 32;
export const WIRE_SERVER_TRACE_CHAR_LIMIT = 6000;

/** Tool diagnostics returned only to the participant whose agent ran them.
 * Summaries contain counts/status, never arguments, result bodies or held text. */
export interface WireAgentCall {
  tool: string;
  round: number;
  ok: boolean;
  ms: number;
  state?: "completed" | "failed" | "approval_required";
  summary?: string;
}

export interface WireServerSpan {
  kind: "model" | "outbound" | "cache";
  label: string;
  offsetMs: number;
  durationMs?: number;
  outcome: "running" | "ok" | "error";
  status?: number;
  bytes?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export interface WireServerTrace {
  version: 1;
  spans: WireServerSpan[];
  omitted: number;
  /** The snapshot ends when response headers are sent, not when background work ends. */
  durationMs: number;
}
