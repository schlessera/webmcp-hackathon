import { describe, expect, it } from "vitest";
import {
  cleanSummary,
  cleanText,
  cleanTitle,
  hasWholeTextSpan,
} from "../../apps/server/src/enrich/text.ts";
import {
  cleanStoredInferences,
  cleanWebFacts,
} from "../../apps/server/src/enrich/stored-text.ts";

describe("extracted text hygiene", () => {
  it("cleans the nasty fixture corpus", () => {
    const fixtures = {
      exactReport: cleanTitle(
        "America&#039;s Most Iconic Diner | Southern California | Northern California",
        "Southern California | Northern California",
      ),
      doubleNumeric: cleanText("Rock &amp;#039;n roll"),
      breaks: cleanText("first<br>second<BR />third"),
      nbsp: cleanText("one&nbsp;&nbsp;two\u00a0three"),
      droppedScript: cleanText("<p>Before</p><script>steal()</script><p>After</p>"),
      cdata: cleanText("<![CDATA[Alpha<br>Beta]]>"),
      mixedEntities: cleanText("Fish &amp;amp; chips &#x2014; &#169; &amp;#x2019;"),
      zeroWidth: cleanText("zero\u200Bwidth \uFEFF gap"),
      inlineWord: cleanText("emp<b>ha</b>sis"),
      unicodeNfc: cleanText("Cafe\u0301 — “smart”"),
      escapedMarkup: cleanText("Safe &amp;lt;script&amp;gt;alert(1)&amp;lt;/script&amp;gt;"),
      onePassMarkup: cleanText("&amp;lt;script&gt;"),
      repeatedBrand: cleanTitle("Diner – Menu – Diner"),
    };

    expect(fixtures).toMatchInlineSnapshot(`
      {
        "breaks": "first
      second
      third",
        "cdata": "Alpha
      Beta",
        "doubleNumeric": "Rock 'n roll",
        "droppedScript": "Before
      After",
        "escapedMarkup": "Safe script alert(1) /script",
        "exactReport": "America's Most Iconic Diner",
        "inlineWord": "emphasis",
        "mixedEntities": "Fish & chips — © ’",
        "nbsp": "one two three",
        "onePassMarkup": "script",
        "repeatedBrand": "Diner – Menu",
        "unicodeNfc": "Café — “smart”",
        "zeroWidth": "zerowidth gap",
      }
    `);
  });

  it("caps descriptions at a word boundary and marks truncation", () => {
    expect(cleanSummary("A compact description with several words", 24)).toBe(
      "A compact description…",
    );
  });

  it("normalizes source and evidence identically before span validation", () => {
    const source = cleanText("<p>Dogs &amp; their people<br>are welcome indoors.</p>");
    expect(hasWholeTextSpan(source, "Dogs &amp; their people are welcome")).toBe(true);
  });

  it("makes the durable re-clean transform idempotent", () => {
    const website = {
      url: "https://example.test/",
      host: "example.test",
      fetchedAt: "2026-09-03T00:00:00.000Z",
      types: ["Rest&amp;amp;aurant"],
      pageTitle: "Diner &amp;#039;s | Diner &amp;#039;s",
      description: "Welcome&nbsp;inside<br>Today",
    };
    const inferred = {
      dogs: {
        key: "dogs",
        lean: "yes" as const,
        confidence: 0.6,
        evidence: "Dogs &amp; friends<br>are welcome",
        source: "infer:test",
        observedAt: "2026-09-03T00:00:00.000Z",
        note: "<b>Dogs &amp; friends</b>",
        adjudication: {
          evidenceHash: "stale",
          verdict: "yes" as const,
          explicit: true,
          publisher: "venue" as const,
          quote: "<i>Dogs &amp; friends</i>",
          observedAt: "2026-09-03T00:00:00.000Z",
        },
      },
    };
    const once = {
      website: cleanWebFacts(website),
      inferred: cleanStoredInferences(inferred),
    };
    const twice = {
      website: cleanWebFacts(once.website),
      inferred: cleanStoredInferences(once.inferred),
    };
    expect(twice).toEqual(once);
    expect(JSON.stringify(once)).not.toMatch(/<|&#|&amp;/);
  });
});
