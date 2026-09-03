import { describe, expect, it } from "vitest";
import { POOL_CAP } from "@webmcp-hackathon/contracts";
import { poolFillRetryDelay, poolTarget } from "../../apps/server/src/pool-fill.ts";

describe("pool fill scheduling", () => {
  it("never reports a target below the current pool size", () => {
    expect(poolTarget(703, 300)).toBe(703);
    expect(poolTarget(60, 343)).toBe(343);
    expect(poolTarget(POOL_CAP, POOL_CAP + 100)).toBe(POOL_CAP);
  });

  it("backs consecutive failures off exponentially", () => {
    expect(poolFillRetryDelay(2)).toBe(poolFillRetryDelay(1) * 2);
    expect(poolFillRetryDelay(3)).toBe(poolFillRetryDelay(1) * 4);
    expect(poolFillRetryDelay(20)).toBeLessThanOrEqual(30_000);
  });
});
