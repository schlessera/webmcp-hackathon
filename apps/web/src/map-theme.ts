/**
 * MapLibre GL paint values.
 *
 * GL layers are painted on a WebGL canvas and cannot read CSS custom
 * properties, so this is the ONE module in the client allowed to hold colour
 * literals (CLAUDE.md §3). Every value below is the composited equivalent of a
 * token in `tokens.css` and must be changed together with it.
 *
 * | literal                   | token             |
 * |---------------------------|-------------------|
 * | #334136                   | --spoke-ink       |
 * | #2c6b52                   | --spoke-works     |
 * | #7d6396                   | --spoke-scope     |
 * | #e9e5da                   | --spoke-surface-sunk (map plate) |
 */
export const MAP_THEME = {
  /** --spoke-ink at 8%: everything outside the scope circle (SPOKES-UI §3). */
  outsideDim: { color: "#334136", opacity: 0.08 },
  /** --spoke-ink, 1.5px dashed at 40%: the scope ring itself. */
  scopeRing: { color: "#334136", width: 1.5, opacity: 0.4, dash: [4, 4.6] },
  /** A proposed wider radius: same ink, fainter and finer (mockup 7b). */
  proposedRing: { color: "#334136", width: 1, opacity: 0.18, dash: [4, 8] },
  /** --spoke-works as a colour wash over the basemap, so the plate reads warm. */
  wash: { color: "#2c6b52", opacity: 0.18 },
  /** --spoke-surface-sunk: what shows when tiles fail to load. */
  plate: "#e9e5da",
} as const;

export const TILE_STYLE = "https://tiles.openfreemap.org/styles/positron";
