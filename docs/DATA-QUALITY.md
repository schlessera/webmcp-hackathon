# Venue data: sources, cost, quality, and what it costs the demo

Last updated: 2026-09-02 (engine decision and city snapshots added; every
earlier measurement is dated 2026-09-01). Measurements in this document were taken on that
date from this repository's development machine. They are reproducible — every
query is given in full.

Spokes negotiates over real places. That makes the quality of the underlying
place data a first-class product constraint, not an implementation detail: the
eligibility engine can only return *eligible* or *excluded* for an attribute it
actually knows. Everything else becomes *uncertain*, and a map full of
uncertain pins is a negotiation with nothing to bite on.

This document records what we measured, what we chose, and what we gave up.

## Summary

- All venue data is OpenStreetMap, under ODbL 1.0. Attribution lives in
  `packages/contracts/data/ATTRIBUTION.md`.
- OpenStreetMap has **no real-time data**. No occupancy, no live availability,
  no reservations. "Live" here means two things only: data freshness via
  minutely diffs, and client-side evaluation of the `opening_hours` tag.
- No public OSM query API is safe to put in a demo's request path. We measured
  the two obvious candidates failing, one of them by banning us.
- Attribute coverage varies enormously by city. Berlin Mitte is roughly twice
  as well tagged as the best San Francisco neighbourhood on the dimensions this
  product reasons about. That difference is visible in the product, and we
  chose to show it rather than paper over it.

## Why not the public APIs

### Overpass API

The Overpass API is the natural way to ask OpenStreetMap "what venues are in
this area with these tags". It is also, on its public instances, unreliable
enough that it cannot be a runtime dependency.

Measured 2026-09-01 against `https://overpass-api.de/api/interpreter`, plus
three public mirrors:

| endpoint | query | result |
| --- | --- | --- |
| overpass-api.de | 4 amenity types, Mitte bbox 4.4 x 3 km | 504 after 9.9 s |
| overpass-api.de | cafes only, 1.7 km bbox, 145 results | 504 after 7.9 s, then 200 in 5.5 s on retry |
| overpass.private.coffee | same small query | 502 / connection timeout, every attempt |
| overpass.kumi.systems | same | no response, 60 s timeout |
| maps.mail.ru (VK) | same | 504 in 0.6 s |

`/api/status` reported `Rate limit: 2` — two concurrent slots per client. The
OpenStreetMap wiki describes the main instance as currently overloaded and
advises seeking alternatives.

Documented quotas for the public instance: roughly 10,000 queries per day and
1 GB of downloads per day for casual use, divided by 100 for regular
applications, which lands around 100 requests per day. Default query timeout
180 s (max 900 s), default memory 512 MiB. HTTP 429 means rate limited, 504
means the query exceeded its resource budget.

Conclusion: excellent for offline extraction, unusable in a request path.

### Photon (photon.komoot.io)

Photon is komoot's OpenStreetMap geocoder. Its public instance is fast — we
measured a median of about 380 ms over 20 sequential queries, with 12 parallel
requests all returning 200 in 0.22–0.80 s.

It is also explicitly a demo server. There is no terms-of-service document.
The landing page says only "You can use the API for your project, but please be
fair - extensive usage will be throttled." The README adds that extensive usage
"will be throttled or completely banned", with no availability guarantee. In
GitHub discussion #598 a maintainer states plainly that photon.komoot.io is "a
demo site for the Photon software" and that "Neither Komoot nor the maintainers
of Photon provide a commercial API for Photon."

We established the practical meaning of that empirically, by accident. Two
bursts of 25 parallel requests produced first 8, then 20 HTTP 503 responses,
after which the host stopped answering at the TCP layer entirely — connections
refused in 33–48 ms, with no HTTP response and no `Retry-After`. A poll every
few minutes over the following 51 minutes never recovered. Roughly 85 requests
bought an hour-plus network-level ban.

Two further findings worth recording:

- The public instance blocks by User-Agent. `python-requests/2.31.0` gets a 403
  in 113 ms; an empty User-Agent gets a 200.
- The public instance returns no venue attributes at all. Across a 50-result
  response the complete property set was `osm_type, osm_id, osm_key, osm_value,
  name, housenumber, street, locality, district, city, postcode, country,
  countrycode, type, extent`. No `opening_hours`, no `wheelchair`, no `cuisine`.

