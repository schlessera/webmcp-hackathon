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
 * | #1649a5 #a11d67 #00646b #74510b #6c2b7c | --spoke-person-1..5 |
 * | rgba(51, 65, 54, 0.55)    | --spoke-line      |
 * | #5b6158                   | --spoke-ink-soft  |
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
  /** The circle a distance need reaches, drawn as a dashed outline only: no
   * fill, no dimming, so it never competes with the scope ring's mask. Green
   * when it is measured from a place, the owner's person colour when it is
   * measured from a person. */
  needRing: { color: "#2c6b52", width: 1.5, opacity: 0.55, dash: [2, 4] },
  /** --spoke-person-1..5, in the order `personColor` assigns them. */
  person: ["#1649a5", "#a11d67", "#00646b", "#74510b", "#6c2b7c"],
  /** The optional layers (SPOKES-UI "Layers"). Each is context under the
   * room, so each is drawn in the plate's own family — never in a state
   * colour, which would read as a verdict about a place (§2). */
  layers: {
    /** --spoke-surface-sunk: building bodies, given depth by MapLibre's own
     * vertical shading rather than by a second colour. */
    buildings: { color: "#e9e5da", opacity: 0.92 },
    /** --spoke-ink, thin and faint: rail and transit lines. */
    transit: { color: "#334136", opacity: 0.4, width: 1.6 },
    /** --spoke-ink-soft on --spoke-surface: landmark names, halo'd so they
     * stay legible over the plate without a plate of their own. */
    landmark: { color: "#5b6158", halo: "#fffdf7" },
  },
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

/** The vector source every OpenMapTiles-schema basemap names, and the one the
 * optional building and transit layers read. Absent when the style failed to
 * load, which is why those layers check for it before they mount. */
export const BASEMAP_SOURCE = "openmaptiles";

export const TILE_STYLE = "https://tiles.openfreemap.org/styles/positron";
