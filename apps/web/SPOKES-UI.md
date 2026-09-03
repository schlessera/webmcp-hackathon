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
| Title | `--spoke-font-display` 700 / 15px, `--spoke-ink`, single line, ellipsis |
| Subtitle | `--spoke-font-text` 500 / 11px, `--spoke-ink-soft` |
| Avatars | 26px squircle `--spoke-radius-avatar`, 2px `--spoke-ground` ring, −6px overlap, alternating rotation −4° / 3° / −2° |
| `{ }` | 22px, borderless, `--spoke-ink-soft` at 70%, 9px mono |

The subtitle is **state, not metadata** — it changes with the room:
"Sunday 10:00 · Mitte" → "nothing works for all three" (`--spoke-unsure-text`)
→ "agreed by all three · 10:00" (`--spoke-works-text`) → "you were away 2 hours".

Absent participants use `--spoke-person-idle`.

Tapping the avatar row opens a small roster card under the header — every
person by name with "here now" / "arrived" / "not arrived yet" — so names and
presence are reachable on touch, not only on hover. It closes on Escape, on an
outside tap, or on the row again. It is a disclosure, not navigation.

**Don't** make `{ }` prominent. It is a debugging affordance: no border, no
fill, no label. Everything protocol-shaped lives behind it.

---

## 3. Map

### Pins & stickers

| State | Drawn as |
|---|---|
| Ruled out | 8px dot, `--spoke-out` at `--spoke-out-opacity`, **no border, no label** |
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

> **Implementation trap.** Position on an outer wrapper, animate on an inner
> element. An `animation` that sets `transform` will silently overwrite a
> positioning `translate` and the sticker will jump to the anchor point.

### Scope ring

Dashed 1.5px circle at 40% opacity, with everything outside dimmed 8% via an
SVG mask. When an agent widens the area, draw the **proposed** radius as a
second, fainter dashed ring (`8d`, `7b`) so the change is visible before it
is accepted.

### Count block

Top-left, 14px inset, rotated −2°, `--spoke-radius-block`, `--spoke-shadow-lift`.

```
6            ← 30px display, 800
still work   ← 11px, two lines
of 34 · 3 unsure   ← 10px mono
```

- Normal: `--spoke-works` fill, cream text.
- Impasse (0): `--spoke-unsure` fill.
- Pre-need (nothing ruled out): `--spoke-surface` fill, `--spoke-ink` text,
  and the number counts *places*, not survivors — "14 green spaces".
- Agreed: shrinks to a two-line "Settled / 18 min from you" chip.

### Delta chip

Bottom-**left**, 12px inset, `z-index: 5` (above attribution),
`--spoke-ink` fill, `--spoke-works-pop` numeral.
Bottom-left because bottom-right belongs to map attribution.

### Presence

No cursors (REDESIGN-HANDOFF D4). A person who has a place **open** is drawn
on that place: an 18px squircle with their initials in their person colour,
1.5px `--spoke-surface` ring, `--spoke-shadow-drop`, peeking out from behind
the sticker's right edge (translated 60% past it, stacked under the card) —
or from behind the bare dot when the place has no name card. Several
viewers overlap by −7px like the header avatars. Never the viewer's own
initials, never a semantic colour. It rides on the presence frame
(`viewing`), so it is gone the moment the panel closes or the tab does.

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

## 6. Place details

Side panel that pushes the map on ≥980px; full-screen takeover on phone
(`8a`). Never a bottom sheet — the map is the context and must stay visible.

The panel is **schema-driven**. It renders whatever attribute groups the
server sends, in server order. There is no restaurant layout, no cinema
layout — one layout that adapts.

```
Name                              [Close]
why it's in / why it's out        ← verdict strip
─────────────────────────────────
Does it fit                       ← per need: mark · need · answer in words
─────────────────────────────────
Also on record                    ← the facts nobody asked about, as pills
Facts from OpenStreetMap.         ← one sources line for the whole panel
─────────────────────────────────
Where everyone stands             ← per person: avatar · sentence · mark
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
- A peer with this place open reads "· looking now" on their stance row.
- **Looking it up.** The panel reserves one line under the verdict from the
  first paint: `looking it up…` with the busy ring while a lookup runs for
  this place, `what the record says` once it has landed. Facts that arrive
  update their rows in place; the first render never looks final.
- The "Does it fit" rows come from the server's per-need verdicts on the
  dossier (`needs[]`); the client never parses a need label. A guess names
  its evidence under the answer in the reader's words ("the menu mentions a
  vegan bowl") and its confidence as a word — "likely", "fairly sure",
  "a guess" — never as a number.
- Address, phone and opening hours sit in a "Where and when" group when the
  record carries them; hours group consecutive days with the same times.

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
