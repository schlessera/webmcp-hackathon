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
 * | #b05f2c                   | --spoke-unsure    |
 * | #3d5a80                   | --spoke-act       |
 * | #fffdf7                   | --spoke-surface   |
 * | #7d6396                   | --spoke-scope     |
 * | #e9e5da                   | --spoke-surface-sunk (map plate) |
 * | #a8a291                   | --spoke-out       |
 * | rgba(51, 65, 54, 0.55)    | --spoke-line      |
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
  /** Cheap snapshot places beneath the room's DOM stickers. */
  exploreDot: { color: "#a8a291", opacity: 0.55, stroke: "rgba(51, 65, 54, 0.55)" },
  /** Candidate marks: each literal is the exact value of its paired token. */
  marks: {
    /** --spoke-works. */
    works: "#2c6b52",
    /** --spoke-unsure. */
    unsure: "#b05f2c",
    /** --spoke-act. */
    act: "#3d5a80",
    /** --spoke-out, composited by the layer at --spoke-out-opacity. */
    out: "#a8a291",
    /** --spoke-surface, also used as the opaque SDF canvas mask. */
    surface: "#fffdf7",
    /** --spoke-out-opacity. */
    outOpacity: 0.6,
  },
} as const;

export const TILE_STYLE = "https://tiles.openfreemap.org/styles/positron";
