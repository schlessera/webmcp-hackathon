# Devpost submission — Spokes

Copy-paste-ready. Fill the two placeholders (`<LIVE_URL>`, `<REPO_URL>`) once
the Coolify deploy and the public repo URL exist. Keep the video under 3 minutes.

---

## Project name

**Spokes**

## Elevator pitch (one line)

A shared map where people and their personal AI agents privately negotiate
what they need, resolve conflicts, and agree on where to meet — together.

## Inspiration / the problem

Groups constantly struggle to pick somewhere to go. The needs are scattered
across people and dribble out piecemeal: a dietary restriction here, a budget
there, a veto that lands late, a reason someone would rather not say out loud. A
search results list optimizes one query; a group chat collects messages; neither
maintains a shared constraint model, and neither lets you keep a sensitive
reason private while still having it counted. Spokes is built for exactly that:
a shared, asynchronous negotiation space for a group **and** their agents.

## What it does

Three people open one planning room from a link. They see the same live map and
the same brief of what the group has asked for. Each person says what matters in
one composer bar — choosing who may see it *before* speaking — and the app
suggests the next thing worth asking for from the data itself, never from a
built-in list of categories. A need can be **shared**, **private** (the server
evaluates it; peers see only its effect on the count), or **agent-only** (a
declaration; the content stays with your agent and never reaches us).

Every need becomes a row you can set aside, and press and hold shows the map
without it, live, so the cost of each need is visible instead of argued about.
The room recomputes which places still work after every move, counts what is
merely unverified separately from what actually failed, and detects when nothing
satisfies everyone. Instead of naming who is blocking, it privately offers a
**quantified** way out: "widen the area from 800 m to 1.2 km, brings back 4
places" to the organizer, "let this need be nice-to-have, +12 places" to the
person who stated it. Consent is explicit and confirmed on the page. When the
group agrees, the composer is replaced by arrival: a travel mode and a one-tap
handoff to the map app everyone already has.

Your personal ChatGPT can sit alongside the live page and act *in the same
session* through WebMCP: catch up on what changed while you were away, inspect
places, put one forward, rule one out, grant an adjustment — all as the same
commands a human gesture would produce.

## Why this is a strong fit for WebMCP

The page already holds semantic state an external agent cannot recover from
pixels: what each pin means, which places were ruled out and *why*, which are
merely unverified, the current selection and vetoes, the active search area and
time, data provenance and freshness, the current participant's identity and
their authorized private projection, and everything that changed since the agent
last participated. WebMCP lets a personal agent read and act on that live state
directly, as the person it represents, without the user re-entering their whole
context into a separate SaaS. Crucially, it lets an agent advocate for private
constraints *without disclosing them*: the agent screens places locally and
returns verdicts, so the server never learns the reason.

## How it creates a better user experience

- Humans and agents share one command model — a gesture and a tool call are
  indistinguishable to the session, so the map always reflects either instantly.
- The agent is not a separate copy of the app; it participates in the live page
  the human is looking at, and catches up through a revision delta on its next
  tool call rather than pretending to be a realtime subscriber.
- Privacy is a first-class control, not an afterthought: three visibility tiers
  chosen before you speak, server-side redaction, and effects that are always
  visible while contents never leave their owner's client.
- Nothing in the interface names a domain. Every control is generated from what
  the server says is askable about the current results, so the same screens
  serve a dog-friendly park, an exhibition, a screening in a given language or
  dinner — and missing data is drawn as its own state rather than silently
  dropping a place.

## What people and agents can do together that was hard or impossible before

Combine several people's needs — including ones nobody wants to say aloud — into
one decision, with each person's own agent advocating within an explicit
authority envelope, and reach a private, consented compromise without any
participant exporting their full personal context to a shared service. An agent
can privately screen, accept or rule out on your behalf; the group sees the
effect, never the cause.

## How we implemented WebMCP

- **20 tools** registered imperatively on `document.modelContext` at page load
  (static surface — ChatGPT's in-app browser binds tools at page level), 9
  negotiation + 10 spatial, each a single narrow function with closed enum
  schemas, `readOnlyHint`/`untrustedContentHint` annotations, and capped result
  budgets. The page is fully usable without WebMCP.
- **Two application protocols over the WebMCP substrate**, taught to the agent by
  the first `sync_session` call's capability manifest (WebMCP itself only
  carries tool names/schemas): a domain-independent **negotiation protocol**
  (identity, revision sync, privacy tiers, requirements, stances, adjustments,
  consent, agreement) and a **spatial-destination domain** (scope, place
  dossiers with four-state attribute honesty, routes, navigation handoff).
- **Server-described controls.** The server returns the facets present across
  the current result set — label, type, and a mandatory unknown count — and the
  client renders whatever it gets. There is no domain branch anywhere in the
  front end, which is also what lets an agent and a human reason over the same
  vocabulary.
- **Server-owned identity and per-viewer projections.** Actor identity comes
  only from the bearer token; no tool argument accepts an actor id. Every event
  is stored once and projected per viewer — unauthorized fields never appear in
  another participant's HTTP body or WebSocket frame (asserted at the wire in the
  test suite).
- **Revision discipline.** Every mutation carries the agent's last-seen
  revision; a stale one returns a structured `sync_required` with a delta instead
  of acting on old state — the async catch-up beat.
- **Agent-private screening loop.** For constraints the server must never see,
  the agent returns per-place verdicts; the council folds them into
  eligibility so peers see only the aggregate effect.
- **Consent the agent cannot forge.** An agent may recommend a grant, but a
  change beyond what the user delegated only *stages*. Staging pushes a
  single-use code to the page's own realtime channel; the applying command must
  carry it back, and it never appears in any tool result.
- **Deterministic council.** Eligibility, minimal-conflict-set detection, and
  quantified impasse counterfactuals are deterministic; no model invents
  feasibility facts.

Independent adversarial reviews ran against both waves of the build — a
protocol-invariant audit and a GPT-5.6 review of the server, then two further
model reviews of the rebuilt client. The privacy and correctness findings were
fixed and are covered by tests.

## Tech

TypeScript monorepo (pnpm). Fastify + Postgres event log with per-participant
projections and a WebSocket realtime channel; React + Vite front end with
MapLibre GL and keyless OpenFreeMap vector tiles; TypeBox single-source
contracts with a hashed contract-manifest gate. Place data is a one-time
OpenStreetMap extract of Berlin Mitte (ODbL). 364 automated tests across unit,
three-user API and three-browser Playwright lanes (222 unit, 128 API, 14 Playwright
tests that drive the redesigned client in isolated browser contexts).

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
- [ ] `docs/DEMO-RUNBOOK.md` walked end to end on the deployed build, so the
      counts quoted on camera are the ones the live data produces
- [ ] If the app is auth-gated for judges, add credentials on the form (it isn't;
      guest links suffice)
