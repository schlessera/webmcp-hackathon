import { describe, expect, it, vi } from "vitest";
import {
  LISTING_CONFIDENCE,
  LISTING_NOTE,
  LISTING_SOURCE,
  mapListing,
  matchListing,
  matchListings,
  type DataForSeoListing,
} from "../../apps/server/src/enrich/listings.ts";
import {
  cacheQueryHash,
  loadSearchCache,
  storeSearchCache,
} from "../../apps/server/src/enrich/cache.ts";

const AT = "2026-09-03T12:00:00.000Z";
const GOOGLE = "https://www.google.com/maps?cid=123";

function listing(overrides: Partial<DataForSeoListing> = {}): DataForSeoListing {
  return {
    type: "business_listing",
    title: "Café Alpha",
    latitude: 52.5,
    longitude: 13.4,
    url: "https://alpha.example/",
    domain: "alpha.example",
    check_url: GOOGLE,
    ...overrides,
  };
}

describe("DataForSEO listing evidence", () => {
  it("maps both available and unavailable attributes without ever verifying", () => {
    const facts = mapListing(listing({
      attributes: {
        available_attributes: {
          crowd: ["welcomes_dogs"],
          accessibility: ["has_wheelchair_accessible_entrance"],
          service_options: ["has_seating_outdoors", "has_takeout"],
        },
        unavailable_attributes: {
          offerings: ["serves_vegetarian"],
          amenities: ["has_wi_fi"],
          service_options: ["has_delivery"],
        },
      },
    }), AT)!;
    expect(Object.fromEntries(facts.claims.map((claim) => [claim.key, claim.lean]))).toEqual({
      "dog-friendly": "yes",
      "wheelchair-accessible": "yes",
      "outdoor-seating": "yes",
      "vegetarian-options": "no",
      wifi: "no",
      takeaway: "yes",
      delivery: "no",
    });
    for (const claim of facts.claims) {
      expect(claim).toMatchObject({
        confidence: LISTING_CONFIDENCE,
        evidence: LISTING_NOTE,
        source: LISTING_SOURCE,
        sourceUrl: GOOGLE,
        explicit: false,
      });
      expect(claim.confidence).toBeLessThan(0.7);
    }
  });

  it("maps hours, PRICE_LEVEL_EUR bands, rating, and website", () => {
    const facts = mapListing(listing({
      price_level: "expensive",
      rating: { value: 4.6, votes_count: 81, rating_max: 5 },
      work_time: {
        work_hours: {
          timetable: {
            monday: [{ open: { hour: 9, minute: 0 }, close: { hour: 18, minute: 30 } }],
          },
        },
      },
    }), AT)!;
    expect(facts).toMatchObject({
      website: "https://alpha.example/",
      domain: "alpha.example",
      hours: ["Mo 09:00-18:30"],
      priceLevel: 3,
      rating: { value: 4.6, best: 5, count: 81 },
    });
    expect(facts.claims.find((claim) => claim.key === "price-level"))
      .toMatchObject({ lean: "yes", value: 3, confidence: 0.65 });
  });

  it("requires similar names, no more than 60 m, and agreeing domains when both exist", () => {
    const candidate = {
      candidateId: "place-alpha",
      osmRef: "node/1",
      name: "Cafe Alpha",
      location: { lat: 52.5, lng: 13.4 },
      website: "https://alpha.example/menu",
    };
    expect(matchListing(candidate, listing({ latitude: 52.5002 }))).not.toBeNull();
    expect(matchListing(candidate, listing({ title: "Beta Bakery", latitude: 52.50005 }))).toBeNull();
    expect(matchListing(candidate, listing({ latitude: 52.5027 }))).toBeNull();
    expect(matchListing(candidate, listing({ domain: "impostor.example", url: "https://impostor.example" }))).toBeNull();

    const matches = matchListings([candidate], [
      listing({ title: "Beta Bakery", latitude: 52.50005 }),
      listing({ latitude: 52.5027 }),
      listing({ domain: "impostor.example", url: "https://impostor.example" }),
      listing({ latitude: 52.5002 }),
    ], AT);
    expect(matches).toHaveLength(1);
    expect(matches[0].listing.latitude).toBe(52.5002);
  });
});

describe("search cache room policy", () => {
  it("makes Parallel hashes room-specific while Tavily-style hashes remain shared", async () => {
    expect(cacheQueryHash("query", ["a.example"], "room-a"))
      .not.toBe(cacheQueryHash("query", ["a.example"], "room-b"));
    expect(cacheQueryHash("query", ["a.example"]))
      .toBe(cacheQueryHash("query", ["a.example"]));

    const query = vi.fn(async () => ({ rows: [], rowCount: 1 }));
    await storeSearchCache({ query } as never, {
      osmRef: "node/1",
      query: "query",
      provider: "parallel",
      roomId: "room-a",
      snippets: [{ url: "https://a.example", title: "A", snippet: "literal page words" }],
    });
    expect(query.mock.calls[0][1]).toContain(cacheQueryHash("query", [], "room-a"));

    query.mockClear();
    expect(await loadSearchCache({ query } as never, "node/1", "query", "parallel"))
      .toBeNull();
    expect(query).not.toHaveBeenCalled();
  });
});