That last point is a configuration choice, not a Photon limitation: a
self-hosted instance can pass `-extra-tags opening_hours,wheelchair,...` (or
`ALL`) at import and return them. But Photon cannot import an `.osm.pbf`
directly — its only inputs are a Nominatim PostgreSQL database or a JSON dump
derived from one. Building our own would mean a Nominatim import first
(a Germany extract runs about 4 hours into a 90–120 GB database; the planet
needs roughly 2.5 days and 1 TB).

Conclusion: fast and genuinely useful for fuzzy place-name lookup, and
self-hostable, but it answers "what and where", never "what is this venue
like". It is not the attribute source this product needs.

### Nominatim

The public Nominatim instance permits an absolute maximum of 1 request per
second, forbids autocomplete outright, requires an identifying User-Agent and
client-side caching, and prohibits distributed clients. Fine for a one-off
lookup, structurally unsuited to an interactive map.

### Commercial OSM providers

For completeness, priced 2026-09-01:

| provider | free tier | first paid tier | notes |
| --- | --- | --- | --- |
| Geoapify Places | 3,000 credits/day, 5 req/s | $59/mo for 10,000/day, 12 req/s | 20 places = 1 credit, max 500 results/request. Has wheelchair, diet, and internet-access condition filters. No open-now filter. |
| LocationIQ | 5,000 req/day | $49/mo for 30,000/day | Geocoding-centric, weaker attribute filtering |
| Stadia Maps | perpetual dev plan | $20/mo | Tiles plus Pelias geocoding, not attribute POI search |
| Geofabrik Overpass | none | quote | Hosted Overpass with an API key |

Geoapify is the closest commercial fit for this product's query shape. We did
not adopt it: a hackathon submission should not depend on a key the judges
cannot see working, and self-hosting the same underlying data costs less than
the free tier's daily cap in engineering time.

### Bulk alternatives

Two open POI datasets could replace OSM as the venue source:

- **Overture Places** — 53M+ POIs, CDLA-Permissive-2.0, Parquet on S3, monthly
  releases, stable GERS identifiers.
- **Foursquare OS Places** — 100M+ POIs, Apache-2.0, monthly, with a prebuilt
  PMTiles bundle that drops straight into MapLibre.

Both have better name and category coverage than OSM in the United States.
Neither carries the accessibility and dietary attributes this product
negotiates over. They are the right answer for a different product.

## What we chose

A self-hosted Overpass instance over city-clipped OpenStreetMap extracts, with
a server-side cache in front of it.

This keeps the data genuinely live — the extract updates from Geofabrik's
minutely diff feed, and a scope query really does hit an OSM query engine —
while removing every failure mode measured above: no shared rate limit, no
third-party outage, no ban risk, no per-request cost, and no participant IP
address leaving our infrastructure.

That last point matters more than it looks. Spokes' entire premise is that a
participant's requirements stay private. Calling a third-party place API from
the browser would send every participant's IP address and query to a company
with no data-processing agreement, which would quietly contradict the privacy
model the product is built to demonstrate.

Extract sizes, measured 2026-09-01:

- Berlin: `berlin-latest.osm.pbf`, 99,143,742 bytes (~94.6 MiB)
- Northern California: `norcal-latest.osm.pbf`, 650,189,567 bytes (~620 MiB)

Both are clipped further to the demo bounding boxes before import, which is
what keeps the container small enough to deploy.

## Coverage: Berlin versus San Francisco

The eligibility engine reads five boolean attributes (`diet:vegetarian`,
`diet:lactose_free`, `wheelchair`, `outdoor_seating`, `dog`), plus `cuisine`
and `opening_hours`. `scripts/curate-venues.mjs` maps each OSM tag to a status:
`yes` becomes `verified_true`, `no` becomes `verified_false`, any other value
becomes `unverified`, and an absent tag becomes `unknown`. Only the two
verified statuses let the engine decide; everything else classifies the
candidate as *uncertain*.

So the question that matters is not "how many venues are there" but "how many
attributes are actually known".

### Venue density is equal. Attribute coverage is not.

