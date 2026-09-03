import type { Static } from "@sinclair/typebox";
import type { RequirementPayload } from "./commands.ts";
import { ATTRIBUTE_LABELS, ATTRIBUTE_VOCABULARY } from "./manifest.ts";
import { windowLabel } from "./hours.ts";

/** One independently answerable fact about one place. */
export type Criterion =
  | { id: string; kind: "key"; key: string; label: string }
  | { id: string; kind: "question"; text: string; label: string };

export type RequirementPayloadValue = Static<typeof RequirementPayload>;

/** Stable machine form: whitespace/case and one trailing sentence mark do not matter. */
export function normalizeQuestion(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase().replace(/[?.]$/, "").trim();
}

/**
 * Synchronous SHA-1 for criterion ids. Kept here instead of hash.ts because
 * this package's main entrypoint is imported by the browser and hash.ts uses
 * node: modules. SHA-1 is an identity hash here, not a security primitive.
 */
function sha1(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const words = new Uint32Array(80);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i += 1) words[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 80; i += 1) {
      const n = words[i - 3] ^ words[i - 8] ^ words[i - 14] ^ words[i - 16];
      words[i] = ((n << 1) | (n >>> 31)) >>> 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let i = 0; i < 80; i += 1) {
      const [f, k] =
        i < 20
          ? [(b & c) | (~b & d), 0x5a827999]
          : i < 40
            ? [b ^ c ^ d, 0x6ed9eba1]
            : i < 60
              ? [(b & c) | (b & d) | (c & d), 0x8f1bbcdc]
              : [b ^ c ^ d, 0xca62c1d6];
      const rotate = ((a << 5) | (a >>> 27)) >>> 0;
      const next = (rotate + f + e + k + words[i]) >>> 0;
      e = d;
      d = c;
      c = ((b << 30) | (b >>> 2)) >>> 0;
      b = a;
      a = next;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }
  return [h0, h1, h2, h3, h4].map((n) => n.toString(16).padStart(8, "0")).join("");
}

export function questionKey(text: string): string {
  return `q:${sha1(normalizeQuestion(text))}`;
}

const keyCriterion = (key: keyof typeof ATTRIBUTE_LABELS): Criterion => ({
  id: key,
  kind: "key",
  key,
  label: ATTRIBUTE_LABELS[key],
});

/** Map a stored requirement payload to the fact a lookup can answer. */
export function criterionFor(
  payload: RequirementPayloadValue | null | undefined,
  context?: { timezone: string; now: Date },
): Criterion | null {
  if (!payload) return null;
  if (payload.kind === "attribute") {
    if (!(ATTRIBUTE_VOCABULARY as readonly string[]).includes(payload.key)) return null;
    return keyCriterion(payload.key);
  }
  if (payload.kind === "text") {
    const label = payload.text.trim().replace(/\s+/g, " ");
    const text = normalizeQuestion(payload.text);
    return { id: questionKey(payload.text), kind: "question", text, label };
  }
  if (payload.kind === "time") {
    const id = `open:${payload.window.start}-${payload.window.end}`;
    const phrase = payload.phrase?.trim().replace(/\s+/g, " ");
    const label = context
      ? windowLabel(payload.window, context.timezone, context.now)
      : phrase || `open ${payload.window.start}–${payload.window.end}`;
    return { id, kind: "key", key: id, label };
  }
  if ((payload.kind === "inclusion" || payload.kind === "exclusion") && payload.key === "cuisine") {
    return keyCriterion("cuisine");
  }
  return null;
}
