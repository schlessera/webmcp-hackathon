# Project status — Spokes

**Last updated:** 2026-09-03, after the WebMCP Challenge deadline.
**HEAD:** `37e9208` on `main`. **Live:** <https://spokes.alainschlesser.com>
(deployed build `37e9208` — `main` and production are in step). **Tool
contract:** version 3, 22 tools.

This is the single source of truth for anyone picking the work up. It replaces
the 2026-09-02 version of this file, which predates roughly 313 commits.

---

## Where things stand

The entry was **submitted to the WebMCP Challenge 2026 before the deadline
(3 September 2026, 22:00 CEST), without the narrated video.** That is the one
hole in the submission itself; everything else the entry claims is deployed and
running. Judging runs 4–21 September.

Two consequences shape the near-term work:

- **The submission is frozen; the project is not.** Per the official rules, the
  Devpost submission cannot be altered after the deadline, but the project in
  the Devpost portfolio — and this repository — can keep moving.
- **The live URL has to keep working through 21 September.** Judges test
  against it. Any change that reaches production during the judging window
  should be treated as touching the thing being judged.

Verified live, 2026-09-03 after the push: `GET /api/meta` returns
`{"buildId":"37e9208","toolContractVersion":"3","nl":true}`; the origin-trial
response header decodes to `{"origin":"https://spokes.alainschlesser.com:443",
"feature":"WebMCP","expiry":1794873600}` (mid-November 2026). The served
document carries no injected script, the WebSocket authenticates and streams
`welcome`/`presence`/`pipeline`/`lookups`, and a browser pass found no console
error and no failed request.

`docs/DEPLOY.md` is now the deployment playbook. `docs/DEPLOY-COOLIFY.md` keeps
only its environment-variable and origin-trial sections and says so at the top.

---

## What Spokes is

A shared map where a small group and their personal AI agents converge on a
place to meet. People state needs at three privacy levels, watch eligibility
recompute live, hit and resolve impasses through quantified counterfactuals with
in-page consent, reach an organizer-committed agreement, and hand off to
navigation. Each person's agent participates in the same room through WebMCP —
22 tools on `document.modelContext` carrying two protocols (`negotiation/v1` and
`spatial-destination/v1`).

The room is domain-agnostic by construction: every control the client draws
comes from server-returned facet data, and there is no domain branch anywhere in
the front end.

---

## What is built

### The room

Goal-first start (`apps/web/src/Start.tsx`): pick an area, type what the group
is trying to do, and `POST /api/plans/preview` reads that sentence into one step
— a place class plus pending needs the organizer can drop before the room
exists. `POST /api/rooms` then creates it. Invite links bypass the picker; `/`
serves a landing page.

Inside the room: an edge-to-edge MapLibre map that never re-centres on a set
change, a brief of what the group has asked for (press-and-hold any need row to
preview the map without it), a composer with a shared/private/agent-private
scope selector, a place details panel that renders whatever attribute groups the
server sends, and the `{ }` drawer — which since `10c169b` draws the wire as a
five-lane timeline rather than a log.

### Decision engine

`apps/server/src/engine.ts` is the single command bus: 19 command types, Ajv
validation, transactional, optimistic concurrency on `baseRevision` (a stale one
returns `sync_required` with a delta), participant-scoped idempotency keys, and
a six-state phase machine with a per-command gating table. UI gestures and
WebMCP tool calls enter through the same door.

`eligibility.ts` classifies each place five ways — eligible, likely, uncertain,
unlikely, excluded. Only verified statuses (confidence ≥ 0.7) rule a place in or
out; a guess is drawn dashed and never makes a room feasible. The client shows
`matching + likely` as the big number, while `matching`, the impasse arithmetic
and every relaxation delta stay eligible-only on the wire.

`impasse.ts` computes the minimal conflict set and the quantified relaxations.
`projection.ts` redacts per viewer, so unauthorised fields never enter another
participant's HTTP body or WebSocket frame. `confirmation.ts` mints single-use
nonces delivered only over the staging participant's own socket.

### The enrichment pipeline

The largest change since the last version of this doc. A process-global
admission controller in `apps/server/src/pipeline/`, documented accurately in
`docs/ENRICHMENT-SOURCES.md`:

