import { wire, utf8Bytes } from "./wire-store.ts";

/** Measures response metadata without retaining the body. */
export async function readJson(response: Response, span?: string): Promise<{ body: unknown; bytes: number }> {
  if (span) wire.received(span, response);
  const started = performance.now();
  const text = await response.text();
  const bodyMs = performance.now() - started;
  const bytes = utf8Bytes(text);
  const parseStarted = performance.now();
  try {
    if (!text) throw new SyntaxError("Empty response body");
    const body = JSON.parse(text);
    if (span) wire.patch(span, { bodyMs, parseMs: performance.now() - parseStarted, bytes });
    return { body, bytes };
  } catch (error) {
    if (span) wire.patch(span, { bodyMs, parseMs: performance.now() - parseStarted, bytes, failureKind: "decode" });
    throw error;
  }
}
