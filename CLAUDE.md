# webmcp-hackathon — Spokes

Monorepo: `apps/web` (React + Vite client), `apps/server` (decision engine,
WebSocket + MCP), `packages/contracts` (shared types + venue data),
`packages/protocols`. `make update` takes a checkout from `git pull` to a
running demo stack; `docs/` carries the product, architecture and demo docs.

# Spokes UI invariants

Rules for working on `apps/web`. These are not style preferences; each one
exists because breaking it destroys something the design is *for*. When a
change would violate one, stop and ask rather than working around it.

Companion docs: `apps/web/src/tokens.css` (frozen palette),
`apps/web/SPOKES-UI.md` (component specs), `apps/web/COPY.md` (wording),
`apps/server/FACETS.md` (the data contract). Mockups and import record:
`docs/design/`.

---

## 1. The app is domain-agnostic. Forever.

Spokes helps a group converge on **a place**, whatever kind. A dog-friendly
park, a museum with a given exhibition, a cinema screening in a given
language, a coworking space with a quiet room, a restaurant.

- **Never** hardcode a domain filter, chip, icon, category or heading.
- **Never** branch on domain in the client. No `if (type === 'restaurant')`.
- Every control comes from server data — see `FACETS.md`.
- The details panel renders whatever attribute groups the server sends, in
  server order. One layout for all domains.

If you find yourself writing a domain word into chrome, that's the bug.

## 2. Four colours, four meanings, no overlap

