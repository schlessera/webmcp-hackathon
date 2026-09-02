import { describe, expect, it } from "vitest";
import {
  clip,
  parseWebsite,
  priceRangeToLevel,
  robotsAllows,
} from "../../apps/server/src/enrich/website.ts";
import { parseEntity } from "../../apps/server/src/enrich/wikidata.ts";
import {
  applyEnrichmentAttributes,
  enrichmentView,
  type Enrichment,
} from "../../apps/server/src/enrich/index.ts";
import { dossierFromTags, linksFromTags } from "../../packages/contracts/src/dossier.ts";

/**
 * The enrichment layer (docs/ENRICHMENT-SOURCES.md): parsing what a place
 * publishes about itself, what Wikidata says, and the one merge rule — a
 * looked-up fact fills an open slot and never overwrites a verified record.
 */

const AT = "2026-09-02T18:00:00Z";

describe("robots.txt", () => {
  it("honours the * group and ignores other agents", () => {
    expect(robotsAllows("User-agent: *\nDisallow: /", "/")).toBe(false);
    expect(robotsAllows("User-agent: *\nDisallow: /private/", "/")).toBe(true);
    expect(robotsAllows("User-agent: Googlebot\nDisallow: /", "/")).toBe(true);
    expect(robotsAllows("", "/")).toBe(true);
  });
});

describe("parseWebsite", () => {
  const page = (ld: unknown, extra = "") =>
    `<html><head><script type="application/ld+json">${JSON.stringify(ld)}</script></head><body>${extra}</body></html>`;

  it("reads a Restaurant node: cuisine, price range, hours, rating, accessibility, menu", () => {
    const f = parseWebsite(
      page({
        "@context": "https://schema.org",
        "@type": "Restaurant",
        name: "X",
        servesCuisine: ["Vietnamese", "Asian"],
        priceRange: "$$",
        openingHours: ["Mo-Fr 11:00-22:00", "Sa 12:00-23:00"],
        aggregateRating: { "@type": "AggregateRating", ratingValue: "4.6", reviewCount: 212 },
        amenityFeature: [{ "@type": "LocationFeatureSpecification", name: "Wheelchair accessible", value: true }],
        hasMenu: "/karte.pdf",
        description: "  Family-run   since 1998. ",
      }),
      "https://example.org/",
      AT,
    );
    expect(f).toMatchObject({
      host: "example.org",
      cuisine: ["vietnamese", "asian"],
      priceLevel: 2,
      hours: ["Mo-Fr 11:00-22:00", "Sa 12:00-23:00"],
      rating: { value: 4.6, best: 5, count: 212 },
      wheelchair: true,
      menuUrl: "https://example.org/karte.pdf",
      description: "Family-run since 1998.",
    });
    expect(f.types).toContain("Restaurant");
  });

  it("walks an @graph and prefers the food-typed node over the Organization", () => {
    const f = parseWebsite(
      page({
        "@graph": [
          { "@type": "Organization", name: "Group", priceRange: "$$$$" },
          { "@type": ["CafeOrCoffeeShop", "LocalBusiness"], priceRange: "$" },
        ],
      }),
      "https://example.org/",
      AT,
    );
    expect(f.priceLevel).toBe(1);
  });

  it("finds a menu link on the page when nothing is marked up, and survives broken JSON", () => {
    const f = parseWebsite(
      `<script type="application/ld+json">{not json</script><a href="/de/speisekarte">Karte</a>`,
      "https://example.org/x/",
      AT,
    );
    expect(f.menuUrl).toBe("https://example.org/de/speisekarte");
    expect(f.rating).toBeUndefined();
  });

  it("rejects ratings outside their scale and price ranges that are not bands", () => {
    const f = parseWebsite(
      page({ "@type": "Restaurant", aggregateRating: { ratingValue: 7, bestRating: 5 }, priceRange: "10-20 EUR" }),
      "https://example.org/",
      AT,
    );
    expect(f.rating).toBeUndefined();
    expect(f.priceLevel).toBeUndefined();
    expect(priceRangeToLevel("€€€")).toBe(3);
    expect(priceRangeToLevel("$$$$$")).toBeUndefined();
  });
});

describe("clip", () => {
  it("cuts at a sentence, else a word, never mid-word", () => {
    expect(clip("Short.", 20)).toBe("Short.");
    expect(clip("First sentence here. Second sentence follows and runs long.", 30)).toBe("First sentence here.");
    expect(clip("no sentence boundary in this long text at all really", 25)).toBe("no sentence boundary in…");
  });
});

