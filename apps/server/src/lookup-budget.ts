/**
 * Per-participant budget for on-demand place lookups (review finding L2).
 *
 * A lookup is not a read: it starts outbound venue fetches and up to one
 * fast-tier model call per candidate. Every entry point that can start one —
 * the HTTP route and the smart agent's `look_up_places` — must spend a token,
 * so a client or an agent in a loop cannot turn a read into unbounded spend.
 */

import { createTokenBucket } from "./token-bucket.ts";

export const LOOKUP_BUCKET_SIZE = 6;
export const LOOKUP_BUCKET_WINDOW_MS = 60_000;
/** A full bucket is indistinguishable from no bucket, so idle ones are dropped. */
const IDLE_EVICT_MS = 10 * LOOKUP_BUCKET_WINDOW_MS;

const bucket = createTokenBucket({
  capacity: LOOKUP_BUCKET_SIZE,
  windowMs: LOOKUP_BUCKET_WINDOW_MS,
  idleEvictMs: IDLE_EVICT_MS,
});

export function consumeLookupToken(participantId: string, now = Date.now()): boolean {
  return bucket.consume(participantId, 1, now);
}

export const LOOKUP_RATE_LIMIT_ERROR = {
  code: "invalid_input" as const,
  message: `Place lookup rate limit exceeded (${LOOKUP_BUCKET_SIZE} per minute).`,
  recovery: "Wait before asking to look up more places, then retry.",
};

/** Test-only: forget every bucket. */
export function resetLookupBudget(): void {
  bucket.reset();
}
