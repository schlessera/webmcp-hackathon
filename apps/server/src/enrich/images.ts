import { createHash } from "node:crypto";
import type pg from "pg";
import sharp from "sharp";
import { outboundFetchFor } from "../net/outbound.ts";
import { IMAGE_CACHE_TTL_MS } from "./cache.ts";
import {
  ENRICH_USER_AGENT,
  fetchAllowed,
  fetchPublic,
  type FetchLike,
} from "./website.ts";
import {
  classifyPlaceImages,
  keepPlaceImageVerdict,
  placeImageClassifierEnabled,
  type PlaceImageKind,
  type PlaceImageVerdict,
} from "./image-classifier.ts";
import { cleanInlineText, truncateText } from "./text.ts";

export interface ImageCandidate {
  url: string;
  source: string;
  pageUrl: string;
  credit?: string;
  license?: string;
  imagePolicy?: {
    class: "structured" | "page-image";
    minimumWidth: number;
    minimumHeight: number;
    confidenceThreshold: number;
  };
}

export interface ProcessedImage {
  mime: "image/webp";
  width: number;
  height: number;
  bytes: Buffer;
  /** How long this copy may be kept, already clamped to the source's own
   * freshness hint. Absent means the full image TTL. */
  ttlMs?: number;
}

export interface StoredPlaceImage extends ProcessedImage {
  osmRef: string;
  idx: number;
  source: string;
  sourceUrl: string;
  pageUrl: string;
  credit?: string;
  license?: string;
  fetchedAt: string;
  expiresAt: string;
}

export const MAX_IMAGE_CANDIDATES = 3;
export const MAX_IMAGE_ATTEMPTS = 8;
export const MAX_IMAGE_DOWNLOAD_BYTES = 6 * 1024 * 1024;
export const MAX_STORED_IMAGE_BYTES = 200 * 1024;
export const IMAGE_TIMEOUT_MS = 10_000;
export const IMAGE_TTL_MS = IMAGE_CACHE_TTL_MS;
const IMAGE_FAILURE_TTL_MS = 60 * 60 * 1000;
export const IMAGE_VERDICT_TTL_DAYS = 30;
/** A source that asks for a shorter life gets a shorter life, but re-fetching
 * every hour for thousands of places is its own kind of rudeness. */
const MIN_IMAGE_TTL_MS = 24 * 60 * 60 * 1000;
const DECODED_FORMATS = new Set([
  "jpeg", "png", "webp", "avif", "heif", "tiff",
]);
const NON_PHOTO_EXTENSION = /\.(?:svg|ico|gif)$/i;

export function imageUrlHash(url: string): string {
  return createHash("sha256").update(url).digest("hex");
}

/** Read a response without ever retaining more than the six-megabyte input
 * ceiling. Content-Length is only an early rejection; the streamed count is
 * authoritative. */
export async function readBoundedImageBody(
  response: Response,
  maxBytes = MAX_IMAGE_DOWNLOAD_BYTES,
): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error("image exceeds download limit");
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error("image exceeds download limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), size);
}

/** Decode first, then constrain and encode. A declared image MIME is never
 * trusted: Sharp must recognize an actual raster/vector image. */
export async function resizePlaceImage(
  input: Uint8Array,
  minimumSize: { width: number; height: number } = { width: 480, height: 320 },
): Promise<ProcessedImage> {
  if (input.byteLength === 0 || input.byteLength > MAX_IMAGE_DOWNLOAD_BYTES) {
    throw new Error("image exceeds download limit");
  }
  const decoder = sharp(Buffer.from(input), {
    failOn: "error",
    limitInputPixels: 40_000_000,
  });
  const metadata = await decoder.metadata();
  if (!metadata.format || !DECODED_FORMATS.has(metadata.format)) {
    throw new Error("decoded content is not an image");
  }
  let decodedWidth = metadata.width;
  let decodedHeight = metadata.height;
  if ((metadata.orientation ?? 0) >= 5) {
    [decodedWidth, decodedHeight] = [decodedHeight, decodedWidth];
  }
  if (!decodedWidth || !decodedHeight) throw new Error("image has no dimensions");
  if (decodedWidth < minimumSize.width || decodedHeight < minimumSize.height) {
    throw new Error("image dimensions are too small");
  }
  const aspect = decodedWidth / decodedHeight;
  if (aspect < 0.5 || aspect > 3) throw new Error("image aspect ratio is unsuitable");
  const { data, info } = await decoder
    .rotate()
    .resize({ width: 960, withoutEnlargement: true })
    .webp({ quality: 72 })
    .toBuffer({ resolveWithObject: true });
  if (!info.width || !info.height) throw new Error("image has no dimensions");
  if (data.byteLength > MAX_STORED_IMAGE_BYTES) {
    throw new Error("resized image exceeds storage limit");
  }
  return { mime: "image/webp", width: info.width, height: info.height, bytes: data };
}