- **Seven work kinds** — `fetch.site`, `fetch.search`, `fetch.asset`,
  `process.judge`, `process.adjudicate`, `process.vision`, `process.decode`.
- **Seven pools** with continuous refill and a priority-zero reservation:
  interactive 3, proxy 8, direct 4, search 4, llm-matrix 2, vision 1,
  image-decode 2.
- **Deficit round robin across rooms, strict priority within one.** Priority 0
  means a person is waiting; background tiers start at 1.
- **One focus per participant.** Moving on drops that participant's queued
  interactive work and aborts its in-flight legs unless another participant
  shares the place. Superseded plan generations publish nothing.
- **Admission floor:** one plan per (place, needs epoch) with a 60-second floor;
  a refused open publishes an immediate `done` carrying `completionReason`.
  "Look again" forces past it.
- **Batching:** matrix rectangles of ≤ 8 places × 5 criteria on a 300 ms
  window; priority-zero cells bypass the window.

Evidence merges monotonically through a single source-rank table (record >
own-site explicit > listing > own-site inferred > domain search > open web >
name/category). An abstention never overwrites a stronger claim, and inference
is capped by source bucket. Sources shipping today: the OSM long tail, venue
websites (JSON-LD plus visible text), Wikidata and Commons, DataForSEO business
listings, a vision menu reader, and facts a person confirmed (kept permanently,
across rooms).

Outbound traffic runs through `net/outbound.ts`: PacketStream residential exits,
per-purpose routing, per-host breakers, a stable 10 % direct control group,
robots honoured, and an SSRF guard on every target.

### Place data

Committed OpenStreetMap area snapshots are the source of truth; no public query
API sits in the request path. `scripts/build-area-snapshot.mjs` clips a
Geofabrik extract and measures its own coverage, which `/api/areas` surfaces —
those numbers are never typed into the client.

| Area | Venues | Landmarks | Focus coverage |
|---|---|---|---|
| berlin-mitte | 19,095 | 3,000 | 874 places, 21.2 % decisive |
| sf-soma | 5,260 | 3,000 | 910 places, 8.9 % decisive |

Scope radii 800 / 1,400 / 2,000 m, `POOL_CAP` 2,500. The explore layer behind
the map loads for the viewport the user panned to — loading follows the
viewport, never the other way round. Ten step classes (food, cafe, drinks,
cinema, theatre, park, museum, coworking, sport, books) decide which place
classes a room's pool draws from.

`room_demo` still runs on the 31-venue curated Berlin Mitte set, unchanged, so
the rehearsed demo arithmetic stays deterministic.

### Models

One door (`nl/llm.ts`), one deployment model: **`openai/gpt-5.6-luna` through
OpenRouter at high reasoning effort.** Per-role overrides
(`LLM_MODEL_ROUTE/_JUDGE/_AGENT/_VISION`, `MENU_READER_MODEL`) all fall back to
it and survive only as override seams. `OPENROUTER_PROVIDERS` pins endpoints
with `allow_fallbacks: false`, so a refusal surfaces instead of a silent swap;
the private screening path adds `data_collection: deny` and `zdr: true`. Search
runs on Parallel's turbo processor by default, with OpenAI and Tavily behind it.

Without a model key the room still works: the composer falls back to label
matching and no agent card appears. No model is ever allowed to invent a
feasibility fact.

### WebMCP surface

22 tools defined once in `packages/contracts/src/tools.ts` and registered at page
load — 10 negotiation, 12 spatial. Unauthenticated calls return a structured
`not_authenticated` rather than being absent. Result budgets: 1,500 characters,
8,000 for `sync_session`. `CommitAgreement` and `ConfirmPrivateRequest`
deliberately have no tool binding.

The page's own agent (`nl/agent.ts`) acts for exactly one person over the same
tool surface and the same command bus. Agent-private conditions live in memory
only (`nl/held-registry.ts` — never a table, an event, or a frame).

### Persistence

