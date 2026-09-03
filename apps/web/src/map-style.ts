import type { StyleSpecification } from "maplibre-gl";

export type TileStyle = StyleSpecification | string;

/**
 * The basemap style, fetched once and patched before the map reads it.
 *
 * OpenFreeMap's styles compare `ref_length` as a number in their shield
 * layers; roads without a ref carry null there, and MapLibre warns on every
 * such feature ("Expected value to be of type number, but found null").
 * Wrapping the lookup in `coalesce` keeps the expression typed and the
 * production console quiet. Nothing else in the style is touched; when the
 * fetch fails the URL is handed to the map as before.
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

export function patchShieldLayers(style: StyleSpecification): StyleSpecification {
  const layers = style.layers.map((layer) =>
    layer.id.includes("shield") ? (coalesceRefLength(layer) as typeof layer) : layer,
  );
  return { ...style, layers };
}

/** Deep-rewrite `["get","ref_length"]` → `["coalesce",["get","ref_length"],0]`. */
function coalesceRefLength(node: unknown): unknown {
  if (Array.isArray(node)) {
    if (node.length === 2 && node[0] === "get" && node[1] === "ref_length") {
      return ["coalesce", ["get", "ref_length"], 0];
    }
    return node.map(coalesceRefLength);
  }
  if (node && typeof node === "object") {
    return Object.fromEntries(
      Object.entries(node as Record<string, unknown>).map(([k, v]) => [k, coalesceRefLength(v)]),
    );
  }
  return node;
}
