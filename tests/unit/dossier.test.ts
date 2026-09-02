import { describe, expect, it } from "vitest";
import {
  BOOLEAN_ATTRS,
  booleanAttr,
  dossierFromTags,
  isDecisive,
  parseOpeningHours,
} from "../../packages/contracts/src/dossier.ts";

/**
 * The shared tag → attribute mapping (docs/DATA-QUALITY.md): only `yes`/`no`
 * are decisive, everything else is a state the UI draws, and nothing is ever
 * invented for a tag OSM does not carry.
 */

const AT = "2026-08-31T20:21:20Z";

describe("booleanAttr", () => {
  it("maps yes/no to the two verified statuses and anything else to unverified", () => {
    expect(booleanAttr("k", "wheelchair", { wheelchair: "yes" }, AT).status).toBe("verified_true");
    expect(booleanAttr("k", "wheelchair", { wheelchair: "no" }, AT).status).toBe("verified_false");
    expect(booleanAttr("k", "wheelchair", { wheelchair: "limited" }, AT).status).toBe("unverified");
    expect(booleanAttr("k", "diet:vegetarian", { "diet:vegetarian": "only" }, AT).status).toBe("unverified");
  });
  it("an absent tag is unknown, with an osm:* source and the extract timestamp", () => {
    const a = booleanAttr("dog-friendly", "dog", {}, AT);
    expect(a).toMatchObject({ status: "unknown", source: "osm:dog", observedAt: AT });
  });
  it("only the two verified statuses are decisive", () => {
    expect(isDecisive("verified_true")).toBe(true);
    expect(isDecisive("verified_false")).toBe(true);
    expect(isDecisive("unverified")).toBe(false);
    expect(isDecisive("unknown")).toBe(false);
  });
});

describe("parseOpeningHours", () => {
  it("handles the common subset", () => {
    expect(parseOpeningHours("24/7")).toHaveLength(7);
    expect(parseOpeningHours("Mo-Fr 08:00-18:00; Sa 10:00-14:00")).toEqual([
      { day: "mon", open: "08:00", close: "18:00" },
      { day: "tue", open: "08:00", close: "18:00" },
      { day: "wed", open: "08:00", close: "18:00" },
      { day: "thu", open: "08:00", close: "18:00" },
      { day: "fri", open: "08:00", close: "18:00" },
      { day: "sat", open: "10:00", close: "14:00" },
    ]);
    expect(parseOpeningHours("12:00-23:00")).toHaveLength(7);
    expect(parseOpeningHours("Sa-Su 18:00+")).toEqual([
      { day: "sat", open: "18:00", close: "23:59" },
      { day: "sun", open: "18:00", close: "23:59" },
    ]);
    expect(parseOpeningHours("Mo-Fr 11:30-24:00")?.[0].close).toBe("23:59");
  });
  it("returns null when nothing usable is there — never a default", () => {
    expect(parseOpeningHours(undefined)).toBeNull();
    expect(parseOpeningHours("")).toBeNull();
    expect(parseOpeningHours("Mo off")).toBeNull();
    expect(parseOpeningHours("by appointment")).toBeNull();
  });
});

describe("dossierFromTags", () => {
  it("emits every engine-read attribute, in a fixed order, with real statuses", () => {
    const d = dossierFromTags(
      {
        amenity: "cafe",
        name: "X",
        cuisine: "coffee_shop;cake",
        "diet:vegetarian": "yes",
        wheelchair: "limited",
        opening_hours: "Mo-Su 09:00-18:00",
      },
      AT,
    );
    expect(d.category).toBe("cafe");
    expect(d.attributes.map((a) => a.key)).toEqual([
      ...BOOLEAN_ATTRS.map((b) => b.key),
      "cuisine",
      "price-level",
      "hours",
    ]);
    const by = Object.fromEntries(d.attributes.map((a) => [a.key, a]));
    expect(by["vegetarian-options"].status).toBe("verified_true");
    expect(by["wheelchair-accessible"].status).toBe("unverified");
    expect(by["lactose-free-options"].status).toBe("unknown");
    expect(by.cuisine).toMatchObject({ status: "verified_true", value: "coffee_shop;cake" });
    expect(by.hours).toMatchObject({ status: "verified_true", value: "Mo-Su 09:00-18:00" });
    expect(d.hours).toHaveLength(7);
  });
  it("invents nothing: no price band, no default hours", () => {
    const d = dossierFromTags({ amenity: "restaurant", name: "Y" }, AT);
    const by = Object.fromEntries(d.attributes.map((a) => [a.key, a]));
    expect(d.priceLevel).toBeNull();
    expect(by["price-level"]).toMatchObject({ status: "unknown" });
    expect(by["price-level"].value).toBeUndefined();
    expect(d.hours).toEqual([]);
    expect(by.hours).toMatchObject({ status: "unknown", source: "osm:opening_hours" });
    expect(by.cuisine.status).toBe("unknown");
    for (const a of d.attributes) {
      expect(a.source.startsWith("osm:")).toBe(true);
      expect(a.observedAt).toBe(AT);
    }
  });
  it("an unparseable opening_hours tag is unverified, not unknown and not defaulted", () => {
    const d = dossierFromTags({ amenity: "bar", name: "Z", opening_hours: "sunset-late" }, AT);
    const hours = d.attributes.find((a) => a.key === "hours")!;
    expect(hours).toMatchObject({ status: "unverified", value: "sunset-late" });
    expect(d.hours).toEqual([]);
  });
});
