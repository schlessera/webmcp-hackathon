# Plan: multi-area live venue data and organizer onboarding

Status: **proposed, not started.** Written 2026-09-01 as a handoff document.
One decision is still open (see "Open decision" below) and it changes the size
of Wave 2.

Read this after `docs/PROJECT-STATUS.md` (what exists today) and
`docs/DATA-QUALITY.md` (the measurements every choice here rests on).

---

## 1. What this wave adds

Today Spokes has one hardcoded room (`room_demo`) over one static, curated
dataset of 31 Berlin Mitte venues, with participants pre-seeded and reachable
through fixed invite URLs. That was the right shape for proving the negotiation
protocol. It is the wrong shape for showing that the product works anywhere,
with data nobody hand-picked.

This wave delivers four things:

1. **Two demo areas** — Berlin Mitte and San Francisco SoMa — selectable at
   runtime, with the quality difference between them made visible rather than
   hidden.
2. **Live venue data** from a self-hosted OpenStreetMap query engine, cached
   server-side, replacing the static dataset as the source of truth.
3. **An organizer onboarding flow**: choose an area, state the problem in your
   own words, get a map plus a join link and QR code for the other parties.
4. **Agent tools for resolving uncertainty**, turning thin attribute coverage
   from a limitation into the thing the agent layer is for.

---

## 2. Decisions already made

User-confirmed, do not relitigate without asking:

- **Both areas ship.** Berlin Mitte stays; San Francisco is added. Berlin is the
  better-tagged dataset and demos more crisply; San Francisco is the area most
  hackathon judges will recognise.
- **Everything is based on live data**, with caching and self-hosting permitted
  and expected for latency, cost, and rate-limit reasons. The static curated
  dataset stops being the source of truth and becomes a fallback.
- **Uncertainty is an engineering problem to solve, not to hide.** Where OSM
  does not know an attribute, participants' agents get explicit tools to raise
  confidence through lookups and research.
- **The organizer's free-text problem statement is parsed into a scope, within
  constraints.** The product publishes what phrasing works, detects
  out-of-domain requests, and lets the organizer iterate. No opaque failure.
- **`room_demo` stays exactly as it is.** It backs 106 passing tests and
  `scripts/record-demo.mjs`. Organizer-created rooms are an additional path,
  not a replacement.
- **The data cost/quality story is explained both in-app and in docs.**
  `docs/DATA-QUALITY.md` is written and complete. The in-app half is Wave 1.
- **San Francisco centre is Moscone / Yerba Buena** (37.7845, −122.4010). It
  measured 20.0% decisive attributes against Berlin Mitte's 36.8%; the four
  other SF centres tested scored 4.5%–14.8%. See `docs/DATA-QUALITY.md`.
- **POC first; determinism later.** Byte-identical datasets, reproducible
  dossiers, and pinned extract timestamps are non-goals for this wave. The
  live path serves raw OSM dossiers; the shipped curated dataset (with its
  overlay) remains a fallback only, and divergence between the two is
  accepted. Testability hardening comes after the POC works.

---

## 3. Open decision

**How much of Wave 2 ships before the submission video.** The full live layer
is roughly a day of work; the reduced variant is perhaps a third of that. The
plan below describes both. Nothing in Waves 1, 3, or 4 depends on which is
chosen — they are written against the dossier interface, not against its
implementation.

Recommended: **reduced Wave 2** (§7.2.1), which keeps the self-hosted query
engine and the real query path but ships the demo on a warmed cache.

---

## 4. Schedule reality

The Devpost deadline is **2026-09-03 22:00 GMT+2**. As of this document there
are about 2.5 days left, and they must also contain:

- the WebMCP-in-ChatGPT verification, which has never been run against the 14
  spatial and negotiation tools and is the project's core thesis;
- a public deploy with a Chrome WebMCP origin-trial token;
- the sub-three-minute narrated video;
- the Devpost submission itself;
- the three previously-confirmed waves (product depth, visual identity, agent
  experience depth).

