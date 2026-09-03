---
name: Spokes
description: A shared map where a group and their agents mark what they know and agree on where to go.
colors:
  notebook-cream: "#fdf8ee"
  page-surface: "#fffdf7"
  sunk-plate: "#e9e5da"
  surveyors-ink: "#334136"
  ink-soft: "#5b6158"
  ink-faint: "#575647"
  ink-ghost: "#8f8975"
  confirmed-green: "#2c6b52"
  confirmed-green-tint: "#dfeee6"
  confirmed-green-text: "#1e5540"
  confirmed-green-pop: "#8fd6b4"
  unverified-amber: "#b05f2c"
  unverified-amber-tint: "#f7e3d6"
  unverified-amber-text: "#8a3f12"
  held-back-violet: "#7d6396"
  held-back-violet-tint: "#ece5f2"
  held-back-violet-text: "#57436b"
  moved-blue: "#3d5a80"
  moved-blue-tint: "#e1e7f0"
  moved-blue-text: "#2b4159"
  ruled-out-grey: "#a8a291"
  person-cobalt: "#1649a5"
  person-magenta: "#a11d67"
  person-teal-ink: "#00646b"
  person-ochre: "#74510b"
  person-plum: "#6c2b7c"
  person-idle: "#e7e2d4"
typography:
  hero:
    fontFamily: "Bricolage Grotesque, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "clamp(38px, 6.4vw, 68px)"
    fontWeight: 800
    lineHeight: 1.02
    letterSpacing: "-0.03em"
  count:
    fontFamily: "Bricolage Grotesque, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "30px"
    fontWeight: 800
    lineHeight: 0.85
    letterSpacing: "-0.04em"
    fontFeature: "tabular-nums"
  title:
    fontFamily: "Bricolage Grotesque, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "15px"
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: "normal"
  place:
    fontFamily: "Bricolage Grotesque, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "12.5px"
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: "normal"
  body:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: 1.45
    letterSpacing: "normal"
  detail:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "11.5px"
    fontWeight: 500
    lineHeight: 1.5
    letterSpacing: "normal"
  label:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "11px"
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: "normal"
  numeral:
    fontFamily: "IBM Plex Mono, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "10px"
    fontWeight: 600
    lineHeight: 1.3
    fontFeature: "tabular-nums"
rounded:
  badge: "6px"
  avatar: "9px"
  sticker: "12px"
  card: "13px"
  block: "14px"
  frame: "34px"
  chip: "999px"
spacing:
  row: "7px"
  group: "9px"
  screen: "16px"
  border: "1.5px"
  tap-min: "44px"
components:
  button-primary:
    backgroundColor: "{colors.confirmed-green}"
    textColor: "{colors.page-surface}"
    typography: "{typography.place}"
    rounded: "0px"
    padding: "0 15px"
    height: "44px"
  scope-chip:
    backgroundColor: "{colors.confirmed-green-tint}"
    textColor: "{colors.confirmed-green-text}"
    rounded: "7px"
    padding: "4px 8px"
  scope-chip-private:
    backgroundColor: "{colors.held-back-violet-tint}"
    textColor: "{colors.held-back-violet-text}"
    rounded: "7px"
    padding: "4px 8px"
  need-row:
    backgroundColor: "{colors.page-surface}"
    textColor: "{colors.surveyors-ink}"
    typography: "{typography.body}"
    rounded: "{rounded.card}"
    padding: "8px 10px"
    height: "44px"
  pill:
    backgroundColor: "{colors.page-surface}"
    textColor: "{colors.surveyors-ink}"
    rounded: "{rounded.chip}"
    padding: "5px 12px"
  count-block:
    backgroundColor: "{colors.confirmed-green}"
    textColor: "{colors.page-surface}"
    typography: "{typography.count}"
    rounded: "{rounded.block}"
    padding: "8px 13px"
  count-block-impasse:
    backgroundColor: "{colors.unverified-amber}"
    textColor: "{colors.page-surface}"
    rounded: "{rounded.block}"
    padding: "8px 13px"
  sticker:
    backgroundColor: "{colors.page-surface}"
    textColor: "{colors.surveyors-ink}"
    typography: "{typography.place}"
    rounded: "{rounded.sticker}"
    padding: "5px 9px 5px 7px"
  badge-scope:
    backgroundColor: "{colors.held-back-violet}"
    textColor: "{colors.page-surface}"
    typography: "{typography.numeral}"
    rounded: "{rounded.badge}"
    padding: "2px 6px"
---

# Design System: Spokes

## Overview

**Creative North Star: "The Field Notebook"**

