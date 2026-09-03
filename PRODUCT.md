# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Small groups — three to a handful of people — deciding where to meet, plus each
person's personal AI agent acting inside the same live page. Three roles carry
different authority and different views of one room:

- **Organizer.** Creates the room, shares the invite link or QR code, holds
  scope changes and the final commit.
- **Participant.** States needs, inspects places, vetoes, approves, contributes
  asynchronously and catches up later.
- **Personal agent.** Advocates for exactly one participant through WebMCP,
  may hold private knowledge of that person, and can only act within declared
  or confirmed authority.

The situation is a group mid-negotiation: needs are distributed across people,
arrive piecemeal, some are sensitive, and someone is waiting on an answer. The
job is converging on one place everyone can accept, then getting there.

Design work is judged twice: by people actually converging on a place, and
near-term by the WebMCP Challenge 2026 review, where demo legibility and the
landing page carry weight. Product truth follows the first; near-term surface
priority follows the second.

## Product Purpose

Spokes is a shared map where people and their agents negotiate requirements,
resolve conflicts, and agree on a destination together. It owns the collective
decision — gathering intent, protecting private context, comparing tradeoffs,
recording vetoes, reaching agreement, coordinating arrival. Navigation apps are
a downstream handoff, not a competitor.

It is simultaneously two things, and both must hold: a polished group
destination-planning application, and a proof of concept for reusable
WebMCP-mediated personal-agent negotiation.

Success: a group with genuinely conflicting needs — one of them private —
reaches an explicit agreement without anyone having to explain themselves, and
each person leaves with a navigation handoff.

## Positioning

> A shared asynchronous negotiation space for groups and their agents.

Not "AI search on a map". The mechanism a neighboring product cannot truthfully
copy: each person's independently contextualized agent joins the application's
structured negotiation through WebMCP, without that person recreating their
entire personal context inside the app. The page already knows what every pin
means, what was ruled out and why, which option is selected or vetoed, the
active bounds, provenance and freshness, and the viewer's own authorized
projection. WebMCP exposes that semantic state as narrow, contextual tools —
22 of them on `document.modelContext`, spanning two custom protocols
(`negotiation/v1`, `spatial-destination/v1`).

Human map gestures and agent tool calls run through the same command bus and
resolve to the same referents. Neither is a second-class path.

## Operating Context

- A room is created, then shared through an existing channel (WhatsApp link,
  QR code shown to people nearby). Participants join as guests.
- The target agent surface is ChatGPT's in-app browser: the live page open
  beside the conversation, tools acting on it, the human also clicking the map
  directly. Embedding the whole product in the transcript is not the goal.
- Participation is asynchronous. People arrive late, catch up on a delta, and
  act.
- Every accepted command becomes a revisioned event, projected separately per
  participant, so unauthorized fields never enter another client's response.
- Rooms run on bounded OpenStreetMap-backed place pools (Berlin Mitte, San
  Francisco SoMa), with an area picker before the room.
- Demo path is scripted: `make demo` seeds a three-person Berlin room;
  `docs/DEMO-RUNBOOK.md` walks the three-window sequence.

## Capabilities and Constraints

Confirmed capabilities:

- Needs stated conversationally or by direct manipulation, each at one of three
  visibility scopes: shared, application-private, agent-private.
- Deterministic eligibility over five graded statuses (yes / likely / unlikely
  / no / unknown), each with a confidence. A guess counts in the headline
  number, never rules a place out, never makes a room feasible, never moves a
  delta.