The four waves here total roughly three days on their own. **They do not all
fit.** Section 8 gives an explicit triage order for whoever picks this up with
less time than the plan assumes.

---

## 5. Architecture

### 5.1 Area registry

New file `packages/contracts/src/areas.ts`, exporting a frozen registry:

```ts
export interface DemoArea {
  id: "berlin-mitte" | "sf-soma";
  label: string;              // "Berlin Mitte"
  city: string;
  countryCode: string;
  timezone: string;           // hours evaluation is local to the venue
  center: { lat: number; lng: number };
  radii: { narrow: number; wide: number };
  bbox: [south: number, west: number, north: number, east: number];
  extract: { source: string; clipped: boolean };
  coverage: {                 // measured, surfaced in-app; see DATA-QUALITY.md
    measuredAt: string;
    venuePool: number;
    decisivePct: number;
    openingHoursPct: number;
  };
}
```

Berlin values come from the existing manifest in
`packages/contracts/data/berlin-mitte-venues.json`. San Francisco values come
from the measurements in `docs/DATA-QUALITY.md` §"Coverage".

The registry is the single place that knows an area exists. Server, web, seed
script, and curation scripts all read it.

### 5.2 Shared dossier mapping

Today the OSM-tag-to-attribute-status mapping lives only in
`scripts/curate-venues.mjs` (`booleanAttr`, `priceHeuristic`,
`parseOpeningHours`). Once venues are built at runtime, both paths should share
the same mapping so they behave consistently — but exact agreement is not a
goal. The shipped Berlin dataset keeps its curated overlay as a build-time
extra; the live path returns raw OSM dossiers. The two may diverge, and for
the POC that is fine.

**Extract it to `packages/contracts/src/dossier.ts`** and have both the curation
script and the server import it. This is a prerequisite for Wave 2. Verify the
refactor by rebuilding the Berlin dataset and confirming it still passes the
curation assertions and the existing test suite — byte-level identity is not
required.

Status vocabulary stays as it is: `verified_true`, `verified_false`,
`unverified`, `unknown`, with only the two verified statuses letting the
eligibility engine rule.

### 5.3 Live data pipeline

```
Geofabrik extracts ──(osmium extract + merge)──> clipped multi-area .osm.pbf
                                                          │
                                                    wiktorn/overpass-api
                                                     (compose service)
                                                          │
      request ──> place cache (Postgres) ──miss──> Overpass ──> dossier.ts ──> candidates
                       │
                    fallback: shipped dataset JSON
```

Components:

- **`scripts/prepare-extracts.sh`** — downloads `berlin-latest.osm.pbf`
  (~94.6 MiB) and `norcal-latest.osm.pbf` (~620 MiB), clips each to its area
  bbox with `osmium extract`, merges to
  `infra/overpass/data/spokes-areas.osm.pbf`. Run once, output gitignored.
  Requires `osmium-tool` on the machine preparing the image, not at runtime.
- **`infra/overpass/`** — compose service on `wiktorn/overpass-api`, pointed at
  the prepared pbf. Not exposed publicly; reachable only on the compose
  network. Optionally `OVERPASS_DIFF_URL` against Geofabrik's `berlin-updates`
  feed for genuine minutely freshness.
- **`apps/server/src/places.ts`** — `queryVenues(area, scope, categories)`:
  builds the Overpass query, normalises elements through `dossier.ts`, returns
  candidate rows. Never calls a public endpoint. A hard timeout with a fallback
  to the cache, then to the shipped dataset.
- **Cache table** — new migration adding `place_cache (query_hash primary key,
  area_id, payload jsonb, osm_timestamp timestamptz, fetched_at timestamptz)`.
  TTL configurable via `config.ts`; `make warm-cache` populates it for both
  areas before a demo.

The fallback chain is **cache → self-hosted Overpass → shipped dataset**, and
the public Overpass API appears nowhere in it. `docs/DATA-QUALITY.md` records
why: measured 504s, 502s, and a 51-minute network-level ban.

