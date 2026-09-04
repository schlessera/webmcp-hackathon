# Spokes — component spec

Anatomy, states and do/don't for every component in the redesign.
Colours are token names from `tokens.css`; **never** a raw hex.

Reference mockups live in `Spokes - Mapview Redesign.dc.html`:
`4a` (locked phone layout), `7a`–`7d` (flow states), `8a`–`8f` (details,
drawer, desktop, consent, brand), `9b` (accent decision).

---

## 0. The semantic contract

Four meanings, four colours, no overlap. This is the spine of the whole UI.

| Token | Means | Example |
|---|---|---|
| `--spoke-works` | satisfies every active need | solid pin, "6 still work", your commit button |
| `--spoke-unsure` | data missing or unverified | hollow pin, "3 unknown", `?` badge |
| `--spoke-scope` | who may see | "private", "agent only", "only you" |
| `--spoke-act` | someone moved | proposal sticker, agent staged, consent card |
| `--spoke-out` | ruled out | 8px grey dot, no border, no label |

**Do not** borrow another meaning's colour for visual emphasis. If two
meanings coincide (a background agent action that is also agent-only), show
**both** marks — see `8d` card 3, which carries a violet `agent only` scope
badge beside a woad `acting now` chip.

---

## 1. Screen frame

```
status bar          52px, ends flush — no card, no divider
header              title + subtitle + avatars + { }
map                 full bleed, 1.5px rule top and bottom
brief               scrollable, fixed height
composer            pinned bottom, 20px from edge
```

- The header flows straight out of the status bar (mockup `4a`). No
  containing card — that was the old design and it wasted ~120px.
- The map is **edge to edge**, bounded by rules, never a rounded card.
- Only the brief scrolls. Header, map and composer are fixed.

**Don't** add a nav bar, tab bar, or hamburger. The room is the whole app.

---

## 2. Header

| Part | Spec |
|---|---|
| Title | glyph + `Spokes`, then `·` and the room's name, `--spoke-font-display` 700 / 15px, `--spoke-ink`, single line |
| Subtitle | `--spoke-font-text` 500 / 11px, `--spoke-ink-soft` |
| Avatars | 26px squircle `--spoke-radius-avatar`, 2px `--spoke-ground` ring, −6px overlap, alternating rotation −4° / 3° / −2° |
| `{ }` | 22px, borderless, `--spoke-ink-soft` at 70%, 9px mono |

The wordmark is permanent. A room's name — its goal, or the committed place
once the room agrees — is appended after a `--spoke-ink-ghost` separator, never
substituted for the wordmark: the app does not lose its own identity to its
content. The wordmark holds its width and the name is what ellipses when the
header runs out of room. Before a room has a name, the separator and the name
are both absent.

The subtitle is **state, not metadata** — it changes with the room:
"Sunday 10:00 · Mitte" → "nothing works for all three" (`--spoke-unsure-text`)
→ "agreed by all three · 10:00" (`--spoke-works-text`) → "you were away 2 hours".

Absent participants use `--spoke-person-idle`.

Person identity uses its own five-hue family: cobalt, magenta, teal-ink,
ochre-brown and plum (`--spoke-person-1..5`). None is a semantic or grey hue.
The same five colour the ends of the wordmark glyph; the mark and wordmark
are specified in `SPOKES-BRAND.md`.
Against the composited fallback map ground (`--spoke-surface-sunk` under the
18% works colour wash), the five contrast ratios are 6.67:1, 5.85:1, 5.56:1,
5.77:1 and 7.42:1 respectively.

Tapping the avatar row opens a small roster card under the header — every
person by name with "here now" / "arrived" / "not arrived yet" — so names and
presence are reachable on touch, not only on hover. It closes on Escape, on an
outside tap, or on the row again. It is a disclosure, not navigation.

**Don't** make `{ }` prominent. It is a debugging affordance: no border, no
fill, no label. Everything protocol-shaped lives behind it.

For a goal-first room, the unresolved header title is the room goal verbatim.
After agreement, the committed place keeps the title as before. A legacy room
without a supplied goal receives the server's area-based goal and uses the
same line; the client never composes a domain label there.