Query: `nwr[amenity~"^(cafe|bar|restaurant|pub|biergarten)$"](around:1400,LAT,LON)`,
1400 m being the demo's wide radius.

| tag | Berlin Mitte | SF Moscone/SoMa | SF Mission |
| --- | --- | --- | --- |
| venues in radius | 767 | 769 | 386 |
| `wheelchair` | 76.7% | 32.8% | 30.3% |
| `outdoor_seating` | 75.6% | 25.5% | 18.4% |
| `opening_hours` | 74.2% | 50.3% | 54.4% |
| `diet:vegetarian` | 31.8% | 7.2% | 7.8% |
| `diet:vegan` | 18.3% | 3.4% | 5.2% |
| `cuisine` | 59.8% | 60.2% | 64.8% |
| `internet_access` | 14.9% | 5.2% | 6.2% |

Berlin Mitte and SoMa have effectively identical venue density. Every attribute
this product reasons about is two to five times thinner in San Francisco. Only
`cuisine` reaches parity.

### What that does to the product

Taking the nearest 31 named venues to each candidate centre — the same
selection size as the shipped Berlin dataset — and applying the curation
mapping gives 5 attributes x 31 venues = 155 attribute slots per area.
"Decisive" counts the slots where the engine can actually rule:

| centre | venue pool | decisive attributes | `opening_hours` present |
| --- | --- | --- | --- |
| Berlin Mitte (52.5219, 13.3899) | 757 | 36.8% | 74% |
| SF Moscone / Yerba Buena (37.7845, -122.4010) | 765 | 20.0% | 58% |
| SF Ferry Building (37.7955, -122.3937) | 529 | 14.8% | 29% |
| SF Hayes Valley (37.7765, -122.4241) | 535 | 13.5% | 68% |
| SF Mission / Valencia (37.7599, -122.4148) | 380 | 8.4% | 52% |
| SF North Beach (37.7999, -122.4083) | 682 | 4.5% | 35% |

For reference, the shipped Berlin dataset scores 49.7% decisive — hand-picked
venues plus a small curated overlay lifting it above the 36.8% baseline.

In the best San Francisco neighbourhood, four of every five attribute slots
come back `unknown`. Moscone/Yerba Buena is the only SF centre worth using, and
it still starts at barely half of Berlin.

## How this limits the demo, and what we do about it

Three consequences, stated plainly because they shape what a viewer sees.

**1. San Francisco demos greyer than Berlin.** More candidates classify as
*uncertain*, fewer as cleanly *eligible* or *excluded*. This is not a bug in
the eligibility engine; it is the data telling the truth about itself. We chose
to show it rather than hide it behind invented attributes, because the product's
central claim is honest provenance, and a viewer who clicks into a fabricated
attribute learns the wrong thing about what Spokes does.

**2. Uncertainty becomes work for the agents, not a dead end.** A requirement
that cannot be settled from OSM tags is exactly the situation where a
participant's own agent earns its place: it can look the venue up, ask, and
contribute an attestation with its own provenance and confidence, distinct from
`osm:*` and from `curated:*`. Thin data is therefore a demonstration surface for
the agent layer rather than a limitation to apologise for.

**3. Scripted demo beats cannot assume fixed data.** The impasse arithmetic in
the Berlin dataset (zero eligible at 800 m, four at 1400 m under the demo's
requirement set) is asserted at build time by `scripts/curate-venues.mjs`
against a pinned extract. Live data moves. The demo path therefore runs against
a warmed cache pinned to a known extract timestamp, so the code path is
genuinely live while the rehearsed arithmetic stays reproducible. The cache is
a performance and determinism device, not a different data source.

## Reproducing these measurements

Venue counts and tag coverage, per area:

```bash
curl -s -A 'your-app/0.1 (contact@example.org)' \
  -d 'data=[out:json][timeout:60];nwr["amenity"~"^(cafe|bar|restaurant|pub|biergarten)$"](around:1400,52.5219,13.3899);out tags center;' \
  https://overpass-api.de/api/interpreter > berlin.json
```

Then count, per tag, the share of elements carrying it. Substitute
`37.7845,-122.4010` for the San Francisco comparison. Expect 504s from the
public instance; retry, and keep the volume low.

