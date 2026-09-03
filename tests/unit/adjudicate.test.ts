import { describe, expect, it } from "vitest";
import {
  ADJUDICATION_CONFIDENCE,
  ADJUDICATION_PROMPT,
  ADJUDICATION_SCHEMA,
  THIRD_PARTY_ADJUDICATION_CONFIDENCE,
  adjudicationCached,
  adjudicationOutcomesFromAnswer,
  evidenceHash,
  publisherNameMatchesPlace,
  registrableDomainMatches,
  validatedPublisher,
  type AdjudicationCell,
} from "../../apps/server/src/enrich/adjudicate.ts";
import { resolveInference, type StoredCriterionInference } from "../../apps/server/src/enrich/index.ts";

const observedAt = "2026-09-03T10:00:00.000Z";
const context =
  "Willkommen bei HANS IM GLÜCK. Hunde sind in allen Restaurants von HANS IM GLÜCK herzlich willkommen. Mehr Informationen zu unseren Restaurants.";

function cell(overrides: Partial<AdjudicationCell> = {}): AdjudicationCell {
  const evidence = "Hunde sind in allen Restaurants von HANS IM GLÜCK herzlich willkommen";
  return {
    candidateId: "hans-berlin",
    osmRef: "node/1",
    criterionId: "dog-friendly",
    criterion: { kind: "key", label: "dogs welcome" },
    place: {
      name: "HANS IM GLÜCK Berlin",
      category: "restaurant",
      website: "https://different-osm-website.example/berlin",
    },
    evidence,
    context,
    pageTitle: "HANS IM GLÜCK | Burgergrill & Bar",
    url: "https://hansimglueck-burgergrill.de/hunde",
    publisherNames: ["HANS IM GLÜCK"],
    claim: {
      key: "dog-friendly",
      lean: "yes",
      confidence: 0.6,
      evidence,
      context,
      pageTitle: "HANS IM GLÜCK | Burgergrill & Bar",
      publisherNames: ["HANS IM GLÜCK"],
      source: "infer:test:venue_site",
      sourceUrl: "https://hansimglueck-burgergrill.de/hunde",
      observedAt,
      explicit: true,
    },
    evidenceHash: evidenceHash(evidence),
    ...overrides,
  };
}

function result(
  verdict: "yes" | "no" | "unclear",
  explicit: boolean,
  publisher: "venue" | "chain" | "third_party" | "unknown",
  quote = verdict === "unclear" ? "" : "Hunde sind in allen Restaurants von HANS IM GLÜCK herzlich willkommen",
) {
  return { results: [{ verdict, explicit, publisher, quote }] };
}

