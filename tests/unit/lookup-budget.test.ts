import { afterEach, describe, expect, it } from "vitest";
import {
  consumeLookupToken,
  LOOKUP_BUCKET_SIZE,
  LOOKUP_BUCKET_WINDOW_MS,
  resetLookupBudget,
} from "../../apps/server/src/lookup-budget.ts";

afterEach(() => resetLookupBudget());

describe("per-participant lookup budget", () => {
  it("allows a full bucket and then refuses", () => {
    const at = 1_000_000;
    for (let i = 0; i < LOOKUP_BUCKET_SIZE; i += 1) {
      expect(consumeLookupToken("p_alain", at)).toBe(true);
    }
    expect(consumeLookupToken("p_alain", at)).toBe(false);
  });

  it("refills continuously across the window", () => {
    const at = 1_000_000;
    for (let i = 0; i < LOOKUP_BUCKET_SIZE; i += 1) consumeLookupToken("p_alain", at);
    expect(consumeLookupToken("p_alain", at)).toBe(false);
    // One token is worth a sixth of the window.
    expect(consumeLookupToken("p_alain", at + LOOKUP_BUCKET_WINDOW_MS / 6)).toBe(true);
    expect(consumeLookupToken("p_alain", at + LOOKUP_BUCKET_WINDOW_MS / 6)).toBe(false);
    // A whole window restores the bucket, and no more than the bucket.
    for (let i = 0; i < LOOKUP_BUCKET_SIZE; i += 1) {
      expect(consumeLookupToken("p_alain", at + LOOKUP_BUCKET_WINDOW_MS * 2)).toBe(true);
    }
    expect(consumeLookupToken("p_alain", at + LOOKUP_BUCKET_WINDOW_MS * 2)).toBe(false);
  });

  it("keeps one participant's spending off another's budget", () => {
    const at = 1_000_000;
    for (let i = 0; i < LOOKUP_BUCKET_SIZE; i += 1) consumeLookupToken("p_alain", at);
    expect(consumeLookupToken("p_alain", at)).toBe(false);
    expect(consumeLookupToken("p_sarah", at)).toBe(true);
  });
});
