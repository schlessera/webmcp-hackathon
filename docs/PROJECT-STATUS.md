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

**Three-window demo recorded.** `scripts/record-demo.mjs` drives the full
trajectory against its own server + throwaway room and records one paced video
per participant window plus `beats.log`
(`test-results/demo-recording/{org,sarah,joe}.webm`, ~55 s arc) — raw material
for the submission video and the eyes-on check (spikes 6/7/8 evidence, spike 10
rehearsal input).

**NOT yet done / NOT verified — the real gaps before submission:**

1. **WebMCP-in-ChatGPT is unverified for the new slice.** The old spike's
   Gate 0/1 validated only `sync_session` in real ChatGPT. The 14 new
   spatial+negotiation tools have never been exercised in ChatGPT's in-app
   browser — this is the core thesis and it is untested end-to-end. Needs a
   public deploy (`docs/DEPLOY-COOLIFY.md`), a Chrome WebMCP origin-trial token
   for that origin, and the real ChatGPT app (user-side steps).
2. **Human eyes-on**: the recordings exist, but a human has to actually watch
   them (or the live three windows) and sign off the flow.
3. **Submission tail**: the sub-3-minute narrated video, Devpost submission
   (`docs/SUBMISSION.md` is a draft), and public-repo checklist.
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
  `node scripts/open-participants.mjs`. The demo stack runs on 4173. **After
  pulling new code, rebuild the images** — and note `seed-demo` hides in compose
  profile `seed`, so plain `docker compose build` skips it:
  `sudo -n docker compose build && sudo -n docker compose --profile seed build
  seed-demo`, then `up -d app` (+ `run --rm migrate` if migrations changed).
  A stale seed image wipes the room scope ("Loading the shared map…" = scope
  NULL → run the fresh seed with `--reset`).
- **Record the demo**: `node scripts/record-demo.mjs` (own server + throwaway
  room; three videos + beats.log).
- **Tests**: `pnpm test:unit`; `pnpm test:api` and `pnpm test:e2e` need the db
  up + migrated (`sudo -n docker compose up -d db migrate`). `sudo -n make test`
  loses the user's pnpm PATH — run the pnpm scripts directly instead. An
  orphan smoke server may linger on **4180**; kill it if tidying.

## Suggested next focus (user to pick)

The ChatGPT WebMCP gate (deploy + origin-trial token + real ChatGPT run of the
14 tools) · human watch of `test-results/demo-recording/` · the narrated
sub-3-minute video · remaining deferred findings.
