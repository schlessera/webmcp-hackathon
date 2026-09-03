import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Layer, Map, Marker, Source, type MapRef } from "@vis.gl/react-maplibre";
import "maplibre-gl/dist/maplibre-gl.css";
import "../map-worker.ts";
import { MAP_THEME, TILE_STYLE } from "../map-theme.ts";
import { spatial } from "../spatial-store.ts";
import type {
  CandidateSummary,
  CommandEnvelope,
  ExplorePlace,
  ParticipantSummary,
  SpatialContext,
} from "../spatial-types.ts";
import type { LookupReason } from "../spatial-store.ts";
import { initials, numberWord, personColor, stillWorkVerb, tiltFor } from "../ui/copy.ts";

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
  participants: ParticipantSummary[];
  meId: string;
  /** Places the server is looking up right now: a busy ring on each. */
  busy: ReadonlySet<string>;
  busyReason: LookupReason | null;
  /** Needs this page said that have not settled yet. */
  pendingCount: number;
  roomId: string;
  isOrganizer: boolean;
  explore: ReadonlyMap<string, ExplorePlace>;
  exploreTruncated: boolean;
  run(type: string, input: Record<string, unknown>): Promise<CommandEnvelope>;
  onSelect(candidateId: string | null): void;
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
  participants,
  meId,
  busy,
  busyReason,
  pendingCount,
  roomId,
  isOrganizer,
  explore,
  exploreTruncated,
  run,
  onSelect,
}: Props) {
  const mapRef = useRef<MapRef>(null);
  const { scope, candidates, proposals } = context;
  const center = scope.area.center;

  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === "undefined" ? 1024 : window.innerWidth,
  );
  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  /* Label placement is screen-space, so it is re-resolved when the user has
     finished moving the map — never mid-gesture, and never as a result of a
     set change moving the viewport, because a set change never does (§8). */
  const [viewTick, setViewTick] = useState(0);
  /** True once the basemap has loaded and the first fit has run — the moment
   * marker positions stop moving on their own. The e2e specs wait on it. */
  const [loaded, setLoaded] = useState(false);
  const [scopeOffscreen, setScopeOffscreen] = useState(false);
  const [panned, setPanned] = useState(false);
  const [selectedExploreRef, setSelectedExploreRef] = useState<string | null>(null);
  const [exploreAnnouncement, setExploreAnnouncement] = useState("");
  const [addingExplore, setAddingExplore] = useState(false);
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

  const collisionOffsets = useMemo(() => {
    const groups = new globalThis.Map<string, CandidateSummary[]>();
    for (const candidate of candidates) {
      const key = `${candidate.location.lat},${candidate.location.lng}`;
      const group = groups.get(key) ?? [];
      group.push(candidate);
      groups.set(key, group);
    }
    const offsets = new globalThis.Map<string, [number, number]>();
    for (const group of groups.values()) {
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
  }, [candidates]);

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

  /* Explicit user actions only: opening a place from a card, or the
     `focus_destination` tool ("show me"). Pin selection does not fly. */
  useEffect(() => {
    if (!selectedId || focusNonce === 0) return;
    const c = candidates.find((v) => v.candidateId === selectedId);
    if (!c) return;
    mapRef.current?.flyTo({
      center: [c.location.lng, c.location.lat],
      zoom: Math.max(mapRef.current?.getZoom() ?? 14, 15),
      duration: 600,
    });
  }, [focusNonce, selectedId]);

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

  const stateOf = (c: CandidateSummary): MarkerState => {
    if (c.candidateId === selectedId) return "selected";
    if (c.candidateId === committedId) return "settled";
    const proposal = proposalByCandidate.get(c.candidateId);
    if (proposal === "staged") return "staged";
    if (proposal === "vetoed") return "vetoed";
    if (proposal === "open") return "proposed";
    if (preview && previewEligible) {
      if (previewEligible.has(c.candidateId)) {
        return liveEligible.has(c.candidateId) ? "works" : "return";
      }
      const shadow = preview.candidates.find((p) => p.candidateId === c.candidateId);
      return shadow?.eligibility === "uncertain"
        ? "unsure"
        : shadow?.eligibility === "likely"
          ? "likely"
          : shadow?.eligibility === "unlikely"
            ? "unlikely"
            : "out";
    }
    if (c.eligibility === "eligible") return "works";
    if (c.eligibility === "likely") return "likely";
    if (c.eligibility === "uncertain") return "unsure";
    if (c.eligibility === "unlikely") return "unlikely";
    return "out";
  };

  const named = useMemo(() => {
    const map = mapRef.current;
    const placements = new globalThis.Map<string, "left" | "right">();
    // A place someone acted on always keeps its name, wherever it sits; a
    // place someone is looking at comes next.
    const priority = (c: CandidateSummary) => {
      if (c.candidateId === selectedId || c.candidateId === committedId) return 0;
      if (proposalByCandidate.has(c.candidateId)) return 1;
      if (viewersOf.has(c.candidateId)) return 2;
      return 3;
    };
    const candidatesByPriority = candidates
      .filter((c) => stateOf(c) !== "out")
      .sort(
        (a, b) =>
          priority(a) - priority(b) ||
          a.walkMin - b.walkMin ||
          (a.ref ?? a.candidateId).localeCompare(b.ref ?? b.candidateId),
      );

    if (!map) {
      for (const c of candidatesByPriority.slice(0, NAME_CAP)) {
        placements.set(c.candidateId, "right");
      }
      return placements;
    }

    // Every place's dot, so a card is refused where it would bury a
    // neighbour's dot — a buried dot is an unreachable place (§13).
    const dots: Array<{ id: string; x: number; y: number }> = [];
    for (const c of candidates) {
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
    for (let rank = 0; rank <= 3; rank += 1) {
      const remaining = candidatesByPriority.filter((candidate) => priority(candidate) === rank);
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
        point.x + w - 13 > width ? ["left", "right"] : ["right", "left"];
      for (const side of preferred) {
        const left = side === "right" ? point.x - 13 : point.x + 13 - w;
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
          priority(c) > 1 &&
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
        const side = point.x + w - 13 <= width - 4 ? "right" : "left";
        const left = side === "right" ? point.x - 13 : point.x + 13 - w;
        if (left >= 4 && left + w <= width - 4) placements.set(candidate.candidateId, side);
      }
    }
    return placements;
  }, [
    candidates,
    viewportWidth,
    selectedId,
    committedId,
    proposalByCandidate,
    viewersOf,
    preview,
    viewTick,
    collisionOffsets,
  ]);

  const explorePlaces = useMemo(() => {
    const refs = new Set(candidates.flatMap((candidate) => candidate.ref ? [candidate.ref] : []));
    return [...explore.values()].filter(
      (place) => !place.candidateId && !place.added && !refs.has(place.ref),
    );
  }, [explore, candidates]);
  const exploreMembershipKey = useMemo(
    () => [...explore.keys()].sort().join("\n"),
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
  /* Guesses are counted apart (§8.2): "4 likely" beside "3 unsure", never
     folded into the big number. */
  const likely = shown.likely ?? 0;
  const unlikely = shown.feasibility.unlikely ?? 0;
  const guessed = `${likely > 0 ? ` · ${likely} likely` : ""}${unsure > 0 ? ` · ${unsure} unsure` : ""}${
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
  const busyLine =
    busyCount > 0 && busyReason?.kind !== "place"
      ? busyReason?.kind === "need" && busyReason.label
        ? `checking ${busyCount} for ${busyReason.label}`
        : `checking ${busyCount} place${busyCount === 1 ? "" : "s"}`
      : pendingCount > 0
        ? "checking…"
        : null;
  const settled = committedId !== null;
  const preNeed = statedNeeds.length === 0 && context.privateEffects.length === 0;

  /* Zero eligible with unknowns outstanding is NOT an impasse (§4) unless the
     council has actually declared one — then the room and the count block
     must say the same thing, and the unknowns stay counted in the subline. */
  const declared = context.impasse?.active === true && !preview;
  const countState = settled
    ? "settled"
    : preNeed
      ? "pre"
      : matching === 0 && (unsure === 0 || declared)
        ? "impasse"
        : matching === 0
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
      aria-busy={busyCount > 0 || pendingCount > 0 || undefined}
      data-explore-count={explorePlaces.length}
    >
      <Map
        ref={mapRef}
        initialViewState={{ latitude: center.lat, longitude: center.lng, zoom: 14 }}
        mapStyle={TILE_STYLE}
        attributionControl={{ compact: true }}
        onLoad={() => {
          fitOnce();
          setLoaded(true);
          viewportSettled();
        }}
        onMoveEnd={viewportSettled}
        onClick={(event) => {
          const map = mapRef.current;
          const features = map?.queryRenderedFeatures(
            [
              [event.point.x - TAP_REACH, event.point.y - TAP_REACH],
              [event.point.x + TAP_REACH, event.point.y + TAP_REACH],
            ],
            { layers: ["explore-dots"] },
          ) ?? [];
          let ref: string | null = null;
          let nearest = Number.POSITIVE_INFINITY;
          const available = new Set(explorePlaces.map((place) => place.ref));
          for (const feature of features) {
            const candidateRef = feature.properties?.ref;
            if (typeof candidateRef !== "string" || !available.has(candidateRef)) continue;
            const geometry = feature.geometry;
            if (geometry.type !== "Point") continue;
            const [lng, lat] = geometry.coordinates as [number, number];
            const point = map?.project([lng, lat]);
            if (!point) continue;
            const distance = (point.x - event.point.x) ** 2 + (point.y - event.point.y) ** 2;
            if (distance < nearest) {
              nearest = distance;
              ref = candidateRef;
            }
          }
          if (typeof ref === "string") {
            focusExploreAction.current = false;
            onSelect(null);
            setSelectedExploreRef(ref);
            return;
          }
          setSelectedExploreRef(null);
          onSelect(null);
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
        {candidates.map((c) => {
          const state = stateOf(c);
          const onTable = state === "proposed" || state === "staged" || state === "vetoed";
          const viewers = viewersOf.get(c.candidateId) ?? [];
          return (
            <Marker
              key={c.candidateId}
              longitude={c.location.lng}
              latitude={c.location.lat}
              offset={collisionOffsets.get(c.candidateId) ?? [0, 0]}
              anchor="center"
              style={{
                zIndex:
                  state === "selected" || state === "settled" || onTable
                    ? 5
                    : viewers.length > 0
                      ? 4
                      : state === "out"
                        ? 1
                        : 3,
              }}
            >
              <div
                className="marker"
                data-state={state}
                data-named={named.has(c.candidateId)}
                data-busy={busy.has(c.candidateId) || undefined}
                data-viewers={viewers.length || undefined}
                data-testid={`pin-${c.candidateId}`}
                role="button"
                tabIndex={0}
                aria-label={`${c.name} — ${STATE_LABEL[state]}${
                  busy.has(c.candidateId) ? ", being looked up" : ""
                }${
                  viewers.length
                    ? `, ${viewers.map((v) => v.p.displayName).join(" and ")} looking`
                    : ""
                }`}
                onClick={(e) => {
                  e.stopPropagation();
                  // A tap on a drawn name card means that place; anywhere
                  // else it means the nearest dot, whatever box is on top.
                  const onCard =
                    named.has(c.candidateId) &&
                    state !== "out" &&
                    (e.target as HTMLElement).closest(".marker-sticker") !== null;
                  onSelect(onCard ? c.candidateId : nearestTo(e.clientX, e.clientY) ?? c.candidateId);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelect(c.candidateId);
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
                  data-side={named.get(c.candidateId) ?? "right"}
                  style={{ "--tilt": `${tiltFor(c.candidateId)}deg` } as CSSProperties}
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
              onSelect(null);
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

      {exploreTruncated && (
        <div className="explore-truncated-cue" data-testid="explore-truncated">
          Zoom in to see every place here.
        </div>
      )}

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
              <span className="count-number" data-testid="count-number">{matching}</span>
              <span className="count-label">
                {stillWorkVerb(matching).split(" ")[0]}
                <br />
                {stillWorkVerb(matching).split(" ")[1]}
              </span>
            </div>
            <div className="count-sub">
              {countState === "impasse" ? `of ${total}${guessed} · ${zeroReason}` : `of ${total}${guessed}`}
            </div>
          </>
        )}
        {busyLine && countState !== "settled" && (
          <div className="count-busy" data-testid="count-busy">
            <i className="busy-ring line-busy" aria-hidden="true" />
            <span>{busyLine}</span>
          </div>
        )}
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