### 5.4 Room lifecycle and onboarding

The `setup` phase already exists in `apps/server/src/phase.ts` and is currently
documented as unreachable, with a `setup + participant_joined → gathering`
transition already defined. This wave makes it reachable.

New endpoints:

- **`POST /api/rooms`** — body `{ areaId, goalText }`. Validates `areaId`
  against the registry, parses `goalText` (§5.5), creates the room in `setup`
  with the parsed scope, creates the organizer participant, mints an organizer
  token and a room-level join secret. Returns the organizer token, the room id,
  and the join URL.
- **`POST /api/session/join`** — body `{ joinSecret, displayName }`. Creates a
  participant in that room and mints a token. The first successful join emits
  `participant_joined`, which moves the room `setup → gathering` through the
  existing machine.

Schema changes (new migration, additive only):

- `rooms.area_id text not null default 'berlin-mitte'`
- new table `room_join_secrets (room_id, secret_hash, created_at, revoked_at)`
- `participants.joined_at timestamptz null`

New event type `participant_joined` in the projection and contracts, visible in
the activity feed as a human line ("Sarah joined").

Rate limiting on both endpoints, mirroring the existing
`/api/session/exchange` limiter in `apps/server/src/server.ts` — these mint
rows and are unauthenticated.

**`room_demo` is unaffected.** `apps/server/src/seed.ts` keeps inserting it at
`gathering` with participants pre-joined. Tests and `record-demo.mjs` continue
to work untouched.

### 5.5 Constrained scope parsing

New file `packages/contracts/src/scope-language.ts`. Deterministic, no network,
no model call in the request path.

```ts
parseGoal(text: string, area: DemoArea): 
  | { ok: true; goal: string; scope: ScopeState; matched: string[] }
  | { ok: false; reason: "no_category" | "out_of_domain" | "ambiguous";
      message: string; examples: string[]; unmatched: string[] }
```

Vocabulary covers what the product can actually negotiate:

- **categories** — food, drinks, coffee, outdoor
- **radius cues** — "walking distance" → the area's narrow radius, "short ride"
  / "anywhere in the neighbourhood" → wide radius
- **time cues** — tonight, lunch, tomorrow evening (stored on the goal; time
  windows themselves are descoped, see §9)

Out-of-domain detection rejects requests implying capabilities the product does
not have — flights, hotels, shopping, ticketing — with a message naming what
*is* supported, so the organizer can iterate rather than guess.

Worked examples must be published in three places and kept identical: the
placeholder and helper text in the onboarding UI, the WebMCP tool description,
and this document. Suggested set:

- "Dinner tonight somewhere we can all walk to"
- "Coffee and a quiet table, anywhere in the neighbourhood"
- "Drinks after work, outdoor seating if possible"

Exposed to agents as a read-only WebMCP tool `propose_session_scope`, which
returns the parse result without committing it, so an agent can iterate against
the same validator the page uses.

**Demo-safety requirement:** the area picker must always offer a direct
category-and-radius control alongside the text box. If the parser rejects the
organizer's live phrasing on camera, the demo continues.

### 5.6 Agent attestation

New command `AttestAttribute`:

```
{ candidateId, key, status: "attested_true" | "attested_false",
  confidence: 0..1, note: string, sourceUrl?: string }
```

Provenance is `agent:<participantId>`, distinct from `osm:*` and
`curated:*`. Precedence rules, which **require a `docs/protocols/SPATIAL-PROTOCOL.md`
§8 amendment**:

1. An OSM `verified_*` status wins over an attestation. Recording a contradicting
   attestation marks the attribute `disputed`, which classifies as *uncertain*
   and surfaces both sources in the candidate sheet.
2. An attestation over an `unknown` attribute makes it decisive for eligibility,
   labelled with its agent provenance and confidence in the UI.
3. Attestations are per-room and never leak across rooms.

