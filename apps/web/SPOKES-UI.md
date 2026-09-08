# Spokes — component spec

Current component anatomy and behavior, with the design rules that govern
changes. Colours are token names from [tokens.css](src/tokens.css);
**never** a raw hex. Copy rules and known wording gaps are in
[COPY.md](COPY.md); documenting a gap does not mean the component is fixed.

Reference mockups live in [Spokes — Mapview Redesign](<../../docs/design/Spokes - Mapview Redesign.dc.html>):
`4a` (locked phone layout), `7a`–`7d` (flow states), `8a`–`8f` (details,
drawer, desktop, consent, brand), `9b` (accent decision).

---

## 0. The semantic contract

Four meanings, four colours, no overlap. This is the spine of the whole UI.

| Token | Means | Example |
|---|---|---|
| `--spoke-works` | works, or a positive selection/settlement control | solid pin, "6 still work", your settle button |
| `--spoke-unsure` | data missing or unverified | hollow pin, "3 unknown", `?` badge |
| `--spoke-scope` | who may see | "private", "agent only", "only you" |
| `--spoke-act` | an action or decision boundary | proposal sticker, agent staged, consent card |
| `--spoke-out` | ruled out | 8px grey dot, no border, no label |

**Do not** borrow another meaning's colour for visual emphasis. If two
meanings coincide (a background agent action that is also agent-only), show
**both** marks — see `8d` card 3, which carries a violet `agent only` scope
badge beside a woad `screening needed` chip.

The visual meaning is not an agreement guarantee. The headline count includes
likely places, optional needs do not rank candidates, and a selected or
settled sticker can be green without clearing every hard need. Agreement
checks stances and readiness, not a separate feasibility threshold.

---

## 1. Screen frame

```
status bar          52px, ends flush — no card, no divider
header              title + subtitle + avatars + { }
map                 full bleed, 1.5px rule top and bottom
brief               scrollable, fixed height
composer            pinned bottom, 20px from edge
```

- The header flows straight out of the status bar (mockup `4a`), without a
  containing card.
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
are specified in [SPOKES-BRAND.md](SPOKES-BRAND.md).
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
After agreement, the committed place supplies the title. A legacy room
without a supplied goal receives the server's area-based goal and uses the
same line; the client never composes a domain label there.

### Before the room: plan review

Onboarding scrolls vertically within the viewport; the room's “only the brief
scrolls” rule begins after entry. The current flow has three screens:

1. `Your name` and `What are you trying to do?`, followed by `Work out what
   that takes`. The goal can describe one outing or several.
2. `What that takes`, with one to three ordered step boxes. Each has `Step
   N of M`, a server-authored `Kind of place` selector, and `From what you
   said` pending rows with `Leave out`. Later steps say `after that, near
   there` and can be removed before creation. Clarifications offer their
   server-authored choices. `Open the room` continues with the reviewed plan.
3. The region choice explains the demo's prepared Berlin Mitte and San
   Francisco data, with server-measured counts and snapshot dates. Choosing
   a region opens the room with the retained needs.

Pending here means “not in the room yet”. It never borrows works or unsure,
and it has no candidate count. Reading the goal and opening the room use the
standard `spoke-busy` ring. If interpretation fails, the class selector and
room creation remain available; the screen preserves a path to continue.

For plans with more than one step, the room header adds an ordered strip:
the active step says `now`, settled steps name their place, and pending steps
show their class. These are status items, not selectable tabs. Settling an
intermediate step recenters the next search near the chosen place. Each new
proposal needs fresh stances, while readiness carries forward. There is no
post-creation plan editor or way to reopen a completed step.

### Invites and joining

`Add someone` opens a dialog with a link and QR code for one person. Its
actions are `Copy link` / `Copied`, native `Share` when supported, and `New
link`. Unused links expire after an hour; a claimed link belongs to that
participant's browser and can recover them there. It is not a reusable group
link or a way to transfer an occupied seat to another browser.

The join preview names the organizer, repeats the goal, lists plan step
titles and classes, and gives the participant count and area. It does not
expose private needs or the full roster. A name field and `Join` / `Joining…`
complete guest entry. The disabled `Log in` control is paired with the
explicit explanation that the demo has no accounts.

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

Name slots go out in rank order:

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
option. A ruled-out place that wins no slot keeps its bare 8px dot and fades
in place. A proposal whose status is vetoed or withdrawn has
left the table and falls back to the place's eligibility rank. When a place
leaves the named set, its card collapses onto its own dot over the settle
duration — the scale runs about the anchor, so the dot never moves (§10).

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
SVG mask. An outstanding private adjustment offer draws its **proposed**
radius as a second, fainter dashed ring (`8d`, `7b`) so the change is visible
before acceptance. This preview does not mean every direct scope change uses
the private adjustment flow.

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

