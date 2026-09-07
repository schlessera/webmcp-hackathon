# webmcp-hackathon — Spokes

Monorepo: `apps/web` (React + Vite client and WebMCP adapter), `apps/server`
(decision engine, HTTP, WebSocket, evidence and model services), and
`packages/contracts` (shared types and place data). `make update` rebuilds,
migrates, restarts, and seeds the local demo after a checkout is updated.
`docs/README.md` distinguishes current references from historical records.

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
| `--spoke-works` | meets active must-haves on the available evidence (and the user's own commit); guesses retain their separate mark |
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

A private need's **effects** can be visible while its **content** is omitted
from peers' views. Application-private text reaches the application server
and durable storage. The built-in agent's held condition reaches server
memory and tool-less interpretation/screening providers, but stays out of
requirement/event records and the tool-calling model's context. An external
agent can keep its condition outside Spokes and submit verdicts.

- ✅ "A private condition ruled two out"
- ❌ naming a peer's private condition/value or tying its predicate to a place
- ❌ hiding that anything happened

Peers can receive ownership metadata, optional hints, counts, and aggregate
per-place effects. Owners receive their stored need; an external agent's
retained text is not stored there. These projections do not promise anonymity
or prevent small-group inference. Never send a private predicate to a peer
"just for rendering". See `docs/KNOWN-LIMITATIONS.md` for the full boundary.

## 6. Nothing protocol-shaped in the main UI

In room controls, tool names, JSON, MCP vocabulary, version strings, connection internals,
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

Exceptions: explicit focus/search, a shared scope-center change, or a
committed plan step that opens the next search around its settled place.

The **explore layer** — the places behind the
map that are not in the room yet — is loaded for the viewport the user has
panned to. Loading follows the viewport; the viewport never follows the data.

## 9. Four animations only

`spoke-pop` (selected sticker idle), `spoke-breathe` (would come back),
`spoke-busy` (a lookup is running: a dashed ring turning around the dot, the
need row, the panel line) and the
420ms settle. Everything else is instant. Respect `prefers-reduced-motion` —
the tokens zero all four; busy then renders as a standing dashed ring plus
text, never nothing.

**Trap:** position on an outer wrapper, animate on an inner element. A CSS
`animation` that sets `transform` overwrites a positioning `translate` and the
element jumps to its anchor.

## 10. Counts are absolute, deltas are signed

"6 still work / of 34 · 3 unsure". Never percentages. Deltas as `−19`, `+3`,
`34→15`. Phrase an offer as a consequence — "+3 if the search widened" —
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
- No nav bar, tab bar, or hamburger inside the active room. Landing and
  onboarding have their own entry flow.

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
  (design reference). Frames: `4a` (locked layout), `7a`–`7d` (flow), `8a`–`8f` (details,
  drawer, desktop, consent, brand), `9b` (accent decision).
- Font: Bricolage Grotesque, self-hosted (`apps/web/public/fonts/README.md`). Display
  family for anything that names or counts; system sans for anything that
  explains; mono for numerals-in-context and the drawer.
- When the design and this file disagree, this file wins — then fix the design
  or tell the designer.
- **Marks, not glyphs.** Off the map, a state is drawn with the
  map's own dot vocabulary (`.mark[data-mark]` in `styles.css`): filled works,
  hollow unsure ring, small grey out, scope dot, dashed ghost, hollow act. No
  ✓ ✗ ● characters in chrome. Map states: `selected → settled → staged →
  vetoed → proposed → return → works/likely/unsure/unlikely/out`.
- **Graded evidence.** Five statuses — yes /
  likely / unlikely / no / unknown — each with a confidence
  (`packages/contracts/src/status.ts`, SPATIAL-PROTOCOL §8.2). A guess is
  drawn **dashed**. A likely match *counts in the big number*, which the client reads
  as `matching + likely`, and the subline breaks that down ("of 34 · 4 of them
  likely · 3 unsure"). A guess still never rules a place out, never makes a
  room feasible, and never moves a delta: `matching`, the impasse arithmetic
  and the relaxation deltas stay eligible-only on the wire.
- **Your agent in the page.** `docs/NL-AGENT.md`. Sentence interpretation
  returns typed needs for the ordinary command path. Tool-calling mutations
  become owner-only review cards with exact arguments and a five-minute,
  single-use approval. Private-condition screening uses a separate tool-less
  model. Replies and reviews belong in the brief. A suggestion is not an
  applied action; approving an agreement stage does not commit it. External
  WebMCP agents do not use the built-in approval wrapper.
- **Agreement.** Every participant must be ready and accepted or abstained,
  with no veto. Accepting marks the person ready; abstaining does not. The
  organizer stages and confirms. The nonce binds to an authenticated
  participant channel, not proof of a human gesture. Disconnected members
  still count, and evidence-based eligibility is not a commitment gate.
- **A room can be a sequence.** `docs/protocols/SPATIAL-PROTOCOL.md` §5.5.
  A goal decomposes into 1–3 steps (`rooms.steps`, `rooms.active_step_id`).
  The room runs **one at a time**: the active step owns the pool, the map and
  the live needs. Committing an agreement settles that step and opens the
  next, re-centred on the place just agreed — which is the §8 exception, not
  a violation of it, because a commit is an explicit decision. Which candidate
  rows are live is ONE rule, in `apps/server/src/live-pool.ts`; a query that
  enumerates a pool without mentioning `LIVE_POOL` has forgotten steps exist.
  Readiness carries forward, but new proposals need fresh stances. Rooms with
  an empty `steps` array, including `room_demo`, use the single-decision flow.
- **The region question is not the product's.** Onboarding asks
  name → goal → plan, and only then which of the two prepared regions. That
  order is deliberate: putting the region first teaches people Spokes is a
  tool for two neighbourhoods. The dialog is drawn plainer than the app
  around it and tagged "demo limit", the same move the `{ }` drawer makes.
  Never promote it into the product flow.
- **A link is one person's.** `+` beside the avatars mints a
  `room_invites` link; the first claim binds it to that device's hash, and it
  stays that person's way back in. Several may be outstanding at once —
  minting never revokes. Unused links expire in an hour; bearer tokens expire
  after 24 hours and organizer recovery after seven days. Claimed member
  recovery has no final lifetime or self-service revocation. **A refusal names
  nobody**: "This link is already in use" is the whole message, because who
  is in a room is not something a URL hands to whoever tries it.
- **Onboarding is agent-reachable.** `describe_regions` and
  `open_room` are the only tools that answer without a participant token. The
  agent states a high-level goal; the page distils it. Never move step-class
  choice or need composition into a tool argument — that would be a second
  planner, and the two would drift. `open_room` uses the preview/creation
  endpoints and schedules navigation, without stopping at the page's review
  screen. The catalog has 24 tools; native registration starts before mount
  and completes asynchronously.
- **Styles.** `styles.css` uses `tokens.css`. Documented colour-literal
  exceptions are GL-paint pairs in `src/map-theme.ts` and the favicon data
  URI. Current boundaries are in `docs/KNOWN-LIMITATIONS.md`; dated design
  handoffs record their original scope.
