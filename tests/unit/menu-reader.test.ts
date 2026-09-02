import { describe, expect, it } from "vitest";
import { READING_CONFIDENCE_CAP, readingFromAnswer } from "../../apps/server/src/enrich/menu-reader.ts";
import { menuImageOf } from "../../apps/server/src/enrich/website.ts";
import { applyEnrichmentAttributes, type Enrichment } from "../../apps/server/src/enrich/index.ts";

/**
 * Reading a menu that is a picture (docs/ENRICHMENT-SOURCES.md): the
 * model's answer becomes graded claims capped below verified, labelled
 * "menu:<host>", filling only what the record left open or guessed.
 */

const AT = "2026-09-02T20:00:00Z";

describe("readingFromAnswer", () => {
  it("clamps confidence below verified, keeps evidence, drops junk and duplicates", () => {
    const r = readingFromAnswer(
      {
        legible: true,
        language: "de",
        items: 23.4,
        cuisine: ["Vietnamese", " pho "],
        priceLevel: 2,
        claims: [
          { key: "vegan-options", lean: "yes", confidence: 0.97, evidence: "Vegan Bowl (vg)" },
          { key: "vegan-options", lean: "no", confidence: 0.5, evidence: "dup" },
          { key: "halal-options", lean: "maybe", confidence: 0.5, evidence: "x" },
          { key: "karaoke", lean: "yes", confidence: 0.9, evidence: "x" },
          { key: "gluten-free-options", lean: "no", confidence: 0, evidence: "x" },
          { key: "vegetarian-options", lean: "yes", confidence: 0.3, evidence: "Gemüse-Curry" },
        ],
      },
      "gpt-test",
      AT,
    );
    expect(r).toMatchObject({ legible: true, language: "de", items: 23, cuisine: ["vietnamese", "pho"], priceLevel: 2 });
    expect(r!.claims).toEqual([
      { key: "vegan-options", lean: "yes", confidence: READING_CONFIDENCE_CAP, evidence: "Vegan Bowl (vg)" },
      { key: "vegetarian-options", lean: "yes", confidence: 0.3, evidence: "Gemüse-Curry" },
    ]);
  });
  it("an illegible page carries no claims; a non-answer is null", () => {
    expect(readingFromAnswer({ legible: false, language: null, items: 0, cuisine: [], priceLevel: 9, claims: [{ key: "vegan-options", lean: "yes", confidence: 0.9, evidence: "x" }] }, "m", AT))
      .toMatchObject({ legible: false, claims: [], priceLevel: null });
    expect(readingFromAnswer(null, "m", AT)).toBeNull();
    expect(readingFromAnswer("nope", "m", AT)).toBeNull();
  });
});

describe("menuImageOf", () => {
  it("finds the picture on a page that is mostly a picture, never on a page of text", () => {
    expect(menuImageOf(`<h1>Karte</h1><img class="logo" src="/logo.png"><img src="/img/speisekarte-2026.jpg" alt="Speisekarte">`, "https://x.de/karte")).toBe("https://x.de/img/speisekarte-2026.jpg");
    expect(menuImageOf(`<p>Menu</p><img src="/only.jpg">`, "https://x.de/")).toBe("https://x.de/only.jpg");
    expect(menuImageOf(`<img src="/a.jpg"><img src="/b.jpg">`, "https://x.de/")).toBeUndefined();
    expect(menuImageOf(`<p>${"lots of dishes ".repeat(60)}</p><img src="/menu.jpg">`, "https://x.de/")).toBeUndefined();
    expect(menuImageOf(`<img src="data:image/png;base64,AAAA" alt="menu">`, "https://x.de/")).toBeUndefined();
  });
});

describe("merging a reading", () => {
  const enrichment = (reading: NonNullable<Enrichment["website"]>["menuReading"]): Enrichment => ({
    osmRef: "node/1",
    fetchedAt: AT,
    website: { url: "https://x.de/", host: "x.de", fetchedAt: AT, types: [], menuKind: "pdf", menuReading: reading },
    wikidata: null,
    error: null,
  });
  const reading = {
    model: "m", readAt: AT, legible: true, language: "de", items: 20, cuisine: ["vietnamese"], priceLevel: 2,
    claims: [
      { key: "vegan-options" as const, lean: "yes" as const, confidence: 0.69, evidence: "Vegan Bowl (vg)" },
      { key: "vegetarian-options" as const, lean: "yes" as const, confidence: 0.6, evidence: "Gemüse-Curry" },
      { key: "halal-options" as const, lean: "no" as const, confidence: 0.4, evidence: "pork throughout" },
    ],
  };
  it("fills unknown and guessed slots as likely with the evidence, never a verified record fact", () => {
    const out = applyEnrichmentAttributes(
      [
        { key: "vegan-options", status: "unknown" },
        { key: "vegetarian-options", status: "likely_true", source: "guess:cuisine", confidence: 0.6 },
        { key: "halal-options", status: "verified_true", source: "osm:diet:halal" },
        { key: "cuisine", status: "unknown" },
        { key: "price-level", status: "unknown" },
      ],
      enrichment(reading),
    );
    const by = Object.fromEntries(out.map((a) => [a.key, a]));
    expect(by["vegan-options"]).toMatchObject({ status: "likely_true", confidence: 0.69, source: "menu:x.de", value: "menu: Vegan Bowl (vg)" });
    expect(by["vegetarian-options"]).toMatchObject({ status: "likely_true", source: "menu:x.de" });
    expect(by["halal-options"]).toMatchObject({ status: "verified_true", source: "osm:diet:halal" });
    expect(by.cuisine).toMatchObject({ status: "likely_true", value: "vietnamese", source: "menu:x.de" });
    expect(by["price-level"]).toMatchObject({ status: "likely_true", value: 2, source: "menu:x.de" });
    for (const a of out) expect(["verified_true", "likely_true", "likely_false", "verified_false", "unknown"]).toContain(a.status);
  });
  it("an illegible reading changes nothing", () => {
    const attrs = [{ key: "vegan-options", status: "unknown" }];
    const out = applyEnrichmentAttributes(attrs, enrichment({ ...reading, legible: false, claims: [] }));
    expect(out[0].status).toBe("unknown");
  });
});
