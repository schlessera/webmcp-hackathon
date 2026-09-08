/** Content-free request diagnostics. No prompts, URLs, headers or bodies. */
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
