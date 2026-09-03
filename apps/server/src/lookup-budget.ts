/**
 * Per-participant budget for on-demand place lookups (review finding L2).
 *
 * A lookup is not a read: it starts outbound venue fetches and up to one
 * fast-tier model call per candidate. Every entry point that can start one —
 * the HTTP route and the smart agent's `look_up_places` — must spend a token,
 * so a client or an agent in a loop cannot turn a read into unbounded spend.
 */

interface LookupBucket {
  tokens: number;
  updatedAt: number;
}

export const LOOKUP_BUCKET_SIZE = 6;
export const LOOKUP_BUCKET_WINDOW_MS = 60_000;
/** A full bucket is indistinguishable from no bucket, so idle ones are dropped. */
const IDLE_EVICT_MS = 10 * LOOKUP_BUCKET_WINDOW_MS;

const buckets = new Map<string, LookupBucket>();

export function consumeLookupToken(participantId: string, now = Date.now()): boolean {
  if (buckets.size > 1000) {
    for (const [id, bucket] of buckets) {
      if (now - bucket.updatedAt > IDLE_EVICT_MS) buckets.delete(id);
    }
  }
  const bucket = buckets.get(participantId) ?? { tokens: LOOKUP_BUCKET_SIZE, updatedAt: now };
  bucket.tokens = Math.min(
    LOOKUP_BUCKET_SIZE,
    bucket.tokens + ((now - bucket.updatedAt) * LOOKUP_BUCKET_SIZE) / LOOKUP_BUCKET_WINDOW_MS,
  );
  bucket.updatedAt = now;
  buckets.set(participantId, bucket);
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

export const LOOKUP_RATE_LIMIT_ERROR = {
  code: "invalid_input" as const,
  message: `Place lookup rate limit exceeded (${LOOKUP_BUCKET_SIZE} per minute).`,
  recovery: "Wait before asking to look up more places, then retry.",
};

/** Test-only: forget every bucket. */
export function resetLookupBudget(): void {
  buckets.clear();
}
