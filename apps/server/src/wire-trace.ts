import type { WireServerSpan, WireServerTrace } from "@webmcp-hackathon/contracts";
import { currentWork } from "./work-context.ts";

/** One request owns this bounded recorder, including work it enqueues. It is
 * sealed when headers are sent; late work never keeps accumulating records. */
export class RequestTrace {
  readonly started = performance.now();
  private spans: WireServerSpan[] = [];
  private omitted = 0;
  private sealed = false;

  begin(kind: WireServerSpan["kind"], label: string) {
    if (this.sealed) return () => {};
    if (this.spans.length >= 16) { this.omitted++; return () => {}; }
    const started = performance.now();
    const span: WireServerSpan = { kind, label: label.replace(/[^a-zA-Z0-9_. /:-]/g, "").slice(0, 80),
      offsetMs: Math.round(started - this.started), outcome: "running" };
    this.spans.push(span);
    return (patch: Partial<Pick<WireServerSpan, "outcome" | "status" | "bytes" | "inputTokens" | "outputTokens" | "costUsd">> = {}) => {
      if (this.sealed) return;
      span.durationMs = Math.round(performance.now() - started);
      span.outcome = patch.outcome ?? "ok";
      for (const key of ["status", "bytes", "inputTokens", "outputTokens", "costUsd"] as const) {
        const value = patch[key];
        if (typeof value === "number" && Number.isFinite(value) && value >= 0) span[key] = value;
      }
    };
  }

  finish(): WireServerTrace {
    this.sealed = true;
    const snapshot: WireServerTrace = { version: 1, spans: this.spans,
      omitted: this.omitted, durationMs: Math.round(performance.now() - this.started) };
    while (JSON.stringify(snapshot).length > 6000) { snapshot.spans.pop(); snapshot.omitted++; }
    return snapshot;
  }
}

export function traceWork(kind: WireServerSpan["kind"], label: string) {
  return currentWork().trace?.begin(kind, label) ?? (() => {});
}