Spokes is drawn the way a surveyor marks a working page: solid for what is
known, dashed for what is guessed, hollow for what is unverified, and
deliberately small and grey for what has been ruled out. Every visual property
carries a fact. A border style is a claim about certainty. A dot's size is a
claim about relevance. A colour is a claim about meaning, and there are exactly
four meanings. Nothing in the system is decorative, because a decoration in a
notebook is a mark somebody has to interpret.

The temperament is quiet and evidential. The interface recedes so the evidence
reads: warm cream paper (`#fdf8ee`), ink-green text, flat spot colour, hard
offset shadows with zero blur, and one 1.5px rule doing all the structural
work. Nothing glows, floats, or gradients. Depth is a printed offset, not a
light source. When the candidate set changes, places settle in place over
420ms; the page never re-lays-out under the reader, because spatial memory is
what the product is protecting.

The system is built to be read in a narrow column beside a live conversation.
Spokes is a WebMCP surface: it runs inside ChatGPT's in-app browser as the
interactive visualization layer next to the transcript, driven by agent tool
calls and direct touch alike. That means it must stay legible at ~330px, must
never render a chat pane of its own (the transcript is already there, in the
host), and must never look like a widget embedded in someone else's product.
It reads as the map the conversation is about.

**Key Characteristics:**

- Four semantic inks, one meaning each, never borrowed for emphasis.
- Solid / dashed / hollow is an epistemic vocabulary, not a style choice.
- Hard 2px offset shadows, zero blur, on a warm cream ground.
- One 1.5px rule; a full-strength coloured border always means something.
- Absolute counts in a display face, breakdowns in mono.
- Slight rotation (−2°, −4°/3°) so elements read as placed, not rendered.
- Survives greyscale: fill, border style and size differ per state.

## Colors

A warm printed palette: cream stock, ink-green text, and four desaturated spot
colours that never mix. A fifth family, entirely separate, belongs to people.