Postgres 17.6, 24 migrations, immutability enforced by a hash manifest and a
unit test. Room state, attestations and confirmed facts, per-OSM-ref enrichment
rows, place images with blurhashes, and four caches — page, outbound metadata,
search, and a matrix cache that has **no expiry by design**: an identical
evidence hash means that exact question was already answered.

---

## Verified state

Every number below was measured on this tree, not carried over from an earlier
session. The unit and api rows were re-measured on 2026-09-04; the e2e row
still stands from 2026-09-03.

| Lane | Command | Result |
|---|---|---|
| typecheck | `pnpm typecheck` | clean, 3 projects |
| unit | `pnpm test:unit` | **778 / 778**, 57 files, no database |
| api | `vitest run tests/api --maxWorkers=4` | **221 / 225**, 35 files — 4 failures, see below |
| e2e | `pnpm test:e2e` | **32 / 46 — 14 failing**, see below |
| native | `pnpm test:native` | not run — needs real Chrome ≥ 149 |

**Cap the api lane's workers.** Left to itself vitest opens one worker per
core, and on a 32-core machine the spawned servers ask Postgres for more
connections than `max_connections` (100 by default) allows: about twenty files
then fail with `sorry, too many clients already`, which says nothing about the
code. `--maxWorkers=4` is enough to stay under it.

**The api lane only means something on a fresh database.** Against the
long-lived compose database the four remaining failures were `demo-seed`,
`pipeline`, `providers` and `rooms`; they reproduce on a clean checkout of the
same commit, and they come from global rows that accumulate across runs
(confirmed facts, place images, the caches), not from the change under test.
`DROP`/`CREATE` a scratch database, migrate into it, and point `DATABASE_URL`
at it before quoting a number.

**The e2e lane has a real regression.** All 14 failures are in
`tests/e2e/spokes-ui.spec.ts` and all of them funnel through one helper,
`closeDrawer` (`tests/e2e/spokes-ui.spec.ts:559`): the `{ }` drawer's close
control satisfies the visibility assertion and is then gone by the time the
click is attempted, so every spec that opens the drawer times out at 60 s. A
fresh database does not change it. Landing, three-user and spokes-flow all pass.

It is not yet bisected. The lane was 46 / 46 at `133c81b`, which already
contained the wire-timeline drawer rewrite, so the cause is somewhere in the
nine commits after it — of which only `cca69ce` (the place panel settling after
a mid-read lookup) and `b18c814` (the new dev server) touch the client at all.
One caveat on the measurement: a second session had uncommitted edits to
`Landing.tsx` and `landing.css` in this working tree while the lane ran. They
are landing-only and the landing specs pass, but attribution is not settled
until someone runs the lane on a clean checkout.

Static `it(`/`test(` counts undercount the real total by 20–30 %, because
several suites are table-driven off `tests/fixtures/nl-corpus.jsonl`. Quote a
run, not a grep. The old "222 unit + 128 API + 14 e2e = 364" figure is stale in
every lane by a wide margin.

There is no CI. `make test` runs unit, api and e2e in sequence but takes no
lock, and the api lane truncates global cache tables.

---

## Running it

```sh
make demo                             # stack + seeded room_demo on 127.0.0.1:4173
node scripts/open-participants.mjs    # Sarah and Joe in isolated contexts, organizer URL printed
make update                           # after a git pull: rebuild every image, migrate, restart, reseed
make demo-reset                       # reset and reseed only room_demo
make dev                              # compose watch, HMR
make venues / venues-refresh          # rebuild the area snapshots from the Geofabrik extracts
APP_DOMAIN=… scripts/push-to-hetzner.sh   # ship to production
```

Deployment is **Caddy in front of the existing compose stack on a plain Docker
host** (`compose.prod.yaml` + `Caddyfile` + the two Hetzner scripts), documented
in `docs/DEPLOY.md`. Coolify was prepared and abandoned at the gate.

Nothing is strictly required in the environment — `apps/server/src/config.ts`
defaults everything — but the live paths need `OPENROUTER_API_KEY`,
`PARALLEL_API_KEY`, `DATAFORSEO_LOGIN`/`_PASSWORD`, `PROXY_URL`,
`DEMO_SECRET_KEY` and `ORIGIN_TRIAL_TOKEN`. There is no `.env.example`;
`docs/DEPLOY-COOLIFY.md` §2 carries the full variable table, which is current
even though its platform is not.