- Impasse detection with quantified counterfactuals ("+4 places if the radius
  went from 800 m to 1.2 km") and in-page consent before anything relaxes.
- Organizer-committed agreement, then navigation handoff per participant.
- Agent investigation of missing facts, attaching an attestation with its
  source; verified data is marked disputed rather than overwritten.
- An in-page NL agent in two tiers: fast (sentence → typed needs) and smart
  (acts through the tool surface, screens agent-private conditions held in
  memory). `docs/NL-AGENT.md`.

Durable constraints:

- **Domain-agnostic, permanently.** The same screens serve a dog walk, an
  exhibition, a film in a given language, a quiet coworking room, or dinner.
  No domain word in chrome, no domain branch in the client, every control from
  server data (`apps/server/FACETS.md`).
- **Unknown is a drawn state**, never silent exclusion and never a failure.
- **Private effects are public, private contents are not.** A private need's
  effect on the count always shows; its content never leaves its owner's
  client.
- **Nothing protocol-shaped in the main UI.** Tool names, JSON, MCP vocabulary,
  versions, timings live behind the `{ }` drawer.
- **The map never re-centres** as a result of a filter change; only explicit
  user action or explore-layer viewport loading moves it.
- Generative models may interpret language or evidence. They never invent
  feasibility facts and never decide whose requirement yields.
- Privacy promise is bounded on purpose: confidential inputs, inference-
  minimizing outputs. No claim of cryptographic secrecy from the operator, no
  claim of perfect inference prevention in a small group.

Terminology is fixed in `apps/web/COPY.md`: **place** (never venue/result/
option), **need** (never filter/preference/constraint), **room** (never board/
session/workspace), **the group** (never party/attendees). A need **rules out**
places. An agent **acted**, **staged**, or **proposed** — never "suggested".

Deliberate non-goals for v1: replacing navigation providers, global coverage,
autonomous relaxation of medical/safety/allergy/accessibility needs, fully
autonomous background agents, booking, live GPS, AR, learning durable traits
from session behavior.

Known POC limits are recorded honestly in `docs/KNOWN-LIMITATIONS.md`
(nonce binds to a page session not a human gesture; `setup`/`closed` phases
unreachable; no join/leave lifecycle; single-process realtime fan-out;
disclosure ladder L1–L3, transit routing and meeting points scoped out).
Future work must not paper over these.

## Brand Commitments

- Name: **Spokes**. Line: "decide together, go together."
- Wordmark, mark and lockups in `docs/design/brand/` (light and dark SVG, plus
  the GitHub banner).
- Typography: Bricolage Grotesque, self-hosted, for anything that names or
  counts; system sans for anything that explains; IBM Plex Mono for
  numerals-in-context and the drawer.
- Frozen four-colour semantic palette in `apps/web/src/tokens.css`:
  works / unsure / scope / act, one meaning each, never borrowed for emphasis.
  No raw hex outside that file (documented exceptions: GL paint pairs in
  `src/map-theme.ts`, the favicon data URI).
- Marks, not glyphs: states off the map are drawn with the map's own dot
  vocabulary. No ✓ ✗ ● characters in chrome.
- Four animations only: `spoke-pop`, `spoke-breathe`, `spoke-busy`, and the
  420ms settle. Everything else instant.
- Voice rules in `apps/web/COPY.md`: sentence case, no emoji in chrome, no
  exclamation marks, second person for the user's things, third for others,
  never first. Counts absolute, deltas signed, never percentages.
- Design source of truth: `docs/design/Spokes - Mapview Redesign.dc.html`
  (frames 4a, 7a–7d, 8a–8f, 9b). When `CLAUDE.md` and the design disagree,
  `CLAUDE.md` wins.

## Evidence on Hand

- Running product: `make demo` seeds the three-person Berlin room; `make dev`
  serves at `http://127.0.0.1:4173`.
- Landing page shipping real product screenshots — `apps/web/public/landing/`
  (hero-desktop, scopes, impasse, pending, explore, drawer, roster).
- Test lanes as proof of the privacy claim: unit (contracts, eligibility,
  redaction, evidence), API (three-user trajectories, privacy at the wire),
  e2e (three isolated browser contexts), and a separate real-Chrome native
  WebMCP lane requiring Chrome 149+ and an origin-trial token.
- Written record: `docs/PRODUCT-CONCEPT.md`, `docs/SYSTEM-ARCHITECTURE.md`,
  `docs/protocols/INTERACTION-AND-BINDING.md`, `docs/DATA-QUALITY.md`,
  `docs/ENRICHMENT-SOURCES.md`, `docs/DEMO-RUNBOOK.md`,
  `docs/KNOWN-LIMITATIONS.md`, `docs/REDESIGN-HANDOFF.md`.
- Prior design review: `.impeccable/critique/2026-09-01T07-24-12Z__apps-web.md`.
- Data is OpenStreetMap-derived under its attribution; MIT licensed code.

Absent, and not to be invented: users, customers, testimonials, adoption
numbers, benchmarks, pricing, uptime or availability claims. Spokes has run
demos, not a userbase.

## Product Principles

1. **The decision is the product.** Search, map and chat are instruments; what
   ships is an explicit group agreement and the arrival that follows.
2. **Domain-agnostic forever.** Any domain word in chrome is a bug, not a
   shortcut.
3. **Effects are public, contents are private.** Never hide that something
   happened; never reveal what it was.
4. **Missing is a state, not a failure.** Unknown data renders, counts, and
   never silently disqualifies a place.
5. **Agents and humans are peers.** Anything a person can do on the page, that
   person's agent can do through the tool surface, and the reverse — with the
   protocol machinery kept out of sight.
6. **Spatial memory is the product.** The map settles; it never re-lays-out
   under the user.

## Accessibility & Inclusion

- `tokens.css` is verified at WCAG AA; new tints must be re-checked against
  their **composited** background, since these surfaces stack translucent
  layers.
- Colour is never the only signal: works / unsure / out differ in fill, border
  style and size. The map must survive greyscale.
- Tap targets ≥44px, extended with padding beyond the drawn box rather than by
  growing the visual element.
- Press-and-hold (the core preview gesture) needs a keyboard equivalent and an
  `aria-live` count announcement.
- `prefers-reduced-motion` zeroes all four animations; busy state then renders
  as a standing dashed ring plus text, never nothing.
- Accessibility needs are also product content: step-free access and similar
  requirements are user needs the system must never autonomously relax.
