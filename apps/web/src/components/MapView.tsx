import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Layer, Map, Marker, Source, type MapRef } from "@vis.gl/react-maplibre";
import type { Map as MapLibreMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "../map-worker.ts";
import { MAP_THEME, TILE_STYLE } from "../map-theme.ts";
import { loadTileStyle, type TileStyle } from "../map-style.ts";
import { spatial } from "../spatial-store.ts";
import type {
  CandidateSummary,
  CommandEnvelope,
  ExplorePlace,
  ParticipantOrigin,
  ParticipantSummary,
  SharedPosition,
  SpatialContext,
} from "../spatial-types.ts";
import type { LookupReason, PipelineStage, PipelineView } from "../spatial-store.ts";
import { COPY, initials, numberWord, personColor, stillWorkVerb, tiltFor } from "../ui/copy.ts";
import { HoverCard } from "./HoverCard.tsx";

/**
 * The shared map.
 *
 * Two invariants govern this file:
 *
 * §8 — it NEVER re-centres as a result of a set change. The initial fit and
 * an explicit user action (opening a place, `focus_destination`) are the only
 * viewport moves. When the candidate set changes, places settle in place.
 *
 * §9 — position lives on the outer `.marker-sticker`, animation on the inner
 * `.sticker-box`. A CSS `animation` that sets `transform` would otherwise
 * overwrite the positioning translate and the sticker would jump to its
 * anchor point.
 */

/**
 * The marker vocabulary, in precedence order (first match wins):
 *   selected  — this viewer has it open
 *   settled   — the committed agreement (works fill: the room's own commit)
 *   staged    — the organizer staged it (act fill, "· staged")
 *   vetoed    — someone ruled it out; a veto stands (hollow act, struck name)
 *   proposed  — on the table (act fill, "· proposed")
 *   return    — would come back, while a brief row is held
 *   works / unsure / out — eligibility
 * Every state differs in fill, border style or size, never in colour alone.
 */
type MarkerState =
  | "works"
  | "unsure"
  | "likely"
  | "unlikely"
  | "out"
  | "selected"
  | "settled"
  | "staged"
  | "vetoed"
  | "proposed"
  | "return";

type GlStatus = "works" | "unsure" | "out" | "act" | "likely" | "unlikely" | "return";

const MARK_DASH_IMAGE = "spokes-mark-dash";
const MARK_BUSY_IMAGE = "spokes-mark-busy";
/** The processing stage: one 270° arc, no dash pattern (SPOKES-UI "dot stages"). */
const MARK_ARC_IMAGE = "spokes-mark-arc";
/** 2π · 6.5, the ring in the count block. */
const RING_CIRCUMFERENCE = 40.84;
const ARC_SWEEP = Math.PI * 1.5;
const DOM_MARKER_CAP = 60;
const MARK_SOURCE_MAX_ZOOM = 12;
const PLACE_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const GL_MARK_RADIUS = {
  out: 4,
  unsure: 8,
  unlikely: 6,
  likely: 5.5,
  return: 7,
  act: 9.5,
  works: 7.5,
} as const;

function displayPixelRatio(): number {
  if (typeof window === "undefined") return 1;
  return Math.min(3, Math.max(1, Math.round(window.devicePixelRatio || 1)));
}

function ringImageId(base: string, pixelRatio: number): string {
  return `${base}-${pixelRatio}x`;
}

function addRingImage(map: MapLibreMap, base: string, pixelRatio: number): void {
  const id = ringImageId(base, pixelRatio);
  if (map.hasImage(id)) return;
  const canvas = document.createElement("canvas");
  const busy = base === MARK_BUSY_IMAGE || base === MARK_ARC_IMAGE;
  map.addImage(
    id,
    ringImage(
      canvas,
      (busy ? 28 : 18) * pixelRatio,
      1.5 * pixelRatio,
      base === MARK_ARC_IMAGE
        ? []
        : busy
          ? [3.5 * pixelRatio, 3 * pixelRatio]
          : [3 * pixelRatio, 2.5 * pixelRatio],
      0,
      base === MARK_ARC_IMAGE ? ARC_SWEEP : Math.PI * 2,
    ),
    { sdf: true, pixelRatio },
  );
}

function addRingImages(map: MapLibreMap, pixelRatio: number): void {
  addRingImage(map, MARK_DASH_IMAGE, pixelRatio);
  addRingImage(map, MARK_BUSY_IMAGE, pixelRatio);
  addRingImage(map, MARK_ARC_IMAGE, pixelRatio);
}

/** Resolve any supported DPR synchronously, including after a display move. */
function resolveRingImage(map: MapLibreMap, id: string): void {
  for (const base of [MARK_DASH_IMAGE, MARK_BUSY_IMAGE, MARK_ARC_IMAGE]) {
    const match = id.match(new RegExp(`^${base}-([1-3])x$`));
    if (match) {
      addRingImage(map, base, Number(match[1]));
      return;
    }
  }
}

declare global {
  interface Window {
    __spokesMapStats?: () => {
      candidates: number;
      domMarkers: number;
      glFeatures: number;
      center: [number, number];
      zoom: number;
      busyAnimating: boolean;
      busyLayerMounted: boolean;
      arcLayerMounted: boolean;
      stages: { queued: number; fetching: number; processing: number };
      pipeline: { done: number; total: number; paused: "budget" | "idle" | null } | null;
      busyRepaints: number;
      mapRenders: number;
      ringPixelRatio: number;
      selectionDispatches: number;
      markRadii: typeof GL_MARK_RADIUS;
      focusNonce: number;
      settleDuration: number;
      transitionDuration: number;
      selected: string | null;
      glOnly: { candidateId: string; point: [number, number] } | null;
    };
  }
}

function glStatusOf(state: MarkerState): GlStatus {
  if (state === "staged" || state === "vetoed" || state === "proposed") return "act";
  if (state === "selected" || state === "settled") return "works";
  return state;
}

function sortKeyOf(state: MarkerState): number {
  switch (glStatusOf(state)) {
    case "out": return 0;
    case "unlikely": return 1;
    case "unsure": return 2;
    case "likely": return 3;
    case "return": return 4;
    case "act": return 5;
    case "works": return 6;
  }
}

function durationMs(value: string): number {
  const trimmed = value.trim();
  const amount = Number.parseFloat(trimmed);
  if (!Number.isFinite(amount)) return 0;
  return trimmed.endsWith("ms") ? amount : trimmed.endsWith("s") ? amount * 1000 : amount;
}

/** A monochrome alpha mask; MapLibre recolours it through SDF icon paint. */
function ringImage(
  canvas: HTMLCanvasElement,
  size: number,
  lineWidth: number,
  dash: number[],
  angle = 0,
  sweep = Math.PI * 2,
): ImageData {
  if (canvas.width !== size) canvas.width = size;
  if (canvas.height !== size) canvas.height = size;
  const drawing = canvas.getContext("2d");
  if (!drawing) return new ImageData(size, size);
  drawing.clearRect(0, 0, size, size);
  drawing.save();
  drawing.translate(size / 2, size / 2);
  drawing.rotate(angle);
  drawing.strokeStyle = MAP_THEME.marks.surface;
  drawing.lineWidth = lineWidth;
  drawing.lineCap = "round";
  drawing.setLineDash(dash);
  drawing.beginPath();
  drawing.arc(0, 0, (size - lineWidth) / 2 - 1, 0, sweep);
  drawing.stroke();
  drawing.restore();
  return drawing.getImageData(0, 0, size, size);
}

const STATE_LABEL: Record<MarkerState, string> = {
  works: "still works",
  likely: "likely works",
  unsure: "not yet known",
  unlikely: "unlikely to work",
  out: "ruled out",
  selected: "open",
  settled: "settled",
  staged: "staged",
  vetoed: "on the table, a veto stands",
  proposed: "on the table",
  return: "would come back",
};

interface Props {
  context: SpatialContext;
  /** The set as it would be without one need, while a brief row is held. */
  preview: SpatialContext | null;
  selectedId: string | null;
  focusNonce: number;
  /** A centre requested through this viewer's command path, if any. */
  localScopeCenterKey: string | null;
  committedId: string | null;
  /** A wider radius an agent has asked for, drawn as a second faint ring. */
  proposedRadiusM: number | null;
  /** participantId -> candidateId: who has which place open right now. */
  viewing: Record<string, string>;
  /** Opted-in live positions from the presence channel, never labels. */
  positions: Record<string, SharedPosition>;
  participants: ParticipantSummary[];
  meId: string;
  /** Places the server is looking up right now: a busy ring on each. */
  busy: ReadonlySet<string>;
  busyReason: LookupReason | null;
  /** Per-place pipeline stage (queued / fetching / processing); a busy place
   * without one reads as fetching. */
  stages: Record<string, PipelineStage>;
  /** The room's pipeline volume for the active needs; null until a frame. */
  pipeline: PipelineView | null;
  /** Needs this page said that have not settled yet. */
  pendingCount: number;
  roomId: string;
  isOrganizer: boolean;
  explore: ReadonlyMap<string, ExplorePlace>;
  /** The viewer's own application-private starting point. */
  origin?: ParticipantOrigin;
  originEditing: boolean;
  onSetOrigin(position: { lat: number; lng: number }): Promise<boolean>;
  run(type: string, input: Record<string, unknown>): Promise<CommandEnvelope>;
  onSelect(candidateId: string | null): void;
  /** The place under the pointer or keyboard focus (a dot or a card), or
   * null when it leaves — a prefetch hint, never sent for GL dots merely
   * under the pointer during a drag. */
  onPreview(candidateId: string | null): void;
}

/** GeoJSON circle polygon (64 segments) around a lat/lng centre. */
function circlePolygon(center: { lat: number; lng: number }, radiusM: number) {
  const points: [number, number][] = [];
  const latR = radiusM / 111320;
  const lngR = radiusM / (111320 * Math.cos((center.lat * Math.PI) / 180));
  for (let i = 0; i <= 64; i += 1) {
    const angle = (i / 64) * 2 * Math.PI;
    points.push([
      center.lng + lngR * Math.cos(angle),
      center.lat + latR * Math.sin(angle),
    ]);
  }
  return {
    type: "Feature" as const,
    properties: {},
    geometry: { type: "Polygon" as const, coordinates: [points] },
  };
}

/**
 * Which places may carry a name.
 *
 * Real geography puts far more eligible places in frame than the authored
 * mockup ever drew — 31 name cards in a 380px band bury each other, and a
 * buried sticker is an unreachable place. So names are placed greedily in
 * priority order and only where the card does not collide with one already
 * placed; everything else falls back to the "works dot" that is already part
 * of the pin vocabulary. Nothing is hidden: every place still has a mark on
 * the map, in its own state's colour, size and border style, and tapping it
 * opens it.
 */
const NAME_CAP = 18;
const NAME_FLOOR = 6;
/* Who gets a name, in order (user decision, 2026-09-03): a place someone has
   open → accepted → on the table → confirmed → likely → being looked up →
   not yet known → unlikely → ruled out. Every in-scope place is now
   nameable; the lower ranks simply almost never win a slot. */
const RANK_OPEN = 0;
const RANK_ACCEPTED = 1;
const RANK_PROPOSED = 2;
const RANK_YES = 3;
const RANK_LIKELY = 4;
const RANK_BUSY = 5;
const RANK_UNKNOWN = 6;
const RANK_UNLIKELY = 7;
const RANK_NO = 8;
/* The distance from the card edge to its dot centre. CSS receives this as a
   custom property, so placement maths, positioning and transform origins all
   use the same anchor. State-specific padding keeps every dot on this value. */
const STICKER_ANCHOR_PX = 14;
/* The collision box is the drawn card plus the height its ±3° tilt adds, so
   two accepted names can sit shoulder to shoulder but never on top of each
   other. Widths are estimated rather than measured: measuring would need the
   cards laid out first, and the whole point is to decide before drawing. */
const STICKER_H = 38;
const STICKER_SLACK = 1;
/* Half a dot plus a little air: how close a card may come to another dot. */
const DOT_CLEARANCE = 10;
/* A tap this close to a dot (in px) belongs to that dot, whatever box is on top. */
const TAP_REACH = 22;
const COLLOCATED_OFFSET = 6;
/** Two places this close on the ground share a spot on any zoom the room uses. */
const COLLOCATED_METRES = 12;

function metresBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Rough drawn width of a sticker: dot + name at ~6.6px/char + optional chip. */
function stickerWidth(name: string, hasChip: boolean): number {
  return 44 + name.length * 6.6 + (hasChip ? 40 : 0);
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function distanceMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const y = (a.lat - b.lat) * 111_320;
  const x =
    (a.lng - b.lng) *
    111_320 *
    Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  return Math.hypot(x, y);
}

export function MapView({
  context,
  preview,
  selectedId,
  focusNonce,
  localScopeCenterKey,
  committedId,
  proposedRadiusM,
  viewing,
  positions,
  participants,
  meId,
  busy,
  busyReason,
  stages,
  pipeline,
  pendingCount,
  roomId,
  isOrganizer,
  explore,
  origin,
  originEditing,
  onSetOrigin,
  run,
  onSelect,
  onPreview,
}: Props) {
  const mapRef = useRef<MapRef>(null);
  const { scope, candidates, proposals } = context;
  const referentMarks = context.activeNeeds.filter(
    (need) => need.active && need.referent?.location,
  );
  const center = scope.area.center;
  const selectedIdRef = useRef(selectedId);
  const candidatesRef = useRef(candidates);
  const onSelectRef = useRef(onSelect);
  const selectionDispatches = useRef(0);
  selectedIdRef.current = selectedId;
  candidatesRef.current = candidates;
  // Hover card: which place a fine pointer rests on (or keyboard focus sits
  // on), and where its dot is inside the band. Only places with an image.
  const [hover, setHover] = useState<{ id: string; x: number; y: number } | null>(null);
  const hoverTimer = useRef<number | null>(null);
  const finePointer = useMemo(
    () => typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(pointer: fine)").matches
      : false,
    [],
  );
  const clearHover = useCallback(() => {
    if (hoverTimer.current !== null) {
      window.clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
    setHover((h) => (h ? null : h));
  }, []);
  /** Show after 120 ms so a cursor crossing dots does not flicker cards. */
  const scheduleHover = useCallback((id: string, x: number, y: number) => {
    if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => {
      hoverTimer.current = null;
      setHover({ id, x, y });
    }, 120);
  }, []);
  /** Where a place's dot is inside the band, from the map projection. */
  const bandPointOf = useCallback((candidateId: string): { x: number; y: number } | null => {
    const map = mapRef.current;
    const c = candidates.find((cand) => cand.candidateId === candidateId);
    if (!map || !c) return null;
    const p = map.project([c.location.lng, c.location.lat]);
    return { x: p.x, y: p.y };
  }, [candidates]);
  const hoverableId = useCallback(
    (candidateId: string | null): string | null =>
      candidateId && candidates.some((c) => c.candidateId === candidateId && c.image)
        ? candidateId
        : null,
    [candidates],
  );
  const hoverFor = useCallback((candidateId: string | null) => {
    const id = hoverableId(candidateId);
    if (!id) {
      clearHover();
      return;
    }
    const point = bandPointOf(id);
    if (!point) return;
    scheduleHover(id, point.x, point.y);
  }, [bandPointOf, clearHover, hoverableId, scheduleHover]);
  useEffect(() => () => {
    if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
  }, []);
  onSelectRef.current = onSelect;
  const dispatchSelect = useCallback((candidateId: string | null) => {
    selectionDispatches.current += 1;
    onSelectRef.current(candidateId);
  }, []);

  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === "undefined" ? 1024 : window.innerWidth,
  );
  const [ringPixelRatio, setRingPixelRatio] = useState(displayPixelRatio);
  useEffect(() => {
    let resolution: MediaQueryList | null = null;
    const updatePixelRatio = () => {
      const next = displayPixelRatio();
      const map = mapRef.current?.getMap();
      if (map) addRingImages(map, next);
      setRingPixelRatio(next);
    };
    const onResize = () => {
      setViewportWidth(window.innerWidth);
      updatePixelRatio();
    };
    const onResolutionChange = () => {
      resolution?.removeEventListener("change", onResolutionChange);
      updatePixelRatio();
      resolution = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      resolution.addEventListener("change", onResolutionChange);
    };
    resolution = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    resolution.addEventListener("change", onResolutionChange);
    window.addEventListener("resize", onResize);
    return () => {
      resolution?.removeEventListener("change", onResolutionChange);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  /* Label placement is screen-space, so it is re-resolved when the user has
     finished moving the map — never mid-gesture, and never as a result of a
     set change moving the viewport, because a set change never does (§8). */
  const [viewTick, setViewTick] = useState(0);
  /** True once the basemap has loaded and the first fit has run — the moment
   * marker positions stop moving on their own. The e2e specs wait on it. */
  const [loaded, setLoaded] = useState(false);
  const [motion, setMotion] = useState({ reduced: false, settleMs: 420, busyMs: 3200 });
  /* Screen readers hear the refinement line at most every 10 s, never on
     every frame (SPOKES-UI "Refinement"). */
  const [refineAnnouncement, setRefineAnnouncement] = useState("");
  const refineAnnouncedAt = useRef(0);
  const busyAnimating = useRef(false);
  const busyFrame = useRef<number | null>(null);
  const busyRepaints = useRef(0);
  const mapRenders = useRef(0);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  /** The displayed stage of a place: the frame's word, else fetching while busy. */
  const stageOf = useCallback(
    (id: string): PipelineStage | null => stages[id] ?? (busy.has(id) ? "fetching" : null),
    [stages, busy],
  );
  const stageOfRef = useRef(stageOf);
  stageOfRef.current = stageOf;
  const pipelineRef = useRef(pipeline);
  pipelineRef.current = pipeline;
  /** Any place whose ring turns (queued rings stand still). */
  const turning = useMemo(
    () => [...busy].some((id) => stageOf(id) !== "queued"),
    [busy, stageOf],
  );
  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const readMotion = () => {
      const root = getComputedStyle(document.documentElement);
      setMotion({
        reduced: preference.matches,
        settleMs: durationMs(root.getPropertyValue("--spoke-dur-settle")),
        busyMs: durationMs(root.getPropertyValue("--spoke-dur-busy")),
      });
    };
    readMotion();
    preference.addEventListener("change", readMotion);
    return () => preference.removeEventListener("change", readMotion);
  }, []);
  // The basemap style, patched once (map-style.ts) so the console stays
  // quiet in production; the URL itself is the fallback.
  const [tileStyle, setTileStyle] = useState<TileStyle | null>(null);
  useEffect(() => {
    let live = true;
    void loadTileStyle(TILE_STYLE).then((style) => {
      if (live) setTileStyle(style);
    });
    return () => {
      live = false;
    };
  }, []);
  const [scopeOffscreen, setScopeOffscreen] = useState(false);
  const [panned, setPanned] = useState(false);
  const [selectedExploreRef, setSelectedExploreRef] = useState<string | null>(null);
  const [exploreAnnouncement, setExploreAnnouncement] = useState("");
  const [addingExplore, setAddingExplore] = useState(false);
  const [originDraft, setOriginDraft] = useState<{ lat: number; lng: number } | null>(
    origin ? { lat: origin.lat, lng: origin.lng } : null,
  );
  useEffect(() => {
    setOriginDraft(origin ? { lat: origin.lat, lng: origin.lng } : null);
  }, [origin?.lat, origin?.lng, origin?.updatedAt]);
  const displayedOrigin = originDraft ?? origin ?? null;

  const nudgeOrigin = (key: string) => {
    if (!originEditing || !displayedOrigin) return;
    const latStep = 10 / 111_320;
    const lngStep = 10 / (111_320 * Math.cos((displayedOrigin.lat * Math.PI) / 180));
    const next = {
      lat: displayedOrigin.lat + (key === "ArrowUp" ? latStep : key === "ArrowDown" ? -latStep : 0),
      lng: displayedOrigin.lng + (key === "ArrowRight" ? lngStep : key === "ArrowLeft" ? -lngStep : 0),
    };
    setOriginDraft(next);
    void onSetOrigin(next);
  };
  const originAtPointer = useCallback((clientX: number, clientY: number) => {
    const map = mapRef.current?.getMap();
    if (!map) return null;
    const bounds = map.getContainer().getBoundingClientRect();
    const point = map.unproject([clientX - bounds.left, clientY - bounds.top]);
    return { lat: point.lat, lng: point.lng };
  }, []);
  const originMarkerRef = useRef<HTMLDivElement | null>(null);
  const originDragCleanupRef = useRef<() => void>(() => undefined);
  const originEditingRef = useRef(originEditing);
  const onSetOriginRef = useRef(onSetOrigin);
  originEditingRef.current = originEditing;
  onSetOriginRef.current = onSetOrigin;
  const beginOriginDrag = useCallback((event: MouseEvent) => {
    if (!originEditingRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    originDragCleanupRef.current();
    let moved = false;
    const move = (moveEvent: MouseEvent) => {
      const position = originAtPointer(moveEvent.clientX, moveEvent.clientY);
      if (!position) return;
      moved = true;
      setOriginDraft(position);
    };
    const cleanup = () => {
      window.removeEventListener("mousemove", move, true);
      window.removeEventListener("mouseup", end as EventListener, true);
      window.removeEventListener("pointerup", end as EventListener, true);
    };
    const end = (upEvent: MouseEvent | PointerEvent) => {
      cleanup();
      originDragCleanupRef.current = () => undefined;
      const position = originAtPointer(upEvent.clientX, upEvent.clientY);
      if (!moved || !position) return;
      setOriginDraft(position);
      void onSetOriginRef.current(position);
    };
    window.addEventListener("mousemove", move, true);
    window.addEventListener("mouseup", end as EventListener, true);
    window.addEventListener("pointerup", end as EventListener, true);
    originDragCleanupRef.current = cleanup;
  }, [originAtPointer]);
  const attachOriginMarker = useCallback((marker: HTMLDivElement | null) => {
    const previous = originMarkerRef.current;
    if (previous) {
      previous.removeEventListener("mousedown", beginOriginDrag);
    }
    if (!marker) originDragCleanupRef.current();
    originMarkerRef.current = marker;
    if (marker) {
      marker.addEventListener("mousedown", beginOriginDrag);
    }
  }, [beginOriginDrag]);
  const exploreActionRef = useRef<HTMLButtonElement>(null);
  const focusExploreAction = useRef(false);
  const ownScopeCenter = useRef<string | null>(null);
  const exploreTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastExploreView = useRef<{
    center: { lat: number; lng: number };
    width: number;
    height: number;
    zoom: number;
  } | null>(null);

  useEffect(() => {
    lastExploreView.current = null;
    setSelectedExploreRef(null);
  }, [roomId]);
  useEffect(
    () => () => {
      if (exploreTimer.current) clearTimeout(exploreTimer.current);
    },
    [],
  );

  const ring = useMemo(
    () => circlePolygon(center, scope.area.radiusM),
    [center.lat, center.lng, scope.area.radiusM],
  );
  const proposedRing = useMemo(
    () => (proposedRadiusM ? circlePolygon(center, proposedRadiusM) : null),
    [center.lat, center.lng, proposedRadiusM],
  );

  /* Inverse of the scope circle: the world with the search area punched out,
     so everything beyond the current range reads dimmed at 8%. */
  const outsideMask = useMemo(
    () => ({
      type: "Feature" as const,
      properties: {},
      geometry: {
        type: "Polygon" as const,
        coordinates: [
          [
            [-180, -85],
            [180, -85],
            [180, 85],
            [-180, 85],
            [-180, -85],
          ] as [number, number][],
          ring.geometry.coordinates[0],
        ],
      },
    }),
    [ring],
  );

  /* The only automatic viewport move is the first fit on load. A later scope
     centre change refits only when this viewer pressed Search here; a peer's
     shared action updates the ring in place without taking over this map. */
  const fitOnce = () => {
    const latR = scope.area.radiusM / 111320;
    const lngR =
      scope.area.radiusM / (111320 * Math.cos((center.lat * Math.PI) / 180));
    mapRef.current?.fitBounds(
      [
        [center.lng - lngR, center.lat - latR],
        [center.lng + lngR, center.lat + latR],
      ],
      { padding: 34, duration: 0 },
    );
  };

  const centerKey = `${center.lat},${center.lng}`;
  const fittedCenter = useRef(centerKey);
  useEffect(() => {
    if (fittedCenter.current === centerKey) {
      if (ownScopeCenter.current === centerKey) ownScopeCenter.current = null;
      if (localScopeCenterKey === centerKey) spatial.clearLocalScopeCenter(centerKey);
      return;
    }
    fittedCenter.current = centerKey;
    if (
      ownScopeCenter.current === centerKey ||
      localScopeCenterKey === centerKey
    ) {
      ownScopeCenter.current = null;
      spatial.clearLocalScopeCenter(centerKey);
      fitOnce();
    }
  }, [centerKey, localScopeCenterKey]);

  /* Explicit `focus_destination` ("show me") actions only. Opening a place
     from any map mark changes the panel without moving the viewport. */
  useEffect(() => {
    if (focusNonce === 0) return;
    let focusFrame: number | null = null;
    const layoutFrame = requestAnimationFrame(() => {
      focusFrame = requestAnimationFrame(() => {
        const focusedId = selectedIdRef.current;
        const c = candidatesRef.current.find((candidate) => candidate.candidateId === focusedId);
        if (!c) return;
        mapRef.current?.flyTo({
          center: [c.location.lng, c.location.lat],
          zoom: Math.max(mapRef.current?.getZoom() ?? 14, 15),
          duration: 600,
        });
      });
    });
    return () => {
      cancelAnimationFrame(layoutFrame);
      if (focusFrame !== null) cancelAnimationFrame(focusFrame);
    };
  }, [focusNonce]);

  /* Dense clusters: 44px tap boxes overlap long before dots do, and z-order
     alone would hand every tap in an overlap to the topmost box. A tap goes
     to the place whose dot is nearest the finger, so every dot's own pixels
     reach it (§13) without moving, resizing or clustering anything (§8). */
  const nearestTo = (clientX: number, clientY: number): string | null => {
    const map = mapRef.current;
    if (!map) return null;
    const rect = map.getContainer().getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    let best: string | null = null;
    let bestD = Infinity;
    for (const c of candidates) {
      let p: { x: number; y: number };
      try {
        p = map.project([c.location.lng, c.location.lat]);
      } catch {
        continue;
      }
      const offset = collisionOffsets.get(c.candidateId) ?? [0, 0];
      const d = (p.x + offset[0] - x) ** 2 + (p.y + offset[1] - y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = c.candidateId;
      }
    }
    return bestD <= TAP_REACH * TAP_REACH ? best : null;
  };

  const cardAt = (clientX: number, clientY: number): string | null => {
    let best: { candidateId: string; zIndex: number } | null = null;
    const cards = document.querySelectorAll<HTMLElement>(
      '.marker[data-named="true"] .sticker-box',
    );
    for (const card of cards) {
      const rect = card.getBoundingClientRect();
      if (
        clientX < rect.left ||
        clientX > rect.right ||
        clientY < rect.top ||
        clientY > rect.bottom
      ) continue;
      const marker = card.closest<HTMLElement>(".marker");
      const wrapper = marker?.closest<HTMLElement>(".maplibregl-marker");
      const candidateId = marker?.dataset.candidateId;
      if (!candidateId || !wrapper) continue;
      const zIndex = Number.parseInt(getComputedStyle(wrapper).zIndex, 10) || 0;
      if (!best || zIndex > best.zIndex) best = { candidateId, zIndex };
    }
    return best?.candidateId ?? null;
  };

  /* One proposal state per place: staged beats vetoed beats open. A veto is
     drawn while it stands, whether the proposal row says "vetoed" or an
     "open" one carries a standing reject. */
  const proposalByCandidate = useMemo(() => {
    const map = new globalThis.Map<string, "staged" | "vetoed" | "open">();
    const rank = { staged: 3, vetoed: 2, open: 1 } as const;
    for (const p of proposals) {
      const state =
        p.status === "staged"
          ? "staged"
          : p.status === "vetoed" || (p.status === "open" && p.vetoStands)
            ? "vetoed"
            : p.status === "open"
              ? "open"
              : null;
      if (!state) continue;
      const prev = map.get(p.candidateId);
      if (!prev || rank[state] > rank[prev]) map.set(p.candidateId, state);
    }
    return map;
  }, [proposals]);

  /* Only open and staged proposals remain on the table. An open proposal may
     carry a standing veto and still qualify; a terminal veto or withdrawal
     keeps its marker vocabulary but falls back to ordinary eligibility for
     whether it may carry a name. */
  const proposalOnTable = useMemo(() => {
    const ids = new Set<string>();
    for (const proposal of proposals) {
      if (proposal.status === "open" || proposal.status === "staged") {
        ids.add(proposal.candidateId);
      }
    }
    return ids;
  }, [proposals]);

  /* Peers with this place open, in roster order, never the viewer. */
  const viewersOf = useMemo(() => {
    const map = new globalThis.Map<string, Array<{ p: ParticipantSummary; index: number }>>();
    participants.forEach((p, index) => {
      if (p.participantId === meId) return;
      const cid = viewing[p.participantId];
      if (!cid) return;
      const list = map.get(cid) ?? [];
      list.push({ p, index });
      map.set(cid, list);
    });
    return map;
  }, [viewing, participants, meId]);

  const sharedPeople = useMemo(() => {
    const out: Array<{
      position: SharedPosition;
      participant: ParticipantSummary;
      index: number;
    }> = [];
    participants.forEach((participant, index) => {
      if (participant.participantId === meId) return;
      const position = positions[participant.participantId];
      if (position) out.push({ position, participant, index });
    });
    return out;
  }, [positions, participants, meId]);

  /* While a brief row is held, the drawn set is the previewed one, and the
     places the held need was removing breathe back in as dashed stickers. */
  const previewEligible = useMemo(() => {
    if (!preview) return null;
    const set = new Set<string>();
    for (const c of preview.candidates) {
      if (c.eligibility === "eligible") set.add(c.candidateId);
    }
    return set;
  }, [preview]);

  const liveEligible = useMemo(() => {
    const set = new Set<string>();
    for (const c of candidates) {
      if (c.eligibility === "eligible") set.add(c.candidateId);
    }
    return set;
  }, [candidates]);

  const markerStates = useMemo(() => {
    const states = new globalThis.Map<string, MarkerState>();
    const previewById = new globalThis.Map(
      (preview?.candidates ?? []).map((candidate) => [candidate.candidateId, candidate]),
    );
    for (const candidate of candidates) {
      let state: MarkerState;
      if (candidate.candidateId === selectedId) state = "selected";
      else if (candidate.candidateId === committedId) state = "settled";
      else {
        const proposal = proposalByCandidate.get(candidate.candidateId);
        if (proposal === "staged") state = "staged";
        else if (proposal === "vetoed") state = "vetoed";
        else if (proposal === "open") state = "proposed";
        else if (preview && previewEligible) {
          if (previewEligible.has(candidate.candidateId)) {
            state = liveEligible.has(candidate.candidateId) ? "works" : "return";
          } else {
            const eligibility = previewById.get(candidate.candidateId)?.eligibility;
            state =
              eligibility === "uncertain"
                ? "unsure"
                : eligibility === "likely"
                  ? "likely"
                  : eligibility === "unlikely"
                    ? "unlikely"
                    : "out";
          }
        } else {
          state =
            candidate.eligibility === "eligible"
              ? "works"
              : candidate.eligibility === "likely"
                ? "likely"
                : candidate.eligibility === "uncertain"
                  ? "unsure"
                  : candidate.eligibility === "unlikely"
                    ? "unlikely"
                    : "out";
        }
      }
      states.set(candidate.candidateId, state);
    }
    return states;
  }, [candidates, selectedId, committedId, proposalByCandidate, preview, previewEligible, liveEligible]);

  const stateOf = (candidate: CandidateSummary): MarkerState =>
    markerStates.get(candidate.candidateId) ?? "out";

  const domCandidates = useMemo(() => {
    const priority = (candidate: CandidateSummary) => {
      if (candidate.candidateId === selectedId || candidate.candidateId === committedId) return 0;
      if (proposalByCandidate.has(candidate.candidateId)) return 1;
      if (viewersOf.has(candidate.candidateId)) return 2;
      return 3;
    };
    const stateRank: Record<MarkerState, number> = {
      selected: 0,
      settled: 0,
      staged: 0,
      vetoed: 0,
      proposed: 0,
      return: 1,
      works: 2,
      likely: 3,
      unsure: 4,
      unlikely: 5,
      out: 6,
    };
    return [...candidates]
      .sort(
        (a, b) =>
          priority(a) - priority(b) ||
          stateRank[stateOf(a)] - stateRank[stateOf(b)] ||
          a.walkMin - b.walkMin ||
          (a.ref ?? a.candidateId).localeCompare(b.ref ?? b.candidateId),
      )
      .slice(0, DOM_MARKER_CAP);
  }, [candidates, selectedId, committedId, proposalByCandidate, viewersOf, markerStates]);
  const domCandidateIds = useMemo(
    () => new Set(domCandidates.map((candidate) => candidate.candidateId)),
    [domCandidates],
  );

  /* Places that share a spot — the same coordinate, or a few metres apart
     (a food hall, two counters in one station) — fan out by a fixed few
     pixels so each DOM dot keeps its own pixels (§13). The GL pool remains
     anchored to geography; this collision pass is bounded to sixty. */
  const collisionOffsets = useMemo(() => {
    const keyOf = (candidate: CandidateSummary) => candidate.ref ?? candidate.candidateId;
    const sorted = [...domCandidates].sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
    const groups: CandidateSummary[][] = [];
    for (const candidate of sorted) {
      const group = groups.find(
        (members) => metresBetween(members[0].location, candidate.location) <= COLLOCATED_METRES,
      );
      if (group) group.push(candidate);
      else groups.push([candidate]);
    }
    const offsets = new globalThis.Map<string, [number, number]>();
    for (const group of groups) {
      if (group.length === 1) {
        offsets.set(group[0].candidateId, [0, 0]);
        continue;
      }
      group.sort(
        (a, b) =>
          stableHash(a.ref ?? a.candidateId) - stableHash(b.ref ?? b.candidateId) ||
          (a.ref ?? a.candidateId).localeCompare(b.ref ?? b.candidateId),
      );
      const start = ((stableHash(group[0].ref ?? group[0].candidateId) % 360) * Math.PI) / 180;
      group.forEach((candidate, index) => {
        const angle = start + (index / group.length) * 2 * Math.PI;
        offsets.set(candidate.candidateId, [
          Math.cos(angle) * COLLOCATED_OFFSET,
          Math.sin(angle) * COLLOCATED_OFFSET,
        ]);
      });
    }
    return offsets;
  }, [domCandidates]);

  /* The busy set ticks with every pipeline frame. Key the placement pass on
     its *content* so two identical states never reshuffle the names. */
  const lookupKey = useMemo(
    () => [...new Set([...busy, ...Object.keys(stages)])].sort().join(","),
    [busy, stages],
  );

  const named = useMemo(() => {
    const map = mapRef.current;
    const lookingUp = new Set(lookupKey === "" ? [] : lookupKey.split(","));
    const placements = new globalThis.Map<string, "left" | "right">();
    const previewById = new globalThis.Map(
      (preview?.candidates ?? []).map((candidate) => [candidate.candidateId, candidate]),
    );
    /* A place this viewer has open, or that a peer is looking at, sorts first:
       the card is what the panel and the presence badge hang off. Then the
       decision states, then the evidence. An open proposal carrying a
       standing veto is still on the table and keeps its card; a terminally
       vetoed or withdrawn one falls through to its eligibility. */
    const tierOf = (candidate: CandidateSummary): number | null => {
      if (distanceMeters(center, candidate.location) > scope.area.radiusM + 1) return null;
      const id = candidate.candidateId;
      if (id === selectedId || viewersOf.has(id)) return RANK_OPEN;
      if (id === committedId || proposalByCandidate.get(id) === "staged") return RANK_ACCEPTED;
      if (proposalOnTable.has(id)) return RANK_PROPOSED;
      const eligibility = previewById.get(id)?.eligibility ?? candidate.eligibility;
      const byEvidence =
        eligibility === "eligible"
          ? RANK_YES
          : eligibility === "likely"
            ? RANK_LIKELY
            : eligibility === "uncertain"
              ? RANK_UNKNOWN
              : eligibility === "unlikely"
                ? RANK_UNLIKELY
                : RANK_NO;
      /* A lookup in flight outranks the evidence it has not returned yet, and
         never demotes a place that already clears every need: busy is a
         floor, not a demotion. */
      return Math.min(byEvidence, lookingUp.has(id) ? RANK_BUSY : RANK_NO);
    };
    const candidatesByTier = domCandidates
      .filter((candidate) => tierOf(candidate) !== null)
      .sort(
        (a, b) =>
          tierOf(a)! - tierOf(b)! ||
          a.walkMin - b.walkMin ||
          (a.ref ?? a.candidateId).localeCompare(b.ref ?? b.candidateId),
      );

    if (!map) {
      for (const c of candidatesByTier.slice(0, NAME_CAP)) {
        placements.set(c.candidateId, "left");
      }
      return placements;
    }

    // Every place's dot, so a card is refused where it would bury a
    // neighbour's dot — a buried dot is an unreachable place (§13).
    const dots: Array<{ id: string; x: number; y: number }> = [];
    for (const c of domCandidates) {
      try {
        const p = map.project([c.location.lng, c.location.lat]);
        const offset = collisionOffsets.get(c.candidateId) ?? [0, 0];
        dots.push({ id: c.candidateId, x: p.x + offset[0], y: p.y + offset[1] });
      } catch {
        /* off the projectable world; nothing to protect */
      }
    }
    // Within each semantic priority, choose the point farthest from names
    // already considered. This keeps the map readable across the viewport
    // instead of spending every name on the nearest dense block.
    const points = new globalThis.Map(dots.map((dot) => [dot.id, dot]));
    const ordered: CandidateSummary[] = [];
    for (let tier = RANK_OPEN; tier <= RANK_NO; tier += 1) {
      const remaining = candidatesByTier.filter((candidate) => tierOf(candidate) === tier);
      while (remaining.length > 0) {
        let bestIndex = 0;
        let bestDistance = -1;
        for (let i = 0; i < remaining.length; i += 1) {
          const point = points.get(remaining[i].candidateId);
          if (!point) continue;
          const nearest = ordered.reduce((distance, chosen) => {
            const other = points.get(chosen.candidateId);
            return other
              ? Math.min(distance, (point.x - other.x) ** 2 + (point.y - other.y) ** 2)
              : distance;
          }, Number.POSITIVE_INFINITY);
          if (nearest > bestDistance) {
            bestDistance = nearest;
            bestIndex = i;
          }
        }
        ordered.push(remaining.splice(bestIndex, 1)[0]);
      }
    }

    const width = map.getContainer().clientWidth;
    const height = map.getContainer().clientHeight;
    const placed: Array<{ x: number; y: number; w: number }> = [];
    const tryPlace = (c: CandidateSummary, protectDots: boolean) => {
      const own = dots.find((d) => d.id === c.candidateId);
      if (!own || own.x < 0 || own.x > width || own.y < STICKER_H / 2 || own.y > height - STICKER_H / 2) {
        return false;
      }
      const point = own;
      const w = stickerWidth(c.name, true) * STICKER_SLACK;
      const preferred: Array<"left" | "right"> =
        point.x + w - STICKER_ANCHOR_PX > width ? ["right", "left"] : ["left", "right"];
      for (const side of preferred) {
        const left =
          side === "left"
            ? point.x - STICKER_ANCHOR_PX
            : point.x + STICKER_ANCHOR_PX - w;
        if (left < 4 || left + w > width - 4) continue;
        const collides = placed.some(
          (p) =>
            Math.abs(p.y - point.y) < STICKER_H &&
            left < p.x + p.w &&
            p.x < left + w,
        );
        if (collides) continue;
        const buries =
          protectDots &&
          // A place someone selected, settled or put on the table may bury a
          // neighbour's dot; merely looking at one does not earn that.
          !(
            c.candidateId === selectedId ||
            c.candidateId === committedId ||
            proposalOnTable.has(c.candidateId)
          ) &&
          dots.some(
            (d) =>
              d.id !== c.candidateId &&
              Math.abs(d.y - point.y) < STICKER_H / 2 + DOT_CLEARANCE &&
              d.x > left + DOT_CLEARANCE &&
              d.x < left + w + DOT_CLEARANCE,
          );
        if (buries) continue;
        placed.push({ x: left, y: point.y, w });
        placements.set(c.candidateId, side);
        return true;
      }
      return false;
    };

    for (const candidate of ordered) {
      if (placements.size >= NAME_CAP) break;
      tryPlace(candidate, true);
    }
    // Preserve dot clearance where possible, but do not repeat W1's zero-name
    // map when six non-overlapping cards actually fit.
    if (placements.size < NAME_FLOOR) {
      for (const candidate of ordered) {
        if (placements.size >= NAME_FLOOR || placements.size >= NAME_CAP) break;
        if (!placements.has(candidate.candidateId)) tryPlace(candidate, false);
      }
    }
    // In an exceptionally dense block, dot protection and card collision can
    // still consume every slot. The farthest-point order is the final safety
    // net: keep six identities visible when their cards fit inside the band,
    // accepting a little overlap rather than returning to an anonymous map.
    if (placements.size < NAME_FLOOR) {
      for (const candidate of ordered) {
        if (placements.size >= NAME_FLOOR) break;
        if (placements.has(candidate.candidateId)) continue;
        const point = points.get(candidate.candidateId);
        if (!point || point.y < STICKER_H / 2 || point.y > height - STICKER_H / 2) continue;
        const w = stickerWidth(candidate.name, true) * STICKER_SLACK;
        const side =
          point.x + w - STICKER_ANCHOR_PX <= width - 4 ? "left" : "right";
        const left =
          side === "left"
            ? point.x - STICKER_ANCHOR_PX
            : point.x + STICKER_ANCHOR_PX - w;
        if (left >= 4 && left + w <= width - 4) placements.set(candidate.candidateId, side);
      }
    }
    return placements;
  }, [
    domCandidates,
    viewportWidth,
    selectedId,
    committedId,
    proposalOnTable,
    proposalByCandidate,
    lookupKey,
    viewersOf,
    markerStates,
    preview,
    center,
    scope.area.radiusM,
    viewTick,
    collisionOffsets,
  ]);

  /* Draw order and the dashed filter are layout facts baked into the source,
     because neither `circle-sort-key` nor a layer filter can read feature
     state. They are therefore keyed on the *committed* reading of a place —
     its eligibility, and whether anyone has put it on the table — never on
     selection or on a hold preview, so the press-and-hold gesture stays a
     pure feature-state sweep with no re-tiling (CLAUDE.md §7). */
  const bakedStateOf = (candidate: CandidateSummary): MarkerState => {
    if (candidate.candidateId === committedId) return "settled";
    const proposal = proposalByCandidate.get(candidate.candidateId);
    if (proposal === "staged") return "staged";
    if (proposal === "vetoed") return "vetoed";
    if (proposal === "open") return "proposed";
    return candidate.eligibility === "eligible"
      ? "works"
      : candidate.eligibility === "likely"
        ? "likely"
        : candidate.eligibility === "uncertain"
          ? "unsure"
          : candidate.eligibility === "unlikely"
            ? "unlikely"
            : "out";
  };
  const marksDataKey = useMemo(
    () =>
      candidates
        .map((candidate) =>
          `${candidate.candidateId}:${sortKeyOf(bakedStateOf(candidate))}:${candidate.eligibility}:` +
          `${candidate.name}:${candidate.location.lng.toFixed(6)},${candidate.location.lat.toFixed(6)}`,
        )
        .sort()
        .join("\n"),
    [candidates, committedId, proposalByCandidate],
  );
  const marksGeoJson = useMemo(
    () => ({
      type: "FeatureCollection" as const,
      features: candidates.map((candidate) => {
        const state = bakedStateOf(candidate);
        return {
          type: "Feature" as const,
          properties: {
            candidateId: candidate.candidateId,
            name: candidate.name,
            sortKey: sortKeyOf(state),
            // Every place that is not already clear may become the dashed
            // return ghost during a hold preview. Baking that potential keeps
            // the gesture free of a source swap; paint opacity picks the
            // dashes that are actually live.
            dashed: candidate.eligibility !== "eligible",
          },
          geometry: {
            type: "Point" as const,
            coordinates: [
              Number(candidate.location.lng.toFixed(6)),
              Number(candidate.location.lat.toFixed(6)),
            ],
          },
        };
      }),
    }),
    [marksDataKey],
  );

  const previousMarkState = useRef(new globalThis.Map<string, string>());
  const previousMarksDataKey = useRef("");
  useEffect(() => {
    if (!loaded) return;
    const map = mapRef.current?.getMap();
    if (!map?.getSource("marks")) return;
    const sourceChanged = previousMarksDataKey.current !== marksDataKey;
    const next = new globalThis.Map<string, string>();
    const apply = (all: boolean) => {
      for (const candidate of candidates) {
        const state = stateOf(candidate);
        const stage = stageOf(candidate.candidateId);
        const featureState = {
          status: glStatusOf(state),
          // `busy` stays one release beside `stage` (older pins read it).
          busy: stage !== null,
          stage: stage ?? "",
          hidden: domCandidateIds.has(candidate.candidateId),
        };
        const serialised = JSON.stringify(featureState);
        next.set(candidate.candidateId, serialised);
        if (!all && previousMarkState.current.get(candidate.candidateId) === serialised) continue;
        map.setFeatureState(
          { source: "marks", id: candidate.candidateId },
          featureState,
        );
      }
    };
    const candidateIds = new Set(candidates.map((candidate) => candidate.candidateId));
    for (const id of previousMarkState.current.keys()) {
      if (!candidateIds.has(id)) map.removeFeatureState({ source: "marks", id });
    }
    apply(sourceChanged);
    previousMarkState.current = next;
    previousMarksDataKey.current = marksDataKey;
    const reapplyAll = () => apply(true);
    map.once("idle", reapplyAll);
    return () => {
      map.off("idle", reapplyAll);
    };
  }, [loaded, marksDataKey, candidates, markerStates, busy, domCandidateIds]);

  useEffect(() => {
    if (!loaded) return;
    const map = mapRef.current?.getMap();
    if (!map) return;
    // A render pass is where an updated image actually reaches the atlas, so
    // counting passes is the only way to tell a turning ring from a rAF loop
    // burning canvas work against a static map (W5).
    const countRender = () => {
      mapRenders.current += 1;
    };
    map.on("render", countRender);
    return () => {
      map.off("render", countRender);
    };
  }, [loaded]);

  useEffect(() => {
    if (!loaded) return;
    const map = mapRef.current?.getMap();
    if (!map) return;
    const canvas = document.createElement("canvas");
    const busyImage = ringImageId(MARK_BUSY_IMAGE, ringPixelRatio);
    const arcImage = ringImageId(MARK_ARC_IMAGE, ringPixelRatio);
    const arcCanvas = document.createElement("canvas");
    const busyRing = (angle: number) =>
      ringImage(
        canvas,
        28 * ringPixelRatio,
        1.5 * ringPixelRatio,
        [3.5 * ringPixelRatio, 3 * ringPixelRatio],
        angle,
      );
    const arcRing = (angle: number) =>
      ringImage(arcCanvas, 28 * ringPixelRatio, 1.5 * ringPixelRatio, [], angle, ARC_SWEEP);
    const paint = (angle: number) => {
      if (map.hasImage(busyImage)) map.updateImage(busyImage, busyRing(angle));
      if (map.hasImage(arcImage)) map.updateImage(arcImage, arcRing(angle));
      map.triggerRepaint();
      busyRepaints.current += 1;
    };
    const cancel = () => {
      if (busyFrame.current !== null) cancelAnimationFrame(busyFrame.current);
      busyFrame.current = null;
      busyAnimating.current = false;
    };
    cancel();
    if (busy.size === 0) return cancel;
    // Only queued rings: they stand still, so nothing asks for frames.
    if (!turning || motion.reduced || motion.busyMs <= 0) {
      paint(0);
      return cancel;
    }
    busyAnimating.current = true;
    const draw = (now: number) => {
      const stillTurning = [...busyRef.current].some((id) => stageOfRef.current(id) !== "queued");
      if (!stillTurning) {
        cancel();
        return;
      }
      paint(((now % motion.busyMs) / motion.busyMs) * Math.PI * 2);
      busyFrame.current = requestAnimationFrame(draw);
    };
    busyFrame.current = requestAnimationFrame(draw);
    return cancel;
  }, [loaded, busy, turning, motion.reduced, motion.busyMs, ringPixelRatio]);

  useEffect(() => {
    const stats = () => {
      const map = mapRef.current?.getMap();
      const mapCenter = map?.getCenter();
      const glOnlyCandidate = candidates.find(
        (candidate) => !domCandidateIds.has(candidate.candidateId),
      );
      const glOnlyPoint = map && glOnlyCandidate
        ? map.project([glOnlyCandidate.location.lng, glOnlyCandidate.location.lat])
        : null;
      const transition = map?.getLayer("mark-dots")
        ? map.getPaintProperty("mark-dots", "circle-radius-transition") as { duration?: number }
        : undefined;
      return {
        candidates: candidates.length,
        domMarkers: domCandidates.length,
        glFeatures: marksGeoJson.features.length,
        center: [mapCenter?.lng ?? center.lng, mapCenter?.lat ?? center.lat] as [number, number],
        zoom: map?.getZoom() ?? 14,
        busyAnimating: busyAnimating.current,
        busyLayerMounted: Boolean(map?.getLayer("mark-busy")),
        arcLayerMounted: Boolean(map?.getLayer("mark-arc")),
        stages: [...busyRef.current].reduce(
          (acc, id) => {
            const stage = stageOfRef.current(id) ?? "fetching";
            acc[stage] += 1;
            return acc;
          },
          { queued: 0, fetching: 0, processing: 0 },
        ),
        pipeline: pipelineRef.current
          ? { done: pipelineRef.current.done, total: pipelineRef.current.total, paused: pipelineRef.current.paused }
          : null,
        busyRepaints: busyRepaints.current,
        mapRenders: mapRenders.current,
        ringPixelRatio,
        selectionDispatches: selectionDispatches.current,
        markRadii: GL_MARK_RADIUS,
        focusNonce,
        settleDuration: motion.settleMs,
        transitionDuration: transition?.duration ?? 0,
        selected: selectedId,
        glOnly: glOnlyCandidate && glOnlyPoint
          ? {
              candidateId: glOnlyCandidate.candidateId,
              point: [glOnlyPoint.x, glOnlyPoint.y] as [number, number],
            }
          : null,
      };
    };
    window.__spokesMapStats = stats;
    return () => {
      if (window.__spokesMapStats === stats) delete window.__spokesMapStats;
    };
  }, [
    candidates,
    domCandidates.length,
    domCandidateIds,
    marksGeoJson,
    center.lat,
    center.lng,
    motion.settleMs,
    ringPixelRatio,
    focusNonce,
    selectedId,
  ]);

  const keyboardCandidates = useMemo(
    () =>
      candidates
        .filter((candidate) => distanceMeters(center, candidate.location) <= scope.area.radiusM + 1)
        .sort(
          (a, b) =>
            PLACE_COLLATOR.compare(a.name, b.name) ||
            PLACE_COLLATOR.compare(a.candidateId, b.candidateId),
        ),
    [candidates, center.lat, center.lng, scope.area.radiusM],
  );
  const [rovingCandidateId, setRovingCandidateId] = useState<string | null>(null);
  const keyboardCandidateRefs = useRef(new globalThis.Map<string, HTMLButtonElement>());
  useEffect(() => {
    if (
      rovingCandidateId &&
      keyboardCandidates.some((candidate) => candidate.candidateId === rovingCandidateId)
    ) return;
    setRovingCandidateId(keyboardCandidates[0]?.candidateId ?? null);
  }, [keyboardCandidates, rovingCandidateId]);

  const moveKeyboardCandidate = useCallback((currentId: string, direction: number) => {
    const index = keyboardCandidates.findIndex((candidate) => candidate.candidateId === currentId);
    if (index < 0 || keyboardCandidates.length === 0) return;
    const next = keyboardCandidates[(index + direction + keyboardCandidates.length) % keyboardCandidates.length];
    setRovingCandidateId(next.candidateId);
    keyboardCandidateRefs.current.get(next.candidateId)?.focus();
  }, [keyboardCandidates]);
  const keyboardRefCallbacks = useRef(
    new globalThis.Map<string, (element: HTMLButtonElement | null) => void>(),
  );
  const keyboardRefFor = useCallback((candidateId: string) => {
    let callback = keyboardRefCallbacks.current.get(candidateId);
    if (!callback) {
      callback = (element) => {
        if (element) keyboardCandidateRefs.current.set(candidateId, element);
        else keyboardCandidateRefs.current.delete(candidateId);
      };
      keyboardRefCallbacks.current.set(candidateId, callback);
    }
    return callback;
  }, []);
  useEffect(() => {
    const currentIds = new Set(keyboardCandidates.map((candidate) => candidate.candidateId));
    for (const id of keyboardRefCallbacks.current.keys()) {
      if (!currentIds.has(id)) keyboardRefCallbacks.current.delete(id);
    }
  }, [keyboardCandidates]);
  const keyboardList = useMemo(
    () =>
      keyboardCandidates.map((candidate) => {
        const state = markerStates.get(candidate.candidateId) ?? "out";
        return (
          <li key={candidate.candidateId}>
            <button
              ref={keyboardRefFor(candidate.candidateId)}
              type="button"
              tabIndex={rovingCandidateId === candidate.candidateId ? 0 : -1}
              data-testid={`keyboard-place-${candidate.candidateId}`}
              onFocus={() => {
                setRovingCandidateId(candidate.candidateId);
                onPreview(candidate.candidateId);
              }}
              onBlur={() => onPreview(null)}
              onClick={() => dispatchSelect(candidate.candidateId)}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" || event.key === "ArrowRight") {
                  event.preventDefault();
                  moveKeyboardCandidate(candidate.candidateId, 1);
                } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
                  event.preventDefault();
                  moveKeyboardCandidate(candidate.candidateId, -1);
                } else if (event.key === "Home" && keyboardCandidates[0]) {
                  event.preventDefault();
                  const first = keyboardCandidates[0].candidateId;
                  setRovingCandidateId(first);
                  keyboardCandidateRefs.current.get(first)?.focus();
                } else if (event.key === "End" && keyboardCandidates.at(-1)) {
                  event.preventDefault();
                  const last = keyboardCandidates.at(-1)!.candidateId;
                  setRovingCandidateId(last);
                  keyboardCandidateRefs.current.get(last)?.focus();
                } else if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  dispatchSelect(candidate.candidateId);
                }
              }}
            >
              {candidate.name} — {STATE_LABEL[state]}
            </button>
          </li>
        );
      }),
    [dispatchSelect, keyboardCandidates, keyboardRefFor, markerStates, moveKeyboardCandidate, rovingCandidateId],
  );

  const explorePlaces = useMemo(() => {
    const refs = new Set(candidates.flatMap((candidate) => candidate.ref ? [candidate.ref] : []));
    return [...explore.values()].filter(
      (place) => !place.candidateId && !place.added && !refs.has(place.ref),
    );
  }, [explore, candidates]);
  const exploreMembershipKey = useMemo(
    () =>
      [...explore.values()]
        .map(
          (place) =>
            `${place.ref}:${place.name}:${place.category}:` +
            `${place.location.lng.toFixed(6)},${place.location.lat.toFixed(6)}`,
        )
        .sort()
        .join("\n"),
    [explore],
  );
  const exploreGeoJson = useMemo(
    () => ({
      type: "FeatureCollection" as const,
      features: [...explore.values()].map((place) => ({
        type: "Feature" as const,
        properties: { ref: place.ref, name: place.name, category: place.category },
        geometry: {
          type: "Point" as const,
          coordinates: [place.location.lng, place.location.lat],
        },
      })),
    }),
    [exploreMembershipKey],
  );
  const hiddenExploreRefs = useRef<Set<string>>(new Set());
  const featureStateMembership = useRef("");
  useEffect(() => {
    if (!loaded) return;
    const map = mapRef.current;
    if (!map) return;
    const nextHidden = new Set(
      candidates.flatMap((candidate) => candidate.ref ? [candidate.ref] : []),
    );
    for (const place of explore.values()) {
      if (place.candidateId || place.added) nextHidden.add(place.ref);
    }
    const membershipChanged = featureStateMembership.current !== exploreMembershipKey;
    const changedRefs = membershipChanged
      ? [...nextHidden]
      : [...new Set([...hiddenExploreRefs.current, ...nextHidden])].filter(
          (ref) => hiddenExploreRefs.current.has(ref) !== nextHidden.has(ref),
        );
    const apply = () => {
      for (const ref of changedRefs) {
        map.setFeatureState(
          { source: "explore", id: ref },
          { hidden: nextHidden.has(ref) },
        );
      }
    };
    hiddenExploreRefs.current = nextHidden;
    featureStateMembership.current = exploreMembershipKey;
    apply();
    map.once("idle", apply);
    return () => {
      map.off("idle", apply);
    };
  }, [loaded, explore, exploreMembershipKey, candidates]);
  const selectedExplore = selectedExploreRef ? explore.get(selectedExploreRef) ?? null : null;
  const visibleExplore = useMemo(() => {
    const map = mapRef.current;
    if (!map) return [];
    const bounds = map.getBounds();
    return explorePlaces.filter(
      (place) =>
        place.location.lat >= bounds.getSouth() &&
        place.location.lat <= bounds.getNorth() &&
        place.location.lng >= bounds.getWest() &&
        place.location.lng <= bounds.getEast(),
    );
  }, [explorePlaces, viewTick]);

  useEffect(() => {
    if (selectedExploreRef && !explore.has(selectedExploreRef)) setSelectedExploreRef(null);
  }, [explore, selectedExploreRef]);

  useEffect(() => {
    if (!selectedExplore || !focusExploreAction.current) return;
    focusExploreAction.current = false;
    setExploreAnnouncement(`${selectedExplore.name} opened.`);
    const frame = requestAnimationFrame(() => exploreActionRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [selectedExplore]);

  const viewportSettled = () => {
    const map = mapRef.current;
    if (!map) return;
    const bounds = map.getBounds();
    const mapCenter = map.getCenter();
    setScopeOffscreen(
      center.lat < bounds.getSouth() ||
      center.lat > bounds.getNorth() ||
      center.lng < bounds.getWest() ||
      center.lng > bounds.getEast(),
    );
    setPanned(distanceMeters(center, { lat: mapCenter.lat, lng: mapCenter.lng }) > 50);
    setViewTick((tick) => tick + 1);
    if (!context.pool?.explorable) return;
    if (exploreTimer.current) clearTimeout(exploreTimer.current);
    exploreTimer.current = setTimeout(() => {
      const current = mapRef.current;
      if (!current) return;
      const box = current.getBounds();
      const next = {
        center: { lat: current.getCenter().lat, lng: current.getCenter().lng },
        width: box.getEast() - box.getWest(),
        height: box.getNorth() - box.getSouth(),
        zoom: current.getZoom(),
      };
      const previous = lastExploreView.current;
      if (
        previous &&
        Math.abs(next.zoom - previous.zoom) < 0.01 &&
        Math.abs(next.center.lng - previous.center.lng) <= previous.width * 0.25 &&
        Math.abs(next.center.lat - previous.center.lat) <= previous.height * 0.25
      ) {
        return;
      }
      lastExploreView.current = next;
      void spatial.loadExplore(roomId, [
        box.getSouth(),
        box.getWest(),
        box.getNorth(),
        box.getEast(),
      ]);
    }, 250);
  };

  const bringExplore = async (refs: string[]) => {
    const remaining = context.pool ? context.pool.cap - context.pool.size : refs.length;
    const selected = refs.slice(0, Math.max(0, Math.min(remaining, 40)));
    if (selected.length === 0) return;
    setAddingExplore(true);
    try {
      const result = await run("AddCandidates", { refs: selected });
      if (result.ok) {
        spatial.markExploreAdded(selected);
        setSelectedExploreRef(null);
      }
    } finally {
      setAddingExplore(false);
    }
  };

  const shown = preview ?? context;
  const matching = shown.matching;
  const total = shown.total;
  const unsure = shown.feasibility.uncertain;
  const likely = shown.likely ?? 0;
  const unlikely = shown.feasibility.unlikely ?? 0;
  /* What the room is told still works: confirmed plus likely (user decision,
     2026-09-03). `matching` keeps the wire's eligible-only meaning — a guess
     still never rules a place out and never makes a room feasible. The
     subline breaks the number down rather than adding to it. */
  const works = matching + likely;
  const guessed = `${likely > 0 ? ` · ${likely} of them likely` : ""}${unsure > 0 ? ` · ${unsure} unsure` : ""}${
    unlikely > 0 ? ` · ${unlikely} unlikely` : ""
  }`;
  const statedNeeds = context.activeNeeds.filter((n) => n.active);
  const collisions = statedNeeds.filter((n) => n.ruledOut > 0).length;
  /* What a zero is made of (COPY.md impasse): unknowns first — "none
     confirmed" is not "none" — then how many needs are doing the ruling out. */
  const zeroReason =
    unsure > 0
      ? `none confirmed · ${unsure} still to check`
      : collisions >= 2
        ? `${numberWord(collisions)} needs collide`
        : collisions === 1
          ? "one need rules the rest out"
          : "nothing clears every need";
  /* The busy line: a lookup a need or the pool started, never a single
     place someone opened (the panel says that). */
  const busyCount = busy.size;
  const refine = context.refine;
  /* Places still needing work for a need someone actually stated. The server
     now excludes the background vocabulary and stale-fact sweeps from this,
     so it is a count the room can act on rather than the whole queue. While
     anything is paused there is no honest tail to show at all. */
  const shownRefineQueue =
    refine && refine.paused == null ? refine.tier1Queued ?? refine.queued : 0;
  const lookupLine =
    busyCount > 0 && busyReason?.kind !== "place"
      ? busyReason?.kind === "refine"
        ? COPY.lookingUpMany(busyCount, shownRefineQueue)
        : busyReason?.kind === "need" && busyReason.label
          ? `checking ${busyCount} for ${busyReason.label}`
          : `checking ${busyCount} place${busyCount === 1 ? "" : "s"}`
      : pendingCount > 0
        ? "checking…"
        : null;
  /* One progress slot only. Whole-area fill wins while it is true because
     its absolute target explains why the denominator is still moving; the
     lookup line resumes in the same slot as soon as the fill completes. */
  const fillLine = context.pool?.filling
    ? `adding places · ${context.pool.size} of ${context.pool.target}`
    : null;
  /* The pipeline ring (SPOKES-UI "The pipeline ring and dot stages"): one
     determinate ring, done of total for the active needs, and one line. It
     replaces the lookup and refinement lines once the server sends
     `pipeline` frames; an older server keeps the two lines. Drained: nothing
     at all — a finished ring that lingers reads as stuck. */
  const pipelineActive = pipeline !== null && pipeline.total > 0 && pipeline.done < pipeline.total;
  const pipelinePaused = pipeline?.paused === "budget";
  const pipelineLine = pipelineActive
    ? pipelinePaused
      ? COPY.refinePaused
      : COPY.pipelineChecked(pipeline.done, pipeline.total, statedNeeds.length)
    : null;
  const pipelineMix =
    pipelineActive && !pipelinePaused
      ? COPY.pipelineMix(pipeline.inFlight.fetch, pipeline.inFlight.process)
      : null;
  const busyLine = fillLine ?? (pipeline !== null ? (pipelineActive ? null : lookupLine) : lookupLine);
  /* The refinement line: what the room has checked so far and what is left,
     quiet, under the count. Out of budget reads as paused, never as an
     error — nothing is wrong, the room is waiting its turn. Replaced by the
     ring once pipeline frames flow. */
  const refineLine = pipeline !== null
    ? null
    : refine?.active
      ? refine.paused === "budget" ||
        refine.budgetLeft.calls === 0 ||
        refine.budgetLeft.searches === 0
        ? COPY.refinePaused
        : COPY.refining(refine.checkedToday, statedNeeds.length, shownRefineQueue)
      : null;
  const settled = committedId !== null;
  useEffect(() => {
    const line = pipelineLine ?? refineLine ?? "";
    const wait = Math.max(0, 10_000 - (Date.now() - refineAnnouncedAt.current));
    const timer = setTimeout(() => {
      refineAnnouncedAt.current = Date.now();
      setRefineAnnouncement(line);
    }, wait);
    return () => clearTimeout(timer);
  }, [refineLine, pipelineLine]);
  const preNeed = statedNeeds.length === 0 && context.privateEffects.length === 0;

  /* Zero eligible with unknowns outstanding is NOT an impasse (§4) unless the
     council has actually declared one — then the room and the count block
     must say the same thing, and the unknowns stay counted in the subline. */
  const declared = context.impasse?.active === true && !preview;
  const countState = settled
    ? "settled"
    : preNeed
      ? "pre"
      : works === 0 && (unsure === 0 || declared)
        ? "impasse"
        : works === 0
          ? "pending"
          : "works";

  const committedWalk = committedId
    ? candidates.find((c) => c.candidateId === committedId)?.walkMin
    : undefined;

  /* The offer chip: what the set would become if the costliest need relaxed.
     Phrased as a consequence, never as an instruction (COPY.md deltas). */
  const bestRelaxation = useMemo(() => {
    const relaxable = context.activeNeeds
      .filter((n) => n.active && n.wouldReturn > 0)
      .sort((a, b) => b.wouldReturn - a.wouldReturn);
    return relaxable[0] ?? null;
  }, [context.activeNeeds]);

  return (
    <div
      className="map-region"
      data-testid="map-region"
      data-scope-radius={Math.round(scope.area.radiusM)}
      data-preview={preview ? "true" : undefined}
      data-loaded={loaded ? "true" : undefined}
      aria-busy={busyCount > 0 || pendingCount > 0 || context.pool?.filling || undefined}
      data-explore-count={explorePlaces.length}
    >
      {tileStyle && (
      <Map
        ref={mapRef}
        initialViewState={{ latitude: center.lat, longitude: center.lng, zoom: 14 }}
        mapStyle={tileStyle}
        attributionControl={{ compact: true }}
        onLoad={() => {
          const map = mapRef.current?.getMap();
          if (map) {
            map.setMissingStyleImageResolver((id) => resolveRingImage(map, id));
            // Symbol layers mount only after this handler marks the map
            // loaded, so both DPR-specific images exist before first paint.
            addRingImages(map, ringPixelRatio);
          }
          fitOnce();
          setLoaded(true);
          viewportSettled();
        }}
        onMoveEnd={viewportSettled}
        onMoveStart={clearHover}
        onDragStart={clearHover}
        onMouseMove={(event) => {
          // One resolver for two consumers: the place under the pointer,
          // resolved the way a tap is (card box first, then the nearest
          // dot), feeds the prefetch hint the socket debounces AND the
          // hover card (GL dots have no DOM element to hover; a DOM marker
          // handles its own hover). Never during a drag — a button held
          // down is a pan, and GL dots sliding under the pointer are not an
          // intent.
          if (event.originalEvent.buttons !== 0) return;
          const overMarker = Boolean(
            (event.originalEvent.target as Element | null)?.closest?.(".maplibregl-marker"),
          );
          const map = mapRef.current;
          const mapRect = map?.getContainer().getBoundingClientRect();
          const clientX = (mapRect?.left ?? 0) + event.point.x;
          const clientY = (mapRect?.top ?? 0) + event.point.y;
          const under = cardAt(clientX, clientY) ?? nearestTo(clientX, clientY);
          onPreview(under);
          if (finePointer && !overMarker) hoverFor(under);
        }}
        onMouseOut={() => {
          onPreview(null);
          clearHover();
        }}
        onClick={(event) => {
          // A marker handles its own tap. Maplibre binds click on the canvas
          // container that markers are appended into, so without this the map
          // would get a second go at a tap the card already answered (W6).
          // Not reproducible today — @vis.gl's Marker stops the native event
          // first — so this is a guard against that changing, not a live fix.
          if ((event.originalEvent.target as Element | null)?.closest?.(".maplibregl-marker")) return;
          const map = mapRef.current;
          const mapRect = map?.getContainer().getBoundingClientRect();
          const clientX = (mapRect?.left ?? 0) + event.point.x;
          const clientY = (mapRect?.top ?? 0) + event.point.y;
          const candidateId =
            cardAt(clientX, clientY) ?? nearestTo(clientX, clientY);
          if (candidateId) {
            setSelectedExploreRef(null);
            dispatchSelect(candidateId);
            return;
          }

          const features = map?.queryRenderedFeatures(
            [
              [event.point.x - TAP_REACH, event.point.y - TAP_REACH],
              [event.point.x + TAP_REACH, event.point.y + TAP_REACH],
            ],
            { layers: ["explore-dots"] },
          ) ?? [];
          let ref: string | null = null;
          let nearest = Number.POSITIVE_INFINITY;
          const seenRefs = new Set<string>();
          const available = new Set(explorePlaces.map((place) => place.ref));
          for (const feature of features) {
            const candidateRef = feature.properties?.ref;
            if (
              typeof candidateRef !== "string" ||
              seenRefs.has(candidateRef) ||
              !available.has(candidateRef)
            ) continue;
            seenRefs.add(candidateRef);
            const geometry = feature.geometry;
            if (geometry.type !== "Point") continue;
            const [lng, lat] = geometry.coordinates as [number, number];
            const point = map?.project([lng, lat]);
            if (!point) continue;
            const distance = (point.x - event.point.x) ** 2 + (point.y - event.point.y) ** 2;
            if (distance <= TAP_REACH * TAP_REACH && distance < nearest) {
              nearest = distance;
              ref = candidateRef;
            }
          }
          if (typeof ref === "string") {
            focusExploreAction.current = false;
            dispatchSelect(null);
            setSelectedExploreRef(ref);
            return;
          }
          setSelectedExploreRef(null);
          dispatchSelect(null);
        }}
      >
        <Source id="explore" type="geojson" data={exploreGeoJson} promoteId="ref">
          <Layer
            id="explore-dots"
            type="circle"
            paint={{
              "circle-radius": 4,
              "circle-color": MAP_THEME.exploreDot.color,
              "circle-opacity": [
                "case",
                ["boolean", ["feature-state", "hidden"], false],
                0,
                MAP_THEME.exploreDot.opacity,
              ],
              "circle-stroke-color": MAP_THEME.exploreDot.stroke,
              "circle-stroke-width": 1,
              "circle-stroke-opacity": [
                "case",
                ["boolean", ["feature-state", "hidden"], false],
                0,
                1,
              ],
            }}
          />
        </Source>
        <Source id="scope-mask" type="geojson" data={outsideMask}>
          <Layer
            id="scope-dim"
            type="fill"
            paint={{
              "fill-color": MAP_THEME.outsideDim.color,
              "fill-opacity": MAP_THEME.outsideDim.opacity,
            }}
          />
        </Source>
        <Source id="scope-ring" type="geojson" data={ring}>
          <Layer
            id="scope-line"
            type="line"
            paint={{
              "line-color": MAP_THEME.scopeRing.color,
              "line-width": MAP_THEME.scopeRing.width,
              "line-opacity": MAP_THEME.scopeRing.opacity,
              "line-dasharray": [...MAP_THEME.scopeRing.dash],
            }}
          />
        </Source>
        {proposedRing && (
          <Source id="scope-ring-proposed" type="geojson" data={proposedRing}>
            <Layer
              id="scope-line-proposed"
              type="line"
              paint={{
                "line-color": MAP_THEME.proposedRing.color,
                "line-width": MAP_THEME.proposedRing.width,
                "line-opacity": MAP_THEME.proposedRing.opacity,
                "line-dasharray": [...MAP_THEME.proposedRing.dash],
              }}
            />
          </Source>
        )}
        <Source
          id="marks"
          type="geojson"
          data={marksGeoJson}
          promoteId="candidateId"
          maxzoom={MARK_SOURCE_MAX_ZOOM}
        >
          <Layer
            id="mark-dots"
            type="circle"
            layout={{ "circle-sort-key": ["get", "sortKey"] }}
            paint={{
              "circle-radius": [
                "match", ["feature-state", "status"],
                "out", GL_MARK_RADIUS.out,
                "unsure", GL_MARK_RADIUS.unsure,
                "unlikely", GL_MARK_RADIUS.unlikely,
                "likely", GL_MARK_RADIUS.likely,
                "return", GL_MARK_RADIUS.return,
                "act", GL_MARK_RADIUS.act,
                GL_MARK_RADIUS.works,
              ],
              "circle-color": [
                "match", ["feature-state", "status"],
                "out", MAP_THEME.marks.out,
                "unsure", MAP_THEME.marks.surface,
                "unlikely", MAP_THEME.marks.surface,
                "return", MAP_THEME.marks.surface,
                "act", MAP_THEME.marks.act,
                MAP_THEME.marks.works,
              ],
              "circle-opacity": [
                "case",
                ["boolean", ["feature-state", "hidden"], false], 0,
                ["==", ["feature-state", "status"], "out"], MAP_THEME.marks.outOpacity,
                1,
              ],
              "circle-stroke-color": [
                "match", ["feature-state", "status"],
                "unsure", MAP_THEME.marks.unsure,
                "return", MAP_THEME.marks.works,
                "act", MAP_THEME.marks.surface,
                "works", MAP_THEME.marks.surface,
                MAP_THEME.marks.surface,
              ],
              "circle-stroke-width": [
                "match", ["feature-state", "status"],
                "unsure", 2.5,
                "return", 0,
                "act", 3,
                "works", 2.5,
                0,
              ],
              "circle-color-transition": { duration: motion.settleMs },
              "circle-radius-transition": { duration: motion.settleMs },
              "circle-stroke-color-transition": { duration: motion.settleMs },
              "circle-stroke-width-transition": { duration: motion.settleMs },
              "circle-opacity-transition": { duration: motion.settleMs },
            }}
          />
          {loaded && <Layer
            id="mark-dashes"
            type="symbol"
            filter={["==", ["get", "dashed"], true]}
            layout={{
              "icon-image": ringImageId(MARK_DASH_IMAGE, ringPixelRatio),
              "icon-allow-overlap": true,
              "icon-ignore-placement": true,
              "symbol-sort-key": ["get", "sortKey"],
            }}
            paint={{
              "icon-color": [
                "match", ["feature-state", "status"],
                "unlikely", MAP_THEME.marks.unsure,
                MAP_THEME.marks.works,
              ],
              "icon-opacity": [
                "case",
                ["boolean", ["feature-state", "hidden"], false], 0,
                ["any",
                  ["==", ["feature-state", "status"], "likely"],
                  ["==", ["feature-state", "status"], "unlikely"],
                  ["==", ["feature-state", "status"], "return"],
                ],
                1,
                0,
              ],
            }}
          />}
          {loaded && busy.size > 0 && (
            <Layer
              id="mark-busy"
              type="symbol"
              layout={{
                "icon-image": ringImageId(MARK_BUSY_IMAGE, ringPixelRatio),
                "icon-allow-overlap": true,
                "icon-ignore-placement": true,
              }}
              paint={{
                "icon-color": [
                  "match", ["feature-state", "status"],
                  "out", MAP_THEME.marks.out,
                  "unsure", MAP_THEME.marks.unsure,
                  "unlikely", MAP_THEME.marks.unsure,
                  "act", MAP_THEME.marks.act,
                  MAP_THEME.marks.works,
                ],
                "icon-opacity": [
                  "case",
                  ["boolean", ["feature-state", "hidden"], false],
                  0,
                  ["==", ["feature-state", "stage"], "queued"],
                  0.4,
                  ["==", ["feature-state", "stage"], "fetching"],
                  1,
                  0,
                ],
              }}
            />
          )}
          {loaded && busy.size > 0 && (
            <Layer
              id="mark-arc"
              type="symbol"
              layout={{
                "icon-image": ringImageId(MARK_ARC_IMAGE, ringPixelRatio),
                "icon-allow-overlap": true,
                "icon-ignore-placement": true,
              }}
              paint={{
                "icon-color": [
                  "match", ["feature-state", "status"],
                  "out", MAP_THEME.marks.out,
                  "unsure", MAP_THEME.marks.unsure,
                  "unlikely", MAP_THEME.marks.unsure,
                  "act", MAP_THEME.marks.act,
                  MAP_THEME.marks.works,
                ],
                "icon-opacity": [
                  "case",
                  ["all",
                    ["==", ["feature-state", "stage"], "processing"],
                    ["!", ["boolean", ["feature-state", "hidden"], false]],
                  ],
                  1,
                  0,
                ],
              }}
            />
          )}
        </Source>
        {referentMarks.map((need) => (
          <Marker
            key={`referent-${need.id}`}
            longitude={need.referent!.location!.lng}
            latitude={need.referent!.location!.lat}
            anchor="center"
            style={{ zIndex: 8 }}
          >
            <div
              className="referent-marker"
              role="img"
              aria-label={`${need.label}. Measured from ${need.referent!.label}.`}
              data-testid={`referent-mark-${need.id}`}
            >
              <span className="referent-anchor" aria-hidden="true" />
              <span className="referent-card">{need.referent!.label}</span>
            </div>
          </Marker>
        ))}
        {sharedPeople.map(({ position, participant, index }) => (
          <Marker
            key={`person-${participant.participantId}`}
            longitude={position.lng}
            latitude={position.lat}
            anchor="center"
            style={{ zIndex: 16 }}
          >
            <div
              className="person-marker"
              role="img"
              aria-label={`${participant.displayName} is showing where they are.`}
              data-testid={`person-mark-${participant.participantId}`}
            >
              <span
                className="person-mark-badge"
                style={{ background: personColor(index) }}
                aria-hidden="true"
              >
                {initials(participant.displayName)}
              </span>
            </div>
          </Marker>
        ))}
        {displayedOrigin && (
          <Marker
            longitude={displayedOrigin.lng}
            latitude={displayedOrigin.lat}
            anchor="center"
            style={{ zIndex: 15 }}
          >
            <div
              ref={attachOriginMarker}
              className="origin-marker"
              data-testid="you-mark"
              data-editing={originEditing || undefined}
              role="button"
              tabIndex={originEditing ? 0 : -1}
              aria-label={
                originEditing
                  ? "Your starting point. Drag it or use the arrow keys to move it."
                  : `Your starting point${origin?.label ? `, ${origin.label}` : ""}.`
              }
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                if (event.key.startsWith("Arrow") && originEditing) {
                  event.preventDefault();
                  event.stopPropagation();
                  nudgeOrigin(event.key);
                }
              }}
            >
              <span className="mark" data-mark="you" aria-hidden="true" />
            </div>
          </Marker>
        )}
        {domCandidates.map((c) => {
          const state = stateOf(c);
          const viewers = viewersOf.get(c.candidateId) ?? [];
          return (
            <Marker
              key={c.candidateId}
              longitude={c.location.lng}
              latitude={c.location.lat}
              offset={collisionOffsets.get(c.candidateId) ?? [0, 0]}
              anchor="center"
              style={{
                zIndex: named.has(c.candidateId)
                  ? state === "selected"
                    ? 14
                    : state === "settled"
                      ? 13
                      : state === "staged"
                        ? 12
                        : state === "proposed"
                          ? 11
                          : 10
                  : state === "out" || state === "unlikely"
                    ? 1
                    : state === "unsure"
                      ? 2
                      : 3,
              }}
            >
              <div
                className="marker"
                data-state={state}
                data-named={named.has(c.candidateId)}
                data-candidate-id={c.candidateId}
                data-busy={busy.has(c.candidateId) || undefined}
                data-stage={stageOf(c.candidateId) ?? undefined}
                data-viewers={viewers.length || undefined}
                data-testid={`pin-${c.candidateId}`}
                role="button"
                tabIndex={0}
                onMouseEnter={() => onPreview(c.candidateId)}
                onMouseLeave={() => onPreview(null)}
                onFocus={() => {
                  onPreview(c.candidateId);
                  hoverFor(c.candidateId);
                }}
                onBlur={() => {
                  onPreview(null);
                  clearHover();
                }}
                aria-label={`${c.name} — ${STATE_LABEL[state]}${
                  busy.has(c.candidateId) ? ", being looked up" : ""
                }${
                  viewers.length
                    ? `, ${viewers.map((v) => v.p.displayName).join(" and ")} looking`
                    : ""
                }`}
                onPointerEnter={(e) => {
                  if (!finePointer || e.pointerType !== "mouse") return;
                  hoverFor(cardAt(e.clientX, e.clientY) ?? c.candidateId);
                }}
                onPointerLeave={clearHover}
                onClick={(e) => {
                  e.stopPropagation();
                  // A drawn name card owns every tap in its box, even where
                  // it covers a nearer bare dot. Outside the card, the 44px
                  // marker target still routes to the nearest dot (§13).
                  dispatchSelect(
                    cardAt(e.clientX, e.clientY) ?? nearestTo(e.clientX, e.clientY),
                  );
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    dispatchSelect(c.candidateId);
                  }
                }}
              >
                <i className="marker-dot" aria-hidden="true" />
                {/* In progress: a dashed ring turning around the dot (§9,
                    spoke-busy). Its own element, so the animated transform
                    never touches anything positioned. */}
                <i className="busy-ring marker-busy" aria-hidden="true" />
                {/* Peers looking: initials peek out from behind the dot when
                    the place has no name card. Identity colours, never
                    semantic ones. */}
                {viewers.length > 0 && (
                  <span className="dot-viewers" aria-hidden="true">
                    {viewers.map((v) => (
                      <span
                        key={v.p.participantId}
                        className="viewer-badge"
                        style={{ background: personColor(v.index) }}
                      >
                        {initials(v.p.displayName)}
                      </span>
                    ))}
                  </span>
                )}
                <div
                  className="marker-sticker"
                  data-side={named.get(c.candidateId) ?? "left"}
                  style={{
                    "--tilt": `${tiltFor(c.candidateId)}deg`,
                    "--sticker-anchor-x": `${STICKER_ANCHOR_PX}px`,
                  } as CSSProperties}
                >
                  {/* Behind the card: the badges sit under the sticker box in
                      the stacking order and clear its right edge by half. */}
                  {viewers.length > 0 && (
                    <span className="sticker-viewers" aria-hidden="true">
                      {viewers.map((v) => (
                        <span
                          key={v.p.participantId}
                          className="viewer-badge"
                          style={{ background: personColor(v.index) }}
                          data-testid={`viewer-${v.p.participantId}`}
                        >
                          {initials(v.p.displayName)}
                        </span>
                      ))}
                    </span>
                  )}
                  <div className="sticker-box">
                    <i className="sticker-dot" aria-hidden="true" />
                    <i className="busy-ring sticker-busy" aria-hidden="true" />
                    <span className="sticker-name">
                      {c.name}
                      {state === "proposed" && (
                        <span className="sticker-suffix"> · proposed</span>
                      )}
                      {state === "staged" && <span className="sticker-suffix"> · staged</span>}
                      {state === "settled" && <span className="sticker-suffix"> · settled</span>}
                    </span>
                    {state === "unsure" ? (
                      <span className="sticker-chip" aria-hidden="true">?</span>
                    ) : state === "return" ? (
                      <span className="sticker-chip">+1</span>
                    ) : state === "vetoed" ? (
                      <span className="sticker-chip">ruled out</span>
                    ) : c.walkMin > 0 ? (
                      <span className="sticker-chip">{c.walkMin} min</span>
                    ) : null}
                  </div>
                </div>
              </div>
            </Marker>
          );
        })}
        {selectedExplore && !selectedExplore.candidateId && (
          <Marker
            longitude={selectedExplore.location.lng}
            latitude={selectedExplore.location.lat}
            anchor="bottom"
            offset={[0, -8]}
            style={{ zIndex: 7 }}
          >
            <div
              className="explore-card"
              data-testid="explore-card"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="explore-card-heading">
                <span>{selectedExplore.name}</span>
                <span aria-hidden="true"> · </span>
                <span className="explore-card-category">
                  {selectedExplore.category.replace(/[_-]+/g, " ")}
                </span>
              </div>
              <div className="explore-card-shared">Everyone in the room will see it.</div>
              <div className="explore-card-actions">
                <button
                  ref={exploreActionRef}
                  type="button"
                  disabled={addingExplore || (context.pool?.size ?? 0) >= (context.pool?.cap ?? Infinity)}
                  onClick={() => void bringExplore([selectedExplore.ref])}
                >
                  Bring into the room
                </button>
                {viewportWidth >= 980 && visibleExplore.length > 1 && (
                  <button
                    type="button"
                    disabled={addingExplore}
                    onClick={() =>
                      void bringExplore(visibleExplore.slice(0, 40).map((place) => place.ref))
                    }
                  >
                    Bring in all here ({Math.min(40, visibleExplore.length)})
                  </button>
                )}
              </div>
            </div>
          </Marker>
        )}
      </Map>
      )}
      {hover && (() => {
        const c = candidates.find((cand) => cand.candidateId === hover.id);
        const rect = mapRef.current?.getContainer().getBoundingClientRect();
        return c?.image ? (
          <HoverCard
            name={c.name}
            image={c.image}
            x={hover.x}
            y={hover.y}
            bandWidth={rect?.width ?? 0}
            bandHeight={rect?.height ?? 0}
          />
        ) : null;
      })()}

      <ul className="sr-only candidate-keyboard-list" aria-label="Places on the map">
        {keyboardList}
      </ul>

      {/* MapLibre circle layers are not focusable. One compact native control
          gives keyboard and screen-reader users the same visible set without
          turning hundreds of snapshot points into DOM markers. */}
      <label className="sr-only">
        Explore places in view
        <select
          value=""
          onChange={(event) => {
            if (event.target.value) {
              focusExploreAction.current = true;
              dispatchSelect(null);
              setSelectedExploreRef(event.target.value);
            }
          }}
        >
          <option value="">Choose a place</option>
          {visibleExplore.slice(0, 40).map((place) => (
            <option key={place.ref} value={place.ref}>{place.name}</option>
          ))}
        </select>
      </label>
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {exploreAnnouncement}
      </div>

      <div className="map-wash" aria-hidden="true" />

      <div className="count-block" data-state={countState} data-testid="count-block">
        {countState === "settled" ? (
          <>
            <div className="count-settled">Settled</div>
            {committedWalk !== undefined && (
              <div className="count-sub">{committedWalk} min from you</div>
            )}
          </>
        ) : countState === "pre" ? (
          <>
            <div className="count-head">
              <span className="count-number" data-testid="count-number">{total}</span>
              <span className="count-label">
                places
              </span>
            </div>
            <div className="count-sub">nothing ruled out yet</div>
          </>
        ) : (
          <>
            <div className="count-head">
              <span className="count-number" data-testid="count-number">{works}</span>
              <span className="count-label">
                {stillWorkVerb(works).split(" ")[0]}
                <br />
                {stillWorkVerb(works).split(" ")[1]}
              </span>
            </div>
            <div className="count-sub">
              {countState === "impasse" ? `of ${total}${guessed} · ${zeroReason}` : `of ${total}${guessed}`}
            </div>
          </>
        )}
        {pipelineLine && !fillLine && countState !== "settled" && (
          <div
            className="count-progress"
            data-testid="count-progress"
            data-paused={pipelinePaused || undefined}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={pipeline!.total}
            aria-valuenow={pipelinePaused ? undefined : pipeline!.done}
            aria-valuetext={pipelineLine + (pipelineMix ? ` ${pipelineMix}` : "")}
          >
            <svg className="progress-ring" viewBox="0 0 16 16" aria-hidden="true">
              <circle className="progress-ring-track" cx="8" cy="8" r="6.5" />
              <circle
                className="progress-ring-fill"
                cx="8"
                cy="8"
                r="6.5"
                style={{
                  strokeDashoffset: RING_CIRCUMFERENCE * (1 - Math.min(1, pipeline!.done / Math.max(1, pipeline!.total))),
                }}
              />
            </svg>
            <span>
              {pipelineLine}
              {pipelineMix && <span className="count-progress-mix"> {pipelineMix}</span>}
            </span>
          </div>
        )}
        {busyLine && countState !== "settled" && (
          <div
            className="count-busy"
            data-testid={fillLine ? "count-fill" : "count-busy"}
          >
            <i className="busy-ring line-busy" aria-hidden="true" />
            <span>{busyLine}</span>
          </div>
        )}
        {refineLine && countState !== "settled" && (
          <div className="count-refine" data-testid="count-refine">
            {refineLine}
          </div>
        )}
        <span className="sr-only" aria-live="polite" aria-atomic="true">
          {refineAnnouncement}
        </span>
      </div>

      {bestRelaxation && !settled && (
        <div className="delta-chip" data-testid="delta-chip">
          <span className="delta-number">+{bestRelaxation.wouldReturn}</span>
          <span className="delta-text">
            if “{bestRelaxation.label}” went optional
          </span>
        </div>
      )}

      {(scopeOffscreen || (isOrganizer && panned)) && (
        <div
          className="map-nav-actions"
          data-has-delta={bestRelaxation && !settled ? "true" : undefined}
        >
          {scopeOffscreen && (
            <button
              type="button"
              className="map-nav-action"
              data-testid="back-to-area"
              onClick={() =>
                mapRef.current?.flyTo({
                  center: [center.lng, center.lat],
                  duration: 600,
                })
              }
            >
              <span className="map-nav-chip">Back to the area</span>
            </button>
          )}
          {isOrganizer && panned && (
            <button
              type="button"
              className="map-nav-action"
              data-testid="search-here"
              onClick={() => {
                const here = mapRef.current?.getCenter();
                if (!here) return;
                const requestedCenter = { lat: here.lat, lng: here.lng };
                ownScopeCenter.current = `${requestedCenter.lat},${requestedCenter.lng}`;
                void run("SetSearchScope", {
                  area: {
                    kind: "circle",
                    center: requestedCenter,
                    radiusM: scope.area.radiusM,
                  },
                }).then((result) => {
                  if (!result.ok) ownScopeCenter.current = null;
                });
              }}
            >
              <span className="map-nav-chip">Search here</span>
            </button>
          )}
        </div>
      )}

      <div className="map-attrib-extra">Routing © OSRM/FOSSGIS</div>
    </div>
  );
}