Extract sizes:

```bash
curl -sL -r 0-0 -D - -o /dev/null https://download.geofabrik.de/europe/germany/berlin-latest.osm.pbf | grep -i content-range
```

## Sources

- Overpass API commons and quotas — https://dev.overpass-api.de/overpass-doc/en/preface/commons.html
- Overpass API instance list — https://wiki.openstreetmap.org/wiki/Overpass_API
- Nominatim usage policy — https://operations.osmfoundation.org/policies/nominatim/
- Photon README and usage docs — https://github.com/komoot/photon
- Photon business-usage discussion — https://github.com/komoot/photon/discussions/598
- Photon "extensive usage" discussion — https://github.com/komoot/photon/discussions/822
- Geoapify pricing — https://www.geoapify.com/pricing/
- Nominatim installation requirements — https://nominatim.org/release-docs/latest/admin/Installation/
- Overture Places — https://docs.overturemaps.org/guides/places/
- Foursquare OS Places — https://opensource.foursquare.com/os-places/
- Geofabrik extracts — https://download.geofabrik.de/


## Engine decision (2026-09-02)

The question left open on 2026-09-01 was whether a self-hosted Overpass
instance should sit in the request path. Both candidates were built and
measured on the same machine (32 cores, 31 GiB, WSL2, Docker 29).

### What was measured

**Self-hosted Overpass** (`wiktorn/overpass-api`, `OVERPASS_META=no`,
`OVERPASS_USE_AREAS=false`), fed the Berlin Mitte clip of the Geofabrik
extract (`osmium extract`, bbox 13.352,52.499,13.428,52.545 — 8.0 MiB, 2,551
venue features):

| measurement | value |
| --- | --- |
| image size | 540 MB |
| import, init to exit (8 MiB clip) | 4 min 24 s |
| database on disk after import | **4.2 GB** (fixed-size index files; the clip size barely matters) |
| boot from an imported volume to first 200 | 10 s |
| idle memory | 76 MiB |
| query, 1.4 km radius, 6 amenity values, `out tags center` | 0.46 s first, 0.31–0.37 s warm |

The image expects a `.osm.bz2` planet; a `.pbf` needs the documented
`OVERPASS_PLANET_PREPROCESS` hook (`osmium cat`) or the import fails silently
("bunzip2: (stdin) is not a bzip2 file"). A whole-city Berlin import (95 MiB)
was not attempted; the disk figure alone rules it out for the deploy target.

**In-process snapshot engine** (`apps/server/src/places.ts`): every named
venue with the product's amenity tags inside each **city** bounding box,
exported once by `osmium` and committed as JSON with the subset of tags the
mapping reads (`packages/contracts/src/dossier.ts`, `KEPT_TAGS`).

| measurement | Berlin | San Francisco |
| --- | --- | --- |
| build (`make venues`), extract → JSON, osmium via Docker | 21 s | 23 s |
| venues in the city bbox | 12,149 | 3,671 |
| snapshot on disk (committed) | 4.7 MiB | 1.4 MiB |
| load into memory (`node data/osm/bench.mjs`, one process) | 42 ms | 7 ms |
| first pool query (120 places, three rings) | 6.2 ms | 1.1 ms |
| warm pool query | 2.8 ms | 1.0 ms |
| added image size, added services | 0, 0 |
| process RSS with both snapshots loaded, no server | 154 MiB |

### The decision

The in-process snapshot is the engine. Overpass is a general query engine
and this product asks it one query shape over two cities; the 4.2 GB
per-area footprint, the 4½-minute import on every cold volume and a second
container with its own health, disk and restart story buy nothing the
committed snapshot does not already give. The snapshot answers in
milliseconds, identically cold or warm, needs no volume, no init container
and no change to `compose.coolify.yaml`, and cannot be down while the app is
up.

The privacy property the 2026-09-01 notes insist on holds trivially: no
request leaves the process. A room is seeded from the snapshot at creation
(`POST /api/rooms`); nothing is fetched at read time.

### What enters a room's pool (2026-09-03)

