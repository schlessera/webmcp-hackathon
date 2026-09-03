import { describe, expect, it } from "vitest";
import { applyAttestations } from "../../apps/server/src/attestations.ts";
import {
  applyInferredAttributes,
} from "../../apps/server/src/enrich/infer.ts";
import {
  INFERENCE_DISAGREEMENT_NOTE,
  INFERENCE_SOURCE_BUCKET_RANK,
  resolveInference,
  type StoredCriterionInference,
} from "../../apps/server/src/enrich/index.ts";

type Claim = Exclude<StoredCriterionInference, { omitted: true }>;

const OLD_AT = "2026-09-01T10:00:00.000Z";
const FRESH_AT = "2026-09-03T10:00:00.000Z";

function claim(overrides: Partial<Claim> = {}): Claim {
  return {
    key: "dog-friendly",
    lean: "yes",
    confidence: 0.55,
    evidence: "Pooches are welcome here",
    source: "infer:test:venue_site",
    observedAt: OLD_AT,
    explicit: false,
    ...overrides,
  };
}

describe("monotonic inference resolution", () => {
  it("does not let an abstain overwrite an existing claim", () => {
    const previous = claim();
    expect(resolveInference(previous, { omitted: true, observedAt: FRESH_AT })).toBe(previous);
  });

  it("does not let a searched omission overwrite an existing claim", () => {
    const previous = claim();
    expect(resolveInference(previous, {
      omitted: true,
      observedAt: FRESH_AT,
      searchDay: "2026-09-03",
      searchAttempts: 1,
    })).toBe(previous);
  });

  it("creates an abstention entry when no evidence was stored", () => {
    const fresh = { omitted: true as const, observedAt: FRESH_AT };
    expect(resolveInference(undefined, fresh)).toBe(fresh);
  });

  it("retains capped same-day search-attempt accounting between omissions", () => {
    expect(resolveInference(
      {
        omitted: true,
        observedAt: OLD_AT,
        searchDay: "2026-09-03",
        searchAttempts: 2,
      },
      {
        omitted: true,
        observedAt: FRESH_AT,
        searchDay: "2026-09-03",
        searchAttempts: 2,
      },
    )).toEqual({
      omitted: true,
      observedAt: FRESH_AT,
      searchDay: "2026-09-03",
      searchAttempts: 3,
    });
  });

  it("keeps the old same-lean claim at lower confidence in the same bucket", () => {
    const previous = claim();
    const fresh = claim({ confidence: 0.5, observedAt: FRESH_AT });
    expect(resolveInference(previous, fresh)).toBe(previous);
  });

  it("replaces a same-lean claim at higher confidence in the same bucket", () => {
    const previous = claim();
    const fresh = claim({ confidence: 0.6, observedAt: FRESH_AT });
    expect(resolveInference(previous, fresh)).toBe(fresh);
  });

  it("replaces an equal-confidence same-lean claim from a higher bucket", () => {
    const previous = claim({ source: "infer:test:domain_search" });
    const fresh = claim({ source: "infer:test:venue_site", observedAt: FRESH_AT });
    expect(resolveInference(previous, fresh)).toBe(fresh);
  });

  it("keeps an equal-confidence same-lean claim against a lower bucket", () => {
    const previous = claim({ source: "infer:test:venue_site" });
    const fresh = claim({ source: "infer:test:domain_search", observedAt: FRESH_AT });
    expect(resolveInference(previous, fresh)).toBe(previous);
  });

  it("replaces an opposite explicit claim from an equal-or-higher bucket", () => {
    const previous = claim({ explicit: true });
    const fresh = claim({ lean: "no", explicit: true, observedAt: FRESH_AT });
    expect(resolveInference(previous, fresh)).toBe(fresh);
  });

  it("keeps status and records disagreement for an opposite explicit lower bucket", () => {
    const previous = claim({ source: "web:venue.example", explicit: true, confidence: 0.72 });
    const fresh = claim({
      lean: "no",
      source: "infer:test:venue_site",
      explicit: true,
      confidence: 0.6,
      observedAt: FRESH_AT,
    });
    expect(resolveInference(previous, fresh)).toEqual({
      ...previous,
      note: INFERENCE_DISAGREEMENT_NOTE,
    });
  });

  it("keeps status and surfaces disagreement for an opposite non-explicit claim", () => {
    const previous = claim();
    const fresh = claim({ lean: "no", confidence: 0.6, observedAt: FRESH_AT });
    const resolved = resolveInference(previous, fresh) as Claim;
    expect(resolved).toMatchObject({
      lean: "yes",
      confidence: previous.confidence,
      observedAt: OLD_AT,
      note: INFERENCE_DISAGREEMENT_NOTE,
    });
    // The ledger keeps the span the claim rests on AND says a later read
    // disagreed. Replacing the evidence with the disagreement would hide what
    // the retained fact is actually based on.
    expect(applyInferredAttributes([], { "dog-friendly": resolved })).toEqual([
      expect.objectContaining({
        status: "likely_true",
        note: `${previous.evidence} · ${INFERENCE_DISAGREEMENT_NOTE}`,
      }),
    ]);
  });

  it("still lets an attestation win over an inference", () => {
    const inferred = applyInferredAttributes([], { "dog-friendly": claim() });
    const merged = applyAttestations("place-1", inferred, [{
      candidate_id: "place-1",
      key: "dog-friendly",
      participant_id: "person-1",
      status: "verified_false",
      confidence: 0.9,
      note: "I called the venue",
      source_url: null,
      at_revision: 1,
    }]);
    expect(merged).toEqual([
      expect.objectContaining({
        status: "verified_false",
        source: "agent:person-1",
        attestedBy: "person-1",
      }),
    ]);
  });

  it("orders every source bucket, with name/category below quoted open web", () => {
    expect(INFERENCE_SOURCE_BUCKET_RANK).toEqual({
      name_category: 0,
      open_web: 1,
      domain_search: 2,
      own_site_inferred: 3,
      listing: 4,
      own_site_explicit: 5,
      record: 6,
    });
  });
});