/** Clamp our thirty-day store to the source's own `max-age`, with a one-day
 * floor so a short hint cannot turn into an hourly re-fetch of every place. */
export function cacheTtlMs(cacheControl: string): number {
  const declared = [...cacheControl.matchAll(/(?:^|,)\s*(?:s-maxage|max-age)=(\d+)/g)]
    .map((match) => Number(match[1]))
    .filter((seconds) => Number.isFinite(seconds));
  if (declared.length === 0) return IMAGE_TTL_MS;
  const shortest = Math.min(...declared) * 1000;
  return Math.min(IMAGE_TTL_MS, Math.max(MIN_IMAGE_TTL_MS, shortest));
}

export async function downloadPlaceImage(
  candidate: ImageCandidate,
  fetchImpl: FetchLike = outboundFetchFor("venue-image", {
    maxBytes: MAX_IMAGE_DOWNLOAD_BYTES,
    timeoutMs: IMAGE_TIMEOUT_MS,
  }),
): Promise<ProcessedImage> {
  const target = new URL(candidate.url);
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error("not a fetchable image URL");
  }
  if (NON_PHOTO_EXTENSION.test(target.pathname)) {
    throw new Error("image file type is unsuitable");
  }
  if (!(await fetchAllowed(target, fetchImpl, IMAGE_TIMEOUT_MS))) {
    throw new Error("robots.txt disallows image");
  }
  const response = await fetchPublic(
    target,
    {
      headers: { "user-agent": ENRICH_USER_AGENT, accept: "image/*" },
      signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
    },
    fetchImpl,
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`HTTP ${response.status}`);
  }
  const cacheControl = (response.headers.get("cache-control") ?? "").toLowerCase();
  if (/(?:^|,)\s*(?:no-store|no-cache|private)(?:\s|,|$)/.test(cacheControl)) {
    await response.body?.cancel();
    throw new Error("source response forbids shared caching");
  }
  // A shorter freshness hint shortens our copy rather than refusing it: almost
  // every real image host sends an hour or a day, and treating that as a
  // prohibition would leave the band permanently empty.
  const image = await resizePlaceImage(
    await readBoundedImageBody(response),
    candidate.imagePolicy
      ? { width: candidate.imagePolicy.minimumWidth, height: candidate.imagePolicy.minimumHeight }
      : undefined,
  );
  return { ...image, ttlMs: cacheTtlMs(cacheControl) };
}

export async function imageRefreshDue(
  q: Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query">,
  osmRef: string,
  forceAfterMs?: number,
): Promise<boolean> {
  const row = (
    await q.query(
      `SELECT
         CASE
           WHEN EXISTS (SELECT 1 FROM place_images WHERE osm_ref = $1)
             AND NOT EXISTS (
               SELECT 1 FROM place_images WHERE osm_ref = $1 AND expires_at > now()
             ) THEN true
           WHEN $2::bigint IS NOT NULL AND image_error IS NULL
             AND image_fetched_at <= now() - ($2 || ' milliseconds')::interval THEN true
           ELSE image_expires_at <= now()
         END AS due
       FROM enrichments WHERE osm_ref = $1`,
      [osmRef, forceAfterMs ?? null],
    )
  ).rows[0] as { due: boolean | null } | undefined;
  return row?.due !== false;
}

/** The batch form of `imageRefreshDue`. A fill pass asks about fifty places at
 * once, and the memory rule is one query per batch, never one per place. */
