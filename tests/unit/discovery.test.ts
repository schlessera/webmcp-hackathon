import { describe, expect, it } from "vitest";
import {
  accessibilityRecords,
  accessibilityTiles,
  matchDiscovery,
  overtureRecord,
} from "../../apps/server/src/enrich/discovery.ts";
import { responseListings } from "../../apps/server/src/enrich/listings.ts";
import { relevantOwnSiteLinks } from "../../apps/server/src/enrich/website.ts";

const location = { lat: 52.52, lng: 13.4 };
const feature = {
  type: "Feature",
  geometry: { type: "Point", coordinates: [location.lng, location.lat] },
  properties: {
    id: "gers-one",
    names: { primary: "Distinct Corner" },
    websites: ["https://corner.example/"],
    confidence: 0.99,
    operating_status: "open",
    basic_category: "cafe",
    sources: [{ dataset: "meta", record_id: "123" }],
  },
};
const cloud = () => ({
  type: "FeatureCollection",
  related: {
    sources: {
      partner: {
        name: "City access survey",
        licenseId: "cc",
        originWebsiteURL: "https://city.example/access",
      },
    },
    licenses: {
      cc: {
        name: "CC BY 4.0",
        consideredAs: "CCBY",
        websiteURL: "https://creativecommons.org/licenses/by/4.0/",
      },
    },
  },
  features: [
    {
      ...feature,
      properties: {
        _id: "place-one",
        sourceId: "partner",
        originalId: "survey-42",
        name: "Distinct Corner",
        accessibility: { accessibleWith: { wheelchair: true } },
      },
    },
  ],
});

describe("conservative discovery", () => {
  it("uses Overture for identity and websites without inventing current hours or accessibility", () => {
    const record = overtureRecord(feature, "2026-08-19.0")!;
    expect(record.website).toBe("https://corner.example/");
    expect(record.operatingStatus).toBe("open");
    expect(record.wheelchair).toBeUndefined();
    expect(record).not.toHaveProperty("confidence");
    expect(record.sources).toEqual([
      { dataset: "meta", recordId: "123", license: "" },
    ]);
  });
  it("rejects closed records, weak identities, domain clashes and ambiguous branches", () => {
    const record = overtureRecord(feature, "2026-08-19.0")!;
    const target = { osmRef: "node/1", name: "Distinct Corner", location };
    expect(matchDiscovery(target, [record])).toEqual(record);
    expect(matchDiscovery({...target,name:"Cafe"},[{...record,name:"Cafe"}])).toBeNull();
    expect(
      matchDiscovery({ ...target, name: "Corner store" }, [record]),
    ).toBeNull();
    expect(
      matchDiscovery({ ...target, website: "https://different.example" }, [
        record,
      ]),
    ).toBeNull();
    expect(
      matchDiscovery(target, [record, { ...record, id: "other-branch" }]),
    ).toBeNull();
    expect(
      overtureRecord(
        {
          ...feature,
          properties: {
            ...feature.properties,
            operating_status: "permanently_closed",
          },
        },
        "2026-08-19.0",
      ),
    ).toBeNull();
  });
  it("requires source scope and open licence metadata, preserves attribution and ignores partial/unknown", () => {
    const body = cloud();
    expect(accessibilityRecords(body, ["partner"])[0]).toMatchObject({
      wheelchair: true,
      sourceId: "partner",
      originalId: "survey-42",
      license: "CC BY 4.0",
    });
    expect(accessibilityRecords(body, [])).toEqual([]);
    body.related.licenses.cc.consideredAs = "restricted";
    expect(accessibilityRecords(body, ["partner"])).toEqual([]);
    body.related.licenses.cc.consideredAs = "CCBY";
    (
      body.features[0].properties.accessibility.accessibleWith as any
    ).wheelchair = "partial";
    expect(accessibilityRecords(body, ["partner"])).toEqual([]);
  });
  it("does not count Wheelmap/OSM as an independent source", () => {
    const body = cloud();
    body.related.sources.partner.name = "Wheelmap / OpenStreetMap";
    expect(accessibilityRecords(body, ["partner"])).toEqual([]);
    expect(() =>
      accessibilityRecords({ error: "denied" }, ["partner"]),
    ).toThrow("invalid_response");
  });
  it("covers a tile boundary with bounded cached tile requests", () => {
    const tiles = accessibilityTiles({ lat: 0, lng: 0 });
    expect(tiles).toHaveLength(4);
    expect(tiles.every((t) => t.z === 16)).toBe(true);
  });
  it("follows only a few same-origin relevant navigation links", () => {
    expect(
      relevantOwnSiteLinks(
        `<a href="/faq">FAQ</a><a href="https://other.example/menu">menu</a>
      <a href="/accessibility">Access</a><a href="/menu?token=private">Menu</a><a href="/cart">Cart</a>`,
        "https://venue.example/",
      ),
    ).toEqual([
      "https://venue.example/faq",
      "https://venue.example/accessibility",
    ]);
  });
});
describe("listing response semantics", () => {
  it("requires independent HTTP-body and task success", () => {
    expect(() =>
      responseListings({
        status_code: 20000,
        tasks: [{ status_code: 40202, result: [] }],
      }),
    ).toThrow("rate_limit");
    expect(() => responseListings({ status_code: 50000, tasks: [] })).toThrow(
      "invalid_response",
    );
    expect(() =>
      responseListings({
        status_code: 20000,
        tasks: [{ status_code: 20000, result: [{}] }],
      }),
    ).toThrow("invalid_response");
    expect(
      responseListings({
        status_code: 20000,
        tasks: [
          { status_code: 20000, result: [{ items: null, total_count: 0 }] },
        ],
      }).items,
    ).toEqual([]);
  });
});
