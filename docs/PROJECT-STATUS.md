# Project status — Spokes (handoff)

> **2026-09-02, later:** the venue layer moved onto whole-city OpenStreetMap
> snapshots for Berlin and San Francisco, with an area picker before the
> room and honest provenance inside it (`docs/DATA-QUALITY.md`, "Engine
> decision"). `room_demo` and the rehearsed trajectory are unchanged. The
> rest of this document predates that and the redesign; trust the code.

Last updated: 2026-09-02 (the mapview redesign has LANDED and its open menu
is closed: tokens, fonts, the FACETS.md server contract, the rebuilt client,
presence on the wire, the rewritten e2e lane (7 passing), the re-walked demo
runbook and recording script are on main. Read `docs/REDESIGN-HANDOFF.md`
first for the current state, locked decisions D1–D6 and the remaining gaps;
the counts and wave descriptions below it predate the redesign.)

This is the single source of truth for a new session
picking up the work. Read this, then `docs/DEMO-RUNBOOK.md` and
`docs/KNOWN-LIMITATIONS.md`.

## What Spokes is

A shared map where a small group and their personal AI agents privately
negotiate a meeting venue: state requirements (shared / application-private /
agent-private), see live eligibility, hit and resolve impasses via quantified
counterfactuals with in-page consent, reach an organizer-committed agreement,
and hand off to navigation. Built on WebMCP: 19 tools on
`document.modelContext` expose two custom protocols (`negotiation/v1` +
`spatial-destination/v1`). Concept + protocol design in `docs/` and
`docs/protocols/`.

## Current state (honest)

**Built and green.** The product vertical slice is implemented on top of the
validation-spike-1 core. Automated tests: **51 unit + 49 API + 6 e2e = 106
passing** (lanes 1–3). Two independent adversarial reviews ran (GPT-5.6 code
review + a protocol-invariant audit); the critical/high privacy and
agreement-integrity findings were fixed and are covered by tests, and the two
biggest deferred findings were closed on 2026-09-01: a realtime-only
**confirmation nonce** on `CommitAgreement`/`ConfirmPrivateRequest` (closes the
raw-HTTP bypass; honest residual limits in KNOWN-LIMITATIONS) and the **full
six-state phase machine** with a per-command gating table.

**UX pass done.** A full dual-agent `impeccable` critique ran (26/40 snapshot in
`.impeccable/critique/`), the user picked the two open design directions (wire
view as a designed trust feature; live-count legend), and the polish wave
shipped: desktop layout fix, legend, humanized copy end-to-end (phase labels,
provenance, requirement summaries), wire view, commit celebration, toasts,
a11y (tabbable pins, sr-only privacy text, contrast), scope spotlight mask
(outside the range dimmed), and unmistakable proposed (pulsing ring) / vetoed
(desaturated + dashed red ring + ✕ badge) pins. Two real rendering bugs died on
the way: the Vite dep optimizer broke MapLibre's worker (no basemap tiles ever
painted in dev serving) and the vetoed ring's base CSS only existed under
`data-proposed`.

**Three-window demo recordable.** `scripts/record-demo.mjs` drives the full
trajectory against its own server + throwaway room and records one paced video
per participant window plus `beats.log`
(`test-results/demo-recording/{org,sarah,joe}.webm`, ~55 s arc). These are
**rehearsal/evidence artifacts only** (spikes 6/7/8 evidence, spike 10 input) —
the user has explicitly decided the product is NOT ready for the submission
video: the three planned waves below come first, and recording resumes only
after them.

**NOT yet done / NOT verified — the real gaps before submission:**

1. **WebMCP-in-ChatGPT is unverified for the new slice.** The old spike's
   Gate 0/1 validated only `sync_session` in real ChatGPT. The 14 new
   spatial+negotiation tools have never been exercised in ChatGPT's in-app
   browser — this is the core thesis and it is untested end-to-end. Needs a
   public deploy (`docs/DEPLOY-COOLIFY.md`), a Chrome WebMCP origin-trial token
   for that origin, and the real ChatGPT app (user-side steps).
2. **Human eyes-on**: the recordings exist, but a human has to actually watch
   them (or the live three windows) and sign off the flow.
3. **Submission tail** — deliberately LAST: the sub-3-minute narrated video,
   Devpost submission (`docs/SUBMISSION.md` is a draft), and public-repo
   checklist all wait until the planned next waves (see below) are done.
4. **Deferred review findings still open** (documented in
   `docs/KNOWN-LIMITATIONS.md`, decide per item): organizer scope-change
   consent routing, mapRevision, token expiry, participant lifecycle.

We are **far from submission-ready** — do not treat the drafted `LICENSE` /
`docs/SUBMISSION.md` as a decision to submit; they are prep, written ahead.

## Where things live

- **Commits** (branch `main`): `3639cb1` spike 1 · `7525d4b` product slice ·
  `bc9ac2b` review fixes · `ca8fcbf` Coolify deploy · `4f7c80f`/`76df833`/
  `6330a2a` nonce + phase machine · `fdad82f`…`d0de320` polish wave ·
  `b59ae10` MapLibre worker fix · `a498352` scope mask + pin states ·
  `33fc2d7` demo recorder · `16cb3eb` human summaries. `LICENSE` (MIT + ODbL
  note) and `docs/SUBMISSION.md` (Devpost draft) are drafts.