### Before the room: goal review

The Start screen keeps the area picker and names, with one optional, one-line
goal field above them. A class selector is always present and contains only
server-provided classes; the compatibility fallback is the single server
default class. Start is a pre-room screen and scrolls vertically within the
viewport; the room's “only the brief scrolls” invariant begins after entry.

A non-empty goal opens a dashed review card before creation:

- `From what you said`, then the server title and selected class;
- every parsed need as a dashed pending row with the map's ghost mark;
- a `Leave out` control whose target is at least 44 px;
- clarification choices plus one free-text field when requested;
- one final `Open the room` action carrying only the needs still shown.

Pending here means “not in the room yet”. It never borrows works or unsure,
and it has no count. Reading the goal and opening the room use the standard
`spoke-busy` ring; no fifth loading animation is introduced. A failed or
timed-out review becomes the same class-only card and never disables room
creation. The invites screen repeats the goal above the invite links.

---

## 3. Map

### Pins & stickers

| State | Drawn as |
|---|---|
| Ruled out | 8px dot, `--spoke-out` at `--spoke-out-opacity`, **no border, no label** — unless it wins one of the last name slots, when it takes the muted card below |
| Works | sticker: `--spoke-surface`, 1.5px `--spoke-line`, `--spoke-shadow-drop`, 11px `--spoke-works` dot, name, optional travel-time chip |
| Unsure | as works, but hollow dot (2.5px `--spoke-unsure` ring on surface), name in `--spoke-ink-soft`, `?` badge in unsure tint |
| Selected | filled `--spoke-works`, cream text, `--spoke-shadow-pop`, `spoke-pop` idle animation |
| Proposed | filled `--spoke-act`, cream text, label suffix `· proposed` |
| Vetoed | hollow act: surface plate, 1.5px `--spoke-act` border, act shadow, name in `--spoke-act-text` struck through, `ruled out` chip. The place keeps its eligibility — a veto blocks agreement, it does not rule the place out |
| Staged | as proposed, suffix `· staged`, no idle breath (the decision is on the page now) |
| Settled | as selected (works fill, cream), suffix `· settled` |
| Would come back | dashed 1.5px `--spoke-works` border, dashed dot, `+n` chip, `spoke-breathe` |
| Being looked up | any of the above, plus a 24px dashed ring in the state's own colour turning around the dot (`spoke-busy`, `data-busy`). A ring, never a spinner glyph; with reduced motion it stands still |

Precedence, first match wins: selected → settled → staged → vetoed →
proposed → would come back → works / unsure / out.

Stickers sit at −3° to +3°. Vary the angle between neighbours; never align
two adjacent stickers to the same rotation.

Name slots go out in rank order (amended 2026-09-03):

1. open — this viewer has the place open, or a peer is looking at it (the
   card is what the panel and the presence badge hang off);
2. accepted — settled, or staged awaiting consent;
3. on the table — an open proposal, including one carrying a standing veto;
4. confirmed places, including a "would come back" preview;
5. likely places;
6. any place with a lookup in flight — being looked up is a *floor*, never a
   demotion, so a busy confirmed place keeps rank 4 and a busy unknown,
   unlikely or ruled-out one rises to here;
7. not yet known;
8. unlikely;
9. ruled out.

Out-of-scope places are still refused a card outright. Everything in scope is
nameable, but with 18 slots the last two ranks only take one when the live
options have not, so the visible effect is small. A card on an unlikely or
ruled-out place is drawn muted — quiet or ghost rule, no drop shadow, name in
`--spoke-ink-soft`, the state's own dot — readable without ever reading as an
option. A ruled-out place that wins no slot keeps its bare 8px dot, and the
leaver fade is unchanged. A proposal whose status is vetoed or withdrawn has
left the table and falls back to the place's eligibility rank. When a place
leaves the named set, its card collapses onto its own dot over the settle
duration — the scale runs about the anchor, so the dot never moves (§8).

