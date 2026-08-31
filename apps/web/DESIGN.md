# Spokes — web client design system

Operate surface. The negotiation table happens to be a map: group decision
state (eligibility, privacy, consent, agreement) always reads as color and
geometry, never only as text. Excluded options dim but never disappear.

## Tokens (`src/styles.css` `:root`)

- Ground `--ground #f4f3ee` (warm paper neutral), cards `#fff`, ink `#23252d`
  with `--ink-soft` / `--ink-faint` steps, hairlines `--line #e4e2d9`.
- Identity accent: spoke indigo `--spoke #4735d8` (+`--spoke-deep`,
  `--spoke-tint`) — actions, proposals, phase, selection.
- Semantic eligibility trio (each with a tint): eligible `#0e7a63` (teal),
  uncertain `#b26205` (amber), excluded `#a3a5a0` (dimmed, smaller pin).
- Privacy is violet `--privacy #7c3aed` (badges, private decision cards,
  redacted feed lines in italic violet). Vetoes/danger `#c22f3d`.
  Committed destination is gold `#b8860b` (star pin, commit button).
- Radius 10px, soft offset shadows (`--shadow`, `--shadow-lift`), system font
  stack, 15px base.

## Components

- Pins: 22px color-filled dots, white ring; excluded 14px at 65% opacity;
  proposal = outer indigo ring (dashed red when vetoed); committed = gold ★;
  selection = indigo halo. Pins are DOM markers — legible without WebGL.
- Scope ring: dashed indigo circle, 5% fill; radius changes tween ~700ms
  ease-out (the widen-the-area demo beat). This is the page's one authored
  motion moment, plus `sheet-in` entrances; no scattered hover effects.
- Chips (phase/feasibility), badges (shared / private / agent-only / hard /
  soft), segmented controls (`.seg`), buttons `.btn` with `-primary`,
  `-accept`, `-danger`, `-gold` variants.
- Decision cards: neutral (stances), violet tint (private requests), indigo
  tint (in-page confirmations), never thick colored side borders.
- Layout: stacked header → map (52vh) → tabbed panel; the three-window demo at
  ~620px wide is the primary composition; ≥980px goes side-by-side (400px
  panel). The shell scrolls (`.app` overflow) — panels never squeeze the tabs.

## Rules

- Every negotiation-meaningful gesture dispatches the same command an agent's
  tool produces; UI reflects mutations before tool results resolve.
- Peer privacy renders as the server sent it: redacted lines stay redacted,
  styled distinctly (italic violet), never reconstructed client-side.
- Attribution (OpenFreeMap/OpenMapTiles/OSM + OSRM/FOSSGIS) always visible on
  the map. Light theme only, by commitment.