- **Code map** (very detailed, from an Explore pass):
  `/home/alain/.claude/jobs/94b7999d/tmp/codebase-map.md` — job-temp, may be
  purged; regenerate with an Explore agent if gone.
- **Review reports**: codex review at
  `/home/alain/.claude/jobs/94b7999d/tmp/codex-review.Ihk82p/report.md`;
  invariant audit (16 findings + HELD list + repro scripts) at
  `/home/alain/.claude/jobs/94b7999d/tmp/invariant-audit.md`. Both are job-temp.
- **Venue dataset**: `packages/contracts/data/berlin-mitte-venues.json` (31 OSM
  venues + curated demo overlay), built by `scripts/extract-venues.mjs` +
  `scripts/curate-venues.mjs`; ODbL in `packages/contracts/data/ATTRIBUTION.md`.
- **Venue data research** (2026-09-01): `docs/DATA-QUALITY.md` — measured OSM
  attribute coverage for Berlin vs five San Francisco centres, why no public
  OSM API is safe in the request path, commercial pricing, and the three ways
  data quality limits the demo.
- **Next wave plan**: `docs/PLAN-LIVE-DATA-AND-ONBOARDING.md` — two areas, live
  self-hosted venue data, organizer onboarding with join link/QR, and agent
  attestation tools. Proposed, not started; one open decision recorded there.
- **Docs**: `DEMO-RUNBOOK.md`, `KNOWN-LIMITATIONS.md`, `DEPLOY-COOLIFY.md`,
  `SUBMISSION.md`; protocol specs in `docs/protocols/` (normative — impl matches;
  §5.4 was narrowed to match reality).

## Demo facts (verified against passing tests)

- Center 52.5219,13.3899, scope 800 m → **21 of 31 eligible** with no
  requirements. Demo requirement set (veg shared + lactose-free app-private +
  exclude Italian + budget ≤ €15) → **impasse fires when Joe's lactose
  requirement lands**; the radius adjustment widens **800 → 1200 m → 3 eligible**;
  veto target **Chén Ché (place_30)** leaves **2**; final destination
  **The Barn (place_24)**. (Dataset manifest says 4 at 1400 m; the engine picks
  the smallest 200 m step reaching ≥3, which is 1200 m — the runbook uses the
  engine's real numbers.)

## Stack decisions (locked)

MapLibre GL + `@vis.gl/react-maplibre`, keyless OpenFreeMap tiles
(`.../styles/liberty`); routing via FOSSGIS OSRM with a haversine fallback
(currently haversine only — walk_min); Google Maps URL for navigation handoff.
All keyless and ToS-cleared for a public demo (spike 9). Agreement rule:
all-accept-organizer-commit. See `[[product-slice-decisions]]` memory.

## How to resume

- **Run the demo**: `make demo` (docker; needs `sudo -n` on this machine), then
  `node scripts/open-participants.mjs`. The demo stack runs on 4173.
- **After pulling new code**: `git pull && sudo -n make update` — rebuilds every
  image (including the profile-hidden `seed-demo`), migrates, restarts, reseeds.
  Then hard-reload open tabs. (`git pull` stays outside make so sudo never runs
  git as root.) If the map is stuck on "Loading the shared map…", the room was
  seeded by a stale image and lost its scope: `make demo-reset`.
- **Record the demo**: `node scripts/record-demo.mjs` (own server + throwaway
  room; three videos + beats.log).
- **Tests**: `pnpm test:unit`; `pnpm test:api` and `pnpm test:e2e` need the db
  up + migrated (`sudo -n docker compose up -d db migrate`). `sudo -n make test`
  loses the user's pnpm PATH — run the pnpm scripts directly instead. An
  orphan smoke server may linger on **4180**; kill it if tidying.

## Planned next waves (user-confirmed 2026-09-01; all required before the video)

The user chose ALL of these as still needed, in no committed order, each to be
PLANNED and DESIGNED before building:

1. **Product depth** — descoped protocol features return to the table:
   disclosure ladder L1–L3, richer requirement types, time-window eligibility,
   meeting points, multiple areas/rooms. Discovery path: the protocol docs'
   open-questions sections (`docs/protocols/*.md`) name each descope and its
   design questions; `PRODUCT-CONCEPT.md` and `IDEATION-JOURNAL.md` hold the
   original ambitions to mine.
2. **Visual identity overhaul** — the critique's verdict stands: the semantic
   core is authored, the chrome is timid. A real design-direction pass (brand,
   typography, header, map styling) beyond the shipped polish. Discovery path:
   `.impeccable/critique/2026-09-01T07-24-12Z__apps-web.md` (especially the
   "provocative questions"), `apps/web/DESIGN.md` as the incumbent system to
   evolve or deliberately replace.
3. **Agent/ChatGPT experience** — deepen the tool surface: first-run
   instructions, richer tool results, the agent-private screening loop's UX,
   demo choreography for the agent window. Discovery path:
   `docs/protocols/INTERACTION-AND-BINDING.md` (tool descriptions and result
   budgets), `WEBMCP-REFERENCE.md`, the lane-5 gate below.

After those waves: the ChatGPT WebMCP gate (public deploy + origin-trial token
+ real ChatGPT run of the 14 tools), the human sign-off, and only then the
narrated sub-3-minute video and Devpost submission.
