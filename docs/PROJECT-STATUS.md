# Project status — Spokes (handoff)

Last updated: 2026-09-01. This is the single source of truth for a new session
picking up the work. Read this, then `docs/DEMO-RUNBOOK.md` and
`docs/KNOWN-LIMITATIONS.md`.

## What Spokes is

A shared map where a small group and their personal AI agents privately
negotiate a meeting venue: state requirements (shared / application-private /
agent-private), see live eligibility, hit and resolve impasses via quantified
counterfactuals with in-page consent, reach an organizer-committed agreement,
and hand off to navigation. Built on WebMCP: 15 tools on
`document.modelContext` expose two custom protocols (`negotiation/v1` +
`spatial-destination/v1`). Concept + protocol design in `docs/` and
`docs/protocols/`.

## Current state (honest)

**Built and green.** The product vertical slice is implemented on top of the
validation-spike-1 core. Automated tests: **33 unit + 38 API + 6 e2e = 77
passing** (lanes 1–3). Two independent adversarial reviews ran (GPT-5.6 code
review + a protocol-invariant audit); the critical/high privacy and
agreement-integrity findings were fixed and are covered by tests. Production
serving path (the deploy image, not the dev server) was smoke-tested against the
real Berlin dataset.

**NOT yet done / NOT verified — the real gaps before submission:**

1. **No human has watched it run.** Only automated tests + e2e screenshots
   confirm the flow. An attempt to auto-capture the live three-window demo via
   Codex computer-use was **blocked** (its browser-control backend isn't wired
   to this machine's display; Playwright/chromium do work here). A live
   eyes-on pass is still owed. Existing stills: `test-results/spokes-*.png`
   (impasse, deliberation, consent, arrival, live dossier details).
2. **WebMCP-in-ChatGPT is unverified for the new slice.** The old spike's
   Gate 0/1 validated only `sync_session` in real ChatGPT. The 14 new
   spatial+negotiation tools have never been exercised in ChatGPT's in-app
   browser — this is the core thesis and it is untested end-to-end. Needs the
   real ChatGPT app + a Chrome WebMCP origin-trial token for the origin used.
3. **Validation spikes 6–10** (see `docs/MVP-AND-RISKS.md`): map/agent command
   parity and navigation handoff are implemented but not spike-signed-off; the
   three-window rehearsal (spike 10) hasn't happened; provider licensing
   (spike 9) is researched and cleared (see below).
4. **UX polish.** The `impeccable` skill ran only an in-thread pass, not its
   full design review. The map UI hasn't had a real critique.
5. **Deferred review findings** are documented in `docs/KNOWN-LIMITATIONS.md`,
   not fixed (partial phase machine, organizer scope-change consent routing,
   the raw-HTTP bypass of the in-page-confirm claim, mapRevision, token expiry,
   participant lifecycle). Decide per item whether to fix or accept.

We are **far from submission-ready** — do not treat the drafted `LICENSE` /
`docs/SUBMISSION.md` as a decision to submit; they are prep, written ahead.

## Where things live

- **Commits** (branch `main`): `3639cb1` spike 1 · `7525d4b` product slice ·
  `bc9ac2b` review fixes · `ca8fcbf` Coolify deploy. `LICENSE` (MIT + ODbL note)
  and `docs/SUBMISSION.md` (Devpost draft) are drafts.
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

- **Free port 4173 first**: an orphaned dev server (`node apps/server/src/
  server.ts`) from a fork's integration run holds it; `kill` was blocked for the
  agent by the permission classifier — run `kill <pid>` yourself (find it with
  `ss -tlnp | grep 4173`). A smoke-test production server may still be running on
  **4180** (same orphan situation) — kill it too if tidying.
- **Run the demo**: `make demo` (docker; needs `sudo -n` on this machine, and
  4173 free), then `node scripts/open-participants.mjs`. Or the no-Docker path in
  the README against the already-running db container.
- **Tests**: `pnpm test:unit`; `pnpm test:api` and `pnpm test:e2e` need the db
  up + migrated (`sudo -n docker compose up -d db migrate`). `sudo -n make test`
  loses the user's pnpm PATH — run the pnpm scripts directly instead.
- **The two implementation forks** (`impl-core` = contracts/server/tests;
  `impl-web` = web/e2e) are resumable by name via SendMessage with full context
  if more slice work is needed.

## Suggested next focus (user to pick)

Live eyes-on verification (Playwright headed, since Codex CU is blocked here) ·
the ChatGPT WebMCP gate for the new tools · UX polish · fixing deferred
findings · spikes 6–10 rehearsal.
