import { describe, expect, it } from "vitest";
import { evaluateFilter, patchShieldLayers } from "../../apps/web/src/map-style.ts";

/* The basemap patch (V8/F6, 2026-09-03): shield layers compare a nullable
 * `ref_length` as a number. The patch touches only those filters, makes a
 * road without a ref fail them cleanly, and never rewrites an icon-image
 * into a sprite name the sprite does not carry. */
const shield = {
  id: "highway-shield-non-us",
  type: "symbol" as const,
  source: "s",
  filter: [
    "all",
    ["<=", ["get", "ref_length"], 6],
    ["match", ["geometry-type"], ["LineString", "MultiLineString"], true, false],
    ["match", ["get", "network"], ["us-highway", "us-interstate", "us-state"], false, true],
  ],
  layout: {
    "icon-image": ["concat", "road_", ["get", "ref_length"]],
    "text-field": ["to-string", ["get", "ref"]],
  },
};
const road = { id: "road_label", type: "symbol" as const, source: "s", filter: ["<=", ["get", "ref_length"], 6] };
const style = { version: 8 as const, sources: {}, sprite: "https://tiles.example/sprites/positron", glyphs: "https://tiles.example/fonts/{fontstack}/{range}.pbf", layers: [shield, road] };
const sprite = new Set(["road_1", "road_2", "road_3", "road_4", "road_5", "road_6"]);

describe("basemap style patch", () => {
  it("keeps sprite and glyphs and rewrites only the shield filters", () => {
    const patched = patchShieldLayers(style as never);
    expect(patched.sprite).toBe(style.sprite);
    expect(patched.glyphs).toBe(style.glyphs);
    const [patchedShield, patchedRoad] = patched.layers as Array<Record<string, unknown>>;
    expect((patchedShield.filter as unknown[])[1]).toEqual(["<=", ["coalesce", ["get", "ref_length"], 99], 6]);
    expect(patchedShield.layout).toEqual(shield.layout);
    expect(patchedRoad.filter).toEqual(road.filter);
  });

  it("filters a road without a ref out before any image is looked up, where the original warned", () => {
    const noRef = { properties: { network: "de-motorway" }, geometryType: "LineString" };
    const withRef = { properties: { network: "de-motorway", ref: "A100", ref_length: 4 }, geometryType: "LineString" };
    expect(() => evaluateFilter(shield.filter, noRef)).toThrow(/found null/);
    const patched = patchShieldLayers(style as never).layers[0] as { filter: unknown; layout: { "icon-image": unknown } };
    expect(evaluateFilter(patched.filter, noRef)).toBe(false);
    expect(evaluateFilter(patched.filter, withRef)).toBe(true);
    // Every image a passing feature can ask for exists in the sprite; the
    // filtered-out feature never asks for "road_0" or "road_99".
    const image = (feature: typeof withRef) =>
      `road_${feature.properties.ref_length}`;
    expect(sprite.has(image(withRef))).toBe(true);
    expect(sprite.has("road_0")).toBe(false);
    expect(sprite.has(`road_${99}`)).toBe(false);
  });
});
