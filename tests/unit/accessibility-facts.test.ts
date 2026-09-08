import { describe, expect, it } from "vitest";
import { accessibilityFacts } from "../../apps/server/src/enrich/accessibility-facts.ts";
import { accessibilityRecords, accessibilityTiles, matchAccessibility, nearbyToilets } from "../../apps/server/src/enrich/discovery.ts";
import { dossierFromTags } from "@webmcp-hackathon/contracts";

describe("everyday survey facts", () => {
  it("keeps pets separate from assistance and legacy guide-dog policies", () => {
    const facts = accessibilityFacts({ accessibility: { animalPolicy: { allowsDogs: false, allowsAssistanceDogs: true }, allowsGuideDogs: true } });
    expect(facts).toEqual([
      expect.objectContaining({ key: "dog-friendly", value: false }),
      expect.objectContaining({ key: "assistance-dog-access", value: true, qualifiers: ["assistance dogs"] }),
      expect.objectContaining({ key: "assistance-dog-access", qualifiers: ["guide dogs only"] }),
    ]);
    expect(accessibilityFacts({ accessibility: { allowsGuideDogs: true } }).some((f) => f.key === "dog-friendly")).toBe(false);
  });
  it("keeps Wi-Fi pricing/restrictions separate from availability", () => {
    expect(accessibilityFacts({ accessibility: { hasFreeWifi: false, wifi: { isOpenToEveryone: false } } }))
      .toEqual([expect.objectContaining({ key: "wifi", value: null })]);
    expect(accessibilityFacts({ accessibility: { hasFreeWifi: true, wifi: { isOpenToEveryone: false } } }))
      .toEqual([expect.objectContaining({ key: "wifi", value: true, qualifiers: ["free", "restricted access"] })]);
    expect(accessibilityFacts({ accessibility: { hasFreeWifi: "true" } })).toEqual([]);
  });
  it("retains partial access, entrance assistance and independent toilet scope", () => {
    const facts = accessibilityFacts({ accessibility: {
      accessibleWith: { wheelchair: false }, partiallyAccessibleWith: { wheelchair: true },
      entrances: [{ properties: { isLevel: false, hasRemovableRamp: true } }, { isLevel: true }],
      restrooms: { isAccessibleWithWheelchair: true, washBasin: { isLocatedInsideRestroom: true } },
    } });
    expect(facts.find((f) => f.key === "wheelchair-accessible")).toMatchObject({ value: null });
    expect(facts.filter((f) => f.key === "step-free-entrance")).toMatchObject([
      { value: null, subject: "entrance", subjectId: "entrance:0" },
      { value: true, subject: "entrance", subjectId: "entrance:1" },
    ]);
    expect(facts.find((f) => f.key === "accessible-toilet")).toMatchObject({ subject: "toilet", value: true });
    expect(facts.some((f) => /baby|family/.test(f.key))).toBe(false);
  });
  it("does not turn an import timestamp or a quietness report into a current observation", () => {
    const unknown = accessibilityFacts({ updatedAt: "2026-09-08T00:00:00Z", accessibility: { isQuiet: true } });
    expect(unknown[0].observedAt).toBeUndefined();
    const dated = accessibilityFacts({ observedAt: "2020-01-01T00:00:00Z", accessibility: { isQuiet: true } });
    expect(dated[0]).toMatchObject({ observedAt: "2020-01-01T00:00:00.000Z" });
    expect(dated[0].qualifiers.join(" ")).toContain("time-specific quietness unconfirmed");
  });
  it("reads OSM Wi-Fi and attached toilets without inventing entrance access", () => {
    const facts = dossierFromTags({ internet_access: "wlan", "toilets:wheelchair": "yes", wheelchair: "yes" }, "2026-09-08").attributes;
    expect(facts.find((f) => f.key === "wifi")?.status).toBe("verified_true");
    expect(facts.find((f) => f.key === "accessible-toilet")?.status).toBe("verified_true");
    expect(facts.find((f) => f.key === "step-free-entrance")?.status).toBe("unknown");
    expect(dossierFromTags({ internet_access: "yes" }, "2026-09-08").attributes.find((f) => f.key === "wifi")?.status).toBe("unknown");
  });
});

describe("source and facility identity", () => {
  const target = { osmRef: "node/1", name: "Corner House", location: { lat: 52.52, lng: 13.4 } };
  const record = { id: "1", name: target.name, location: target.location, sourceId: "a", sourceUrl: "https://example.org", license: "CC BY" };
  it("keeps independent surveys while refusing ambiguous branches within a dataset", () => {
    expect(matchAccessibility(target, [record, { ...record, id: "2", sourceId: "b" }])).toHaveLength(2);
    expect(matchAccessibility(target, [record, { ...record, id: "duplicate" }, { ...record, id: "2", sourceId: "b" }]))
      .toMatchObject([{ sourceId: "b" }]);
  });
  it("does not match a same-named toilet to a café and bounds proximity without assuming a route", () => {
    const toilet = { ...record, facility: "toilet" as const, location: { lat: 52.521, lng: 13.4 } };
    expect(matchAccessibility(target, [toilet])).toEqual([]);
    expect(nearbyToilets(target, [toilet, { ...toilet, id: "far", location: { lat: 52.53, lng: 13.4 } }]))
      .toEqual([{ record: toilet, distanceM: 112 }]);
    expect(accessibilityTiles(target.location, 300).length).toBeLessThanOrEqual(9);
    expect(() => accessibilityTiles({ lat: 85, lng: 0 }, 300)).toThrow("capacity");
  });
  it("accepts dog-only records and independent Wheelmap surveys, but holds stale parking and OSM mirrors", () => {
    const body = (sourceId: string) => ({ type: "FeatureCollection", related: {
      sources: { [sourceId]: { name: "Independent Wheelmap survey", licenseId: "cc" } },
      licenses: { cc: { name: "CC BY", consideredAs: "CCBY" } },
    }, features: [{ type: "Feature", geometry: { type: "Point", coordinates: [13.4, 52.52] },
      properties: { _id: "1", sourceId, name: "Corner House", accessibility: { animalPolicy: { allowsDogs: true } } } }] });
    expect(accessibilityRecords(body("partner"), ["partner"])[0]).toMatchObject({ facts: [{ key: "dog-friendly", value: true }] });
    for (const id of ["LiBTS67TjmBcXdEmX", "3H7vWGaLzWqRKqtMS", "dvxYrDLdMv3tdiHck", "XWATLf3NA778iPJTp"]) {
      expect(accessibilityRecords(body(id), [id])).toEqual([]);
    }
  });
});
