import { describe, expect, it } from "vitest";
import {
  clip,
  extractAnchors,
  extractVisibleText,
  extractPageIdentity,
  fetchWebsiteFacts,
  hoursFromSpecification,
  isPublicAddress,
  MAX_PAGE_TEXT,
  parseWebsite,
  pickMenuLink,
  priceRangeToLevel,
  robotsAllows,
  scanMenuMentions,
} from "../../apps/server/src/enrich/website.ts";
import { parseEntity } from "../../apps/server/src/enrich/wikidata.ts";
import {
  applyEnrichmentAttributes,
  enrichmentView,
  type Enrichment,
} from "../../apps/server/src/enrich/index.ts";
import { dossierFromTags, linksFromTags } from "../../packages/contracts/src/dossier.ts";
import { warmTargetsFor } from "../../apps/server/src/candidate-write.ts";

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

describe("website network boundary", () => {
  it.each([
    "0.0.0.0",
    "10.1.2.3",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
  ])("rejects non-public address %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it("accepts public IPv4 and IPv6 addresses", () => {
    expect(isPublicAddress("93.184.216.34")).toBe(true);
    expect(isPublicAddress("2606:2800:220:1:248:1893:25c8:1946")).toBe(true);
  });

  it("rejects a private initial target before invoking the transport", async () => {
    let calls = 0;
    const result = await fetchWebsiteFacts("http://169.254.169.254/latest/meta-data", async () => {
      calls += 1;
      return new Response("should not be fetched");
    });
    expect(result.facts).toBeNull();
    expect(result.error).toContain("non-public network target");
    expect(calls).toBe(0);
  });

  it("rejects a redirect to loopback before issuing the redirected request", async () => {
    const fetched: string[] = [];
    const result = await fetchWebsiteFacts("https://93.184.216.34/venue", async (url) => {
      fetched.push(url);
      if (url.endsWith("/robots.txt")) return new Response("", { status: 200 });
      return new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1/private" },
      });
    });
    expect(result.facts).toBeNull();
    expect(result.error).toContain("non-public network target");
    expect(fetched).toEqual([
      "https://93.184.216.34/robots.txt",
      "https://93.184.216.34/venue",
    ]);
  });
});

