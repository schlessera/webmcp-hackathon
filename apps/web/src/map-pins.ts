import {
  MercatorCoordinate, type LngLatLike, type Map as MapLibreMap, type CustomLayerInterface,
  type DataDrivenPropertyValueSpecification, type TransitionSpecification,
} from "maplibre-gl";
import { MAP_THEME } from "./map-theme.ts";

// Every room pin reserves the space a label will need, before it has a name.
const PIN_HEIGHT = 42;
const EXPLORE_PIN_HEIGHT = 24;
// Include feet just outside the viewport when their elevated heads are visible.
export const PIN_QUERY_PADDING = PIN_HEIGHT * 4;

export function pinLift(pitch: number, explore = false): number {
  return (explore ? EXPLORE_PIN_HEIGHT : PIN_HEIGHT) *
    Math.sin(Math.max(0, Math.min(90, pitch)) * Math.PI / 180);
}

const PROJECTION_LAYER = "pin-projection";
type PinOpacity = "circle-opacity" | "circle-stroke-opacity" | "icon-opacity";
type SuppressedPaint = PinOpacity | `${PinOpacity}-transition`;
type SuppressedValue = DataDrivenPropertyValueSpecification<number> | TransitionSpecification | undefined;
const projectionMatrices = new WeakMap<MapLibreMap, ArrayLike<number>>();
const ringAngles = new WeakMap<MapLibreMap, number>();

export function setPinRingAngle(map: MapLibreMap, angle: number) {
  ringAngles.set(map, angle);
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

/** Raise only Z, using the same full-precision Mercator camera matrix as 3D
 * buildings. Moving X/Y toward the horizon would make the heads lean inward.
 * The altitude is zoom-normalized to keep these UI pins a readable size. */
export function canvasPinPoint(map: MapLibreMap, location: LngLatLike, explore = false) {
  const point = map.project(location);
  const matrix = projectionMatrices.get(map);
  if (!matrix || map.getPitch() === 0) return point;
  const coordinate = MercatorCoordinate.fromLngLat(location);
  // Retract continuously near 2D, including the otherwise-visible outward
  // displacement when looking straight down at an elevated point.
  const t = Math.min(1, Math.max(0, map.getPitch()) / 12);
  const altitude = (explore ? EXPLORE_PIN_HEIGHT : PIN_HEIGHT) * t * t * (3 - 2 * t);
  const z = altitude / (512 * 2 ** map.getZoom());
  const centerX = MercatorCoordinate.fromLngLat(map.getCenter()).x;
  const x = coordinate.x + Math.round(centerX - coordinate.x);
  const y = coordinate.y;
  const w = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];
  point.x = ((matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12]) / w + 1) * map.getCanvas().clientWidth / 2;
  point.y = (1 - (matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13]) / w) * map.getCanvas().clientHeight / 2;
  return point;
}

// Source points use MapLibre's tile precision. Reuse them when a canvas pin
// becomes a DOM label so high zoom cannot expose a rounding jump either.
const roomCoordinates = new WeakMap<MapLibreMap, Map<string, [number, number]>>();

export function roomPinPoint(map: MapLibreMap, candidateId: string, location: LngLatLike) {
  if (map.getPitch() === 0) return map.project(location);
  return canvasPinPoint(map, roomCoordinates.get(map)?.get(candidateId) ?? location);
}

/** Circle layers cannot take an altitude. In 3D, draw their evaluated styles
 * at the elevated camera projection, with needles on a separate canvas below
 * the heads. Keep the native layers for 2D, tiling, state/style evaluation and
 * queries. No features are re-tiled and React does not render camera frames. */