`room_demo` on production currently holds **356 candidates**, not the seeded 31:
the explore layer accumulated them during live sessions and the seed tops up
rather than wipes. The room is otherwise clean — no active needs. The runbook's
rehearsed counts (21 in scope, 12, 0, 4 of 31) will not reproduce against it
without `seed --reset`.

---

## The demo

`docs/DEMO-RUNBOOK.md` holds the rehearsed 14-beat, three-window script on
`room_demo`, with counts the engine actually produces: 21 places in scope →
12 after Sarah's shared need → 0 after Joe's private one → 0 after Alain's two
→ 4 of 31 once the area widens to 1.2 km → settled on The Barn. It is accurate
except for one number: setup step 3 says 17 WebMCP tools, and there are 22.

The rehearsed demo is **not** goal-first. `make demo` seeds a fixed room with a
fixed scope and three joined participants. Goal-first rooms, the area picker and
the live-data path are real and reachable, but unrehearsed, and the runbook's
optional section describes the pre-goal version of that flow.

No narrated video exists. `scripts/record-demo.mjs` still drives the full
trajectory against its own server and a throwaway room, producing three paced
`.webm` files plus `beats.log`; `test-results/demo-recording/` is not in the
working tree.

---

## Open gaps

**Broken now**

0. **14 e2e specs fail on `main`** — the drawer-close regression described under
   "Verified state". It is the only red lane, it is reproducible, and it blocks
   any honest "all green" claim. Fix it before anything on this list.

**The submission**

1. No narrated video. The submission is frozen, so this can only improve the
   Devpost portfolio entry, not the judged submission.
2. The manual ChatGPT gate — the 22 tools exercised end to end in ChatGPT's
   in-app browser against the live URL — has never been run and recorded. The
   deploy and the origin-trial token are both in place, so nothing blocks it.
   `docs/VALIDATION-SPIKE-1-AUTOMATED-DEMO.md` lane 5 has the ten steps.

**Protocol and privacy** (each with a written threat model in
`docs/KNOWN-LIMITATIONS.md`)

3. The confirmation nonce binds to a page session, not to a human gesture: the
   same token holder can open a socket, be re-issued a nonce, and apply.
4. Organizer `SetSearchScope` applies without consent routing — spatial
   invariant 7 is unimplemented for the organizer; members are refused outright.
5. No participant join/leave lifecycle. `policy.expiresAt` is stored but not
   enforced; guest tokens neither expire nor revoke.
6. `exclusion.key` is still pinned to the literal `"cuisine"`
   (`packages/contracts/src/commands.ts`) — a domain word on the wire, against
   the domain-agnostic rule. `FACETS.md` should decide whether exclusions
   generalise to any enum facet.
7. Five protocol questions stay open in `docs/protocols/*` §7: commutative
   rebase, brief and delta wording templates, the `evaluate_candidates`
   re-screen nudge, the scoring model, and the minimal-conflict-set algorithm.
8. The disclosure ladder L1–L3, transit routing and meeting points remain
   scoped out. Agent-private screening (L0) ships.

**Product and UI** (fuller list in `docs/REDESIGN-HANDOFF.md`)

9. Desktop is a thin adaptation of mockup 8c — a 319 px rail and a wide map.
   Nobody has decided what desktop is for; that is a design decision first.
10. The agreed map draws no route and no origin marker.
11. The `{ }` drawer is a full-screen takeover without the Wire / Tools /
    Session tabs the mockup specifies.
12. "Send the link" is not built — invite secrets are minted per person and
    never come back to the page.
13. Attribution links are 7 px with no 44 px target: invariant 11 and invariant
    13 contradict each other and the contradiction is unresolved.

**Data and operations**

14. Presence, realtime fan-out and the pipeline counters are single-process. No
    LISTEN/NOTIFY, no Redis, no cross-worker presence store. A multi-instance
    deploy needs sticky sessions or a shared store, and split work would make
    the volume figures wrong.
15. Budget needs are EUR-only, so an SF room classifies every place unsure on
    budget. Supplementary SF sources are researched but unwired.