This is what makes San Francisco's 20% decisive coverage a demonstration rather
than a weakness: the organizer sees uncertainty, asks their agent, the agent
looks it up and attests, and the map resolves — with every step's provenance
visible.

---

## 6. Wave 1 — areas, datasets, and the in-app data story

**Goal:** two selectable areas with the quality difference visible. Ships value
on its own, and is common to every variant of the open decision.

Tasks:

1. Add `packages/contracts/src/areas.ts` (§5.1) and export it from
   `packages/contracts/src/index.ts`.
2. Extract the dossier mapping to `packages/contracts/src/dossier.ts` (§5.2) as
   a refactor. Rebuild the Berlin dataset afterwards and confirm the curation
   assertions and existing tests still pass.
3. Teach `scripts/extract-venues.mjs` and `scripts/curate-venues.mjs` an
   `--area` flag reading the registry. Both currently hardcode a Berlin bbox
   and a Berlin selection list.
4. Produce `packages/contracts/data/sf-soma-venues.json` with the same pipeline.
   Curate honestly: real OSM tags, minimal overlay. Expect visibly more
   *uncertain* pins than Berlin — that is the point.
5. `apps/server/src/seed.ts` reads `rooms.area_id` to pick its dataset;
   `room_demo` keeps `berlin-mitte`.
6. In-app data-quality panel on the area picker: venue pool, decisive-attribute
   share, `opening_hours` coverage, measurement date, and one sentence on what
   thinner coverage means for what they are about to see. Numbers come from the
   registry, not hardcoded in the component.
7. Link `docs/DATA-QUALITY.md` from `README.md` and `docs/PROJECT-STATUS.md`.

**Acceptance:** both datasets build from their area definition; the Berlin
dataset still passes its curation assertions; the panel renders real measured
numbers for both areas; all existing tests green.

---

## 7. Wave 2 — live venue data

### 7.2.1 Reduced variant (recommended)

Stand up the query engine and the real query path, ship the demo on the cache.

1. `scripts/prepare-extracts.sh` (§5.3).
2. `infra/overpass/` compose service, plus a `make` target to build and import.
3. `apps/server/src/places.ts` with the full query path, using `dossier.ts`.
4. `place_cache` migration and `make warm-cache`.
5. Rebuild both area datasets **from the self-hosted instance** rather than the
   public API, so fallback and live path share the same pipeline. Exact
   agreement between them is not required.
6. Demo runs from the warmed cache.

**Acceptance:** a scope query returns candidates built at request time from the
self-hosted engine; the same query served from cache returns equivalent
candidates; killing the Overpass container degrades to cache, then to the
shipped dataset, without an error surfacing to a participant.

### 7.2.2 Full variant

Everything above, plus:

7. `OVERPASS_DIFF_URL` wired to Geofabrik's minutely feed, so the extract
   genuinely tracks OSM.
8. Cache invalidation on `osm_timestamp` change rather than TTL alone.
9. Scope changes re-query live instead of filtering a preloaded candidate set —
   this is the part that makes "widen the search radius" a real query rather
   than a client-side filter.
10. A visible freshness indicator in the UI ("venue data as of ...").

Item 9 is the one that materially changes what the product *is*, and the one
most likely to break the rehearsed impasse arithmetic. Do not attempt it
without time to re-verify the demo trajectory.

---

## 8. Wave 3 — organizer onboarding

**Goal:** the demo opens with the organizer choosing an area, stating the
problem, and handing out a join link and QR code.

1. Migration for `rooms.area_id`, `room_join_secrets`, `participants.joined_at`
   (§5.4).
2. `POST /api/rooms` and `POST /api/session/join`, with rate limiting.
3. `participant_joined` event type in contracts and projection, with a human
   feed line.
4. `packages/contracts/src/scope-language.ts` (§5.5) plus the
   `propose_session_scope` WebMCP tool.
5. Web: a pre-room onboarding view — area picker with the Wave 1 data panel,
   goal text box with published examples and inline parse feedback, and the
   always-available category/radius fallback control.