A room is opened from a goal, and its **step class** decides which snapshot
place classes may enter its pool — seeding, background filling and top-up all
read the same list (`packages/contracts/src/step-classes.ts`, applied by
`places.ts roomPoolClasses`). The class is recorded as the room's
`scope.category`; `food` is the default and its members are exactly the six
classes every room pooled before goals existed, so a room created without a
step is seeded from the same venues it always was. A category the table does
not know falls back to the area's own `placeClasses`.

`area.placeClasses` still governs the explore layer and any older reader. The
snapshot itself is unchanged: it already carries every named class, so no
rebuild was needed to open a room about a park or a cinema.

`GET /api/areas` reports, per area, each step class with at least one snapshot
venue inside the narrow radius and how many there are — measured from the
snapshot at load, not typed. Berlin Mitte has one cinema inside 800 m of its
centre, so a cinema room there opens with a very small pool until someone
widens the scope; that is honest, and the number is on screen before the room
is opened.

### What "live" means here, honestly

OpenStreetMap has no real-time data. The snapshot carries the Geofabrik
extract timestamp (`manifest.extract.timestamp`, currently
`2026-08-31T20:21:20Z`) and stamps it on every attribute as `observedAt`; the
UI shows it as "Places from OpenStreetMap, as of 31 Aug 2026" and the area
picker shows it per area. Refreshing is `make venues-refresh` (re-download
the two extracts, rebuild, commit). Minutely diffs against the extract are
**not** consumed; the `updates` URL is recorded on each area for whoever
wires that later. Nothing in the UI claims more than the extract date.

### Fallback chain

1. The area snapshot (`packages/contracts/data/areas/<id>.json`) — the
   normal path, committed, so a deploy cannot lack it.
2. For Berlin only: the curated demo dataset
   (`berlin-mitte-venues.json`), if the snapshot file is missing.
3. Otherwise room creation answers 503 and the picker marks the area
   unavailable. No invented places.

`room_demo` is seeded from the curated dataset as before; its provenance is
recorded on the room (`rooms.data_source.kind = "curated"`) and the brief
says so.

### Coverage as shipped

Measured at build time from the snapshots themselves
(`manifest.coverage`), with the engine's own definition of decisive
(`verified_true` or `verified_false`), over the **ten** boolean attributes
the engine reads since 2026-09-02 (vegetarian, vegan, gluten-free, halal,
lactose-free, step-free, outdoor seating, dogs, takeaway, delivery — the
five added ones are rarer tags, which is why the shares below are lower
than the five-attribute figures measured earlier that day):

| | Berlin Mitte | San Francisco SoMa |
| --- | --- | --- |
| venues in the city bbox | 12,149 | 3,671 |
| venues within 1.4 km of the default centre | 874 | 910 |
| decisive, city | 16.7 % | 8.3 % |
| decisive, 1.4 km focus | 21.2 % | 8.9 % |
| decisive, the 120-place pool a room starts with | 21.2 % (254 of 1,200) | 11.4 % (137 of 1,200) |
| `opening_hours` in the pool | 82 of 120 | 69 of 120 |
| `website` in the pool | 41 of 120 | 65 of 120 |

What a room can learn about a place **beyond** its record — menus, links,
descriptions, self-published ratings, awards — is a separate layer with its
own research and measurements: `docs/ENRICHMENT-SOURCES.md`.

The picker renders these as absolute counts and a meter, never as
percentages (`CLAUDE.md` §10). The pool rule — the 40 nearest inside 800 m,
40 more out to 1.4 km, 40 more out to 2 km — is stated on the card; the
outer rings are the buffer a room widens into.

### Not done, deliberately

- Supplementary San Francisco sources (Open Food Facts, Wikidata, Foursquare
  OS Places, venue-site JSON-LD): all redistributable, none wired. The gap is
  shown, not closed.
- Attestations (done the same day): `attest_attribute` lets a participant or
  their agent resolve an unknown fact for the room, named and noted, with the
  record's verified facts taking precedence (`docs/protocols/SPATIAL-PROTOCOL.md`
  §8.1). Nothing looks anything up by itself — the agent brings the evidence.
- Budget needs are EUR-only in the command contract; a San Francisco room
  accepts a budget in EUR bands only, and since no price band exists on the
  live path it classifies every place unsure.
- Time-of-day evaluation of `opening_hours` in the client.
