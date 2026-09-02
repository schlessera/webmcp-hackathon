import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Layer, Map, Marker, Source, type MapRef } from "@vis.gl/react-maplibre";
import "maplibre-gl/dist/maplibre-gl.css";
import "../map-worker.ts";
import { MAP_THEME, TILE_STYLE } from "../map-theme.ts";
import type {
  CandidateSummary,
  ParticipantSummary,
  SpatialContext,
} from "../spatial-types.ts";
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
  committedId: string | null;
  /** A wider radius an agent has asked for, drawn as a second faint ring. */
  proposedRadiusM: number | null;
  /** participantId -> candidateId: who has which place open right now. */
  viewing: Record<string, string>;
  participants: ParticipantSummary[];
  meId: string;
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
const NAME_CAP = 14;
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

/** Rough drawn width of a sticker: dot + name at ~6.6px/char + optional chip. */
function stickerWidth(name: string, hasChip: boolean): number {
  return 44 + name.length * 6.6 + (hasChip ? 40 : 0);
}

export function MapView({
  context,
  preview,
  selectedId,
  focusNonce,
  committedId,
  proposedRadiusM,
  viewing,
  participants,
  meId,
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

  /* The automatic viewport moves: the first fit on load, and a refit when
     the scope CENTRE moves (an explicit search — the §8 exception). There is
     deliberately no effect keyed on the scope radius — a widened area grows
     the ring under a viewport the user still recognises (§8). */
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
    if (fittedCenter.current === centerKey) return;
    fittedCenter.current = centerKey;
    fitOnce();
  }, [centerKey]);

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
      const d = (p.x - x) ** 2 + (p.y - y) ** 2;
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
    const set = new Set<string>();
    // A place someone acted on always keeps its name, wherever it sits; a
    // place someone is looking at comes next.
    const priority = (c: CandidateSummary) => {
      if (c.candidateId === selectedId || c.candidateId === committedId) return 0;
      if (proposalByCandidate.has(c.candidateId)) return 1;
      if (viewersOf.has(c.candidateId)) return 2;
      return 3;
    };
    const ordered = candidates
      .filter((c) => stateOf(c) !== "out")
      .sort((a, b) => priority(a) - priority(b) || a.walkMin - b.walkMin);

    if (!map) {
      for (const c of ordered.slice(0, NAME_CAP)) set.add(c.candidateId);
      return set;
    }

    // Every place's dot, so a card is refused where it would bury a
    // neighbour's dot — a buried dot is an unreachable place (§13).
    const dots: Array<{ id: string; x: number; y: number }> = [];
    for (const c of candidates) {
      try {
        const p = map.project([c.location.lng, c.location.lat]);
        dots.push({ id: c.candidateId, x: p.x, y: p.y });
      } catch {
        /* off the projectable world; nothing to protect */
      }
    }
    const placed: Array<{ x: number; y: number; w: number }> = [];
    for (const c of ordered) {
      if (set.size >= NAME_CAP) break;
      const own = dots.find((d) => d.id === c.candidateId);
      if (!own) continue;
      const point = own;
      const w = stickerWidth(c.name, true) * STICKER_SLACK;
      const left = point.x - 13;
      const collides = placed.some(
        (p) =>
          Math.abs(p.y - point.y) < STICKER_H &&
          left < p.x + p.w &&
          p.x < left + w,
      );
      if (collides) continue;
      // A place someone acted on (open, settled, on the table) is named even
      // where its card sits over a neighbour's dot: the act is the thing the
      // map must show, and every dot stays reachable through nearest-dot
      // tapping (D5). Everything else yields to the dot.
      const buries =
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
      set.add(c.candidateId);
    }
    return set;
  }, [
    candidates,
    viewportWidth,
    selectedId,
    committedId,
    proposalByCandidate,
    viewersOf,
    preview,
    viewTick,
  ]);

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
    >
      <Map
        ref={mapRef}
        initialViewState={{ latitude: center.lat, longitude: center.lng, zoom: 14 }}
        mapStyle={TILE_STYLE}
        attributionControl={{ compact: true }}
        onLoad={() => {
          fitOnce();
          setViewTick((t) => t + 1);
          setLoaded(true);
        }}
        onMoveEnd={() => setViewTick((t) => t + 1)}
        onClick={() => onSelect(null)}
      >
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
                data-viewers={viewers.length || undefined}
                data-testid={`pin-${c.candidateId}`}
                role="button"
                tabIndex={0}
                aria-label={`${c.name} — ${STATE_LABEL[state]}${
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
      </Map>

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
              {countState === "impasse"
                ? `of ${total}${guessed} · ${
                    collisions >= 2
                      ? `${numberWord(collisions)} needs collide`
                      : "one need rules the rest out"
                  }`
                : `of ${total}${guessed}`}
            </div>
          </>
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

      <div className="map-attrib-extra">Routing © OSRM/FOSSGIS</div>
    </div>
  );
}
