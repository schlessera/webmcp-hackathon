import { describe, expect, it, vi } from "vitest";
import {
  LISTING_CONFIDENCE,
  LISTING_NOTE,
  LISTING_SOURCE,
  DATAFORSEO_CATEGORIES_PER_REQUEST,
  LISTING_CATEGORIES,
  listingCategoryBatches,
  listingNameContains,
  listingNameCore,
  listingNameSimilarity,
  matchListingsWithDiagnostics,
  mapListing,
  matchListing,
  matchListings,
  type DataForSeoListing,
} from "../../apps/server/src/enrich/listings.ts";
import { PLACE_CLASSES } from "@webmcp-hackathon/contracts";
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
    // A different name next door, with no domain to vouch for it.
    const stranger = { title: "Beta Bakery", latitude: 52.50005, domain: undefined, url: undefined };
    expect(matchListing(candidate, listing({ latitude: 52.5002 }))).not.toBeNull();
    expect(matchListing(candidate, listing(stranger))).toBeNull();
    expect(matchListing(candidate, listing({ latitude: 52.5027 }))).toBeNull();
    expect(matchListing(candidate, listing({ domain: "impostor.example", url: "https://impostor.example" }))).toBeNull();

    const matches = matchListings([candidate], [
      listing(stranger),
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

describe("provider category filter", () => {
  it("covers every place class and names only verified provider categories", () => {
    for (const placeClass of PLACE_CLASSES) {
      const names = LISTING_CATEGORIES[placeClass];
      expect(names, `no provider category for ${placeClass}`).toBeTruthy();
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it("asks for the pool's own classes, in class order, chunked to the request cap", () => {
    const batches = listingCategoryBatches(["restaurant", "park", "restaurant"]);
    const flat = batches.flat();
    // Class order, not the order the pool happened to list them in.
    expect(flat[0]).toBe("restaurant");
    expect(flat).toContain("park");
    expect(flat).toContain("bar_and_grill");
    // A class the pool does not hold is never requested.
    expect(flat).not.toContain("museum");
    expect(new Set(flat).size).toBe(flat.length);
    for (const batch of batches) {
      expect(batch.length).toBeLessThanOrEqual(DATAFORSEO_CATEGORIES_PER_REQUEST);
    }
  });

  it("returns no batch for an unrecognized pool, so the caller sends no filter", () => {
    expect(listingCategoryBatches(["", "not_a_class"])).toEqual([]);
  });
});

describe("branch-suffix name matching", () => {
  const near = { lat: 52.5, lng: 13.4 };

  it("accepts a listing name that is the place plus whole extra words, when close", () => {
    expect(listingNameContains("Hackescher Hof", "Restaurant Hackescher Hof")).toBe(true);
    expect(listingNameContains("Haferkater", "Haferkater, Friedrichstrasse")).toBe(true);
    const match = matchListing(
      { candidateId: "c1", osmRef: "node/1", name: "Hackescher Hof", location: near },
      listing({ title: "Restaurant Hackescher Hof", latitude: 52.5, longitude: 13.4, domain: undefined, url: undefined }),
    );
    expect(match).not.toBeNull();
  });

  it("refuses a short or thinly covering containment, and refuses it at distance", () => {
    // "sushi" is a dish, not an identity, and is too short to carry one.
    expect(listingNameContains("sushi", "Sushi Miyabi")).toBe(false);
    // One word of four is not enough of the longer name.
    expect(listingNameContains("Alphabet", "Alphabet Beta Gamma Delta")).toBe(false);
    // Containment only counts within 25 m. "Friedrichstrasse" is a street, not
    // a class word, so the core names differ (0.51) and only containment could
    // have carried this pair.
    expect(matchListing(
      { candidateId: "c1", osmRef: "node/1", name: "Haferkater", location: near },
      listing({ title: "Haferkater Friedrichstrasse", latitude: 52.5004, longitude: 13.4, domain: undefined, url: undefined }),
    )).toBeNull();
    expect(matchListing(
      { candidateId: "c1", osmRef: "node/1", name: "Haferkater", location: near },
      listing({ title: "Haferkater Friedrichstrasse", latitude: 52.50005, longitude: 13.4, domain: undefined, url: undefined }),
    )).not.toBeNull();
  });
});

describe("name normalization and the domain path", () => {
  const near = { lat: 52.5, lng: 13.4 };
  let seq = 0;
  const at = (name: string, website?: string) => ({
    candidateId: `c${(seq += 1)}`, osmRef: `node/${seq}`, name, location: near,
    ...(website ? { website } : {}),
  });

  it("ignores diacritics, sharp s, city and legal words, and class words", () => {
    expect(listingNameCore("Café Nénom")).toBe("nenom");
    expect(listingNameCore("Weinstube Süd GmbH")).toBe("weinstube sud");
    expect(listingNameCore("Gentle Restaurant")).toBe("gentle");
    expect(listingNameCore("Schnitzelei Mitte")).toBe("schnitzelei");
    // A name made only of class words keeps them rather than vanishing.
    expect(listingNameCore("The Coffee House")).toBe("the coffee house");
  });

  it("lets a shared domain identify a place whose name would never match", () => {
    const listed = listing({
      title: "RYCE - Kitchen & Sushi Bar", latitude: 52.5, longitude: 13.4,
      domain: "ryce.example", url: "https://ryce.example/",
    });
    expect(listingNameSimilarity("Ryce", "RYCE - Kitchen & Sushi Bar"))
      .toBeLessThan(0.72);
    expect(matchListing(at("Ryce"), listed)).toBeNull();
    expect(matchListing(at("Ryce", "https://ryce.example/menu"), listed)).not.toBeNull();
  });

  it("counts each unmatched place once, under the reason nearest to a match", () => {
    const { matches, diagnostics } = matchListingsWithDiagnostics(
      [at("Café Nénom"), { ...at("Faraway"), location: { lat: 52.51, lng: 13.4 } },
       at("Kopenhagen", "https://mine.example/")],
      [
        listing({ title: "Cafe Nenom", latitude: 52.5, longitude: 13.4, domain: undefined, url: undefined }),
        listing({ title: "Kopenhagen", latitude: 52.5, longitude: 13.4, domain: "other.example", url: "https://other.example/" }),
      ],
      AT,
    );
    expect(matches).toHaveLength(1);
    expect(diagnostics).toEqual({
      matched: 1,
      // Faraway had no listing inside 60 m; Kopenhagen was refused by the veto.
      unmatchedByReason: { distance: 1, name: 0, domain: 1 },
    });
  });
});
