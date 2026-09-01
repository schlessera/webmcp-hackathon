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
  selection = indigo halo. Pins are DOM markers — legible without WebGL —
  and keyboard-reachable (tabIndex, Enter/Space).
- Legend: a live pill bottom-left on the map (`.map-legend`) teaching the
  color language with real counts (`21 eligible · 3 checking · 7 out`);
  proposed/agreed rows exist only while such a pin does. Pointer-inert,
  never covers attribution.
- Scope ring: dashed indigo circle; everything OUTSIDE the range is dimmed by
  an inverse mask (ink at 14%), so the searchable area reads as the bright
  spotlight. Proposed pins scale up with a soft pulsing indigo ring (paused
  under prefers-reduced-motion); vetoed pins desaturate, keep a dashed red
  ring, and carry a red ✕ badge. Radius changes tween ~700ms
  ease-out (the widen-the-area demo beat). The page's TWO authored motion
  moments are this tween and the commit celebration (six gold spokes — the
  wordmark motif — converge on the star once, on commit only, disabled
  under prefers-reduced-motion), plus `sheet-in`/`toast-in` entrances; no
  scattered hover effects.
- Wire view (`.dev-tools`): the collapsed bottom `<details>` is a designed
  trust feature, not scaffolding — "what actually crossed the network",
  with monospace reserved for actual wire data.
- Chips (phase/feasibility), badges (shared / private / agent-only / hard /
  soft), segmented controls (`.seg`), buttons `.btn` with `-primary`,
  `-accept`, `-danger`, `-gold` variants. Phase chips carry human labels
  ("Gathering needs", "Deliberating", "Agreed", "On our way"); wire enums
  live in the title attribute and the wire view.
- Toasts: top-center under the header; success auto-dismisses at 4s,
  errors stay until dismissed.
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