export function bindMapPins(map: MapLibreMap): () => void {
  const container = map.getContainer();
  const makeCanvas = (className: string) => {
    const canvas = document.createElement("canvas");
    canvas.className = className;
    canvas.setAttribute("aria-hidden", "true");
    map.getCanvasContainer().append(canvas);
    return canvas;
  };
  const canvas = makeCanvas("map-pin-needles");
  const headCanvas = makeCanvas("map-pin-heads");
  const drawing = canvas.getContext("2d")!;
  const headDrawing = headCanvas.getContext("2d")!;
  const suppressed = new Map<string, Map<SuppressedPaint, SuppressedValue>>();
  const restoring = new Map<string, Map<SuppressedPaint, SuppressedValue>>();
  let syncing = false;

  const draw = () => {
    const mapCanvas = map.getCanvas();
    for (const surface of [canvas, headCanvas]) {
      if (surface.width !== mapCanvas.width || surface.height !== mapCanvas.height) {
        surface.width = mapCanvas.width;
        surface.height = mapCanvas.height;
      }
    }
    drawing.clearRect(0, 0, canvas.width, canvas.height);
    headDrawing.clearRect(0, 0, headCanvas.width, headCanvas.height);
    if (map.getPitch() === 0 || !mapCanvas.clientWidth) return;
    const pixelRatio = canvas.width / mapCanvas.clientWidth;
    drawing.save();
    drawing.scale(pixelRatio, pixelRatio);
    drawing.fillStyle = MAP_THEME.pinNeedle.color;
    headDrawing.save();
    headDrawing.scale(pixelRatio, pixelRatio);
    const heads: Array<{ x: number; y: number; radius: number }> = [];
    const seen = new Set<string>();
    const layers = ["mark-dots", "explore-dots"].filter((id) => Boolean(map.getLayer(id)));
    // Queries return topmost first. Paint in the opposite order so the
    // existing status sort order still determines which head is on top.
    const features = map.queryRenderedFeatures([
      [-PIN_QUERY_PADDING, -PIN_QUERY_PADDING],
      [mapCanvas.clientWidth + PIN_QUERY_PADDING, mapCanvas.clientHeight + PIN_QUERY_PADDING],
    ], { layers });
    for (const feature of features.reverse()) {
      if (feature.geometry.type !== "Point" || feature.state.hidden) continue;
      const key = `${feature.source}:${feature.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const location = feature.geometry.coordinates as [number, number];
      const ground = map.project(location);
      const explore = feature.layer.id === "explore-dots";
      const head = canvasPinPoint(map, location, explore);
      const status = (feature.state.status ?? "works") as keyof typeof GL_MARK_RADIUS;
      const paint = feature.layer.paint as Record<string, unknown>;
      const fillRadius = Number(paint["circle-radius"]);
      const stroke = Number(paint["circle-stroke-width"]);
      const radius = Math.max(fillRadius + stroke, !explore && ["likely", "unlikely", "return"].includes(status) ? 9 : 0);
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
      headDrawing.globalAlpha = drawing.globalAlpha;
      headDrawing.fillStyle = String(paint["circle-color"]);
      headDrawing.beginPath();
      headDrawing.arc(head.x, head.y, fillRadius, 0, Math.PI * 2);
      headDrawing.fill();
      if (stroke > 0) {
        headDrawing.globalAlpha = 1;
        headDrawing.strokeStyle = String(paint["circle-stroke-color"]);
        headDrawing.lineWidth = stroke;
        headDrawing.beginPath();
        headDrawing.arc(head.x, head.y, fillRadius + stroke / 2, 0, Math.PI * 2);
        headDrawing.stroke();
      }
      if (!explore) {
        const ringColor = status === "out" ? MAP_THEME.marks.out :
          status === "unsure" || status === "unlikely" ? MAP_THEME.marks.unsure :
          status === "act" ? MAP_THEME.marks.act : MAP_THEME.marks.works;
        const ring = (size: number, dash: number[], angle = 0, sweep = Math.PI * 2) => {
          headDrawing.strokeStyle = ringColor;
          headDrawing.lineWidth = 1.5;
          headDrawing.lineCap = "round";
          headDrawing.setLineDash(dash);
          headDrawing.beginPath();
          headDrawing.arc(head.x, head.y, (size - 1.5) / 2 - 1, angle, angle + sweep);
          headDrawing.stroke();
          headDrawing.setLineDash([]);
        };
        headDrawing.globalAlpha = 1;
        if (["likely", "unlikely", "return"].includes(status)) ring(18, [3, 2.5]);
        const stage = feature.state.stage;
        if (stage) {
          headDrawing.globalAlpha = stage === "queued" ? 0.4 : 1;
          ring(28, stage === "processing" ? [] : [3.5, 3],
            stage === "queued" ? 0 : ringAngles.get(map) ?? 0,
            stage === "processing" ? Math.PI * 1.5 : Math.PI * 2);
        }
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
    headDrawing.restore();
  };

  const syncCoordinates = () => {
    const coordinates = new Map<string, [number, number]>();
    if (map.getSource("marks")) {
      for (const feature of map.querySourceFeatures("marks")) {
        if (feature.geometry.type === "Point") {
          coordinates.set(String(feature.id), feature.geometry.coordinates as [number, number]);
        }
      }
    }
    roomCoordinates.set(map, coordinates);
  };

  const syncMarkers = () => {
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
  };

  const restoreLayers = () => {
    for (const [id, properties] of suppressed) {
      if (!map.getLayer(id)) continue;
      const transitions = new Map<SuppressedPaint, SuppressedValue>();
      for (const [property, value] of properties) {
        if (property.endsWith("-transition")) transitions.set(property, value);
        else map.setPaintProperty(id, property, value);
      }
      restoring.set(id, transitions);
    }
    suppressed.clear();
  };

  const restoreTransitions = () => {
    // Render the first flat frame with zero-duration opacity restoration.
    // Restoring its 420ms duration in the same style update would fade the
    // native circles in from nothing after the elevated canvas disappears.
    for (const [id, properties] of restoring) {
      if (!map.getLayer(id)) continue;
      for (const [property, value] of properties) map.setPaintProperty(id, property, value);
    }
    restoring.clear();
  };

  const syncLayers = () => {
    if (syncing) return;
    syncing = true;
    try {
      const pitch = map.getPitch();
      const lift = pinLift(pitch);
      container.style.setProperty("--map-pin-lift", `${lift}px`);
      container.style.setProperty("--map-pin-visible", lift > 0 ? "1" : "0");
      if (pitch === 0) {
        restoreLayers();
        return;
      }
      for (const id of ["mark-dots", "explore-dots", "mark-dashes", "mark-busy", "mark-arc"]) {
        if (!map.getLayer(id)) continue;
        const properties = suppressed.get(id) ?? new Map<SuppressedPaint, SuppressedValue>();
        suppressed.set(id, properties);
        const opacityProperties: PinOpacity[] = id.endsWith("dots") ? ["circle-opacity", "circle-stroke-opacity"] : ["icon-opacity"];
        for (const property of opacityProperties) {
          const current = map.getPaintProperty(id, property);
          if (current === 0) continue;
          properties.set(property, current);
          const transition = `${property}-transition` as const;
          if (!properties.has(transition)) properties.set(transition,
            restoring.get(id)?.has(transition) ? restoring.get(id)!.get(transition) : map.getPaintProperty(id, transition));
          map.setPaintProperty(id, transition, { duration: 0 });
          map.setPaintProperty(id, property, 0);
        }
        restoring.delete(id);
      }
    } finally {
      syncing = false;
    }
  };

  const projection: CustomLayerInterface = {
    id: PROJECTION_LAYER,
    type: "custom",
    render(_gl, frame) {
      projectionMatrices.set(map, frame.defaultProjectionData.mainMatrix);
    },
  };
  const render = () => {
    syncMarkers();
    draw();
    restoreTransitions();
  };
  map.addLayer(projection);
  syncCoordinates();
  syncLayers();
  map.on("move", syncLayers);
  map.on("sourcedata", syncCoordinates);
  map.on("styledata", syncLayers);
  map.on("render", render);
  return () => {
    map.off("move", syncLayers);
    map.off("sourcedata", syncCoordinates);
    map.off("styledata", syncLayers);
    map.off("render", render);
    if (map.getLayer(PROJECTION_LAYER)) map.removeLayer(PROJECTION_LAYER);
    restoreLayers();
    restoreTransitions();
    projectionMatrices.delete(map);
    roomCoordinates.delete(map);
    canvas.remove();
    headCanvas.remove();
  };
}
