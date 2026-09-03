# Spokes — mark and wordmark

Locked from the logo exploration, option **5b** (`Spokes Logo Explorations.dc.html`).
Colours are token names from `tokens.css`; never a raw hex in a component.

## The mark

A hub with six spokes. Five ends are people; the sixth is the empty seat.
22 × 22 viewBox, drawn once, used at every size.

| Part | Geometry | Colour |
|---|---|---|
| Spokes | 6 lines from (11,11) to the hexagon points, 1.8 stroke, round caps | `--spoke-ink` at 55 % |
| Hub | circle r 3.4 | `--spoke-ink` |
| Person ends | circles r 1.9 at (11,2.4) (18.4,6.7) (18.4,15.3) (11,19.6) (3.6,15.3), 0.9 edge | fills `--spoke-person-1…5` in that order, edge `--spoke-ink` |
| Empty seat | circle r 1.9 at (3.6,6.7), 0.9 edge | fill ground (`--spoke-surface`), edge `--spoke-ink-ghost` |

Clockwise from the top: person-1, person-2, person-3, person-4, person-5, seat.
The seat is always top-left. Ends are 1.9, not 1.6 — the edge needs the room.

### The value rule (why it works on both grounds)

The edge on the person ends is **one step further from the ground than the
seat's edge**, in whichever direction the ground allows:

- On cream: edge = ink, seat edge = ink-ghost. Edge darker than seat edge.
- On ink: edge = surface (a halo), seat edge = ink-ghost. Edge lighter than seat edge.

Because the edge is `--spoke-ink` and hosts redefine `--spoke-ink` to surface
on ink grounds (landing.css), the component flips itself. The only extra hook
is `--wordmark-seat`, which the ink host sets so the seat fills with ink.
Never use a ground-coloured halo *and* an ink seat fill — that is what made
the earlier version flip its focus between grounds.

## Wordmark

`Spokes`, `--spoke-font-display` (Bricolage Grotesque) 800, sentence case,
letter-spacing −0.02em, `--spoke-ink`. Glyph 22 px, gap 7 px, text 15 px
(`--spoke-size-title`) in the header and landing bar — unchanged from today.
At wall size (landing hero, print) keep the ratio: glyph ≈ 1.45 × cap height.

## Sizes

- 16 px favicon: the mark alone. Person ends stay r 1.9; nothing is thinned.
- 22 px header: the mark + text.
- 56–66 px lockup: the mark + text at 36–46 px.

## Don't

- Don't colour the ends with semantic tokens (works / unsure / scope / act).
- Don't tint the spokes per person, add a rim, or move the seat.
- Don't fade the seat. Its edge is ink-ghost at full opacity; the fill does the receding.
- Don't put the mark on any ground other than `--spoke-ground`, `--spoke-surface`
  or `--spoke-ink`. On the map plate use the sticker treatment, not the mark.

## Files

- `docs/design/brand/spokes-mark-light.svg`, `docs/design/brand/spokes-mark-dark.svg` — the mark, literal colours
- `docs/design/brand/spokes-lockup-light.svg`, `docs/design/brand/spokes-lockup-dark.svg` — mark + wordmark (needs Bricolage Grotesque installed or the font-face loaded)
- `apps/web/src/components/Wordmark.tsx` — drop-in replacement
- `apps/web/src/landing.css` (`.ld-top[data-ink]`) and `apps/web/index.html` (favicon) — the two hosts around it