### Primary
- **Confirmed Green** (#2c6b52): the fact that a place satisfies every active
  need, and the user's own commit action. Solid pins, the count block fill,
  the composer's Add button, the active composer border. It is the only colour
  that means "this holds".
- **Confirmed Green Tint** (#dfeee6) / **Text** (#1e5540): tinted chips and
  labels sitting on cream. **Pop** (#8fd6b4) exists solely for green numerals
  on the ink-dark drawer and delta chip, where the solid green would fail.

### Secondary
- **Unverified Amber** (#b05f2c): data missing, unread, or unconfirmed —
  hollow rings, `?` badges, "3 unsure", and the count block at impasse. It is
  never a failure state and never renders as red.
- **Held-Back Violet** (#7d6396): who may see. Private needs, agent-only
  scope, "only you". It marks visibility and never marks action.
- **Moved Blue** (#3d5a80): someone moved — a proposal, an agent action, a
  staged consent card. It marks authorship and never marks identity.

### Tertiary
- **Person Cobalt** (#1649a5), **Person Magenta** (#a11d67), **Person Teal-Ink**
  (#00646b), **Person Ochre** (#74510b), **Person Plum** (#6c2b7c): assigned
  round-robin by join order for avatars, viewing badges and the wordmark's
  glyph ends. Measured 6.67:1, 5.85:1, 5.56:1, 5.77:1 and 7.42:1 against the
  composited fallback map ground. **Person Idle** (#e7e2d4) is invited but not
  yet arrived.

### Neutral
- **Notebook Cream** (#fdf8ee): the app ground. **Page Surface** (#fffdf7):
  cards, rows, stickers, the composer bar. **Sunk Plate** (#e9e5da): the map
  plate and wells.
- **Surveyor's Ink** (#334136): primary text, the drawer ground, the delta
  chip fill. **Ink Soft** (#5b6158) secondary text, **Ink Faint** (#575647)
  labels and captions, **Ink Ghost** (#8f8975) row indices and placeholders.
- **Ruled-Out Grey** (#a8a291) at 0.6 opacity: a place the needs excluded.
  Deliberately colourless and small.
- Lines and shadows are ink at low alpha: `rgba(51,65,54,.55)` structural,
  `.35` quiet, `.16` ghost, `.30` for every shadow.

### Named Rules

**The Four Meanings Rule.** Confirmed Green, Unverified Amber, Held-Back
Violet and Moved Blue own one meaning each. A component may not borrow
another's colour for emphasis. When two meanings genuinely coincide, draw
both marks — a violet `agent only` badge beside a blue `acting now` chip.

**The No-Raw-Hex Rule.** Every colour comes from `apps/web/src/tokens.css`. If
the value you need is not there, the design is missing a decision — ask, don't
invent. The only literals outside that file are the documented GL paint pairs
in `src/map-theme.ts` and the favicon data URI.

**The Composited Contrast Rule.** These surfaces stack translucent layers, so
a new tint is checked against what it actually composites over — never against
the token beneath it in the file. Body text holds ≥4.5:1 composited.

## Typography

**Display Font:** Bricolage Grotesque, self-hosted subset (with system-ui)
**Body Font:** system-ui (with -apple-system, Segoe UI, Roboto)
**Label/Mono Font:** IBM Plex Mono, self-hosted subset (with ui-monospace)

**Character:** Bricolage's tight, slightly eccentric grotesk carries anything
that names or counts, so names and numbers feel authored. The system sans
carries anything that explains, so explanation reads as ambient rather than
composed. Mono appears only where a numeral needs to sit inside a sentence
without shifting — breakdowns, deltas, wire lines. Body text runs semibold
(600); this is a small, dense interface, and regular weight goes soft on cream.

### Hierarchy
- **Hero** (800, `clamp(38px, 6.4vw, 68px)`, -0.03em): the landing page only.
  Never appears inside a room.
- **Count** (800, 30px, 0.85 line-height, -0.04em, tabular): the big number in
  the count block. The single most-read element in the product.
- **Title** (700, 15px): room title, single line, ellipsis. Panel headings.
- **Place** (700, 12.5px): sticker and place names, and the Add button's word.
- **Body** (600, 13px): brief rows, composer input, panel prose.
- **Detail** (500, 11.5px): card explanations, pill labels.
- **Label** (700, 11px, uppercase for section heads like `WHAT MATTERS`):
  subtitles, chip labels, section heads.
- **Numeral** (600, 10px, mono, tabular): the count subline, row deltas, row
  indices, badge numerals, and every line in the `{ }` drawer.

### Named Rules

**The Two Voices Rule.** Display names and counts; system sans explains. A
heading in the body face is a mistake, and an explanation in the display face
is a louder mistake.

**The Tabular Rule.** Any numeral that changes while the reader is looking at
it is `tabular-nums` in mono or the display face. Counts must not jitter as
the set settles.

## Layout

The room is a fixed frame with exactly one scrolling region. Top to bottom:
status bar (52px, ending flush), header flowing straight out of it with no
containing card, the map edge-to-edge and bounded by 1.5px rules, the brief
(the only thing that scrolls), and the composer pinned 20px from the bottom
with a 16px inset.

Spacing runs on a small, tight rhythm: 7px between brief rows, 9px between
groups, 16px screen padding, `8px 10px` inside a row, `10px 12px` inside a
card. Every structural line is 1.5px. Tap targets are ≥44px, extended with
padding or a `::before` beyond the drawn box — never by growing the visual
element, which is why a 24px pill and a 21px toggle still pass.

Two breakpoints. At ≥980px the room becomes three columns: brief rail left
(320px), map centre, details panel pushing in from the right (380px). Below
that it is the single phone column, and the details panel is a full-screen
takeover — never a bottom sheet, because the map is the context and must stay
visible. The landing page uses its own 720px and 960px steps.

The narrow end of the range is a real target, not a courtesy: ChatGPT's in-app
browser is about 330px wide, so brief rows wrap their badges under the label
rather than overlaying them.

### Named Rules

**The Never Re-Centre Rule.** A change to the candidate set never re-fits
bounds, re-centres, or re-lays-out the map. Places settle where they are.
Only an explicit user action — search, "show me", opening a place — or the
explore layer following a panned viewport may move the view.

**The One Scroller Rule.** Only the brief scrolls. Header, map and composer are
fixed. No nav bar, no tab bar, no hamburger: the room is the whole app.

**The Bottom-Left Rule.** The delta chip sits bottom-left at `z-index: 5`,
because bottom-right belongs to map attribution. Attribution stays 7px with a
9px line-height and never grows; it is a legal requirement, not a UI element.

## Elevation & Depth

There are no soft shadows. Depth is printed: a hard offset in ink at 30%
alpha with zero blur, as if a second impression sat slightly off register.
Three steps — drop, lift, pop — and their difference is distance, not
diffusion. Blur is reserved for the phone shell in mockups and appears nowhere
in the product. Tonal layering does the rest: cream ground, lighter surface
above it, sunk plate below it.

State can promote a shadow into a semantic colour: an applied need row swaps
its ink shadow for `2px 2px 0 var(--spoke-works)`, an unsure row for amber, a
private row for violet. The shadow then carries meaning as literally as the
border does.

### Shadow Vocabulary
- **drop** (`box-shadow: 2px 2px 0 rgba(51,65,54,.30)`): resting elements —
  brief rows, stickers, pills, viewing badges.
- **lift** (`box-shadow: 2px 3px 0 rgba(51,65,54,.30)`): the composer bar, the
  scope menu, the count block's calmer states.
- **pop** (`box-shadow: 3px 4px 0 rgba(51,65,54,.30)`): the count block and the
  selected sticker. The loudest thing on the map.

### Named Rules

**The Zero-Blur Rule.** Never use a blur greater than 0 for structure. If
something needs to feel closer, it takes a longer offset, not a softer edge.

**The Coloured Shadow Rule.** A shadow in a semantic colour always means the
row's border is that colour too. Never colour one without the other.

## Shapes

Rounded but never soft: 12px stickers, 13px cards and rows, 14px blocks, 6px
badges, and a 9px squircle for avatars — deliberately not a circle, so a person
mark never reads as a generic user chip. Pills are the only fully round form
(`999px`), which is what distinguishes an optional suggestion from a stated
need. The phone shell in mockups is 34px.

Form carries certainty. A solid 1.5px border is a claim; a dashed 1.5px border
is a guess or a thing not yet in the room (a pending need, a peer's agent-only
need, a place being previewed away, a queued lookup ring). A hollow ring is an
unverified fact. A bare 8px dot with no border and no label is a place ruled
out. Rotation is part of the vocabulary too: the count block sits at −2°,
stickers carry an oriented tilt, and header avatars alternate −4° / 3° / −2°.

Off the map, states are drawn with the map's own dot vocabulary
(`.mark[data-mark]`): filled works, hollow unsure ring, small grey out, scope
dot, dashed ghost, hollow act.

### Named Rules

**The Marks-Not-Glyphs Rule.** No ✓, ✗ or ● characters anywhere in chrome. A
state is drawn with the map's dot vocabulary so the same shape means the same
thing on the map and off it.

**The Meaningful Outline Rule.** The semantic border is the only full-strength
line in the design; neutral rows use the tinted line. That is what makes an
outline mean something.

## Components

### Buttons
- **Shape:** square where the button is welded into a bar (the composer's Add
  shares the bar's 13px outer radius via `overflow: hidden`); 13px card radius
  when standalone.
- **Primary:** Confirmed Green fill, Page Surface text, display face 700 at
  12.5px, `0 15px` padding at full bar height, divided from the input by a
  1.5px border in the same green. Always a word, never a glyph — no arrow, no
  paper plane, no emoji.
- **Disabled:** 0.55 opacity, default cursor. No colour change.
- **Busy:** when the in-page agent is working, the composer bar's border and
  the Add fill both move to Moved Blue. The button does not spin.

### Chips
- **Scope chip** (inline, left of the composer input): Confirmed Green tint and
  border while Shared; Held-Back Violet tint and border for Private or Agent
  only. 7px radius, `4px 8px`, 10.5px/700, with a `::before` extending the tap
  target to 44px. Scope is chosen *before* speaking, never after.
- **Suggestion pill:** fully round, Page Surface, 1.5px line, drop shadow,
  `5px 12px`, 11.5px/700, count in mono after the label. Generated from server
  facet keys, ordered by count descending. Never hardcoded, never domain-named.
- **Badge:** 6px radius, `2px 6px`, 10px/700. Tinted variants for unsure, act
  and works; solid Held-Back Violet with cream text for a scope badge that must
  read as a hard boundary.

### Cards / Containers
- **Corner Style:** 13px rows and cards, 14px blocks.
- **Background:** Page Surface on Notebook Cream; the map plate is Sunk Plate.
- **Shadow Strategy:** drop at rest, promoted to a semantic-colour offset when
  the row's state has a colour (see Elevation).
- **Border:** 1.5px, tinted line for neutral, full-strength semantic colour
  when the state means something, dashed when the content is a guess or not
  yet in the room.
- **Internal Padding:** `8px 10px` for rows, `10px 12px` for cards, with a
  44px min-height on anything tappable.

### Inputs / Fields
- **Style:** the input has no border of its own. The composer bar owns the
  1.5px line, the 13px radius and the lift shadow; the field is transparent
  inside it at 13px/600 with a 44px min-height.
- **Focus:** the bar's border moves to Confirmed Green when active; the input
  itself has `outline: none` because the bar is the focus surface.
- **Placeholder:** Ink Ghost. Never italic.

### Navigation
There is none, by rule. No nav bar, tab bar, or hamburger. The header carries
the room title, a state subtitle, the avatar row (which opens a roster
disclosure), and the `{ }` drawer control. On desktop the three columns are the
navigation.

### Count block (signature)
Top-left of the map, 14px inset, rotated −2°, 14px radius, pop shadow, and no
pointer events. 30px display numeral over an 11px two-line label over a 10px
mono subline: `6 / still work / of 34 · 4 of them likely · 3 unsure`. Confirmed
Green fill normally; Unverified Amber at impasse or while pending; Page Surface
with ink text before any need exists; and a two-line Page Surface chip once the
room has settled. Counts are absolute, never percentages.

### Brief row (signature)
`[toggle] Dogs can be off-leash −19`. A 36×21px track with a 16px knob, a
13px/600 label, and a trailing signed mono delta or badge. Six variants —
active, just applied, has unknowns, private (yours), agent-only (another's),
pending — each differing in border colour, border style, shadow colour and
trailing mark, so they separate in greyscale. Tap toggles; **press and hold
previews the set without that need**, live on the map, restoring on release,
with a keyboard equivalent and an `aria-live` count announcement. Badges wrap
under the label in a narrow column rather than overlaying it.

### Map sticker (signature)
Page Surface, 1.5px line, drop shadow, 12px radius, an 11px dot, the name in
the display face, and an optional travel-time chip. Works is a filled green
dot; unsure is a 2.5px hollow amber ring with the name in Ink Soft and a `?`
badge; selected is a solid green fill with cream text, pop shadow and the
`spoke-pop` idle breath; proposed is a Moved Blue fill with a `· proposed`
suffix; ruled out is an 8px grey dot with no border and no label. Tilt and
settle-scale ride the individual `rotate` and `scale` properties so a keyframed
`transform` cannot overwrite the positioning translate.

### `{ }` drawer (signature)
A slide-over from the right on the Surveyor's Ink ground, cream text, mono
throughout. Deliberately unstyled-looking: the control that opens it is 22px,
borderless, Ink Soft at 70%, 9px mono, and must never be made prominent.
Everything protocol-shaped lives here — tool names, JSON, versions, timings,
raw payloads, room id.

### Motion
Four animations, and nothing else. **Settle** (420ms, `cubic-bezier(.22,.61,.36,1)`)
when a place enters or leaves the set. **Pop** (3200ms) as the selected
sticker's idle breath. **Breathe** for a place that would come back. **Busy**
(3200ms, one turn in 1.6s) as a dashed ring turning around whatever is being
looked up, rotation only, on its own inner element. `prefers-reduced-motion`
zeroes all four; busy then renders as a standing dashed ring plus text, never
nothing.

## Do's and Don'ts

### Do:
- **Do** take every colour, radius, shadow and size from `tokens.css`, and ask
  when the value you need is missing.
- **Do** draw certainty with border style: solid known, dashed guessed, hollow
  unverified, small grey ruled out.
- **Do** promote a row's shadow to its semantic colour whenever its border is
  semantic, and leave both neutral otherwise.
- **Do** extend tap targets past the drawn box with padding or `::before` to
  reach 44px.
- **Do** keep counts absolute and deltas signed — `−19`, `+3`, `34→15` — with
  the total on the second line.
- **Do** let every control come from server data (`FACETS.md`), ordered by
  count descending.
- **Do** check new tints against their composited background, not the token
  underneath.
- **Do** design for ~330px first: the room runs inside ChatGPT's in-app
  browser beside a live transcript.

### Don't:
- **Don't** borrow one semantic colour for another's emphasis. Show both marks
  when two meanings coincide.
- **Don't** use a blur greater than 0 for structure, or a gradient, glass, glow
  or sparkle anywhere.
- **Don't** write a domain word, chip, icon, category or heading into chrome —
  the app is domain-agnostic permanently.
- **Don't** render unknown as a red or negative state, and never silently drop
  a place for lacking a value.
- **Don't** re-centre, re-fit or re-lay-out the map because the set changed.
- **Don't** let anything protocol-shaped out of the `{ }` drawer.
- **Don't** use ✓ ✗ ● glyphs in chrome; use the map's dot vocabulary.
- **Don't** add a fifth animation, a nav bar, a bottom sheet, or a chat pane —
  the transcript already exists in the host client.
- **Don't** grow the map attribution above 7px, or move the delta chip to the
  bottom-right.
- **Don't** drift toward SaaS dashboard chrome, consumer-maps chrome, or AI
  product chrome (gradient mesh, sparkles, purple-blue accents).