Every card has two mirrored orientations, recorded as `data-side` for the
side carrying the dot: `left` puts the dot left of the name and extends the
card right; `right` puts the dot right of the name and extends the card left.
The dot centre is the invariant anchor and lands exactly on the place's map
position in either orientation; tilt mirrors around that anchor. Prefer the
inward-facing orientation near a band edge, otherwise use the greedy
placement pass to avoid cards and neighbouring dots. Re-evaluate orientation
only on `moveend` and viewport resize, never during a drag. A card must remain
inside both sides of the map band; if neither orientation fits, draw the dot
only.

The map's own overlays own their corners. A card is refused any placement that
would land in the count block's rectangle, the delta chip's, or the controls'
(`.map-top-right`) — all three measured live, because each sizes to its own
text — and the place keeps its bare dot instead. The rule holds in the
last-resort pass too: a name under a solid overlay is not a name.

Three depths, and markers own only the lowest of them:

| Layer | `z-index` |
|---|---|
| markers — a bare dot 1, a named card 10, selected 14, the starting-point mark 16 | 1–16 |
| readouts — the count block, the delta chip | 18 |
| controls — `.map-top-right`, `.map-nav-actions` | 20 |

A readout is never read through a label, and never covers a button.

A name card always stacks above every unlabelled dot, regardless of either
place's state. DOM marker wrappers use two explicit tiers: dot-only markers
at 1–3 by state, and carded markers at 10+, with selected, settled, staged
and proposed cards above the ordinary card tier. Presence badges stay inside
their marker's tier. Hover and keyboard focus lift the whole marker above
both tiers; stacking never changes a marker's size or position.

A map tap resolves in this order: first, a DOM name card whose drawn box
contains the point; second, the nearest DOM or GL dot within the 22px reach;
third, an explore dot; otherwise nothing. The card owns its whole box, name
included, even when a bare dot lies nearer or underneath it. A dot-only
mark keeps nearest-dot routing, and keyboard selection is unchanged.

> **Implementation trap.** Position on an outer wrapper, animate on an inner
> element. An `animation` that sets `transform` will silently overwrite a
> positioning `translate` and the sticker will jump to the anchor point.

### Scope ring

Dashed 1.5px circle at 40% opacity, with everything outside dimmed 8% via an
SVG mask. When an agent widens the area, draw the **proposed** radius as a
second, fainter dashed ring (`8d`, `7b`) so the change is visible before it
is accepted.

### You mark

The viewer's own origin is a small `data-mark="you"`: a
`--spoke-scope` ring with a centre dot, inside a 44px target. It never uses
`--spoke-act` because it describes private scope, not authorship. It is
draggable only after the viewer chooses **Set where you start** in their own
roster row. Arrow keys nudge it while that mode is active. Enabling, dragging,
and the resulting recount never pan, fit, or re-centre the map. Peer coordinates
reach the client only when that person explicitly shares on the presence
channel; the durable label never does.

### Person marks

An opted-in peer position is a 26px initials badge in that person's colour:
display face, rounded square, 2px `--spoke-surface` halo and 1px
`--spoke-ink` outline. It has no name card and is never a circle or
`.marker-dot`. Initials plus square geometry keep it distinct from every place
dot in greyscale. The viewer's own **you** mark stays the scope ring and centre
dot described above. Position frames never pan, fit or re-centre the map.

### Referent marks

Every active scope need measured from something other than `self` carries a
small anchor at the resolved measuring point and a tiny server-authored label
card. Both use the `--spoke-scope` family: the mark describes where a scope
need applies from, never an action or an author. A participant referent whose
position is unavailable to this reader has no map mark; its brief label remains
visible in privacy-safe words. Adding, moving or removing a referent mark never
pans, fits or re-centres the map and introduces no animation.

When landmark wording has several plausible matches, the agent reply card
holds at most three choice pills. Each is a keyboard-reachable button with a
44px minimum target; choosing one states the corresponding need and dismisses
the card.

### Refinement (2026-09-03)

The room keeps looking things up on its own (docs/ENRICHMENT-SOURCES.md,
"Continuous refinement"). What the page shows, and only this:

- Places being worked on carry the busy ring (the `lookups` frame with
  `reason.kind: "refine"` drives it exactly like a need-triggered lookup).
