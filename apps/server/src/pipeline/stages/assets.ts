import { createHash } from "node:crypto";
import type { FetchLike } from "../../enrich/website.ts";
import {
  fetchPlaceImageBytes,
  refreshPlaceImages,
  resizePlaceImage,
  type ImageCandidate,
  type ProcessedImage,
} from "../../enrich/images.ts";
import {
  classifyPlaceImages,
  type ClassifiedImageBatch,
  type PlaceImageVerdict,
} from "../../enrich/image-classifier.ts";
import { pipelineDedupeKey } from "../queue.ts";
import { pipelineScheduler, type PipelineScheduler } from "../scheduler.ts";
import type { OutboundPurpose, OutboundRoute } from "../../net/outbound.ts";
import type pg from "pg";

export {
  fetchPlaceImageBytes as fetchAsset,
  resizePlaceImage as decodeAsset,
  refreshPlaceImages as refreshAssets,
  classifyPlaceImages as classifyAssets,
  type ClassifiedImageBatch,
  type ImageCandidate,
  type PlaceImageVerdict,
  type ProcessedImage,
};

export interface PipelineAssetContext {
  db: pg.Pool;
  roomId: string;
  candidateId: string;
  osmRef: string;
  placeName: string;
  candidates: ImageCandidate[];
  intent: "interactive" | "background";
  needsEpoch?: number;
  imageWork?: { commonsApiCalls?: number };
  /** Called only when decoded images are ready for the single vision batch. */
  consumeVision?: () => boolean;
  fetchForRoute: (route: OutboundRoute, purpose: OutboundPurpose) => FetchLike;
  scheduler?: PipelineScheduler;
}

function assetPurpose(url: string): OutboundPurpose {
  const host = new URL(url).hostname.toLowerCase();
  return host === "upload.wikimedia.org" || host.endsWith(".wikimedia.org")
    ? "commons"
    : "image-cdn";
}

function assetHash(candidate: ImageCandidate): string {
  return createHash("sha1").update(candidate.url).digest("hex");
}

/** On-demand asset materialisation with one scheduler item per real stage. */
export function refreshAssetsThroughPipeline(context: PipelineAssetContext): Promise<number> {
  if (context.intent !== "interactive") return Promise.resolve(0);
  const scheduler = context.scheduler ?? pipelineScheduler;
  const needsEpoch = context.needsEpoch ?? 0;
  const prepare = async (candidate: ImageCandidate): Promise<ProcessedImage> => {
    const purpose = assetPurpose(candidate.url);
    const host = new URL(candidate.url).hostname.toLowerCase();
    const evidenceHash = assetHash(candidate);
    const fetchBase = {
      roomId: context.roomId,
      candidateId: context.candidateId,
      osmRef: context.osmRef,
      kind: "fetch.asset" as const,
      criteria: [],
      priority: 0 as const,
      intent: "interactive" as const,
      host,
      purpose,
      evidenceHash,
      needsEpoch,
      enqueuedAt: Date.now(),
    };
    const downloaded = await scheduler.enqueue(
      { ...fetchBase, dedupeKey: pipelineDedupeKey(fetchBase) },
      async (route) => ({
        value: await fetchPlaceImageBytes(
          candidate,
          context.fetchForRoute(route ?? "direct", purpose),
        ),
        actualRoute: route ?? "direct",
      }),
      { reason: { kind: "place" }, present: true },
    );
    const decodeBase = {
      ...fetchBase,
      kind: "process.decode" as const,
      host: undefined,
      purpose: undefined,
    };
    const decoded = await scheduler.enqueue(
      { ...decodeBase, dedupeKey: pipelineDedupeKey(decodeBase) },
      async () => ({
        value: await resizePlaceImage(
          downloaded.bytes,
          candidate.imagePolicy
            ? {
                width: candidate.imagePolicy.minimumWidth,
                height: candidate.imagePolicy.minimumHeight,
              }
            : undefined,
        ),
        actualRoute: "direct",
      }),
      { reason: { kind: "place" }, present: true },
    );
    return { ...decoded, ttlMs: downloaded.ttlMs };
  };
  const classify = async (
    placeName: string,
    images: Array<{ bytes: Uint8Array }>,
  ): Promise<ClassifiedImageBatch> => {
    if (context.consumeVision && !context.consumeVision()) {
      return classifyPlaceImages(placeName, [], context.intent);
    }
    const evidenceHash = createHash("sha1")
      .update(context.candidates.map((candidate) => candidate.url).join("\0"))
      .digest("hex");
    const base = {
      roomId: context.roomId,
      candidateId: context.candidateId,
      osmRef: context.osmRef,
      kind: "process.vision" as const,
      criteria: [],
      priority: 0 as const,
      intent: "interactive" as const,
      evidenceHash,
      needsEpoch,
      enqueuedAt: Date.now(),
    };
    return scheduler.enqueue(
      { ...base, dedupeKey: pipelineDedupeKey(base) },
      async () => ({
        value: await classifyPlaceImages(placeName, images, context.intent),
        actualRoute: "direct",
      }),
      { reason: { kind: "place" }, present: true },
    );
  };
  return refreshPlaceImages(
    context.db,
    context.osmRef,
    context.placeName,
    context.candidates,
    undefined,
    context.imageWork,
    { prepare, classify },
  );
}
