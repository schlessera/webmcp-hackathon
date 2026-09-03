/**
 * A continuously refilling token bucket keyed by the caller's chosen scope.
 * State is process-local and deliberately contains no participant or room
 * content beyond the opaque key supplied by its owner.
 */

export interface TokenBucketOptions {
  capacity: number;
  windowMs: number;
  idleEvictMs?: number;
  maxEntries?: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export interface TokenBucket {
  consume(key: string, amount?: number, now?: number): boolean;
  remaining(key: string, now?: number): number;
  retryAfterMs(key: string, amount?: number, now?: number): number;
  reset(): void;
}

export function createTokenBucket(options: TokenBucketOptions): TokenBucket {
  const capacity = Math.max(0, options.capacity);
  const windowMs = Math.max(1, options.windowMs);
  const idleEvictMs = options.idleEvictMs ?? 10 * windowMs;
  const maxEntries = Math.max(1, options.maxEntries ?? 1_000);
  const buckets = new Map<string, Bucket>();

  const refill = (key: string, now: number, create: boolean): Bucket | undefined => {
    let bucket = buckets.get(key);
    if (!bucket && create && buckets.size >= maxEntries) {
      let removed = false;
      for (const [candidate, bucket] of buckets) {
        if (now - bucket.updatedAt > idleEvictMs) {
          buckets.delete(candidate);
          removed = true;
        }
      }
      // Active callers can otherwise grow the map forever. When the idle
      // sweep finds nothing, make room by dropping the least recently used
      // key before inserting the new one.
      if (!removed && buckets.size >= maxEntries) {
        let oldest: { key: string; updatedAt: number } | undefined;
        for (const [candidate, candidateBucket] of buckets) {
          if (!oldest || candidateBucket.updatedAt < oldest.updatedAt) {
            oldest = { key: candidate, updatedAt: candidateBucket.updatedAt };
          }
        }
        if (oldest) buckets.delete(oldest.key);
      }
    }
    bucket = buckets.get(key);
    if (!bucket) {
      if (!create) return undefined;
      bucket = { tokens: capacity, updatedAt: now };
      buckets.set(key, bucket);
      return bucket;
    }
    bucket.tokens = Math.min(
      capacity,
      bucket.tokens + ((now - bucket.updatedAt) * capacity) / windowMs,
    );
    bucket.updatedAt = now;
    return bucket;
  };

  return {
    consume(key, amount = 1, now = Date.now()) {
      const wanted = Math.max(0, amount);
      const bucket = refill(key, now, true)!;
      if (bucket.tokens + Number.EPSILON < wanted) return false;
      bucket.tokens -= wanted;
      return true;
    },
    remaining(key, now = Date.now()) {
      return Math.floor(refill(key, now, false)?.tokens ?? capacity);
    },
    retryAfterMs(key, amount = 1, now = Date.now()) {
      const wanted = Math.max(0, amount);
      const tokens = refill(key, now, false)?.tokens ?? capacity;
      if (tokens >= wanted || capacity <= 0) return capacity <= 0 ? windowMs : 0;
      return Math.ceil(((wanted - tokens) * windowMs) / capacity);
    },
    reset() {
      buckets.clear();
    },
  };
}
