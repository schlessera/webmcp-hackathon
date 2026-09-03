import type { StyleSpecification } from "maplibre-gl";

export type TileStyle = StyleSpecification | string;

/**
 * The basemap style, fetched once and patched before the map reads it.
 *
 * OpenFreeMap's styles compare `ref_length` as a number in their shield
 * layers' filters; roads without a ref carry null there, and MapLibre warns
 * on every such feature ("Expected value to be of type number, but found
 * null"). The patch coalesces the lookup to a length no shield accepts, so a
 * road without a ref fails the filter cleanly and its `icon-image`
 * ("road_" + length) is never resolved — coalescing to 0 would instead ask
 * the sprite for a "road_0" it does not have. Layout and paint are left as
 * they are, and so are `sprite` and `glyphs`; when the fetch fails the URL is
 * handed to the map as before.
 */
export async function loadTileStyle(url: string): Promise<TileStyle> {
  try {
    const response = await fetch(url);
    if (!response.ok) return url;
    const style = (await response.json()) as StyleSpecification;
    return patchShieldLayers(style);
  } catch {
    return url;
  }
}

/** Longer than any shield the sprite carries (road_1 … road_6). */
export const NO_SHIELD_LENGTH = 99;

export function patchShieldLayers(style: StyleSpecification): StyleSpecification {
  const layers = style.layers.map((layer) =>
    layer.id.includes("shield") && "filter" in layer && layer.filter
      ? ({ ...layer, filter: coalesceRefLength(layer.filter) } as typeof layer)
      : layer,
  );
  return { ...style, layers };
}

/** Deep-rewrite `["get","ref_length"]` → `["coalesce",["get","ref_length"],99]`. */
function coalesceRefLength(node: unknown): unknown {
  if (Array.isArray(node)) {
    if (node.length === 2 && node[0] === "get" && node[1] === "ref_length") {
      return ["coalesce", ["get", "ref_length"], NO_SHIELD_LENGTH];
    }
    return node.map(coalesceRefLength);
  }
  return node;
}

/**
 * A minimal reading of the filter subset these layers use — enough for a
 * test to show that a feature without a ref is filtered out before any
 * image lookup. Supports all / any / <= / < / >= / > / == / match /
 * coalesce / get / geometry-type / literals.
 */
export function evaluateFilter(
  expression: unknown,
  feature: { properties: Record<string, unknown>; geometryType: string },
): unknown {
  if (!Array.isArray(expression)) return expression;
  const [op, ...args] = expression as [string, ...unknown[]];
  const ev = (x: unknown) => evaluateFilter(x, feature);
  switch (op) {
    case "all":
      return args.every((a) => Boolean(ev(a)));
    case "any":
      return args.some((a) => Boolean(ev(a)));
    case "get":
      return feature.properties[String(args[0])] ?? null;
    case "geometry-type":
      return feature.geometryType;
    case "coalesce":
      for (const a of args) {
        const v = ev(a);
        if (v !== null && v !== undefined) return v;
      }
      return null;
    case "<=":
    case "<":
    case ">=":
    case ">": {
      const [a, b] = [ev(args[0]), ev(args[1])];
      if (typeof a !== "number" || typeof b !== "number") {
        throw new TypeError(`Expected value to be of type number, but found ${a === null ? "null" : typeof a} instead.`);
      }
      return op === "<=" ? a <= b : op === "<" ? a < b : op === ">=" ? a >= b : a > b;
    }
    case "==":
      return ev(args[0]) === ev(args[1]);
    case "match": {
      const value = ev(args[0]);
      for (let i = 1; i + 1 < args.length; i += 2) {
        const labels = args[i];
        if ((Array.isArray(labels) ? labels : [labels]).includes(value)) return ev(args[i + 1]);
      }
      return ev(args[args.length - 1]);
    }
    default:
      throw new Error(`unsupported expression ${op}`);
  }
}
