import { MercatorCoordinate, type LngLatLike, type Map as MapLibreMap } from "maplibre-gl";
import { MAP_THEME } from "./map-theme.ts";

// Every room pin reserves the space a label will need, before it has a name.
const PIN_HEIGHT = 42;
const EXPLORE_PIN_HEIGHT = 24;

export function pinLift(pitch: number, explore = false): number {
  return (explore ? EXPLORE_PIN_HEIGHT : PIN_HEIGHT) *
    Math.sin(Math.max(0, Math.min(90, pitch)) * Math.PI / 180);
}

function canvasPinTranslation(pitch: number, explore = false): number {
  // Counter the map plane's foreshortening so the stem clears the head.
  return pinLift(pitch, explore) / Math.max(0.25, Math.cos(pitch * Math.PI / 180));
}

/** Local coordinates: head at (0, 0), tip at the geographic point. */
export function pinStem(x: number, y: number, clearance: number) {
  const length = Math.hypot(x, y);
  if (length <= clearance) return null;
  const nx = x / length;
  const ny = y / length;
  // Clipping a different head must not change the triangle beneath it.
  const halfWidth = MAP_THEME.pinNeedle.width / 2 * (1 - clearance / length);
  return [
    [x, y],
    [nx * clearance - ny * halfWidth, ny * clearance + nx * halfWidth],
    [nx * clearance + ny * halfWidth, ny * clearance - nx * halfWidth],
  ];
}

export function pinStemPath(x: number, y: number, clearance: number): string {
  const points = pinStem(x, y, clearance);
  return points ? `M${points[0]} L${points[1]} L${points[2]} Z` : "";
}

export const GL_MARK_RADIUS = {
  out: 4, unsure: 8, unlikely: 6, likely: 5.5, return: 7, act: 9.5, works: 7.5,
} as const;

export const PIN_CIRCLE_PAINT = {
  "circle-translate-anchor": "viewport",
  "circle-translate-transition": { duration: 0 },
  "circle-pitch-scale": "viewport",
} as const;

export const PIN_ICON_LAYOUT = {
  "icon-pitch-alignment": "viewport",
  "icon-rotation-alignment": "viewport",
} as const;

export const PIN_ICON_PAINT = {
  "icon-translate-anchor": "viewport",
  "icon-translate-transition": { duration: 0 },
} as const;

/** MapLibre applies circle/icon-translate in tile space, even with a viewport
 * anchor. Match that Mercator displacement before projecting: simply moving
 * the projected point upward loses both perspective and bearing. */
export function canvasPinPoint(map: MapLibreMap, location: LngLatLike, explore = false) {
  const coordinate = MercatorCoordinate.fromLngLat(location);
  const shift = canvasPinTranslation(map.getPitch(), explore) / (512 * 2 ** map.getZoom());
  const angle = map.getBearing() * Math.PI / 180;
  coordinate.x += shift * Math.sin(angle);
  coordinate.y -= shift * Math.cos(angle);
  return map.project(coordinate.toLngLat());
}

// Source points use MapLibre's tile precision. Reuse them when a canvas pin
// becomes a DOM label so high zoom cannot expose a rounding jump either.
const roomCoordinates = new WeakMap<MapLibreMap, Map<string, [number, number]>>();

export function roomPinPoint(map: MapLibreMap, candidateId: string, location: LngLatLike) {
  if (map.getPitch() === 0) return map.project(location);
  return canvasPinPoint(map, roomCoordinates.get(map)?.get(candidateId) ?? location);
}

/** One transparent canvas for visible GL needles. Cutting out every head
 * keeps strokes behind hollow/translucent dots too, including neighbours.
 * HTML cards sit above the canvas and keep their own geographic SVG needle.
 * No features are re-tiled and React does not render animation frames. */