- The count block's progress slot says `looking up N · M to go` while the
  frame names places; whole-area fill still wins the slot while it runs.
- A quiet mono line under the count, `.count-refine`: `checked N places
  for K needs · M to go` from the context's `refine` view; `paused for
  now` when the room is out of budget. Announced to screen readers at most
  once every 10 s (`aria-live="polite"`, batched), never per frame.
- A question need (criterion `q:`) that has answers shows `· looked up`
  beside its label; its badges are the live likely / unlikely / unknown.
- In the place panel a web-derived fact carries a citation link,
  `from example.org ↗`, opening in a new tab; 44px tall through padding.
  A fact settling while the panel is open changes colour and edge on the
  settle duration — no movement, no new keyframe.

### Count block

Top-left, 14px inset, rotated −2°, `--spoke-radius-block`, `--spoke-shadow-lift`.

```
6            ← 30px display, 800
still work   ← 11px, two lines
of 34 · 4 of them likely · 3 unsure   ← 10px mono
```

The big number is confirmed plus likely: a guess with a reason is an option
the room can act on. The subline breaks that number down ("4 of them likely"),
and unsure and unlikely stay counted apart from it. The wire keeps
`matching` eligible-only (SPATIAL-PROTOCOL §8.2); the sum is a display
decision, made in the client. The delta chip stays on the eligible-only
base, so its `+3` and `−19` are about confirmed gain and loss.

- Normal: `--spoke-works` fill, cream text.
- Impasse (0): `--spoke-unsure` fill.
- Pre-need (nothing ruled out): `--spoke-surface` fill, `--spoke-ink` text,
  and the number counts *places*, not survivors — "14 green spaces".
- Agreed: shrinks to a two-line "Settled / 18 min from you" chip.

### Delta chip

Bottom-**left**, 12px inset, `z-index: 18` (above attribution and every
marker, below the controls), `--spoke-ink` fill, `--spoke-works-pop` numeral.
Bottom-left because bottom-right belongs to map attribution. Name cards are
refused its rectangle, which is measured while the chip is mounted.

### Presence

No cursors (REDESIGN-HANDOFF D4). A person who has a place **open** is drawn
on that place: an 18px squircle with their initials in their person colour,
1.5px `--spoke-surface` ring, `--spoke-shadow-drop`, peeking out from behind
the sticker's right edge (translated 60% past it, stacked under the card) —
or from behind the bare dot when the place has no name card. Several
viewers overlap by −7px like the header avatars. Never the viewer's own
initials, never a semantic colour. It rides on the presence frame
(`viewing`), so it is gone the moment the panel closes or the tab does.

An opted-in live position rides on the same presence frame as `positions` and
disappears when sharing stops or the person's last socket closes. This is the
26px person mark above, not the smaller viewing badge tucked behind a place.
The header avatar carries a small square showing mark while its position row is
present; the round dot continues to mean here now.

### Find a place, and the layers control

Both live in one right-anchored row at the map's top (`.map-top-right`,
`z-index: 20` — in front of every marker), so the count block keeps the
top-left corner it owns and no name card is drawn into either corner. The row
takes what the count block leaves of the band (`--count-block-w`, measured),
wrapping rather than shrinking a control; an open field takes the whole band,
being transient and asked for. Below 560px the count block is most of the
band, so the row sits under it (`--count-block-h`) instead of beside it.

**Find a place** (`MapFind.tsx`) is a `Find a place` chip until it is asked
for, then a field of `min(300px, 100vw − 190px)` with the matches beneath it
in a `--spoke-surface` card. Matching runs server-side over the room area's
snapshot — the same rows the explore layer draws — by name only, forgiving
accents, punctuation, word order and one wrong letter. At most 8 matches, each
a ≥44px row with the name above its place class. ↓/↑ move, Enter chooses,
Escape clears then closes, and the match count goes out on `aria-live`.

Choosing a match makes it the **target**. The map flies to it and centres on
it (an explicit action, the §8 exception), and the chip becomes the target's
name beside a `✕`: the map always says what it is centred on, and the one
control that lets it go sits next to it. Tapping the name searches again.

The target is drawn, not selected. Its card is forced into the named set
whatever its rank, sits at `z-index: 15`, takes the suffix `· found`, and
carries a second `--spoke-ink` ring at 2.5px offset with a 1.06 scale and the
lift shadow. The ring is form, not colour — the dot inside still says whether
the place works, and a fifth colour would claim a fifth meaning (§2). A target
the room does not hold is drawn as a card of its own (`found-marker`) with the
explore layer's grey dot.

What *opens* depends on the width, because the detail is a panel beside the
map on desktop and a full screen over it on mobile:

- **≥980px** — the detail opens with the target: its panel when the room holds
  the place, its explore card (also ink-ringed) when it does not.
- **<980px** — nothing opens. Opening a full-screen detail would hide the very
  place the viewer asked to see, so the target is drawn and its detail is a
  second tap on the card.

Dismissing the target with `✕` returns the chip to `Find a place` and closes
whatever the target opened.

**Layers** (`MapLayers.tsx`) is a `Layers` chip whose panel carries one
checkbox per optional layer: buildings in 3D, places not in the room,
landmarks, transit lines. The chip's border goes to `--spoke-ink` while any
layer is on. Every layer is *context under the room* and is painted in the
plate's own family (`MAP_THEME.layers`) — never in a state colour, which would
read as a verdict about a place. Nothing the room decided is ever behind a
switch.

- **Buildings in 3D** — `fill-extrusion` from the basemap's own building
  layer, beneath the first label layer, `render_height` where OSM has one and
  6m where it does not. Turning it on pitches the camera to 48°, which is a
  camera state, not an animation; reduced motion arrives at the same pitch
  instantly.
- **Places not in the room** — the explore dots' own visibility. On by
  default; while off, the layer takes no taps either.
- **Landmarks** — the area snapshot's landmark rows (the same rows a distance
  need measures from): a 2.5px `--spoke-ink-soft` mark on the anchor with the
  name under it, halo'd in `--spoke-surface`, loaded for the viewport the
  viewer panned to. The mark is what keeps it from reading as a second copy of
  a basemap label.
- **Transit lines** — rail and transit from the basemap's transportation
  layer, `--spoke-ink` at 40%.

### Attribution

7px, 9px line-height, no min-height, 62% white plate, 42% ink. It is a legal
requirement, not a UI element. Never let it grow.

---

## 4. Brief — "What matters"

The group's stated needs, each toggleable. **This replaces all predefined
filter controls.** Every row comes from data; the app ships zero domain chips.

Header: `WHAT MATTERS` (display 800, 12px, uppercase) + count badge.

### Row anatomy

```
[toggle]  Dogs can be off-leash                    −19
```

- Row: `--spoke-surface`, 1.5px border, `--spoke-radius-card`,
  `--spoke-shadow-drop`, padding `8px 10px`, gap 9px.
- Toggle: 36×21px track, 16px knob, no border on the knob.
- Label: 13px / 600, `--spoke-ink`.
- Trailing: signed delta in mono, or a badge.

### Row variants

| Variant | Border | Shadow | Trailing |
|---|---|---|---|
| Active, shared | `--spoke-line` | `--spoke-shadow` | `−19` in `--spoke-ink-soft` |
| Just applied | `--spoke-works` | `--spoke-works` | `−3` in `--spoke-works-text` |
| Has unknowns | `--spoke-unsure` | `--spoke-unsure` | `3 unknown` badge |
| Private (yours) | `--spoke-scope` | `--spoke-scope` | `private` badge |
| Agent-only (other's) | 1.5px dashed `--spoke-line` | none | `agent only` badge |
| Pending (just said) | 1.5px dashed `--spoke-line` | none | busy ring + `checking 12 places…` |

A need is **pending** from the moment it is said until the room has committed
it and the first round of lookups it triggered has landed (or 8 s, whichever
first). The row exists at once — the person sees their own words on the
brief before the server answers — and settles into its real variant when the
count does. The count block carries the same state: `checking 12 for
step-free access`. `aria-busy` is set on the brief while a need is pending
and the count is announced once, when it settles.

The semantic border is the **only** full-strength line in the design. Neutral
rows use the tinted line. That way an outline means something.

**Interaction.** Tap toggles. **Press and hold previews the set without it** —
the map re-settles live and returns on release. This is the core gesture of
the app; do not replace it with a modal.

**Don't** show another person's private need's content, ever. Show the row as
dashed with an `agent only` badge and no label text beyond who holds it.

---

## 5. Composer

Pinned, 16px inset, 20px from the bottom.

```
┌──────────────────────────────────────────┐
│ [Shared ▾]  What matters to you?    [Add]│
└──────────────────────────────────────────┘
```

- One bar, 1.5px `--spoke-works` border, `--spoke-radius-card`,
  `--spoke-shadow-lift`, `overflow: hidden`.
- **Scope selector inline on the left** — a small `--spoke-works-tint` chip
  reading `Shared`, opening to `Private` / `Agent only`. Scope is chosen
  *before* speaking, never after. Each option carries one line saying what
  leaves the device and what the room sees, at the point of choice.
- Input: transparent, no border of its own, 13px / 600, `min-height: 44px`.
- **Add**: flush right, full bar height, `--spoke-works` fill, cream, divided
  by a 1.5px border. A word, not a glyph — no arrow, no paper plane, no emoji.

Above the bar, when the server returns facets: a `Also worth asking for` label
(11px / 700, `--spoke-ink-soft`) and pill suggestions.

### Suggestion pills

`--spoke-radius-chip`, `--spoke-surface`, 1.5px `--spoke-line`,
`--spoke-shadow-drop`, padding `5px 12px`, 11.5px / 700, with the count in
mono after the label. ~28px tall — extend the tap target with padding, don't
grow the pill.

Pills are **generated from facet keys the server returned for the current
candidate set** (see `FACETS.md`). Order by count descending. Never hardcode.

---

### Hover card

A dot or name card whose summary carries `image` shows a floating card after
120 ms under a fine pointer (`pointer: fine`, never touch) or when keyboard
focus lands on it: the name in the display face and a 172 px card with the
first photo (3:2). The blurhash paints first, the bytes replace it. The card
has `pointer-events: none` so the cursor moves freely between dots; it sits
above the dot, below it near the top edge, clamped inside the band, and goes
on move start, drag, blur, leave and mouse-out. It is not an animation: only
its opacity rides the settle token, and reduced motion zeroes that. GL dots
without a DOM marker get the card through the nearest-dot rule on mousemove.

### Photo band placeholder

The details panel reserves the photo band's box from first paint whenever
the summary says a photo exists — the band's fixed 3:2 crop — with the
blurhash as background, so the facts below never move when the bytes land.
When the summary promises no photo there is no box and no copy: the panel's
nav control already says a lookup is running, and a second place saying it
only cost a row that appeared and vanished under the reader.

## 6. Place details

Side panel that pushes the map on ≥980px; full-screen takeover on phone
(`8a`). Never a bottom sheet — the map is the context and must stay visible.

The panel is **schema-driven**. It renders whatever attribute groups the
server sends, in server order. There is no restaurant layout, no cinema
layout — one layout that adapts.

```
[refresh | ring + "reading the site…"]   [close]
Name
why it's in / why it's out        ← verdict strip
─────────────────────────────────
Does it fit                       ← per need: mark · need · answer in words
─────────────────────────────────
Where everyone stands             ← one line of badges, marks in the corners
─────────────────────────────────
Where and when                    ← open now · address · phone
hours for 7 days on record        ← the week folds behind its count
─────────────────────────────────
Also on record                    ← 12 on record · 3 not on record
Facts from OpenStreetMap.         ← one sources line for the whole panel
─────────────────────────────────
[Put it forward]  [Rule it out]
```

- **Verdict strip first.** The user's question is always "why is this here?"
- **The marks are the map's dots, off the map.** Filled `--spoke-works` =
  clears it; hollow `--spoke-unsure` ring = nobody could confirm; small grey
  `--spoke-out` = fails; `--spoke-scope` = a private condition; dashed ghost
  ring = silent; hollow `--spoke-act` ring = a veto. Size, fill and border
  differ per mark, so a row reads in greyscale. **No glyphs** — no ✓, ✗ or
  tick characters anywhere in the panel.
- Each need row answers in words ("yes", "nobody could confirm", "about €15
  each", "your agent passed it"); unknown is a state, never a failure.
- A peer's private need is a row too, reduced to its effect on this place
  ("ruled it out" / "not yet checked" / "passes") — never its content.
- Facts already answered under "Does it fit" do not repeat below; unknown
  facts are a count ("3 not on record"), not a list of question marks.
- Provenance is one line under the facts, not a column per row.
- **Don't** invent icons per attribute type; label + value in the type ramp.
- **Where everyone stands is one line.** Each person is a 26px badge in
  their own colour with the header's avatar geometry, carrying two corner
  marks: their stance (filled works = in, hollow act ring = ruled it out,
  dashed ghost ring = nothing said) and, separately, a round ink dot when
  they have this place open. Two meanings never share a mark, so somebody
  can be silent and looking at once. The sentence — "Sarah is in",
  "You haven't said", "· looking now" — is the badge's title and its
  screen-reader text.
- **One nav control, two faces.** Top-left is a single element. While
  anything is running it is the busy ring plus the step in words —
  `reading the site…`, `checking it against your needs…`,
  `reading the record…` — announced politely. When nothing is running it is
  a refresh affordance labelled "Look it up again", whose title carries what
  the last read left: `looked up just now · 3 facts changed`,
  `looked up 4 min ago`, or `what the record says`. Only the refresh face
  waits on the phase; the busy face speaks in any phase. Close is a stroke
  glyph alone top-right. Both are drawn at 16–18px and reach 44px through
  `tap-44`. Facts that arrive update their rows in place; the first render
  never looks final.
- **The two folds.** "Where and when" keeps the open-now line, the address
  and the phone; the per-day rows sit behind `hours for 7 days on record`,
  which counts weekdays the lines can draw, never schedule rows — a split
  shift or an overnight range is one day, and seven is the ceiling.
  "Also on record" shows only `12 on record · 3 not on record` until it is
  asked to open. Both start closed, both are absolute counts and never an
  instruction, and neither hides that the facts exist.
- The "Does it fit" rows come from the server's per-need verdicts on the
  dossier (`needs[]`); the client never parses a need label. A guess names
  its evidence under the answer in the reader's words ("the menu mentions a
  vegan bowl") and its confidence as a word — "likely", "fairly sure",
  "a guess" — never as a number.
- Address, phone and opening hours sit in a "Where and when" group when the
  record carries them; hours group consecutive days with the same times and
  stay folded behind their count.
- **Photo band.** When the dossier carries images, the band sits at the top
  of the scrolling panel, before the name. One image fills the width at a 3:2
  crop (`object-fit: cover`). Two or three images form a horizontal
  scroll-snap band with targets at least 44px; there is no autoplay or
  auto-advance. Each image loads lazily, uses the place name as alt text, and
  sits in a reserved 3:2 box while its authenticated same-origin bytes load,
  so the panel does not shift. One source line below follows the visible
  image: `from the place's site ↗`, or
  `photo · <credit> · <actual licence> ↗` for Commons. It links the source
  page in a new tab. With no images the entire band and source line are absent
  — no placeholder, empty frame, or missing-photo copy.

