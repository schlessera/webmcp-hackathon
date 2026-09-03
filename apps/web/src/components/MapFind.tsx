import { useEffect, useId, useRef, useState } from "react";
import { fetchPlaceSearch } from "../api.ts";
import type { ExplorePlace } from "../spatial-types.ts";

/**
 * Find a place by name (CLAUDE.md §1: by name, never by kind).
 *
 * A collapsed chip until it is asked for, so the map keeps its top edge. The
 * matches come from the same snapshot the explore layer draws, so choosing one
 * always lands on a place the room can bring in — the caller decides what
 * "choose" means (open it, or fly the map to it), this only finds.
 *
 * Keyboard: ↓/↑ move through the matches, Enter chooses, Escape clears and
 * then closes. The match count is announced, so a screen reader hears the
 * list change without reading it.
 */

const DEBOUNCE_MS = 140;

interface Props {
  roomId: string;
  /** Where the viewer is looking; ties break towards it. */
  near: { lat: number; lng: number } | null;
  onChoose(place: ExplorePlace): void;
}

export function MapFind({ roomId, near, onChoose }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<ExplorePlace[]>([]);
  const [active, setActive] = useState(0);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const chipRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const nearRef = useRef(near);
  nearRef.current = near;

  useEffect(() => {
    const typed = query.trim();
    if (!open || typed.length === 0) {
      setMatches([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void (async () => {
        const result = await fetchPlaceSearch(
          roomId,
          typed,
          nearRef.current,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setSearching(false);
        setMatches(result.ok ? result.places : []);
        setActive(0);
      })();
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, query, roomId]);

  /* A disclosure, not navigation: an outside tap closes it (W12). */
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onPointer);
    return () => window.removeEventListener("pointerdown", onPointer);
  }, [open]);

  const close = () => {
    setOpen(false);
    setQuery("");
    setMatches([]);
    chipRef.current?.focus();
  };

  const choose = (place: ExplorePlace | undefined) => {
    if (!place) return;
    onChoose(place);
    setOpen(false);
    setQuery("");
    setMatches([]);
  };

  if (!open) {
    return (
      <button
        ref={chipRef}
        type="button"
        className="map-nav-action map-find-open"
        data-testid="find-place"
        onClick={() => {
          setOpen(true);
          requestAnimationFrame(() => inputRef.current?.focus());
        }}
      >
        <span className="map-nav-chip">Find a place</span>
      </button>
    );
  }

  return (
    <div className="map-find" data-testid="find-panel" ref={rootRef}>
      <input
        ref={inputRef}
        type="text"
        className="map-find-input"
        value={query}
        placeholder="Find a place"
        aria-label="Find a place by name"
        role="combobox"
        aria-expanded={matches.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={
          matches.length > 0 ? `${listId}-${active}` : undefined
        }
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            if (query) {
              setQuery("");
              setMatches([]);
            } else {
              close();
            }
          } else if (event.key === "ArrowDown" && matches.length > 0) {
            event.preventDefault();
            setActive((index) => (index + 1) % matches.length);
          } else if (event.key === "ArrowUp" && matches.length > 0) {
            event.preventDefault();
            setActive((index) => (index - 1 + matches.length) % matches.length);
          } else if (event.key === "Enter") {
            event.preventDefault();
            choose(matches[active]);
          }
        }}
      />
      {matches.length > 0 && (
        <ul className="map-find-list" id={listId} role="listbox" aria-label="Places found">
          {matches.map((place, index) => (
            <li
              key={place.ref}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === active}
              data-active={index === active ? "true" : undefined}
            >
              <button
                type="button"
                className="map-find-match"
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(place)}
              >
                <span className="map-find-name">{place.name}</span>
                <span className="map-find-category">
                  {place.category.replace(/[_-]+/g, " ")}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {query.trim().length > 0 && matches.length === 0 && !searching && (
        <div className="map-find-empty">No place here goes by that name.</div>
      )}
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {searching || query.trim().length === 0
          ? ""
          : matches.length === 0
            ? "No place here goes by that name."
            : `${matches.length} ${matches.length === 1 ? "place" : "places"} found`}
      </div>
    </div>
  );
}
