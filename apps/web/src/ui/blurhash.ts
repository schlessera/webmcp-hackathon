import { decode } from "blurhash";

/**
 * A blurhash is painted once into a tiny canvas and kept as a data URL, so
 * the same placeholder costs nothing the second time it is drawn (a hover
 * card and the details panel share one). 32×24 covers a 3:2 box; CSS scales
 * it up, and the blur is the point.
 */
const cache = new Map<string, string | null>();

export function blurhashDataUrl(hash: string | undefined): string | null {
  if (!hash) return null;
  const known = cache.get(hash);
  if (known !== undefined) return known;
  let url: string | null = null;
  try {
    const width = 32;
    const height = 24;
    const pixels = decode(hash, width, height);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      const imageData = ctx.createImageData(width, height);
      imageData.data.set(pixels);
      ctx.putImageData(imageData, 0, 0);
      url = canvas.toDataURL();
    }
  } catch {
    url = null;
  }
  cache.set(hash, url);
  return url;
}
