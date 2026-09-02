import { config } from "../config.ts";
import { parseJson, respond } from "../nl/openai.ts";

/**
 * Reading a menu that is a picture (docs/ENRICHMENT-SOURCES.md, S2 "reading
 * menus"). A scanned PDF, a photo, an image-only menu page: a vision model
 * reads it and answers a fixed set of questions with a confidence each.
 *
 * Why a model and not OCR: the same call handles a PDF, a photo taken at an
 * angle and a page image, reads German and English, and returns the claims
 * in the shape the dossier wants instead of a text blob to regex through.
 * Why it never verifies anything: a reading is a reading. Every claim lands
 * as `likely_*` at no more than 0.69 (SPATIAL-PROTOCOL.md §8.2) with the
 * source `menu:<host>`, so the room sees where it came from and the engine
 * treats it as a guess. Text the model reads is not stored; only the claims.
 *
 * Off whenever OPENAI_API_KEY is unset or MENU_READER=0.
 */

export const READABLE_KEYS = [
  "vegetarian-options",
  "vegan-options",
  "gluten-free-options",
  "lactose-free-options",
  "halal-options",
] as const;

export interface MenuClaim {
  key: (typeof READABLE_KEYS)[number];
  lean: "yes" | "no";
  confidence: number;
  /** A few words from the menu that carry the claim, e.g. "vegan bowl (vg)". */
  evidence: string;
}

export interface MenuReading {
  model: string;
  readAt: string;
  legible: boolean;
  language: string | null;
  /** Rough count of dishes read; 0 when illegible. */
  items: number;
  cuisine: string[];
  /** 1–4, when the prices read make a band obvious. */
  priceLevel: number | null;
  claims: MenuClaim[];
}

export interface MenuSource {
  kind: "pdf" | "image";
  url: string;
  contentType: string;
  bytes: Uint8Array;
}

/** The most a reading may claim: a likely fact, never a verified one. */
export const READING_CONFIDENCE_CAP = 0.69;
const MAX_BYTES = 4_000_000;

export function menuReaderEnabled(): boolean {
  return config.nlEnabled && process.env.MENU_READER !== "0";
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["legible", "language", "items", "cuisine", "priceLevel", "claims"],
  properties: {
    legible: { type: "boolean" },
    language: { type: ["string", "null"] },
    items: { type: "integer" },
    cuisine: { type: "array", items: { type: "string" } },
    priceLevel: { type: ["integer", "null"] },
    claims: {
      type: "array",
      maxItems: 10,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "lean", "confidence", "evidence"],
        properties: {
          key: { type: "string", enum: [...READABLE_KEYS] },
          lean: { type: "string", enum: ["yes", "no"] },
          confidence: { type: "number" },
          evidence: { type: "string" },
        },
      },
    },
  },
};

const INSTRUCTIONS = [
  "You are reading a restaurant, café or bar menu from an image or PDF for a planning tool.",
  "Answer only from what is on the page. If the page is not a menu or cannot be read, set legible=false, items=0 and claims=[].",
  "items: roughly how many dishes or drinks are listed.",
  "cuisine: up to three lowercase words for the kind of food, OpenStreetMap style (e.g. vietnamese, pizza, coffee_shop); [] when unclear.",
  "priceLevel: 1 cheap … 4 expensive for a main dish, from the prices shown; null when no prices or unclear.",
  "claims: for each of vegetarian-options, vegan-options, gluten-free-options, lactose-free-options, halal-options, answer only when the menu gives evidence either way: lean yes when dishes are marked or described as such (V, vg, vegan, vegetarisch, glutenfrei, gluten-free, laktosefrei, lactose-free, halal, or obviously meat-free dishes), lean no only when the menu makes it clear there is none (e.g. a steak-only list). confidence 0–1 is how sure you are; quote the evidence in a few words. Omit keys with no evidence.",
  "Never invent dishes or markers. Output only the JSON.",
].join("\n");

/** Pure: a model answer into a reading, clamped and capped. Exported for tests. */
export function readingFromAnswer(answer: unknown, model: string, readAt: string): MenuReading | null {
  const a = answer as Partial<MenuReading> | null;
  if (!a || typeof a !== "object" || typeof a.legible !== "boolean") return null;
  const claims: MenuClaim[] = [];
  for (const c of Array.isArray(a.claims) ? a.claims : []) {
    if (!c || !(READABLE_KEYS as readonly string[]).includes(c.key)) continue;
    if (c.lean !== "yes" && c.lean !== "no") continue;
    const confidence = Number(c.confidence);
    if (!Number.isFinite(confidence) || confidence <= 0) continue;
    if (claims.some((x) => x.key === c.key)) continue;
    claims.push({
      key: c.key,
      lean: c.lean,
      confidence: Math.min(READING_CONFIDENCE_CAP, Math.max(0.05, confidence)),
      evidence: String(c.evidence ?? "").slice(0, 80),
    });
  }
  const price = Number(a.priceLevel);
  return {
    model,
    readAt,
    legible: a.legible,
    language: typeof a.language === "string" ? a.language.slice(0, 12) : null,
    items: Math.max(0, Math.round(Number(a.items) || 0)),
    cuisine: (Array.isArray(a.cuisine) ? a.cuisine : []).map(String).map((s) => s.trim().toLowerCase()).filter(Boolean).slice(0, 3),
    priceLevel: Number.isInteger(price) && price >= 1 && price <= 4 ? price : null,
    claims: a.legible ? claims : [],
  };
}

/** One model call over one menu file. Null when disabled, too big, or unreadable. */
export async function readMenu(source: MenuSource): Promise<MenuReading | null> {
  if (!menuReaderEnabled()) return null;
  if (source.bytes.byteLength === 0 || source.bytes.byteLength > MAX_BYTES) return null;
  const base64 = Buffer.from(source.bytes).toString("base64");
  const mime = source.contentType.split(";")[0].trim() || (source.kind === "pdf" ? "application/pdf" : "image/jpeg");
  const part =
    source.kind === "pdf"
      ? { type: "input_file" as const, filename: "menu.pdf", file_data: `data:${mime};base64,${base64}` }
      : { type: "input_image" as const, image_url: `data:${mime};base64,${base64}`, detail: "high" as const };
  const model = config.menuReaderModel;
  const reply = await respond({
    model,
    instructions: INSTRUCTIONS,
    input: [{ role: "user", content: [{ type: "input_text", text: `Menu from ${source.url}` }, part] }],
    schema: { name: "menu_reading", schema: SCHEMA },
    reasoning: "low",
    maxOutputTokens: 900,
    timeoutMs: 45_000,
  });
  return readingFromAnswer(parseJson(reply.text), reply.model, new Date().toISOString());
}