16. Roughly 45 % of Berlin and 50 % of SF focus places have no website tag; the
    Foursquare/Overture offline join that would close it is not built.
17. Wave 3 D2 — multi-step goals with `then`/`near` offers and `stepId` columns
    — is designed but unbuilt, and its design note (`UNDERSTANDING-ARCH.md`) is
    not in the repository. `docs/NL-AGENT.md` still cites it.

---

## Which documents to trust

**Current, written or rewritten against the shipped code**

- `README.md` — demo-first, accurate, and now pointing at `docs/DEPLOY.md`.
- `docs/SYSTEM-ARCHITECTURE.md` — carries the scheduler, outbound routing and
  the interactive lane.
- `docs/ENRICHMENT-SOURCES.md` — the pipeline document that matches the code.
- `docs/DATA-QUALITY.md` — measured coverage, and why no public OSM API sits in
  the request path.
- `docs/NL-AGENT.md` — the two agent tiers and the goal-first read.
- `docs/KNOWN-LIMITATIONS.md` — the deferral list, with one exception: it says
  the `setup` and `closed` phases are unreachable, and `setup` became reachable
  when room creation shipped.
- `docs/DEMO-RUNBOOK.md` — one wrong tool count, otherwise walked.
- `docs/DEVPOST.md` — the submitted narrative. Its test counts are the ones that
  were true when it was written.
- Root `PRODUCT.md`, `DESIGN.md`, `CLAUDE.md`, `apps/web/SPOKES-UI.md`,
  `apps/web/COPY.md`, `apps/server/FACETS.md` — the working invariants.

**Superseded, and mostly not saying so**

- `docs/DEPLOY-COOLIFY.md` — the platform was abandoned; §2's environment table
  and §4's origin-trial notes are still the best there are, and the file now
  says so at the top. `docs/DEPLOY.md` replaced it as the playbook.
- `docs/PLAN-LIVE-DATA-AND-ONBOARDING.md` — headed "proposed, not started",
  while three of its four waves shipped and wave 2's self-hosted Overpass
  architecture was rejected in `DATA-QUALITY.md`.
- `docs/REDESIGN-HANDOFF.md` — locked decisions D1–D6 still bind; its test
  counts and `TOOL_CONTRACT_VERSION 2` are wrong.
- `docs/SUBMISSION.md` — reads pre-deploy, keeps `<LIVE_URL>` placeholders and
  an unchecked checklist. `DEVPOST.md` is the real narrative; `SUBMISSION.md`
  uniquely holds the WebMCP-fit bullets.
- `docs/EXPERIENCE-AND-DEMO.md` — its 16-step sequence predates the runbook's 14
  beats. `docs/README.md` — an August 31 index that omits half the corpus.
  `docs/PROTOCOLS.md` — self-marked superseded. `docs/MVP-AND-RISKS.md` — its
  open-decisions list is fully resolved and carries no caveat.
- `docs/protocols/INTERACTION-AND-BINDING.md` §2.3 is headed "22 tools" and
  enumerates 21: `confirm_fact` is documented nowhere in the corpus.

---

## Operating rules that will bite

- **Take the shared lane lock.** `flock /tmp/claude-1000/spokes-lane.lock` for
  the api and e2e lanes. Sibling worktrees share the compose database and the
  api lane truncates global cache tables; concurrent runs corrupt each other.
- **Run the api lane twice, or run it on a fresh database.** Global rows
  (confirmed facts, images, caches) accumulate, so one green run proves less
  than two. `DROP`/`CREATE` a scratch database and migrate for merge testing.
- **Never edit an applied migration.** Add one and re-run
  `node scripts/migration-hashes.mjs`; a unit test enforces it.
- **Local Node is four majors behind the image.** `engines.node` is ≥ 24, the
  local default is 22.18, the Dockerfile builds on node:26-alpine. pnpm warns on
  every command; nothing has broken yet.
- **`make test` omits the native lane**, and the compose `e2e` service runs only
  `three-user.spec.ts` — narrower than `pnpm test:e2e`.
- Test servers run with `OPENAI_API_KEY=""` so no lane can spend money.