describe("focused evidence adjudication", () => {
  it("publishes the strict per-cell schema and bounded prompt", () => {
    expect(ADJUDICATION_SCHEMA.additionalProperties).toBe(false);
    expect(ADJUDICATION_SCHEMA.properties.results.items.additionalProperties).toBe(false);
    expect(ADJUDICATION_SCHEMA.properties.results.items.required).toEqual([
      "verdict", "explicit", "publisher", "quote",
    ]);
    expect(ADJUDICATION_PROMPT).toContain("single evidence span");
  });

  it.each([
    ["yes", true, "chain", "verified_true", ADJUDICATION_CONFIDENCE, "adjudicated:hansimglueck-burgergrill.de"],
    ["no", true, "chain", "verified_false", ADJUDICATION_CONFIDENCE, "adjudicated:hansimglueck-burgergrill.de"],
    ["yes", true, "third_party", "likely_true", THIRD_PARTY_ADJUDICATION_CONFIDENCE, "infer:test:venue_site"],
    ["no", true, "third_party", "likely_false", THIRD_PARTY_ADJUDICATION_CONFIDENCE, "infer:test:venue_site"],
  ] as const)(
    "implements %s / explicit=%s / %s",
    (verdict, explicit, publisher, status, confidence, source) => {
      const output = adjudicationOutcomesFromAnswer(
        result(verdict, explicit, publisher),
        [cell()],
        "2026-09-03T11:00:00.000Z",
      )[0];
      expect(output).toMatchObject({ verdict, explicit, publisher });
      expect(output.inference).toMatchObject({ status, confidence, source, lean: verdict });
      expect(output.inference.evidence).toBe(
        "Hunde sind in allen Restaurants von HANS IM GLÜCK herzlich willkommen",
      );
    },
  );

  it("leaves unclear and non-explicit own-publisher claims unchanged while caching the read", () => {
    for (const answer of [result("unclear", false, "unknown"), result("yes", false, "chain")]) {
      const output = adjudicationOutcomesFromAnswer(answer, [cell()])[0].inference;
      expect(output).toMatchObject({ lean: "yes", confidence: 0.6, source: "infer:test:venue_site" });
      expect(output.adjudication?.evidenceHash).toBe(cell().evidenceHash);
    }
  });

  it("validates registrable domains and place/brand identity, including Hans im Glück", () => {
    expect(registrableDomainMatches(
      "https://berlin.example.co.uk/dogs",
      "https://www.example.co.uk/locations/berlin",
    )).toBe(true);
    expect(registrableDomainMatches("https://example.co.uk", "https://example.com")).toBe(false);
    expect(publisherNameMatchesPlace("HANS IM GLÜCK", "HANS IM GLÜCK Berlin")).toBe(true);
    // The source host differs from the OSM website, but og:site_name/schema
    // identity establishes the chain as its own publisher.
    expect(validatedPublisher("chain", cell())).toBe("chain");
    expect(validatedPublisher("venue", cell({ publisherNames: [] }))).toBe("unknown");
  });

  it("never downgrades or flips an existing verified fact", () => {
    const previous: Exclude<StoredCriterionInference, { omitted: true }> = {
      ...cell().claim,
      confidence: 0.75,
      source: "adjudicated:hansimglueck-burgergrill.de",
    };
    const opposite = adjudicationOutcomesFromAnswer(
      result("no", true, "chain"),
      [cell({ claim: previous })],
      "2026-09-03T12:00:00.000Z",
    )[0].inference;
    expect(resolveInference(previous, opposite)).toMatchObject({
      lean: "yes",
      confidence: 0.75,
      source: "adjudicated:hansimglueck-burgergrill.de",
    });
  });

  it("keys a 30-day reread cache on the evidence hash", () => {
    const hash = cell().evidenceHash;
    const stored = adjudicationOutcomesFromAnswer(
      result("unclear", false, "unknown"),
      [cell()],
      observedAt,
    )[0].inference as Exclude<StoredCriterionInference, { omitted: true }>;
    expect(adjudicationCached(stored, hash, new Date("2026-10-02T10:00:00.000Z").getTime())).toBe(true);
    expect(adjudicationCached(stored, evidenceHash("different evidence"))).toBe(false);
    expect(adjudicationCached(stored, hash, new Date("2026-10-04T10:00:00.000Z").getTime())).toBe(false);
  });

  it("rejects a yes/no quote that is not a verbatim span", () => {
    expect(adjudicationOutcomesFromAnswer(
      result("yes", true, "chain", "Dogs are welcome at every location"),
      [cell()],
    )).toEqual([]);
  });

  it("scriptedly adjudicates five representative cells", () => {
    const fixtures = [
      { criterionId: "dog-friendly", label: "dogs welcome", evidence: "Dogs are welcome at all HANS IM GLÜCK restaurants", verdict: "yes" as const, publisher: "chain" as const, expected: "verified_true", own: true },
      { criterionId: "smoking", label: "smoking allowed", evidence: "This is a completely smoke-free restaurant", verdict: "no" as const, publisher: "venue" as const, expected: "verified_false", own: true },
      { criterionId: "outdoor-seating", label: "outdoor seating", evidence: "Reviewers praise the sheltered outdoor terrace", verdict: "yes" as const, publisher: "third_party" as const, expected: "likely_true", own: false },
      { criterionId: "delivery", label: "delivery", evidence: "This restaurant does not offer delivery", verdict: "no" as const, publisher: "third_party" as const, expected: "likely_false", own: false },
      { criterionId: "wifi", label: "free wifi", evidence: "Ask our team about connectivity options", verdict: "unclear" as const, publisher: "unknown" as const, expected: "likely_true", own: false },
    ];
    const cells = fixtures.map((fixture, index) => {
      const url = fixture.own
        ? `https://venue${index}.com/info`
        : `https://guide${index}.com/review`;
      const website = fixture.own ? `https://www.venue${index}.com` : "https://venue.example";
      const base = cell();
      return cell({
        candidateId: `sample-${index}`,
        criterionId: fixture.criterionId,
        criterion: { kind: "key", label: fixture.label },
        evidence: fixture.evidence,
        context: `Context before. ${fixture.evidence}. Context after.`,
        url,
        evidenceHash: evidenceHash(fixture.evidence),
        publisherNames: fixture.publisher === "chain" ? ["HANS IM GLÜCK"] : [],
        place: { ...base.place, website },
        claim: {
          ...base.claim,
          evidence: fixture.evidence,
          context: `Context before. ${fixture.evidence}. Context after.`,
          sourceUrl: url,
        },
      });
    });
    const outcomes = adjudicationOutcomesFromAnswer({
      results: fixtures.map((fixture) => ({
        verdict: fixture.verdict,
        explicit: fixture.verdict !== "unclear",
        publisher: fixture.publisher,
        quote: fixture.verdict === "unclear" ? "" : fixture.evidence,
      })),
    }, cells);
    expect(outcomes.map((outcome) => outcome.inference.status)).toEqual(
      fixtures.map((fixture) => fixture.expected),
    );
  });
});