### Refinement

The room keeps looking things up on its own (see
[continuous refinement](../../docs/ENRICHMENT-SOURCES.md)). The page shows:

- Places being worked on carry the busy ring (the `lookups` frame with
  `reason.kind: "refine"` drives it exactly like a need-triggered lookup).
- The count's head-row progress slot carries the ring and available counts;
  whole-area fill wins while it runs. There is no progress line below it.
- Sentences such as `looking up N · M to go`, `checked N places for K needs
  · M to go`, and `paused for now` are accessible progress text. The live
  summary is batched at most once every 10 s, never per frame.
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
of 34 · 4 likely · 3 unsure   ← 10px mono
```

The big number is confirmed plus likely: a guess with a reason is an option
the room can act on. The subline breaks that number down ("4 likely"),
and unsure and unlikely stay counted apart from it. The wire keeps
`matching` eligible-only ([spatial protocol](../../docs/protocols/SPATIAL-PROTOCOL.md)); the sum is a display
decision, made in the client. The delta chip stays on the eligible-only
base, so its `+3` and `−19` are about confirmed gain and loss.

- Normal: `--spoke-works` fill, cream text.
- Impasse (0): `--spoke-unsure` fill.
- Pre-need (nothing ruled out): `--spoke-surface` fill, `--spoke-ink` text,
  and the number counts *places*, not survivors — `14 places`, with
  `nothing ruled out yet` underneath.
- Agreed: shrinks to `Settled`, with `18 min from you` when travel is known.

### Delta chip

Bottom-**left**, 12px inset, `z-index: 18` (above attribution and every
marker, below the controls), `--spoke-ink` fill, `--spoke-works-pop` numeral.
Bottom-left because bottom-right belongs to map attribution. Name cards are
refused its rectangle, which is measured while the chip is mounted.

### Presence

No cursors. A person who has a place **open** is drawn
on that place: an 18px squircle with their initials in their person colour,
1.5px `--spoke-surface` ring, `--spoke-shadow-drop`, peeking out from behind
the sticker's right edge (translated 60% past it, stacked under the card) —
or from behind the bare dot when the place has no name card. Several
viewers overlap by −7px like the header avatars. Never the viewer's own
initials, never a semantic colour. It rides on the presence frame
(`viewing`) and clears when the panel closes or disconnection is detected.
Opening or focusing a place can therefore be visible to peers; it is not a
private reading action.

An opted-in live position rides on the same presence frame as `positions` and
disappears when sharing stops or the person's last socket closes. This is the
26px person mark above, not the smaller viewing badge tucked behind a place.
The header avatar carries a small square showing mark while its position row is
present; the round dot continues to mean here now.

### Find a place, and the layers control

Both are round icon buttons in a column at the map's top-right corner
(`.map-top-right`, `z-index: 20` — in front of every marker): find above,
layers below. A 32px face inside a 44px tap box (§11 — the padding reaches
44px, the drawn circle does not), `--spoke-surface` on a `--spoke-line` ring
with the drop shadow, and a single-stroke glyph in `currentColor`
(`MapIcons.tsx`). One button's width, whatever the count block opposite is
saying, so neither control is ever pushed into a second row or squeezed.

Glyphs here are affordances, not state: the map's state vocabulary is still
dots and rings. Each button carries its words
in `aria-label` — "Find a place", "Layers, 2 on" — because the glyph is not
the name.

**Find a place** (`MapFind.tsx`) is the magnifier button until it is asked
for, then a field of `min(300px, 100vw − 96px)` with the matches beneath it
in a `--spoke-surface` card. Matching runs server-side over the room area's
snapshot — the same rows the explore layer draws — by name only, forgiving
accents, punctuation, word order and one wrong letter. At most 8 matches, each
a ≥44px row with the name above its place class. ↓/↑ move, Enter chooses,
Escape clears then closes, and the match count goes out on `aria-live`.

Choosing a match makes it the **target**. The map flies to it and centres on
it (an explicit action, the §10 exception), and the find button inverts —
`--spoke-ink` face, `--spoke-surface` glyph — with a `✕` button beside it.
The corner does not repeat the name: the place carries it on the map, on its
own card. Pressing the find button again searches for something else.

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

Dismissing the target with `✕` returns the find button to its plain state and
closes whatever the target opened.

**Layers** (`MapLayers.tsx`) is the stacked-planes button whose panel carries
one checkbox per optional layer: buildings in 3D, places not in the room,
landmarks, transit lines. The button's ring goes to `--spoke-ink` while any
layer is on. Every layer is *context under the room* and is painted in the
plate's own family (`MAP_THEME.layers`) — never in a state colour, which would
read as a verdict about a place. Nothing the room decided is ever behind a
switch.

- **Buildings in 3D** — `fill-extrusion` from the basemap's own building
  layer, beneath the first label layer, `render_height` where OSM has one and
  6m where it does not. Turning it on pitches the camera to 48°. Room and
  explore pin heads lift with the pitch, joined by thin needles to their
  original geographic points; named cards keep the corresponding pin
  anchors. Turning it off retracts the pins as the camera returns flat.
  Reduced motion arrives at either state instantly. Pin geometry lives in
  [map-pins.ts](src/map-pins.ts).
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

The group's stated needs, with toggles on the viewer's own rows. **This
replaces all predefined filter controls.** Every row comes from data; the
app ships zero domain chips.

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
| Private or agent-only (other's) | 1.5px dashed `--spoke-line` | none | `private` badge |
| Pending (just said) | 1.5px dashed `--spoke-line` | none | busy ring + `checking 12 places…` |

A provisional row appears before the server answers and says `saying it…`;
an agent-only row keeps the condition out of its displayed label. After
commitment it can say `checking 12 places…`. Pending presentation ends after
a 600 ms grace period with no busy places, or at the 8 s cap. That
cap is not proof that all evidence has arrived. `aria-busy` is set on the
brief while a need is pending; the count's single head-row slot reports room
progress separately.

The semantic border is the **only** full-strength line in the design. Neutral
rows use the tinted line. That way an outline means something.

**Interaction.** Tap toggles your own need. **Press and hold a visible need
previews the set without it** —
the map re-settles live and returns on release. This is the core gesture of
the app; do not replace it with a modal.

**Don't** show another person's private need's content, ever. The peer effect
row is dashed, noninteractive, and says `A private condition` with a `private`
badge. Only an owner-authorized topic hint can add `about …`; it is not a
toggle or a hold-preview target. Privacy hides the condition, not necessarily
its owner or the fact that they acted.

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
  *before* speaking, never after. Current options summarize who in the room
  can read the need or its effects; they do not fully explain server and
  model-provider processing at the point of choice.
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
candidate set** (see [FACETS.md](../server/FACETS.md)). Order by count
descending. Never hardcode.

### Privacy boundary

`Private` hides the text from peers while the server stores and evaluates it;
natural-language input also goes to the configured model provider. For
`Agent only`, an external agent can keep the condition and submit a
content-free declaration plus verdicts. The built-in path sends the condition
to server memory and the configured interpretation and screening models. It
omits that text from requirement and event records and the tool-calling
agent's context, but it is not device-only or hidden from the service.

The held condition is lost on server restart. An outstanding screening request
does not prove an agent is connected or making progress; the built-in
`needs_info` response also currently lacks required `infoNeeded` data and can
cause its result batch to be rejected. Do not turn these states into a promise
of automatic completion. See [known limitations](../../docs/KNOWN-LIMITATIONS.md).

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
(`8a`). Never a bottom sheet. Desktop retains the map beside the reading
surface; mobile gives the details the full screen.

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
- `Confirm` and `Rule out` record participant evidence for this room, with
  `undo` available to its confirmer or an organizer. They do not update the
  shared venue record or prove that a human performed the action.
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

Private adjustment decisions use `--spoke-act`; scope badges inside them
stay `--spoke-scope`. A proposed or staged change is not an applied one.

| State | Card | Primary action |
|---|---|---|
| Proposed adjustment | act border + tint, numeric scope and gain | `Accept` (+ `Decline`) |
| Beyond the grant, staged | act border + tint | `Confirm` (+ `Cancel the grant`) |

State the boundary numerically: "Widen from 900 m to 1.4 km — beyond the
1.2 km you delegated." An accepted adjustment within the grant applies;
one beyond it stages for confirmation. The staged card says "Your agent staged
it for your confirmation." The confirmation path is participant-bound, not
proof of a human gesture.

An agent-only evaluation request not marked as held by the built-in agent
gets a separate status card: neutral surface, act shadow, `agent only` and
`screening needed` chips, and no decision action. The request proves there are
places awaiting screening, not that an agent is connected and screening
them. The body explains that peers see compatibility without the condition,
and that the built-in agent uses Spokes and its model providers to check it.
A stale declaration after restart can still produce this card.

### Built-in agent action review

[AgentActionReview](src/components/AgentActionReview.tsx) is a separate
owner-approval card for a tool-calling mutation. It shows the suggested
action's title and exact stored values, followed by `These are the values
that will be applied. Review any shared text before approving.` Its buttons
are `Approve change` and `Dismiss`; approval shows `Saving…` while busy.
Until approval succeeds, the agent has suggested the change, not made it.

The server keeps one current suggestion per participant for five minutes.
Approval is single-use and applies the stored arguments at the original room
revision. Stale, expired, or already consumed suggestions require a fresh
request. This is not the private adjustment grant or a blanket authorization
for later actions; direct external-agent tool calls do not use this wrapper.
Ordinary natural-language need interpretation and private screening also have
their own paths.

### Agreement

Proposal stances (`Works for me` / `Rule it out`) are separate from readiness.
The organizer uses `Stage it` and then `Settle it`. Staging needs every active
participant ready and accepting or abstaining, with no veto; it does not
check a separate feasibility threshold. Settling an intermediate plan step
advances the room rather than finishing the whole outing. Fresh proposals
need fresh stances, while readiness carries forward.

**Don't** let a consent card be dismissed by tapping outside. It is a
decision, not a notification.

---

## 8. `{ }` diagnostics drawer

Slide-over from the right, `--spoke-ink` ground, cream text, mono throughout.

Header: `{ } under the hood` + `Close`. The reassurance chip
("nothing here is needed to use the app") sits on its **own line** beneath —
it is an aside, not a peer of the title.

Contents: connection and contract state, the wire timeline and its filters,
and expandable diagnostic payloads. Keep protocol details here.

Wire has one activity view with no tab selector. It draws explicit parent,
request-correlation, inferred revision and retry links alongside virtualized
44px rows. Request timing breakdowns remain in the event inspector.
Offscreen links continue across the viewport and offer above/below navigation;
filtered endpoints have open ends and a Show control. A selected
event opens an inspector with a chain summary, paged connected events, browser/server timings,
bounded server spans and metadata. On narrow screens the inspector replaces
the list; Close returns to it. Expand gives the drawer room for both panes.
Pause freezes the view while recording continues. Search, lane and attention
filters affect the displayed/exported subset. The recording scope and limits
remain available underneath the view. Wire loads only when the drawer opens;
folded raw payloads are not serialized or rendered until expanded.

**Everything protocol-shaped lives here and nowhere else.** If a wire concept
(tool names, JSON, version strings, MCP vocabulary) appears in the main UI,
it is a bug.

---

## 9. Desktop ≥980px

Three columns (`8c`): brief rail left (320px), map centre, details right
(pushes in, 380px). Chat lives in the user's own client beside the browser —
the app never renders a chat pane. The in-page agent ([NL-AGENT.md](../../docs/NL-AGENT.md))
keeps that rule: it speaks through the composer and answers as a "Your
agent" card in the brief, dismissed by the reader.

Agent turns distinguish an answer, an approval request, an applied change,
and a staged decision. Name a change and its delta only after it happened,
so the chat and the map never disagree.

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

One widget **in the count's head row, right of the number** reports progress:
a 16 px ring (`--spoke-ink-soft` on `currentColor`, fill on the settle
duration, static under reduced motion) with available counts in mono beside
it. Starting or finishing a lookup does not change the count block's height.

That head slot is the **only** progress slot, and every kind of progress uses
it, in this precedence: the whole-area fill (`count-fill`, determinate on
`pool.size / pool.target` — its absolute target explains why the denominator
moves), then the pipeline (`count-progress`), then a lookup (`count-busy`,
the turning busy ring with the number in flight beside it), then background
refinement (`count-refine`, the busy ring alone). Where there are honest
numbers the ring is determinate and shows `done/total`; where there are not,
it turns. No progress line is drawn below the count; the ordinary total and
eligibility subline keeps its place.

Progress sentences — "checked N of M places for K needs · N
reading", "adding places · N of M", "looking up N · M to go", "paused for
now" — all stay on `aria-valuetext`, where they are read rather than
measured, and the live region speaks whichever is running. The widget has
`role="progressbar"` and `aria-valuetext`; it adds numeric min/max/now only
when a total is known, omitting now while paused. One `aria-live` summary
runs at most every 10 s.
Drained: nothing is drawn. Whole-area fill keeps the slot while it runs.

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