---

## 7. Consent cards

Three rungs of authority, and the ladder must read as authority — **all three
are `--spoke-act`**, because in every case an agent moved. Scope badges inside
them stay `--spoke-scope`.

| Rung | Card | Primary action |
|---|---|---|
| 1 · within the grant | act border + tint | `Accept` |
| 2 · beyond the grant, staged | act border + tint | `Confirm` (+ `Cancel the grant`) |
| 3 · agent-only screening in progress | neutral surface, act shadow, `acting now` chip | none — it's status |

Rung 2 must state the boundary numerically: "Widen from 900 m to 1.4 km —
beyond the 1.2 km you delegated. Your agent staged it; only this gesture
applies it."

**Don't** let a consent card be dismissed by tapping outside. It is a
decision, not a notification.

---

## 8. `{ }` diagnostics drawer

Slide-over from the right, `--spoke-ink` ground, cream text, mono throughout.

Header: `{ } under the hood` + `Close`. The reassurance chip
("nothing here is needed to use the app") sits on its **own line** beneath —
it is an aside, not a peer of the title.

Contents: connection state, protocol version, the tool-call log with
timestamps, raw candidate payload, facet response, room id.

**Everything protocol-shaped lives here and nowhere else.** If a wire concept
(tool names, JSON, version strings, MCP vocabulary) appears in the main UI,
it is a bug.

