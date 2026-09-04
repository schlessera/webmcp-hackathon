/**
 * The two map controls' glyphs (SPOKES-UI §3, "Find a place, and the layers
 * control").
 *
 * Drawn, not typed: an emoji or a text glyph would inherit the font's own
 * weight and metrics and would never sit right in a 32px round button. Both
 * are single-stroke in `currentColor`, so a button's own state colours them,
 * and both are `aria-hidden` — the button carries the words.
 *
 * These are affordances, not state. The map's state vocabulary is still dots
 * and rings (CLAUDE.md, "Marks, not glyphs"): nothing here says whether a
 * place works, is unsure, or is out.
 */

const COMMON = {
  width: 17,
  height: 17,
  viewBox: "0 0 17 17",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

/** A magnifier: find a place by name. */
export function FindIcon() {
  return (
    <svg {...COMMON}>
      <circle cx="7.3" cy="7.3" r="4.6" />
      <line x1="10.7" y1="10.7" x2="14.4" y2="14.4" />
    </svg>
  );
}

/** Stacked planes: what the map draws under the room. */
export function LayersIcon() {
  return (
    <svg {...COMMON}>
      <path d="M8.5 2.2 15 5.6 8.5 9 2 5.6z" />
      <path d="M2 9.2l6.5 3.4L15 9.2" />
      <path d="M2 12.4l6.5 3.4 6.5-3.4" />
    </svg>
  );
}

/** Dismiss the place the map is centred on. */
export function ClearIcon() {
  return (
    <svg {...COMMON}>
      <line x1="4.6" y1="4.6" x2="12.4" y2="12.4" />
      <line x1="12.4" y1="4.6" x2="4.6" y2="12.4" />
    </svg>
  );
}
