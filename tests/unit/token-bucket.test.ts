import { describe, expect, it } from "vitest";
import { createTokenBucket } from "../../apps/server/src/token-bucket.ts";

describe("shared token bucket", () => {
  it("consumes atomically, refills continuously, and isolates keys", () => {
    const bucket = createTokenBucket({ capacity: 4, windowMs: 4_000 });
    expect(bucket.consume("room-a", 4, 1_000)).toBe(true);
    expect(bucket.consume("room-a", 1, 1_000)).toBe(false);
    expect(bucket.remaining("room-a", 1_999)).toBe(0);
    expect(bucket.retryAfterMs("room-a", 1, 1_000)).toBe(1_000);
    expect(bucket.consume("room-a", 1, 2_000)).toBe(true);
    expect(bucket.consume("room-b", 4, 2_000)).toBe(true);
  });

  it("does not partially spend a multi-token request", () => {
    const bucket = createTokenBucket({ capacity: 3, windowMs: 3_000 });
    expect(bucket.consume("r", 2, 0)).toBe(true);
    expect(bucket.consume("r", 2, 0)).toBe(false);
    expect(bucket.remaining("r", 0)).toBe(1);
    bucket.reset();
    expect(bucket.remaining("r", 0)).toBe(3);
  });
});