describe("transient website text", () => {
  it("captures bounded Open Graph and schema publisher identity", () => {
    expect(extractPageIdentity(`
      <title>HANS IM GLÜCK | Burgergrill &amp; Bar</title>
      <meta property="og:site_name" content="HANS IM GLÜCK">
      <script type="application/ld+json">
        {"@type":"Restaurant","name":"HANS IM GLÜCK Berlin"}
      </script>
    `)).toEqual({
      title: "HANS IM GLÜCK | Burgergrill & Bar",
      publisherNames: ["HANS IM GLÜCK", "HANS IM GLÜCK Berlin"],
    });
  });

  it("keeps only selected visible content, strips page chrome, and enforces the page budget", () => {
    const text = extractVisibleText(`
      <html><head>
        <title>Courtyard Café</title>
        <meta content="A quiet &amp; welcoming place" name="description">
        <style>.secret { content: "style words" }</style>
        <script>window.secret = "script words"</script>
      </head><body>
        <nav><p>Navigation promotion</p></nav>
        <h1>Seasonal cooking</h1>
        <p>Dogs are <strong>welcome</strong> in the garden.</p>
        <ul><li>Step-free entrance</li></ul>
        <p hidden>Hidden promotion</p>
        <footer><p>Footer boilerplate</p></footer>
      </body></html>
    `);
    expect(text).toBe([
      "Courtyard Café",
      "A quiet & welcoming place",
      "Seasonal cooking",
      "Dogs are welcome in the garden.",
      "Step-free entrance",
    ].join("\n"));
    expect(extractVisibleText(`<p>${"word ".repeat(2_000)}</p>`).length).toBeLessThanOrEqual(MAX_PAGE_TEXT);
  });

  it("takes a layout container's own sentence without duplicating what it wraps", () => {
    const text = extractVisibleText(`
      <body>
        <div>Sourdough baked here every morning.<span>ignored child</span></div>
        <div><p>Dogs are welcome in the garden.</p></div>
        <section>Our terrace opens in May.</section>
        <div>Menü</div>
        <div>08:00</div>
        <td>Lunch is served until four.</td>
      </body>
    `);
    // A container's own clause is taken; a wrapper around a paragraph yields
    // the paragraph once, never twice.
    expect(text.split("\n")).toEqual([
      "Dogs are welcome in the garden.",
      "Sourdough baked here every morning.",
      "Our terrace opens in May.",
      "Lunch is served until four.",
    ]);
    // Single words and bare times are not quotable evidence.
    expect(text).not.toContain("Men\u00fc");
    expect(text).not.toContain("08:00");
    expect(text).not.toContain("ignored child");
  });

  it("returns separately budgeted homepage and menu text without putting either in WebFacts", async () => {
    const result = await fetchWebsiteFacts("https://93.184.216.34/", async (url) => {
      if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
      if (url.endsWith("/menu")) {
        return new Response(`<h1>Evening menu</h1><p>Vegan mushroom dumplings</p>`, {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      return new Response(`<title>Venue home</title><p>Dogs are welcome in our courtyard.</p><a href="/menu">Menu</a>`, {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    });
    expect(result.pageText).toEqual({
      homepage: "Venue home\nDogs are welcome in our courtyard.",
      menu: "Evening menu\nVegan mushroom dumplings",
    });
    expect(result.pageText!.homepage!.length).toBeLessThanOrEqual(MAX_PAGE_TEXT);
    expect(result.pageText!.menu!.length).toBeLessThanOrEqual(MAX_PAGE_TEXT);
    expect(result.facts).not.toHaveProperty("pageText");
    expect(result.facts).not.toHaveProperty("homepage");
    expect(result.facts).not.toHaveProperty("menu");
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

describe("what the crawl of 1,400 sites taught the parser", () => {
  const page = (ld: unknown, extra = "") =>
    `<html><head><script type="application/ld+json">${JSON.stringify(ld)}</script></head><body>${extra}</body></html>`;

  it("folds openingHoursSpecification into hours strings, arrays and schema URLs included", () => {
    expect(
      hoursFromSpecification([
        { "@type": "OpeningHoursSpecification", dayOfWeek: "https://schema.org/Tuesday", opens: "11:00", closes: "23:59:59" },
        { "@type": "OpeningHoursSpecification", dayOfWeek: ["Monday", "Wednesday"], opens: "12:30", closes: "23:00" },
        { "@type": "OpeningHoursSpecification", opens: "10:00", closes: "18:00" },
        { "@type": "OpeningHoursSpecification", dayOfWeek: "Friday" },
      ]),
    ).toEqual(["Tu 11:00-23:59", "Mo,We 12:30-23:00", "Mo-Su 10:00-18:00"]);
  });

  it("merges facts across nodes: an Organization first, a LocalBusiness with hours after it", () => {
    const f = parseWebsite(
      page({
        "@graph": [
          { "@type": "Organization", name: "Group", description: "A group." },
          { "@type": "LocalBusiness", openingHoursSpecification: [{ dayOfWeek: "Monday", opens: "11:30", closes: "01:00" }] },
        ],
      }),
      "https://example.org/",
      AT,
    );
    expect(f.hours).toEqual(["Mo 11:30-01:00"]);
    expect(f.description).toBe("A group.");
  });

  it("dereferences an @id-linked Menu and prefers a concrete URL over a fragment", () => {
    const f = parseWebsite(
      page({
        "@graph": [
          { "@type": "Restaurant", hasMenu: { "@id": "https://example.org/#menu" }, menu: "/assets/week.pdf" },
          { "@type": "Menu", "@id": "https://example.org/#menu", name: "Speisekarte" },
        ],
      }),
      "https://example.org/",
      AT,
    );
    expect(f.menuUrl).toBe("https://example.org/assets/week.pdf");
    const g = parseWebsite(
      page({
        "@graph": [
          { "@type": "Restaurant", hasMenu: { "@id": "https://example.org/#menu" } },
          { "@type": "Menu", "@id": "https://example.org/#menu", url: "https://example.org/karte" },
        ],
      }),
      "https://example.org/",
      AT,
    );
    expect(g.menuUrl).toBe("https://example.org/karte");
  });

  it("falls back to the WebPage description when no venue node carries one", () => {
    const f = parseWebsite(page({ "@type": "WebPage", description: "Das Steakhaus in Berlin." }), "https://example.org/", AT);
    expect(f.description).toBe("Das Steakhaus in Berlin.");
  });

  it("reads navigation: anchor text counts, strong words beat weak, legal pages never match", () => {
    const anchors = extractAnchors(
      `<a href="/impressum">Impressum</a><a href="/food"><span>Food</span></a>` +
        `<a href="https://drive.google.com/file/d/x/view">Menü - Regulär</a>` +
        `<a href="/de/speisen-und-getraenke/">Speisen &#038; Getr&auml;nke</a>`,
    );
    expect(anchors.map((a) => a.text)).toEqual(["Impressum", "Food", "Menü - Regulär", "Speisen & Getränke"]);
    // Strong word in the text on the same host wins over a strong word on a third-party host.
    expect(pickMenuLink(anchors, "https://example.org/")).toBe("https://example.org/de/speisen-und-getraenke/");
    // With only a weak word, the site's own /food link is taken.
    expect(pickMenuLink(anchors.slice(0, 2), "https://example.org/")).toBe("https://example.org/food");
    // An opaque third-party URL is fine when the text says what it is.
    expect(pickMenuLink(anchors.slice(2, 3), "https://example.org/")).toBe("https://drive.google.com/file/d/x/view");
    // A bare PDF with no menu-like text is not a menu; one with text is.
    expect(pickMenuLink(extractAnchors(`<a href="/files/agb.pdf">AGB</a>`), "https://example.org/")).toBeUndefined();
    expect(pickMenuLink(extractAnchors(`<a href="/s/LUNCH.pdf">LUNCH</a>`), "https://example.org/")).toBe("https://example.org/s/LUNCH.pdf");
    // Booking and delivery hosts are never the menu.
    expect(pickMenuLink(extractAnchors(`<a href="https://www.opentable.de/r/x">Menu & Tisch</a>`), "https://example.org/")).toBeUndefined();
  });

  it("finds booking and delivery platforms in the navigation", () => {
    const f = parseWebsite(
      "",
      "https://example.org/",
      AT,
    );
    expect(f.reservationsUrl).toBeUndefined();
    const g = parseWebsite(
      `<a href="https://www.opentable.com/r/place">Book</a><a href="https://wolt.com/de/deu/berlin/restaurant/place">Order</a>`,
      "https://example.org/",
      AT,
    );
    expect(g.reservationsUrl).toBe("https://www.opentable.com/r/place");
    expect(g.deliveryUrl).toBe("https://wolt.com/de/deu/berlin/restaurant/place");
  });

  it("scans a menu page for dietary words in English and German, ignoring scripts", () => {
    expect(scanMenuMentions(`<script>var vegan = 1;</script><p>Unsere vegetarischen Gerichte, glutenfreie Pasta.</p>`)).toEqual([
      "vegetarian-options",
      "gluten-free-options",
    ]);
    expect(scanMenuMentions(`<li>Vegan bowl (dairy-free)</li>`)).toEqual(["vegan-options", "lactose-free-options"]);
    expect(scanMenuMentions(`<p>nothing here</p>`)).toEqual([]);
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

  it("a word on the menu lifts an unknown to likely, never to verified, and never touches a known fact", () => {
    const out = applyEnrichmentAttributes(
      dossierFromTags({ amenity: "cafe", name: "X", "diet:vegan": "no" }, AT).attributes,
      enrichment({ menuMentions: ["vegan-options", "gluten-free-options"] }),
    );
    const by = Object.fromEntries(out.map((a) => [a.key, a]));
    expect(by["vegan-options"]).toMatchObject({ status: "verified_false", source: "osm:diet:vegan" });
    expect(by["gluten-free-options"]).toMatchObject({ status: "likely_true", value: "mentioned on the menu", source: "web:example.org", confidence: 0.6 });
  });

  it("published hours only ever reach likely", () => {
    const out = applyEnrichmentAttributes(attrs(), enrichment({ hours: ["Mo-Su 10:00-20:00"] }));
    expect(out.find((a) => a.key === "hours")).toMatchObject({ status: "likely_true", value: "Mo-Su 10:00-20:00" });
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
      website: { url: "https://example.org/", host: "example.org", fetchedAt: AT, types: [], menuUrl: "https://example.org/other", rating: { value: 4.2, best: 5 }, reservationsUrl: "https://book.example.org", deliveryUrl: "https://wolt.com/x" },
      wikidata: { id: "Q1", fetchedAt: AT, description: "a café", wikipedia: "https://en.wikipedia.org/wiki/X", awards: [{ item: "Q20824563", label: "Michelin star" }], cuisineItems: [] },
      error: null,
    });
    expect(view.links.map((l) => [l.kind, l.source])).toEqual([
      ["website", "osm:website"],
      ["menu", "osm:website:menu"],
      ["reservations", "web:example.org"],
      ["delivery", "web:example.org"],
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

describe("warm targets for a pool batch", () => {
  const seed = (id: string, extras?: Record<string, string>) => ({
    id,
    name: id,
    category: "cafe",
    price_level: null,
    walk_min: 3,
    location: { lat: 52.5, lng: 13.4 },
    attributes: [],
    hours: null,
    osmRef: `node/${id}`,
    ...(extras ? { extras } : {}),
  }) as never;

  it("keeps only the seeds with somewhere to look", () => {
    const targets = warmTargetsFor([
      seed("with-site", { website: "https://example.test" }),
      seed("with-wikidata", { wikidata: "Q42" }),
      seed("with-nothing"),
    ]);
    expect(targets.map((target) => target.candidateId)).toEqual(["with-site", "with-wikidata"]);
    expect(targets[0]).toMatchObject({
      osmRef: "node/with-site",
      website: "https://example.test",
    });
    expect(targets[1]).not.toHaveProperty("website");
  });

  it("drops a seed the snapshot could not resolve to an OSM ref", () => {
    const orphan = { ...seed("orphan", { website: "https://example.test" }), osmRef: undefined };
    expect(warmTargetsFor([orphan as never])).toEqual([]);
  });
});
