import { useEffect, useRef, useState } from "react";

/**
 * What the map draws under the room (SPOKES-UI "Layers").
 *
 * Everything here is optional context — buildings, the places not in the
 * room, landmarks, transit lines. None of it is a state: the room's own
 * marks, counts and rings are never behind a switch, because a viewer must
 * never be able to turn off what the room decided.
 *
 * The control is one chip until it is asked for, so the map keeps its top
 * edge, and each row is a plain checkbox — a disclosure, not navigation.
 */

export type MapLayerKey = "buildings" | "explore" | "landmarks" | "transit";

export const MAP_LAYERS: ReadonlyArray<{ key: MapLayerKey; label: string }> = [
  { key: "buildings", label: "Buildings in 3D" },
  { key: "explore", label: "Places not in the room" },
  { key: "landmarks", label: "Landmarks" },
  { key: "transit", label: "Transit lines" },
];

interface Props {
  active: Readonly<Record<MapLayerKey, boolean>>;
  onToggle(key: MapLayerKey, on: boolean): void;
}

export function MapLayers({ active, onToggle }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const chipRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      chipRef.current?.focus();
    };
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const count = MAP_LAYERS.filter((layer) => active[layer.key]).length;

  return (
    <div className="map-layers" ref={rootRef}>
      <button
        ref={chipRef}
        type="button"
        className="map-nav-action"
        data-testid="map-layers"
        aria-expanded={open}
        aria-label={
          count === 0 ? "Layers, none on" : `Layers, ${count} on`
        }
        onClick={() => setOpen((value) => !value)}
      >
        <span className="map-nav-chip" data-on={count > 0 ? "true" : undefined}>
          Layers
        </span>
      </button>
      {open && (
        <div className="map-layers-panel" data-testid="map-layers-panel">
          {MAP_LAYERS.map((layer) => (
            <label key={layer.key} className="map-layers-row">
              <input
                type="checkbox"
                checked={active[layer.key]}
                data-testid={`layer-${layer.key}`}
                onChange={(event) => onToggle(layer.key, event.target.checked)}
              />
              <span>{layer.label}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