export async function imagesRefreshDue(
  q: Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query">,
  refs: string[],
): Promise<Set<string>> {
  if (refs.length === 0) return new Set();
  const rows = (
    await q.query(
      `SELECT r.osm_ref,
              (e.osm_ref IS NULL
                OR e.image_expires_at IS NULL
                OR e.image_expires_at <= now()
                OR (EXISTS (SELECT 1 FROM place_images i WHERE i.osm_ref = r.osm_ref)
                    AND NOT EXISTS (
                      SELECT 1 FROM place_images i
                       WHERE i.osm_ref = r.osm_ref AND i.expires_at > now()
                    ))) AS due
         FROM unnest($1::text[]) AS r(osm_ref)
         LEFT JOIN enrichments e ON e.osm_ref = r.osm_ref`,
      [refs],
    )
  ).rows as Array<{ osm_ref: string; due: boolean }>;
  return new Set(rows.filter((row) => row.due).map((row) => row.osm_ref));
}

interface VerdictRow {
  url_hash: string;
  kind: PlaceImageKind;
  confidence: number;
  model: string;
  decided_at: Date;
}

async function loadImageVerdicts(
  db: Pick<pg.Pool, "query">,
  candidates: ImageCandidate[],
): Promise<Map<string, VerdictRow>> {
  if (candidates.length === 0) return new Map();
  const hashes = candidates.map((candidate) => imageUrlHash(candidate.url));
  const rows = (await db.query(
    `SELECT url_hash, kind, confidence, model, decided_at
       FROM place_image_verdicts
      WHERE url_hash = ANY($1)
        AND decided_at > now() - ($2 || ' days')::interval`,
    [hashes, String(IMAGE_VERDICT_TTL_DAYS)],
  )).rows as VerdictRow[];
  return new Map(rows.map((row) => [row.url_hash, row]));
}

async function saveImageVerdicts(
  db: Pick<pg.Pool, "query">,
  rows: Array<{ candidate: ImageCandidate; verdict: PlaceImageVerdict }>,
  model: string,
): Promise<void> {
  if (rows.length === 0) return;
  await db.query(
    `INSERT INTO place_image_verdicts
       (url_hash, kind, confidence, model, decided_at)
     SELECT batch.url_hash, batch.kind, batch.confidence, $4, now()
       FROM unnest($1::text[], $2::text[], $3::real[])
            AS batch(url_hash, kind, confidence)
     ON CONFLICT (url_hash) DO UPDATE SET
       kind = EXCLUDED.kind,
       confidence = EXCLUDED.confidence,
       model = EXCLUDED.model,
       decided_at = EXCLUDED.decided_at`,
    [
      rows.map(({ candidate }) => imageUrlHash(candidate.url)),
      rows.map(({ verdict }) => verdict.kind),
      rows.map(({ verdict }) => verdict.confidence),
      model,
    ],
  );
}

interface ExistingImage {
  source_url: string;
  mime: "image/webp";
  width: number;
  height: number;
  bytes: Buffer;
  expires_at: Date;
}

/** One place at a time is already bounded by the enrichment semaphore.
 * Curated candidates are tried first. Site candidates are cache-gated before
 * download, transformed once, then classified together in one vision call. */