export function bindMapPins(map: MapLibreMap): () => void {
  const container = map.getContainer();
  const canvas = document.createElement("canvas");
  canvas.className = "map-pin-needles";
  canvas.setAttribute("aria-hidden", "true");
  map.getCanvasContainer().append(canvas);
  const drawing = canvas.getContext("2d")!;
  let syncing = false;

  const draw = () => {
    const mapCanvas = map.getCanvas();
    if (canvas.width !== mapCanvas.width || canvas.height !== mapCanvas.height) {
      canvas.width = mapCanvas.width;
      canvas.height = mapCanvas.height;
    }
    drawing.clearRect(0, 0, canvas.width, canvas.height);
    if (map.getPitch() === 0 || !mapCanvas.clientWidth) return;
    const pixelRatio = canvas.width / mapCanvas.clientWidth;
    drawing.save();
    drawing.scale(pixelRatio, pixelRatio);
    drawing.fillStyle = MAP_THEME.pinNeedle.color;
    const heads: Array<{ x: number; y: number; radius: number }> = [];
    const seen = new Set<string>();
    const layers = ["mark-dots", "explore-dots"].filter((id) => Boolean(map.getLayer(id)));
    for (const feature of map.queryRenderedFeatures({ layers })) {
      if (feature.geometry.type !== "Point" || feature.state.hidden) continue;
      const key = `${feature.source}:${feature.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const location = feature.geometry.coordinates as [number, number];
      const ground = map.project(location);
      const explore = feature.layer.id === "explore-dots";
      const head = canvasPinPoint(map, location, explore);
      const status = (feature.state.status ?? "works") as keyof typeof GL_MARK_RADIUS;
      const radius = explore ? 5 :
        status === "works" ? GL_MARK_RADIUS.works + 2.5 :
        status === "act" ? GL_MARK_RADIUS.act + 3 :
        status === "unsure" ? GL_MARK_RADIUS.unsure + 2.5 :
        ["likely", "unlikely", "return"].includes(status) ? 9 : GL_MARK_RADIUS.out;
      // Meet the antialiased border instead of leaving a clear pixel outside it.
      const clearance = Math.max(0, radius - 0.5);
      heads.push({ x: head.x, y: head.y, radius: clearance });
      drawing.globalAlpha = explore ? MAP_THEME.exploreDot.opacity :
        status === "out" ? MAP_THEME.marks.outOpacity : 1;
      const stem = pinStem(ground.x - head.x, ground.y - head.y, clearance);
      if (stem) {
        drawing.beginPath();
        drawing.moveTo(head.x + stem[0][0], head.y + stem[0][1]);
        drawing.lineTo(head.x + stem[1][0], head.y + stem[1][1]);
        drawing.lineTo(head.x + stem[2][0], head.y + stem[2][1]);
        drawing.closePath();
        drawing.fill();
      }
    }
    drawing.globalAlpha = 1;
    drawing.globalCompositeOperation = "destination-out";
    for (const head of heads) {
      drawing.beginPath();
      drawing.arc(head.x, head.y, head.radius, 0, Math.PI * 2);
      drawing.fill();
    }
    drawing.restore();
  };

  const sync = () => {
    if (syncing) return;
    syncing = true;
    try {
      const pitch = map.getPitch();
      const lift = pinLift(pitch);
      container.style.setProperty("--map-pin-lift", `${lift}px`);
      container.style.setProperty("--map-pin-visible", lift > 0 ? "1" : "0");
      const coordinates = new Map<string, [number, number]>();
      if (map.getSource("marks")) {
        for (const feature of map.querySourceFeatures("marks")) {
          if (feature.geometry.type === "Point") {
            coordinates.set(String(feature.id), feature.geometry.coordinates as [number, number]);
          }
        }
      }
      roomCoordinates.set(map, coordinates);
      for (const marker of container.querySelectorAll<HTMLElement>(".marker")) {
        const location: [number, number] = [Number(marker.dataset.lng), Number(marker.dataset.lat)];
        const ground = map.project(location);
        const head = roomPinPoint(map, marker.dataset.candidateId!, location);
        const dx = head.x - ground.x;
        const dy = head.y - ground.y;
        marker.style.setProperty("--map-pin-shift-x", `${dx}px`);
        marker.style.setProperty("--map-pin-shift-y", `${dy}px`);
        const path = marker.querySelector<SVGPathElement>(".marker-needle path");
        if (path) path.setAttribute("d", pinStemPath(
          -dx - Number(path.dataset.offsetX),
          -dy - Number(path.dataset.offsetY),
          Number(path.dataset.clearance),
        ));
      }
      for (const id of ["mark-dots", "explore-dots", "mark-dashes", "mark-busy", "mark-arc"]) {
        if (!map.getLayer(id)) continue;
        const property = id.endsWith("dots") ? "circle-translate" : "icon-translate";
        const current = map.getPaintProperty(id, property) as [number, number] | undefined;
        const translation = canvasPinTranslation(pitch, id === "explore-dots");
        if (current?.[1] !== -translation) map.setPaintProperty(id, property, [0, -translation]);
      }
    } finally {
      syncing = false;
    }
  };

  sync();
  draw();
  map.on("move", sync);
  map.on("sourcedata", sync);
  map.on("styledata", sync);
  map.on("render", draw);
  return () => {
    map.off("move", sync);
    map.off("sourcedata", sync);
    map.off("styledata", sync);
    map.off("render", draw);
    canvas.remove();
  };
}