---

## 9. Desktop ≥980px

Three columns (`8c`): brief rail left (320px), map centre, details right
(pushes in, 380px). Chat lives in the user's own client beside the browser —
the app never renders a chat pane. The in-page agent (`docs/NL-AGENT.md`)
keeps that rule: it speaks through the composer and answers as a "Your
agent" card in the brief, dismissed by the reader.

Agent turns in the transcript name the change they made and its delta, so the
chat and the map never disagree.

---

## 10. Motion

Three gestures and the settle. Everything else is instant.

1. **Settle** (`--spoke-dur-settle`, 420ms) — when the candidate set changes,
   places that leave fade to `--spoke-out` in place; places that return grow
   from their dot. Never re-layout the map, never re-centre.
2. **Pop** (`--spoke-dur-pop`) — the selected sticker's idle breath.
3. **Breathe** (`--spoke-dur-breathe`) — a "would come back" sticker.
4. **Busy** (`--spoke-dur-busy`, one turn in 1.6 s) — a dashed ring turning
   around whatever is being looked up: a dot on the map, a pending need row,
   the panel's lookup line. Rotation only, on an inner element. Shown only
   for work that takes longer than a glance; a sub-second answer never
   flashes a ring.

Respect `prefers-reduced-motion`; the tokens zero all four, and busy then
stands as a still dashed ring beside its text.