6. Web: post-creation share view — join URL, QR code, and a live list of who has
   joined. QR needs one dependency; `qrcode` renders to SVG and is small.
7. `apps/web/src/session.ts` learns the join-secret path alongside the existing
   invite-fragment path.

**Acceptance:** an organizer creates a room from a cold browser, a second
browser joins via the link and a third via the QR, the room moves
`setup → gathering` on the first join, and the existing negotiation flow runs
unchanged from there.

---

## 9. Wave 4 — agent attestation

1. `AttestAttribute` command schema, handler, and WebMCP tool.
2. Eligibility precedence and the `disputed` status (§5.6).
3. `docs/protocols/SPATIAL-PROTOCOL.md` §8 amendment.
4. Candidate sheet shows attestation provenance, confidence, and note beside
   the OSM value.
5. Tests: attestation resolves an unknown attribute; a contradicting
   attestation produces `disputed` and classifies *uncertain*; attestations do
   not cross rooms.

**Acceptance:** in the San Francisco area, an uncertain candidate becomes
decisive after an agent attestation, with provenance visible, and the privacy
tests still pass.

---

## 10. Triage if time is short

In strict order. Stop wherever the clock runs out; everything above the stop
line is coherent on its own.

1. **Wave 1** — cheap, visible, common to every variant.
2. **Wave 3** — this is what judges see; it is the opening of the video.
3. **Wave 2 reduced** — makes the live claim true; invisible in a three-minute
   video but defensible under questioning.
4. **Wave 4** — the most interesting idea here and the most likely casualty.
5. **Wave 2 full** — only with time to re-verify the demo trajectory.

If less than a day is available, do Wave 1 only and cite
`docs/DATA-QUALITY.md` for the rest of the story. Do not start Wave 2 and leave
it half-wired; the fallback chain is the part that makes it safe, and a partial
implementation is worse than none.

---

## 11. Risks

| risk | mitigation |
| --- | --- |
| Overpass import time and image size break the Coolify deploy | Clip extracts to area bboxes before import; measure the image before wiring it into the deploy; keep the shipped datasets as fallback so the app boots without the service |
| `osmium-tool` unavailable on the build machine | Prepared pbf is a build artefact, not a runtime dependency; it can be produced anywhere and copied |
| Live data breaks the rehearsed impasse arithmetic (0 eligible at 800 m, 4 at 1400 m) | Warm the cache before a demo; `scripts/curate-venues.mjs` keeps asserting the arithmetic at build time. If live data shifts the numbers, adjust the demo script rather than the data |
| Scope parser rejects the organizer's phrasing on camera | Category/radius fallback control always visible; published example phrases are covered by unit tests |
| Attestation precedence contradicts the protocol invariant audit | Amend `SPATIAL-PROTOCOL.md` §8 first, then implement; re-run the privacy tests |
| Unauthenticated room creation gets abused on a public deploy | Rate limit per IP as `/api/session/exchange` does; cap rooms per IP per hour; join secrets revocable |
| Two areas double the surface the demo script must cover | Record the video in one area; the second exists to answer "does this work where I live?" |

---

## 12. Explicitly out of scope

Unchanged from the previous descope list, and not reopened by this wave:
disclosure ladder L1–L3, commutative rebase, transit mode, meeting points, and
time-window eligibility. Time cues parsed from the goal text are stored on the
goal string only; they do not drive eligibility.

Also out of scope here: replacing OSM with Overture or Foursquare places
(§"Bulk alternatives" in `docs/DATA-QUALITY.md`), and any commercial place API.

---

## 13. Open questions for whoever picks this up

1. Which Wave 2 variant (§3). Default to reduced.
2. Does the video open in Berlin or San Francisco? Berlin demos more crisply;
   San Francisco is more familiar to the likely judges. The plan supports
   either; the choice affects only which area the recording script targets.
3. How many join seats should a created room allow before the link stops
   working? Currently unbounded, which is fine for a demo and wrong for a
   public deploy.
