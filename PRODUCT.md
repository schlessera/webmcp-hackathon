# Product

<!-- impeccable:product-schema 1 -->

Current product reference, checked against the implementation on 2026-09-07.
Brand commitments and product principles guide design; implemented behavior
and remaining limits are described separately below.

## Platform

web

## Users

Small groups — three to a handful of people — deciding where to meet, plus each
person's personal AI agent acting inside the same live page. Three roles carry
different authority and different views of one room:

- **Organizer.** Creates the room, shares a separate invite link or QR code for
  each new participant, holds
  scope changes and the final commit.
- **Participant.** States needs, inspects places, vetoes, approves, contributes
  asynchronously and catches up later.
- **Personal agent.** Advocates for exactly one participant through WebMCP,
  may hold private knowledge of that person, and uses their room authority.
  The built-in tool-calling agent adds an owner-review step for its proposed
  mutations; external WebMCP agents use the command API directly.

The situation is a group mid-negotiation: needs are distributed across people,
arrive piecemeal, some are sensitive, and someone is waiting on an answer. The
job is converging on a place for each step of an outing, then getting there.

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

Each person's personal agent can join the application's structured negotiation
through WebMCP, without recreating its entire personal context inside the app.
The page knows what each pin
means, what was ruled out and why, which option is selected or vetoed, the
active bounds, provenance and freshness, and the viewer's own authorized
projection. WebMCP exposes that semantic state as narrow, contextual tools —
24 of them on `document.modelContext`, spanning two custom protocols
(`negotiation/v1`, `spatial-destination/v1`).

Page gestures and agent room mutations run through the same command bus and
resolve to the same referents. Reads, onboarding, and map focus use separate
handlers; final commitments and some personal controls remain page-only.

## Operating Context

- An organizer states a goal, reviews up to three sequential steps, chooses a
  prepared region, and opens a room. One-person links or QR codes are shared
  through an existing channel. Participants join as browser-bound guests.
- The target agent surface is ChatGPT's in-app browser: the live page open
  beside the conversation, tools acting on it, the human also clicking the map
  directly. Embedding the whole product in the transcript is not the goal.
- Participation is asynchronous. People arrive late, catch up on a delta, and
  act.
- Room mutations can append revisioned events, projected separately per
  participant with private content omitted from peer views. No-op commands
  and idempotency replays need not create new events.
- Rooms run on bounded OpenStreetMap-backed place pools (Berlin Mitte, San
  Francisco SoMa), with an area picker before the room.
- Demo path is scripted: `make demo` seeds a three-person Berlin room;
  `docs/DEMO-RUNBOOK.md` walks the three-window sequence.

## Capabilities and Constraints

Confirmed capabilities:

- Needs stated conversationally or by direct manipulation, each at one of three
  visibility scopes: shared, application-private, agent-private.
- Deterministic eligibility over five evidence statuses (yes / likely yes /
  likely no / no / unknown). Likely matches count in the headline with a
  breakdown; wire `matching` and adjustment gains count eligible places only.
  Soft/optional needs are stored but do not affect ranking.
- Impasse detection with quantified counterfactuals. Addressed grants within
  delegated bounds can apply immediately; over-bound grants stage for page
  confirmation. The organizer can change shared scope directly.
- Agreement requires every participant ready and accepted or abstained, with
  no veto. The organizer stages and commits each step. Intermediate choices
  open the next search around the settled place; the final one leads to
  navigation handoff. Agreement does not certify evidence-based eligibility.
- Agent investigation of missing facts, attaching an attestation with its
  source; verified data is marked disputed rather than overwritten.
- Language jobs for sentence interpretation, plan preview, participant
  assistance, and private screening, with separate configurable model roles.
  The tool-calling agent proposes exact mutations for owner review; approval
  expires after five minutes. Private-condition interpretation and screening
  are tool-less model paths. See `docs/NL-AGENT.md`.
- Per-person starting points and opt-in live location sharing. Ongoing device
  updates require both device-origin selection and sharing consent.

Durable constraints:

- **Domain-agnostic, permanently.** The same screens serve a dog walk, an
  exhibition, a film in a given language, a quiet coworking room, or dinner.
  No domain word in chrome, no domain branch in the client, every control from
  server data (`apps/server/FACETS.md`).
- **Unknown is a drawn state**, never silent exclusion and never a failure.
- **Private effects are public, private contents are not shared with peers.**
  Application-private needs reach the server and durable storage. The built-in
  agent's held condition reaches server memory and interpretation/screening
  providers, but stays out of requirement/event records and the tool-calling
  model's context. An external agent can retain its condition outside Spokes.
  Effects can expose ownership metadata and support inference.
- **Nothing protocol-shaped in the main UI.** Tool names, JSON, MCP vocabulary,
  versions, timings live behind the `{ }` drawer.
- **The map preserves spatial memory** when needs change. Explicit focus,
  shared scope-center changes, and committing the next plan step can move it.
  Explore loading follows the viewport; it does not move the viewport.
- Models can interpret source evidence and produce graded or verified claims
  under server validation. Those claims are not independent proof of venue
  conditions. The deterministic classifier evaluates needs; participants
  authorize adjustments and agreement.
- Privacy promise is bounded on purpose: confidential inputs, inference-
  minimizing outputs. No claim of cryptographic secrecy from the operator, no
  claim of perfect inference prevention in a small group.

Terminology is fixed in `apps/web/COPY.md`: **place** (never venue/result/
option), **need** (never filter/preference/constraint), **room** (never board/
session/workspace), **the group** (never party/attendees). A need **rules out**
places. Agent wording distinguishes a **suggestion awaiting review**, an
**applied action**, and a **staged change awaiting confirmation**.

Deliberate non-goals for v1: replacing navigation providers, global coverage,
autonomous relaxation of medical/safety/allergy/accessibility needs, fully
autonomous background external agents, booking, street routing, AR, learning durable traits
from session behavior.

Known POC limits are recorded honestly in `docs/KNOWN-LIMITATIONS.md`
(nonce binds to a page session not a human gesture; `setup`/`closed` phases
unreachable; no participant leave/removal or room closing; single-process
realtime fan-out; no disclosure escalation L1–L3, soft ranking, transit routing,
or meeting-point negotiation). Built-in screening and browser retries have
the current failure cases described there.
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
- Test lanes for application privacy and contract checks: unit (contracts, eligibility,
  redaction, evidence), API (three-user trajectories, privacy at the wire),
  e2e (isolated browser contexts), and a separate native WebMCP harness
  requiring real Chrome 149+ and an origin-trial token for its test origin.
  Passing results apply to the tested build/environment, not every agent host.
- Current references: `docs/SYSTEM-ARCHITECTURE.md`,
  `docs/protocols/INTERACTION-AND-BINDING.md`, `docs/DATA-QUALITY.md`,
  `docs/ENRICHMENT-SOURCES.md`, `docs/DEMO-RUNBOOK.md`,
  `docs/KNOWN-LIMITATIONS.md`. Original concepts, design handoffs, and dated
  reviews retain their historical scope; see `docs/README.md`.
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
3. **Protect private content in peer views.** Show authorized effects without
   exposing the condition. Describe the server/model boundary accurately.
4. **Missing is a state, not a failure.** Unknown data renders, counts, and
   never silently disqualifies a place.
5. **Agents and people use the same room rules.** Shared commands use the same
   identity, revision, and consent checks. Keep page-only confirmation and
   built-in action review clear, with protocol machinery out of the main UI.
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