describe("parseEntity (Wikidata)", () => {
  it("reads description, official site, Wikipedia and a named award", () => {
    const f = parseEntity(
      "Q1",
      {
        entities: {
          Q1: {
            descriptions: { en: { value: "restaurant in Berlin" } },
            claims: {
              P856: [{ mainsnak: { datavalue: { value: "https://example.org" } } }],
              P166: [{ mainsnak: { datavalue: { value: { id: "Q20824563" } } } }, { mainsnak: { datavalue: { value: { id: "Q999" } } } }],
              P2012: [{ mainsnak: { datavalue: { value: { id: "Q123" } } } }],
            },
            sitelinks: { enwiki: { title: "Some Place", url: "https://en.wikipedia.org/wiki/Some_Place" } },
          },
        },
      },
      AT,
    );
    expect(f).toMatchObject({
      description: "restaurant in Berlin",
      website: "https://example.org",
      wikipedia: "https://en.wikipedia.org/wiki/Some_Place",
      cuisineItems: ["Q123"],
    });
    expect(f.awards).toEqual([{ item: "Q20824563", label: "Michelin star" }, { item: "Q999" }]);
  });
});

describe("merge rules", () => {
  const enrichment = (website: Partial<Enrichment["website"]>): Enrichment => ({
    osmRef: "node/1",
    fetchedAt: AT,
    website: { url: "https://example.org/", host: "example.org", fetchedAt: AT, types: [], ...website } as never,
    wikidata: null,
    error: null,
  });
  const attrs = () =>
    dossierFromTags({ amenity: "restaurant", name: "X", wheelchair: "no" }, "2026-08-31T20:21:20Z").attributes;

  it("fills unknown slots with web:<host> and never overwrites a verified record fact", () => {
    const out = applyEnrichmentAttributes(attrs(), enrichment({ cuisine: ["thai"], priceLevel: 2, wheelchair: true }));
    const by = Object.fromEntries(out.map((a) => [a.key, a]));
    expect(by.cuisine).toMatchObject({ status: "verified_true", value: "thai", source: "web:example.org" });
    expect(by["price-level"]).toMatchObject({ status: "verified_true", value: 2, source: "web:example.org" });
    // The record says no; the site says yes: the record wins.
    expect(by["wheelchair-accessible"]).toMatchObject({ status: "verified_false", source: "osm:wheelchair" });
    expect(by.hours.status).toBe("unknown");
  });

  it("published hours only ever reach unverified", () => {
    const out = applyEnrichmentAttributes(attrs(), enrichment({ hours: ["Mo-Su 10:00-20:00"] }));
    expect(out.find((a) => a.key === "hours")).toMatchObject({ status: "unverified", value: "Mo-Su 10:00-20:00" });
  });

  it("leaves the input untouched without a website result", () => {
    const a = attrs();
    expect(applyEnrichmentAttributes(a, undefined)).toBe(a);
  });

  it("the panel view: record links first, looked-up ones fill in, rating is labelled", () => {
    const extras = dossierFromTags(
      { amenity: "cafe", name: "X", website: "example.org", "website:menu": "https://example.org/menu", "contact:instagram": "xcafe" },
      AT,
    ).extras;
    const view = enrichmentView(extras, {
      osmRef: "node/1",
      fetchedAt: AT,
      website: { url: "https://example.org/", host: "example.org", fetchedAt: AT, types: [], menuUrl: "https://example.org/other", rating: { value: 4.2, best: 5 }, reservationsUrl: "https://book.example.org" },
      wikidata: { id: "Q1", fetchedAt: AT, description: "a café", wikipedia: "https://en.wikipedia.org/wiki/X", awards: [{ item: "Q20824563", label: "Michelin star" }], cuisineItems: [] },
      error: null,
    });
    expect(view.links.map((l) => [l.kind, l.source])).toEqual([
      ["website", "osm:website"],
      ["menu", "osm:website:menu"],
      ["reservations", "web:example.org"],
      ["wikipedia", "wikidata:Q1"],
      ["instagram", "osm:contact:instagram"],
    ]);
    expect(view.rating).toMatchObject({ value: 4.2, label: "as published by the place", source: "web:example.org" });
    expect(view.description).toEqual({ text: "a café", source: "wikidata:Q1" });
    expect(view.awards).toEqual([{ label: "Michelin star", source: "wikidata:Q1" }]);
  });

  it("linksFromTags normalises bare domains and instagram handles", () => {
    expect(linksFromTags({ website: "example.org", "contact:instagram": "@x.y" }).map((l) => l.url)).toEqual([
      "https://example.org",
      "https://www.instagram.com/x.y/",
    ]);
  });
});