---

## 11. Accessibility floor

- Tap targets ≥ 44px, extended beyond the visual box where the drawn element
  is smaller (pills, `{ }`, toggles).
- All body text ≥ 4.5:1 against its **composited** background. The palette in
  `tokens.css` is verified at AA; new tints must be re-checked.
- Colour is never the only signal: works/unsure/out also differ in **fill,
  border style and size**, so the map survives colour-blindness and greyscale.
- The press-and-hold preview needs a keyboard equivalent (focus + hold Space)
  and an `aria-live` announcement of the new count.

## The pipeline ring and dot stages

One widget in the count block replaces the lookup and refinement lines once
the server sends `pipeline` frames: a 16 px determinate ring (`--spoke-ink-soft`
on `currentColor`, fill on the settle duration, static under reduced motion)
beside "checked N of M places for K needs" and, while anything is in flight,
"· N reading · N checking". `role="progressbar"` with `aria-valuemin`,
`aria-valuemax`, `aria-valuenow` (omitted while paused) and `aria-valuetext`
carrying the sentence; one `aria-live` summary at most every 10 s. Drained:
nothing is drawn. Whole-area fill keeps the slot while it runs.

Every place in the pipeline carries one displayed stage, drawn with the
map's own ring vocabulary and no new colour or animation:

| stage | ring | motion |
|---|---|---|
| queued | 24 px dashed ring, the state's colour at 40 % | none |
| fetching | 24 px dashed ring, full | turns (`spoke-busy`) |
| processing | 24 px ring drawn as one 270° arc | turns (`spoke-busy`) |
| settled | no ring | — |

Stages differ in stroke and opacity, never hue, so they survive greyscale and
stand still under reduced motion while staying distinguishable. DOM markers
expose `data-stage`; GL dots carry a `stage` feature-state beside `busy`.

Opening a place is the fast track: the panel renders cached facts at once
and applies each interactive `facts` frame in place (rows transition on the
settle token) with a stage line; after 3 s without the plan closing the line
reads "still reading the site…". Hover or keyboard focus on a dot or card
sends `previewing` (debounced 250 ms, cleared on blur) so the server can
prefetch; GL dots merely under the pointer during a drag never send it.