| Token | Means |
|---|---|
| `--spoke-works` | satisfies every active need (and the user's own commit) |
| `--spoke-unsure` | data missing or unverified — **not** a failure |
| `--spoke-scope` | who may see: private, agent-only |
| `--spoke-act` | someone moved: proposal, agent action, staged consent |

Never borrow one for emphasis. If two meanings genuinely coincide, show both
marks. `--spoke-act` is about **authorship**, never about visibility — do not
use it for identity or avatars.

## 3. No raw hex, ever

Every colour, radius, shadow and font size comes from `tokens.css`. If the
value you need isn't there, the design is missing a decision — ask.

New tints must be contrast-checked against their **composited** background
(these surfaces stack translucent layers; naive checks give false results).

## 4. Unverified is a state you draw

Missing data is not absence and not failure. It renders: hollow pin, `?`
badge, "3 unknown", `--spoke-unsure`. Never silently exclude a place for
lacking a value, and never show unknown as a red/negative state.

## 5. Privacy: effects are public, contents are not

A private need's **effect** on the count is always visible. Its **content**
never leaves its owner's client.

- ✅ "A private condition ruled two out"
- ❌ naming the condition, its value, or the places it removed
- ❌ hiding that anything happened

Peers receive `privateEffects` (coarse), owners receive the full need. Don't
route a private predicate through shared state "just for rendering".

## 6. Nothing protocol-shaped in the main UI

Tool names, JSON, MCP vocabulary, version strings, connection internals,
timing, raw payloads — all of it lives behind the `{ }` drawer and nowhere
else. The drawer is deliberately small and unstyled-looking. If a wire
concept surfaces in the main UI, it's a bug.

## 7. Press-and-hold is the core gesture

Holding a brief row previews the candidate set **without** that need, live on
the map, and restores on release. Don't replace it with a modal, a checkbox
list, or a separate "what-if" mode. It needs a keyboard equivalent and an
`aria-live` count announcement.

## 8. The map never re-centres itself

When the set changes, places settle in place — leavers fade to `--spoke-out`,
returners grow from their dot. Never re-fit bounds, never re-centre, never
re-layout as a result of a filter change. The user's spatial memory is the
product.

Exception: an explicit user action (search, "show me", opening a place).

Second exception (2026-09-03): the **explore layer** — the places behind the
map that are not in the room yet — is loaded for the viewport the user has
panned to. Loading follows the viewport; the viewport never follows the data.

## 9. Four animations only

`spoke-pop` (selected sticker idle), `spoke-breathe` (would come back),
`spoke-busy` (a lookup is running: a dashed ring turning around the dot, the
need row, the panel line — added 2026-09-03 at the user's request) and the
420ms settle. Everything else is instant. Respect `prefers-reduced-motion` —
the tokens zero all four; busy then renders as a standing dashed ring plus
text, never nothing.

**Trap:** position on an outer wrapper, animate on an inner element. A CSS
`animation` that sets `transform` overwrites a positioning `translate` and the
element jumps to its anchor.

## 10. Counts are absolute, deltas are signed

"6 still work / of 34 · 3 unsure". Never percentages. Deltas as `−19`, `+3`,
`34→15`. Phrase an offer as a consequence — "+3 if 'step-free' went optional" —
not an instruction.

## 11. Layout invariants

- Header flows straight out of the status bar. No containing card.
- Map is edge-to-edge, bounded by 1.5px rules, never a rounded card.
- Only the brief scrolls; header, map and composer are fixed.
- Delta chip bottom-**left** (bottom-right is map attribution), `z-index: 18`.
- Three depths on the map: markers 1–16, readouts (count block, delta chip) 18,
  controls (find, layers, the nav chips) 20. A name card is refused any
  placement inside a readout's or a control's measured rectangle.
- Attribution stays 7px and must never grow.
- No nav bar, tab bar, or hamburger. The room is the whole app.

## 12. Copy

Follow `COPY.md`. Highlights: "places" not domain nouns; "need" not
"filter"/"preference"; "rules out" not "filters"; sentence case; no emoji in
chrome; no exclamation marks; second person for the user's things, third for
others, never first.

## 13. Accessibility floor

- Tap targets ≥44px, extended with padding beyond the drawn box where the
  visual element is smaller. **Don't** grow the visual element to reach 44px.
- Body text ≥4.5:1 composited.
- Colour is never the only signal — works/unsure/out also differ in fill,
  border style and size. The map must survive greyscale.
- `button { white-space: nowrap }` is global; short glyph labels like `{ }`
  must never wrap.

---

## Working notes

- Design source of truth: `docs/design/Spokes - Mapview Redesign.dc.html`
  (133 KB, imports whole). Frames: `4a` (locked layout), `7a`–`7d` (flow), `8a`–`8f` (details,
  drawer, desktop, consent, brand), `9b` (accent decision).
- Font: Bricolage Grotesque, self-hosted (`apps/web/public/fonts/README.md`). Display
  family for anything that names or counts; system sans for anything that
  explains; mono for numerals-in-context and the drawer.
- When the design and this file disagree, this file wins — then fix the design
  or tell the designer.
- **Marks, not glyphs (2026-09-02).** Off the map, a state is drawn with the
  map's own dot vocabulary (`.mark[data-mark]` in `styles.css`): filled works,
  hollow unsure ring, small grey out, scope dot, dashed ghost, hollow act. No
  ✓ ✗ ● characters in chrome. Map states: `selected → settled → staged →
  vetoed → proposed → return → works/likely/unsure/unlikely/out`.
- **Graded evidence (2026-09-02, amended 2026-09-03).** Five statuses — yes /
  likely / unlikely / no / unknown — each with a confidence
  (`packages/contracts/src/status.ts`, SPATIAL-PROTOCOL §8.2). A guess is
  drawn **dashed**. It now *counts in the big number*, which the client reads
  as `matching + likely`, and the subline breaks that down ("of 34 · 4 of them
  likely · 3 unsure"). A guess still never rules a place out, never makes a
  room feasible, and never moves a delta: `matching`, the impasse arithmetic
  and the relaxation deltas stay eligible-only on the wire.
- **Your agent in the page (2026-09-02).** `docs/NL-AGENT.md`. Fast tier
  routes a composer sentence into typed needs; smart tier acts through the
  tool surface and screens agent-private conditions held in memory. Replies
  are a card in the brief, never a chat pane. Accepting a proposal marks you
  ready; the stage card names what staging waits on.
- **Applied 2026-09-01.** `styles.css` is built on `tokens.css`; the old
  `:root` palette and the legacy `--spoke` token are gone (not aliased). The
  only colour literals outside `tokens.css` are the documented GL-paint pairs
  in `src/map-theme.ts` and the favicon data URI. Remaining gaps and the
  session record: `docs/REDESIGN-HANDOFF.md`.
