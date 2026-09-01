# Devpost submission — Spokes

Copy-paste-ready. Fill the two placeholders (`<LIVE_URL>`, `<REPO_URL>`) once
the Coolify deploy and the public repo URL exist. Keep the video under 3 minutes.

---

## Project name

**Spokes**

## Elevator pitch (one line)

A shared map where people and their personal AI agents privately negotiate
requirements, resolve conflicts, and agree on where to meet — together.

## Inspiration / the problem

Groups constantly struggle to pick somewhere to go. The needs are scattered
across people and dribble out piecemeal: a dietary restriction here, a budget
there, a veto that lands late, a reason someone would rather not say out loud. A
search results list optimizes one query; a group chat collects messages; neither
maintains a shared constraint model, and neither lets you keep a sensitive
reason private while still having it counted. Spokes is built for exactly that:
a shared, asynchronous negotiation space for a group **and** their agents.

## What it does

Three people open one planning room from a link. Each sees a live shared map of
Berlin Mitte and their own private requirement area. They state needs
conversationally or by clicking the map — vegetarian, lactose-free, under €15,
"not Italian today", "too far", a veto with a reason. Each need is marked
**shared**, **application-private** (the server can evaluate it; peers see only
its aggregate effect), or **agent-private** (only your agent ever sees the
content). The room continuously recomputes which venues are eligible, detects
when no option satisfies everyone, and — instead of naming who is blocking —
privately offers the affected person a **quantified** way out ("widen the search
by 400 m to add 3 places"). Consent is explicit and confirmed on the page. When
the group agrees, the room flips to arrival mode and hands each person a
one-click navigation link.

Your personal ChatGPT can sit alongside the live page and act *in the same
session* through WebMCP: catch up on what changed while you were away, inspect
venues, propose one, cast a veto, grant an adjustment — all as the same commands
a human click would produce.

## Why this is a strong fit for WebMCP

The page already holds semantic state an external agent cannot recover from
pixels: what each pin means, which candidates were filtered out and *why*, the
current selection and vetoes, the active search scope and time, data provenance
and freshness, the current participant's identity and their authorized private
projection, and everything that changed since the agent last participated.
WebMCP lets a personal agent read and act on that live state directly, as the
person it represents, without the user re-entering their whole context into a
separate SaaS. Crucially, it lets an agent advocate for private constraints
*without disclosing them*: the agent screens candidates locally and returns
verdicts, so the server never learns the reason.

## How it creates a better user experience

- Humans and agents share one command model — a click and a tool call are
  indistinguishable to the session, so the map always reflects either instantly.
- The agent is not a separate copy of the app; it participates in the live page
  the human is looking at, and catches up through a revision delta on its next
  tool call rather than pretending to be a realtime subscriber.
- Privacy is a first-class control, not an afterthought: three visibility tiers,
  server-side redaction, and aggregate-only explanations that never name an
  owner or a reason.

## What people and agents can do together that was hard or impossible before

Combine several people's needs — including ones nobody wants to say aloud — into
one decision, with each person's own agent advocating within an explicit
authority envelope, and reach a private, consented compromise without any
participant exporting their full personal context to a shared service. An agent
can privately veto or accept on your behalf; the group sees the effect, never
the cause.

## How we implemented WebMCP

- **15 tools** registered imperatively on `document.modelContext` at page load
  (static surface — ChatGPT's in-app browser binds tools at page level), 8
  negotiation + 7 spatial, each a single narrow function with closed enum
  schemas, `readOnlyHint`/`untrustedContentHint` annotations, and capped result
  budgets. The page is fully usable without WebMCP.
- **Two application protocols over the WebMCP substrate**, taught to the agent by
  the first `sync_session` call's capability manifest (WebMCP itself only
  carries tool names/schemas): a domain-independent **negotiation protocol**
  (identity, revision sync, privacy tiers, requirements, stances, adjustments,
  consent, agreement) and a **spatial-destination domain** (scope, candidate
  dossiers with four-state attribute honesty, routes, navigation handoff).
- **Server-owned identity and per-viewer projections.** Actor identity comes
  only from the bearer token; no tool argument accepts an actor id. Every event
  is stored once and projected per viewer — unauthorized fields never appear in
  another participant's HTTP body or WebSocket frame (asserted at the wire in the
  test suite).
- **Revision discipline.** Every mutation carries the agent's last-seen
  revision; a stale one returns a structured `sync_required` with a delta instead
  of acting on old state — the async catch-up beat.
- **Agent-private screening loop.** For constraints the server must never see,
  the agent returns per-candidate verdicts; the council folds them into
  eligibility so peers see only the aggregate effect.
- **Deterministic council.** Eligibility, minimal-conflict-set detection, and
  quantified impasse counterfactuals are deterministic; no model invents
  feasibility facts.

Two independent adversarial reviews (a GPT-5.6 code review and a
protocol-invariant audit) ran against the build; the privacy and correctness
findings were fixed and are covered by tests.

## Tech

TypeScript monorepo (pnpm). Fastify + Postgres event log with per-participant
projections and a WebSocket realtime channel; React + Vite front end with
MapLibre GL and keyless OpenFreeMap vector tiles; TypeBox single-source
contracts with a hashed contract-manifest gate. Venue data is a one-time
OpenStreetMap extract of Berlin Mitte (ODbL). 77 automated tests across unit,
three-user API, and three-browser Playwright lanes.

## Try it

- **Live URL:** `<LIVE_URL>` — open in ChatGPT's in-app browser or Chrome with
  WebMCP enabled. The organizer link carries `?surface=chatgpt`.
- Guest links for the three demo participants are printed by the seed step; the
  secret rides in the URL fragment.

## Repository

`<REPO_URL>` — MIT licensed (code) + ODbL (OpenStreetMap data). See README,
`docs/DEMO-RUNBOOK.md`, and `docs/KNOWN-LIMITATIONS.md`.

## What's next

Extract the domain-independent `negotiation-core` (identity, projections,
consent, revision sync, WebMCP helpers) so the same privacy-preserving
negotiation layer drives other shared decisions — scheduling across private
calendars, group purchasing, resource allocation — by swapping only the domain
adapter.

---

## Submission checklist

- [ ] Live URL reachable in ChatGPT in-app browser / Chrome + WebMCP
      (Coolify deploy per `docs/DEPLOY-COOLIFY.md`; set `ORIGIN_TRIAL_TOKEN` for
      the deployed origin, or tools won't be discoverable there)
- [ ] Public repo URL, MIT LICENSE visible in the About section
- [ ] <3-min YouTube demo video, public, with audio covering what + how (WebMCP)
- [ ] Text description (above) pasted into the four Devpost fields
- [ ] Manual ChatGPT release gate re-run against the live URL (lane 5)
- [ ] If the app is auth-gated for judges, add credentials on the form (it isn't;
      guest links suffice)
