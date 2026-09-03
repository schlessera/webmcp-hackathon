import { useEffect, useState } from "react";
import { placeImageBlob } from "../api.ts";
import { blurhashDataUrl } from "../ui/blurhash.ts";

/**
 * The floating card a dot shows while a fine pointer rests on it or keyboard
 * focus lands on it: the name and the place's first image. It never takes
 * pointer events, so the cursor moves freely between dots, and it is not an
 * animation — only its opacity rides the settle token (§9).
 */
export interface HoverCardProps {
  name: string;
  image: { url: string; width: number; height: number; blurhash?: string };
  /** Position of the dot inside the map band, in CSS pixels. */
  x: number;
  y: number;
  bandWidth: number;
  bandHeight: number;
}

const CARD_W = 172;
const CARD_H = 107 + 30;
const GAP = 14;

/** Object URLs by image route, so a second hover paints at once. */
const blobUrls = new Map<string, string>();

export function HoverCard({ name, image, x, y, bandWidth, bandHeight }: HoverCardProps) {
  const [src, setSrc] = useState<string | undefined>(blobUrls.get(image.url));
  useEffect(() => {
    const known = blobUrls.get(image.url);
    if (known) {
      setSrc(known);
      return;
    }
    const controller = new AbortController();
    void placeImageBlob(image.url, controller.signal).then((blob) => {
      if (!blob || controller.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      blobUrls.set(image.url, url);
      setSrc(url);
    });
    return () => controller.abort();
  }, [image.url]);

  // Above the dot by default, below it near the top edge; clamped inside the
  // band horizontally so the card never leaves the map.
  const above = y - GAP - CARD_H >= 4;
  const top = above ? y - GAP - CARD_H : Math.min(y + GAP, Math.max(4, bandHeight - CARD_H - 4));
  const left = Math.min(Math.max(4, x - CARD_W / 2), Math.max(4, bandWidth - CARD_W - 4));
  const placeholder = blurhashDataUrl(image.blurhash);
  return (
    <div
      className="map-hover-card"
      data-testid="hover-card"
      data-side={above ? "above" : "below"}
      data-loaded={src ? "true" : undefined}
      style={{ left, top, width: CARD_W }}
      aria-hidden="true"
    >
      <div
        className="map-hover-photo"
        data-testid="hover-card-photo"
        style={placeholder ? { backgroundImage: `url(${placeholder})` } : undefined}
      >
        {src && <img src={src} alt="" width={image.width} height={image.height} />}
      </div>
      <div className="map-hover-name">{name}</div>
    </div>
  );
}
