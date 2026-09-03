import { config } from "../config.ts";
import { parseJson, respond, type ContentPart } from "../nl/llm.ts";

/** The deliberately small visual vocabulary persisted in
 * `place_image_verdicts`. It is about what an image depicts, not why a URL
 * happened to be present in a page. */
export const PLACE_IMAGE_KINDS = [
  "venue_exterior",
  "venue_interior",
  "food_or_drink",
  "people",
  "logo",
  "flag_or_icon",
  "map_or_screenshot",
  "text_or_graphic",
  "other",
] as const;

export type PlaceImageKind = (typeof PLACE_IMAGE_KINDS)[number];

export interface PlaceImageVerdict {
  kind: PlaceImageKind;
  confidence: number;
}

export interface ClassifiedImageBatch {
  verdicts: PlaceImageVerdict[] | null;
  model: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
}

export const PLACE_IMAGE_CONFIDENCE_THRESHOLD = 0.6;

export function placeImageClassifierEnabled(): boolean {
  return config.nlEnabled && process.env.PLACE_IMAGE_CLASSIFIER !== "0";
}

/** People visibly inside or in front of a place are instructed to land in a
 * venue kind. `people` therefore means a portrait/stock/group shot with no
 * place visible and fails closed. */
export function keepPlaceImageVerdict(
  verdict: PlaceImageVerdict,
  confidenceThreshold = PLACE_IMAGE_CONFIDENCE_THRESHOLD,
): boolean {
  return verdict.confidence >= confidenceThreshold &&
    (verdict.kind === "venue_exterior" ||
      verdict.kind === "venue_interior" ||
      verdict.kind === "food_or_drink");
}

/** Strict at the application boundary as well as in the Responses schema. A
 * malformed or short answer cannot accidentally align with only the images
 * it liked: the entire batch rejects. */
export function placeImageVerdictsFromAnswer(
  answer: unknown,
  expectedImages: number,
): PlaceImageVerdict[] | null {
  const images = (answer as { images?: unknown } | null)?.images;
  if (!Array.isArray(images) || images.length !== expectedImages) return null;
  const out: PlaceImageVerdict[] = [];
  for (const raw of images) {
    if (!raw || typeof raw !== "object") return null;
    const item = raw as { kind?: unknown; confidence?: unknown };
    const confidence = Number(item.confidence);
    if (
      typeof item.kind !== "string" ||
      !(PLACE_IMAGE_KINDS as readonly string[]).includes(item.kind) ||
      !Number.isFinite(confidence) || confidence < 0 || confidence > 1
    ) return null;
    out.push({ kind: item.kind as PlaceImageKind, confidence });
  }
  return out;
}

const INSTRUCTIONS = [
  "Classify representative-image candidates for one place. Return exactly one entry per image, in input order.",
  "venue_exterior: the place's building, entrance, frontage, terrace, or recognisable exterior.",
  "venue_interior: the place's recognisable room, counter, dining area, shop floor, or other interior.",
  "food_or_drink: food or drink plausibly served by this place.",
  "If people are visibly inside or directly in front of a venue, classify by the visible setting as venue_interior or venue_exterior. Use people for portraits, staff headshots, crowds, lifestyle or stock shots where no venue setting is visible.",
  "Use logo, flag_or_icon, map_or_screenshot, or text_or_graphic for those non-photo/place-irrelevant forms. Use other when none fits.",
  "Confidence is 0 to 1 for the chosen kind. Do not infer that an image depicts the place merely because the page supplied it.",
  "Output only the JSON.",
].join("\n");

function schemaFor(count: number) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["images"],
    properties: {
      images: {
        type: "array",
        minItems: count,
        maxItems: count,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["kind", "confidence"],
          properties: {
            kind: { type: "string", enum: [...PLACE_IMAGE_KINDS] },
            confidence: { type: "number", minimum: 0, maximum: 1 },
          },
        },
      },
    },
  };
}

/** One low-detail vision call for all already-downloaded WebPs from a place. */
export async function classifyPlaceImages(
  placeName: string,
  images: Array<{ bytes: Uint8Array }>,
): Promise<ClassifiedImageBatch> {
  const model = config.nlFastModel;
  if (images.length === 0) {
    return { verdicts: [], model, durationMs: 0, inputTokens: 0, outputTokens: 0 };
  }
  const content: ContentPart[] = [{
    type: "input_text",
    text: `Place: ${placeName}\nImages follow in candidate order (1-${images.length}).`,
  }];
  for (const [index, image] of images.entries()) {
    content.push({ type: "input_text", text: `Image ${index + 1}` });
    content.push({
      type: "input_image",
      image_url: `data:image/webp;base64,${Buffer.from(image.bytes).toString("base64")}`,
      detail: "low",
    });
  }
  const reply = await respond({
    model,
    instructions: INSTRUCTIONS,
    input: [{ role: "user", content }],
    schema: { name: "place_image_verdicts", schema: schemaFor(images.length) },
    reasoning: "low",
    maxOutputTokens: 1_150,
    timeoutMs: 90_000,
  });
  return {
    verdicts: placeImageVerdictsFromAnswer(parseJson(reply.text), images.length),
    model: reply.model,
    durationMs: reply.ms,
    inputTokens: reply.inputTokens,
    outputTokens: reply.outputTokens,
  };
}