export async function refreshPlaceImages(
  db: pg.Pool,
  osmRef: string,
  placeName: string,
  candidates: ImageCandidate[],
  fetchImpl: FetchLike = outboundFetchFor("venue-image", {
    maxBytes: MAX_IMAGE_DOWNLOAD_BYTES,
    timeoutMs: IMAGE_TIMEOUT_MS,
  }),
  /** Counted by the caller on the routed Commons fetch, reported on the log
   * line so the per-place geosearch volume is visible in production. */
  imageWork: { commonsApiCalls?: number } = {},
): Promise<number> {
  const unique = [
    ...new Map(candidates.map((candidate) => [candidate.url, candidate])).values(),
  ].slice(0, MAX_IMAGE_ATTEMPTS);
  const stored: Array<{ candidate: ImageCandidate; image: ProcessedImage }> = [];
  let failures = 0;
  const rejectedByKind: Record<string, number> = {};
  let visionImagesIn = 0;
  let keptByVision = 0;
  let visionModel = "none";
  let visionDurationMs = 0;
  let visionInputTokens = 0;
  let visionOutputTokens = 0;
  const curated = unique.filter((candidate) => !candidate.source.startsWith("web:"));
  const website = unique.filter((candidate) => candidate.source.startsWith("web:"));
  const structuredWebsite = website.filter((candidate) => candidate.imagePolicy?.class !== "page-image");
  const pageWebsite = website.filter((candidate) => candidate.imagePolicy?.class === "page-image").slice(0, 1);
  const orderedWebsite = [...structuredWebsite, ...pageWebsite];
  for (const candidate of curated) {
    if (stored.length >= MAX_IMAGE_CANDIDATES) break;
    try {
      stored.push({ candidate, image: await downloadPlaceImage(candidate, fetchImpl) });
    } catch {
      failures += 1;
    }
  }

  if (stored.length < MAX_IMAGE_CANDIDATES && orderedWebsite.length > 0 && placeImageClassifierEnabled()) {
    const verdicts = await loadImageVerdicts(db, orderedWebsite);
    const existingRows = (await db.query(
      `SELECT source_url, mime, width, height, bytes, expires_at
         FROM place_images WHERE osm_ref = $1 AND expires_at > now()`,
      [osmRef],
    )).rows as ExistingImage[];
    const existing = new Map(existingRows.map((row) => [row.source_url, row]));
    const approved = new Map<string, ProcessedImage>();
    const pending: Array<{ candidate: ImageCandidate; image: ProcessedImage }> = [];

    for (const candidate of orderedWebsite) {
      const cached = verdicts.get(imageUrlHash(candidate.url));
      if (cached && !keepPlaceImageVerdict(cached, candidate.imagePolicy?.confidenceThreshold)) continue;
      if (cached) {
        const prior = existing.get(candidate.url);
        if (prior) {
          approved.set(candidate.url, {
            mime: prior.mime,
            width: prior.width,
            height: prior.height,
            bytes: prior.bytes,
            ttlMs: Math.max(1, prior.expires_at.getTime() - Date.now()),
          });
          continue;
        }
      }
      try {
        const image = await downloadPlaceImage(candidate, fetchImpl);
        if (cached) approved.set(candidate.url, image);
        else pending.push({ candidate, image });
      } catch {
        failures += 1;
      }
    }

    if (pending.length > 0) {
      visionImagesIn = pending.length;
      try {
        const classified = await classifyPlaceImages(placeName, pending.map(({ image }) => image));
        visionModel = classified.model;
        visionDurationMs = classified.durationMs;
        visionInputTokens = classified.inputTokens;
        visionOutputTokens = classified.outputTokens;
        if (classified.verdicts) {
          const decided = pending.map((entry, index) => ({
            candidate: entry.candidate,
            verdict: classified.verdicts![index],
          }));
          await saveImageVerdicts(db, decided, classified.model);
          for (const [index, entry] of pending.entries()) {
            const verdict = classified.verdicts[index];
            if (keepPlaceImageVerdict(verdict, entry.candidate.imagePolicy?.confidenceThreshold)) {
              approved.set(entry.candidate.url, entry.image);
              keptByVision += 1;
            } else {
              rejectedByKind[verdict.kind] = (rejectedByKind[verdict.kind] ?? 0) + 1;
            }
          }
        } else {
          rejectedByKind.invalid_answer = pending.length;
          failures += pending.length;
        }
      } catch {
        rejectedByKind.classifier_error = pending.length;
        failures += pending.length;
      }
    }

    for (const candidate of orderedWebsite) {
      if (stored.length >= MAX_IMAGE_CANDIDATES) break;
      const image = approved.get(candidate.url);
      if (image) stored.push({ candidate, image });
    }
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM place_images WHERE osm_ref = $1", [osmRef]);
    if (stored.length > 0) {
      for (const [idx, entry] of stored.entries()) {
        await client.query(
          `INSERT INTO place_images
             (osm_ref, idx, mime, width, height, bytes, source, source_url,
              page_url, license, credit, fetched_at, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                   now(), now() + ($12 || ' milliseconds')::interval)`,
          [
            osmRef,
            idx,
            entry.image.mime,
            entry.image.width,
            entry.image.height,
            entry.image.bytes,
            entry.candidate.source,
            entry.candidate.url,
            entry.candidate.pageUrl,
            entry.candidate.license
              ? truncateText(cleanInlineText(entry.candidate.license), 80)
              : null,
            entry.candidate.credit
              ? truncateText(cleanInlineText(entry.candidate.credit), 180)
              : null,
            String(entry.image.ttlMs ?? IMAGE_TTL_MS),
          ],
        );
      }
    }
    const completed = stored.length > 0 || failures === 0;
    await client.query(
      `UPDATE enrichments SET
         image_fetched_at = now(),
         image_expires_at = now() + ($2 || ' milliseconds')::interval,
         image_error = $3
       WHERE osm_ref = $1`,
      [
        osmRef,
        String(completed ? IMAGE_TTL_MS : IMAGE_FAILURE_TTL_MS),
        failures > 0 && stored.length === 0 ? "no usable image candidate" : null,
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  console.info(JSON.stringify({
    msg: "place image work",
    place: placeName,
    candidates: unique.length,
    stored: stored.length,
    imagesIn: visionImagesIn,
    kept: keptByVision,
    rejectedByKind,
    model: visionModel,
    durationMs: visionDurationMs,
    inputTokens: visionInputTokens,
    outputTokens: visionOutputTokens,
    commonsApiCalls: imageWork.commonsApiCalls ?? 0,
  }));
  return stored.length;
}

interface ImageRow {
  osm_ref: string;
  idx: number;
  mime: "image/webp";
  width: number;
  height: number;
  bytes: Buffer;
  source: string;
  source_url: string;
  page_url: string;
  license: string | null;
  credit: string | null;
  fetched_at: Date;
  expires_at: Date;
}

function storedImage(row: ImageRow): StoredPlaceImage {
  return {
    osmRef: row.osm_ref,
    idx: row.idx,
    mime: row.mime,
    width: row.width,
    height: row.height,
    bytes: row.bytes,
    source: row.source,
    sourceUrl: row.source_url,
    pageUrl: row.page_url,
    ...(row.license ? { license: truncateText(cleanInlineText(row.license), 80) } : {}),
    ...(row.credit ? { credit: truncateText(cleanInlineText(row.credit), 180) } : {}),
    fetchedAt: row.fetched_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
  };
}

export async function loadPlaceImages(
  q: Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query">,
  refs: string[],
): Promise<Map<string, StoredPlaceImage[]>> {
  if (refs.length === 0) return new Map();
  const rows = (
    await q.query(
      `SELECT * FROM place_images
        WHERE osm_ref = ANY($1) AND expires_at > now()
        ORDER BY osm_ref, idx`,
      [refs],
    )
  ).rows as ImageRow[];
  const out = new Map<string, StoredPlaceImage[]>();
  for (const row of rows) {
    const list = out.get(row.osm_ref) ?? [];
    list.push(storedImage(row));
    out.set(row.osm_ref, list);
  }
  return out;
}

export async function loadPlaceImage(
  q: Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query">,
  osmRef: string,
  idx: number,
): Promise<StoredPlaceImage | null> {
  const row = (
    await q.query(
      `SELECT * FROM place_images
        WHERE osm_ref = $1 AND idx = $2 AND expires_at > now()`,
      [osmRef, idx],
    )
  ).rows[0] as ImageRow | undefined;
  return row ? storedImage(row) : null;
}

export async function loadImageCounts(
  q: Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query">,
  refs: string[],
): Promise<Map<string, number>> {
  if (refs.length === 0) return new Map();
  const rows = (
    await q.query(
      `SELECT osm_ref, count(*)::int AS count FROM place_images
        WHERE osm_ref = ANY($1) AND expires_at > now()
        GROUP BY osm_ref`,
      [refs],
    )
  ).rows as Array<{ osm_ref: string; count: number }>;
  return new Map(rows.map((row) => [row.osm_ref, Number(row.count)]));
}

/** A lightweight change token for realtime refreshes. It contains no URL or
 * bytes and changes when a same-sized image set is refreshed in place. */
export async function loadImageVersions(
  q: Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query">,
  refs: string[],
): Promise<Map<string, string>> {
  if (refs.length === 0) return new Map();
  const rows = (
    await q.query(
      `SELECT osm_ref, count(*)::int AS count, max(fetched_at) AS fetched_at
         FROM place_images
        WHERE osm_ref = ANY($1) AND expires_at > now()
        GROUP BY osm_ref`,
      [refs],
    )
  ).rows as Array<{ osm_ref: string; count: number; fetched_at: Date }>;
  return new Map(rows.map((row) => [
    row.osm_ref,
    `${Number(row.count)}:${row.fetched_at.toISOString()}`,
  ]));
}
