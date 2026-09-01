import { useEffect, useMemo, useRef, useState } from "react";
import { Layer, Map, Marker, Source, type MapRef } from "@vis.gl/react-maplibre";
import "maplibre-gl/dist/maplibre-gl.css";
import type { SpatialContext } from "../spatial-types.ts";

/**
 * The shared map: scope ring, one pin per candidate colored by eligibility
 * (excluded pins stay visible but dimmed — the room keeps a constant visual
 * representation as options change), proposal rings, committed star.
 * Pins are DOM markers, so the room stays legible (and testable) even when
 * WebGL tiles cannot load.
 */

const TILE_STYLE = "https://tiles.openfreemap.org/styles/liberty";

interface Props {
  context: SpatialContext;
  selectedId: string | null;
  focusNonce: number;
  committedId: string | null;
  onSelect(candidateId: string | null): void;
}

/** GeoJSON circle polygon (64 segments) around a lat/lng center. */
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

export function MapView({ context, selectedId, focusNonce, committedId, onSelect }: Props) {
  const mapRef = useRef<MapRef>(null);
  const { scope, candidates, proposals } = context;
  const center = scope.area.center;

  /* The page's second authored motion moment (with the scope-ring tween):
     when the room commits, spokes converge on the gold star — once. A page
     that loads into an already-committed room does not celebrate again. */
  const prevCommitted = useRef<string | null>(committedId);
  const [burstId, setBurstId] = useState<string | null>(null);
  useEffect(() => {
    if (committedId && prevCommitted.current !== committedId) {
      setBurstId(committedId);
      const t = setTimeout(() => setBurstId(null), 1300);
      prevCommitted.current = committedId;
      return () => clearTimeout(t);
    }
    prevCommitted.current = committedId;
  }, [committedId]);

  /* The widen-the-area beat: animate the ring radius with an ease-out tween
     instead of snapping, so consent visibly grows the shared search space. */
  const [drawnRadius, setDrawnRadius] = useState(scope.area.radiusM);
  const animFrom = useRef(scope.area.radiusM);
  useEffect(() => {
    const from = animFrom.current;
    const to = scope.area.radiusM;
    if (from === to) return;
    const start = performance.now();
    const duration = 700;
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setDrawnRadius(from + (to - from) * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
      else animFrom.current = to;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [scope.area.radiusM]);

  const ring = useMemo(
    () => circlePolygon(center, drawnRadius),
    [center.lat, center.lng, drawnRadius],
  );

  /* Inverse of the scope circle: the world with the search area punched out,
     so everything beyond the current range reads dimmed while the area itself
     stays at full brightness. Follows the same tweened radius as the ring. */
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

  /* Fit the scope circle once on load, and again when the radius settles. */
  const fitTo = (radiusM: number, animate: boolean) => {
    const latR = radiusM / 111320;
    const lngR = radiusM / (111320 * Math.cos((center.lat * Math.PI) / 180));
    mapRef.current?.fitBounds(
      [
        [center.lng - lngR, center.lat - latR],
        [center.lng + lngR, center.lat + latR],
      ],
      { padding: 28, duration: animate ? 800 : 0 },
    );
  };
  useEffect(() => {
    fitTo(scope.area.radiusM, true);
    // Center is a dependency too: SetSearchScope can move the circle without
    // changing its radius, and the viewport must follow.
  }, [scope.area.radiusM, center.lat, center.lng]);

  /* focus_destination / pin selection pans to the candidate. */
  useEffect(() => {
    if (!selectedId || focusNonce === 0) return;
    const c = candidates.find((v) => v.candidateId === selectedId);
    if (c) {
      mapRef.current?.flyTo({
        center: [c.location.lng, c.location.lat],
        zoom: Math.max(mapRef.current?.getZoom() ?? 14, 15),
        duration: 600,
      });
    }
  }, [focusNonce, selectedId]);

  const proposalByCandidate = useMemo(() => {
    const map = new Map_<string, string>();
    for (const p of proposals) {
      if (p.status === "open" || p.status === "staged") map.set(p.candidateId, "open");
      if (p.status === "vetoed") map.set(p.candidateId, "vetoed");
    }
    return map;
  }, [proposals]);

  /* The legend teaches the color language and narrates it live: counts move
     the moment eligibility shifts, and the proposal/agreed rows exist only
     while such a pin is on the map. */
  const counts = useMemo(() => {
    const c = { eligible: 0, uncertain: 0, excluded: 0 };
    for (const v of candidates) {
      if (v.candidateId === committedId) continue;
      c[v.eligibility as keyof typeof c] += 1;
    }
    return c;
  }, [candidates, committedId]);
  const proposedCount = [...proposalByCandidate.values()].filter((s) => s === "open").length;
  const vetoedCount = [...proposalByCandidate.values()].filter((s) => s === "vetoed").length;

  return (
    <div
      className="map-region"
      data-testid="map-region"
      data-scope-radius={Math.round(scope.area.radiusM)}
      data-phase={context.phase}
    >
      <Map
        ref={mapRef}
        initialViewState={{ latitude: center.lat, longitude: center.lng, zoom: 14 }}
        mapStyle={TILE_STYLE}
        attributionControl={{ compact: true }}
        onLoad={() => fitTo(scope.area.radiusM, false)}
        onClick={() => onSelect(null)}
      >
        <Source id="scope-mask" type="geojson" data={outsideMask}>
          <Layer
            id="scope-dim"
            type="fill"
            paint={{ "fill-color": "#23252d", "fill-opacity": 0.14 }}
          />
        </Source>
        <Source id="scope-ring" type="geojson" data={ring}>
          <Layer
            id="scope-line"
            type="line"
            paint={{
              "line-color": "#4735d8",
              "line-width": 2,
              "line-opacity": 0.55,
              "line-dasharray": [1.5, 1.5],
            }}
          />
        </Source>
        {candidates.map((c) => {
          const committed = c.candidateId === committedId;
          const proposal = proposalByCandidate.get(c.candidateId);
          return (
            <Marker
              key={c.candidateId}
              longitude={c.location.lng}
              latitude={c.location.lat}
              anchor="center"
              style={{ zIndex: committed ? 5 : c.eligibility === "excluded" ? 1 : 2 }}
            >
              {committed ? (
                <div
                  className="pin-star"
                  data-testid={`pin-${c.candidateId}`}
                  data-committed="true"
                  data-burst={burstId === c.candidateId || undefined}
                  role="button"
                  tabIndex={0}
                  aria-label={`${c.name} — agreed destination`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelect(c.candidateId);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelect(c.candidateId);
                    }
                  }}
                >
                  ★
                  {burstId === c.candidateId && (
                    <span className="commit-burst" aria-hidden="true">
                      {Array.from({ length: 6 }, (_, i) => (
                        <i key={i} style={{ transform: `rotate(${i * 60}deg)` }} />
                      ))}
                    </span>
                  )}
                </div>
              ) : (
                <div
                  className="pin"
                  data-testid={`pin-${c.candidateId}`}
                  data-eligibility={c.eligibility}
                  data-proposed={proposal === "open" || undefined}
                  data-vetoed={proposal === "vetoed" || undefined}
                  data-selected={c.candidateId === selectedId || undefined}
                  role="button"
                  tabIndex={0}
                  aria-label={`${c.name} (${c.eligibility})`}
                  title={c.name}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelect(c.candidateId);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelect(c.candidateId);
                    }
                  }}
                />
              )}
            </Marker>
          );
        })}
      </Map>
      <div className="map-legend" data-testid="map-legend" aria-label="Map key">
        <span className="legend-item">
          <i className="legend-dot" data-k="eligible" /> {counts.eligible} eligible
        </span>
        {counts.uncertain > 0 && (
          <span className="legend-item">
            <i className="legend-dot" data-k="uncertain" /> {counts.uncertain} checking
          </span>
        )}
        {counts.excluded > 0 && (
          <span className="legend-item">
            <i className="legend-dot" data-k="excluded" /> {counts.excluded} out
          </span>
        )}
        {proposedCount > 0 && (
          <span className="legend-item">
            <i className="legend-dot" data-k="proposed" /> proposed
          </span>
        )}
        {vetoedCount > 0 && (
          <span className="legend-item">
            <i className="legend-dot" data-k="vetoed" /> vetoed
          </span>
        )}
        {committedId && (
          <span className="legend-item legend-agreed">★ agreed</span>
        )}
      </div>
      <div className="map-attrib-extra">Routing © OSRM/FOSSGIS</div>
    </div>
  );
}

/* Local alias: `Map` is taken by the react-maplibre component in this module. */
const Map_ = globalThis.Map;
