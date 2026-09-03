import { describe, expect, it } from "vitest";
import { patchShieldLayers } from "../../apps/web/src/map-style.ts";

/** The basemap patch (V8, 2026-09-03): shield layers compare a nullable
 * `ref_length` as a number; the patch wraps only that lookup, only there. */
describe("basemap style patch", () => {
  it("coalesces ref_length in shield layers and leaves every other layer alone", () => {
    const style = {
      version: 8 as const,
      sources: {},
      layers: [
        {
          id: "highway-shield-non-us",
          type: "symbol" as const,
          source: "s",
          filter: ["all", ["<=", ["get", "ref_length"], 6]],
          layout: { "icon-image": ["concat", "road_", ["get", "ref_length"]], "text-field": ["to-string", ["get", "ref"]] },
        },
        {
          id: "road_label",
          type: "symbol" as const,
          source: "s",
          filter: ["<=", ["get", "ref_length"], 6],
        },
      ],
    };
    const patched = patchShieldLayers(style as never);
    const [shield, road] = patched.layers as Array<Record<string, unknown>>;
    expect(shield.filter).toEqual(["all", ["<=", ["coalesce", ["get", "ref_length"], 0], 6]]);
    expect((shield.layout as Record<string, unknown>)["icon-image"]).toEqual(["concat", "road_", ["coalesce", ["get", "ref_length"], 0]]);
    expect((shield.layout as Record<string, unknown>)["text-field"]).toEqual(["to-string", ["get", "ref"]]);
    expect(road.filter).toEqual(["<=", ["get", "ref_length"], 6]);
  });
});
