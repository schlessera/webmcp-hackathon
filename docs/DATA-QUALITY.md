# Place data and quality

Implementation reference, checked against `main` on 2026-09-07. Spokes starts
from prepared OpenStreetMap snapshots and supplements them with cached source
evidence. Missing, likely, and disputed facts remain visible in the product.
This document describes the current source and selection rules; dated crawler
reports remain in [research](research/enrichment-crawl-2026-09-02/).

## Summary

- The base inventory is committed city-area snapshots for Berlin and San
  Francisco, loaded and queried inside the application process.
- Snapshots cover more than food: the current class vocabulary includes parks,
  cinemas, museums, libraries, shops, and other outing destinations.
- The room's active plan step and shared search circle decide what is pooled.
  Browser viewport exploration can show other snapshot places.
- Runtime websites, Wikidata, optional business listings, model evaluation,
  and participant evidence supplement records. They do not make the underlying
  inventory a complete live venue database.
- OSM attribution and database licensing are recorded in
  [Data attribution](../packages/contracts/data/ATTRIBUTION.md). Cached external
  evidence has separate source handling described in
  [Enrichment sources](ENRICHMENT-SOURCES.md).

## Engine decision

[places.ts](../apps/server/src/places.ts) loads one JSON snapshot per registered
area and performs local name, class, viewport, and distance queries. There is
no Overpass, Photon, Nominatim, or other geocoding service in the runtime place
lookup path. There is no self-hosted Overpass deployment and no runtime
consumption of minutely OSM diffs.

The [area registry](../packages/contracts/src/areas.ts) holds geometry, default
centres, timezones, currencies, and extract metadata. Its labels are Berlin
Mitte and San Francisco SoMa, but the bounding boxes cover the respective
cities so an organizer can select another centre within the prepared region.
The registry is not a worldwide geocoder.

The snapshot builder keeps supported named place classes and the tags consumed
by [dossier mapping](../packages/contracts/src/dossier.ts), together with a
bounded landmark index for named measuring points. Each snapshot records its
extract timestamp, build time, class counts, and coverage. Rebuilding a JSON
file does not itself make its source extract newer.

## What enters a room's pool

A [step class](../packages/contracts/src/step-classes.ts) groups concrete OSM
place classes. `food` includes cafés, restaurants, bars, pubs, beer gardens,
and fast food; a cinema step pools cinemas, while a park step can include
parks, gardens, dog parks, and playgrounds. A missing or unknown class falls
back to the area's food-class list.

Room creation selects a deterministic, spatially spread seed of at most
60 places inside the initial 800-metre circle. Background
[pool filling](../apps/server/src/pool-fill.ts) adds the remaining matching
places in the current scope up to the 2,500-candidate cap. Widening or moving
the circle schedules another fill; it does not download a new extract.
Explicitly adding an explored place resolves its stable snapshot ref locally.

The viewport explore endpoint returns at most 600 snapshot places and indicates
truncation. Exploration is not restricted to the room's current step class.
Settling an intermediate plan step stores the chosen place, removes that
step's candidates from the live pool, and opens a new pool around the chosen
location for the next step. Existing rows and their history are retained.

These runtime rules are different from `manifest.coverage.poolRule`, which is
a fixed 120-place, three-ring measurement sample retained in the committed
manifest. That sample is not the current room-starting selection algorithm.

## Coverage as shipped

The following values are read from the committed snapshot manifests, not a new
network crawl. Both carry extract timestamp `2026-08-31T20:21:20Z` and were
built on 2026-09-03. Check the files after refreshing rather than treating these
numbers as live counts.

| Manifest measure | Berlin | San Francisco |
|---|---:|---:|
| Named places across supported city classes | 19,095 | 5,260 |
| Stored landmarks | 3,000 | 3,000 |
| Food-class places within 1.4 km of the default centre | 874 | 910 |
| Decisive boolean slots in that food focus sample | 1,852 / 8,740 | 813 / 9,100 |
| Opening-hours tags in that food focus sample | 641 | 463 |
| Website tags in that food focus sample | 331 | 438 |

Sources: [Berlin snapshot](../packages/contracts/data/areas/berlin-mitte.json)
and [San Francisco snapshot](../packages/contracts/data/areas/sf-soma.json).

A decisive slot in the manifest means that the snapshot mapper classified one
of its ten measured boolean facts as verified true or verified false. It is
not a count of eligible destinations, a completeness score for the full
attribute vocabulary, or a measurement of subsequent enrichment. `city`
includes all supported classes; `focus` and the historical `pool` sample use
the area's food-class list, so those denominators are not interchangeable.

`GET /api/areas` returns the recorded coverage plus step-class counts computed
from the snapshot within each default narrow circle. Current room counts and
eligibility depend on its actual centre, step, participant needs, private
screening, and any evidence learned since creation.

## Evidence states

The [status contract](../packages/contracts/src/status.ts) has five states:

| State | Meaning |
|---|---|
| `verified_true` | An accepted record or assertion says yes |
| `likely_true` | Evidence leans yes |
| `likely_false` | Evidence leans no |
| `verified_false` | An accepted record or assertion says no |
| `unknown` | No usable answer on record |

Legacy input `unverified` is normalized to likely true with confidence capped
at 0.5. Source, confidence, time, and supporting evidence distinguish an OSM
tag, venue statement, model inference, deterministic guess, listing, and
participant confirmation. A verified label is not an independent inspection
by Spokes.

The [eligibility engine](../apps/server/src/eligibility.ts) evaluates active
hard and bounded-negotiable requirements against these facts. Likely and
unknown evidence can leave a candidate likely, unlikely, or uncertain; it is
not silently counted as a confirmed match. Soft/optional needs currently do
not contribute a utility ranking. Agent-private verdicts are tied to candidate
fact revisions and become stale when those facts change.

Model inference is not the only source of uncertain data: a small
[deterministic guess table](../apps/server/src/guess.ts) supplies labelled
likely facts from cuisine and place class. Neither those guesses nor ordinary
listing evidence overwrite verified source records. Attestations and
confirmations merge as participant evidence within their originating room;
contradictions can create a visible dispute. See
[evidence precedence](ENRICHMENT-SOURCES.md#evidence-and-precedence).

## Time, price, and distance

Time-window needs are implemented. The shared weekly-hours evaluator uses the
venue area's timezone, including midnight crossings and DST. The parser
supports common weekly OSM forms, `24/7`, multiple intervals, and ordered
closed/off overrides. Public-holiday selectors and unsupported syntax are
ignored. Website schedules can contribute likely opening evidence; a dated
closure or special event may still be absent.

Budget needs accept EUR and USD. Area currency determines how the rough price
bands are interpreted; a mismatched currency remains pending rather than
being converted. Prices can come from website/listing evidence, menu reading,
or labelled guesses. Bands are estimates, not current menu quotes or a full
per-person bill.

Walking, cycling, and driving times use great-circle distance and fixed speeds.
They do not account for street layout, traffic, elevation, or access barriers.
Transit travel-time needs remain pending. Navigation hands coordinates to an
external map app; no route is calculated at that handoff.

Created organizers receive a labelled fixture origin. Newly joining members
have no origin initially; distance calculations can fall back to the scope
centre. Participants can set a stated or device location. Device tracking
requires device-origin selection and live-sharing opt-in; no claim is made
that fixture positions describe real participants.

## Freshness, lookup, and prepopulation

The base dataset changes through an explicit offline refresh. Its `observedAt`
timestamp comes from the extract, not the date somebody opened the page.
Runtime enrichment has provider-specific cache and retry clocks. Cached facts
can survive a temporary source failure, so the absence of a current error does
not mean a venue was checked moments ago.

[Prepopulation](PREPOPULATE.md) runs the same listing, site, image, and search
providers ahead of a demo. It creates no room, participant, requirement, or
candidate rows. New rooms can reuse its OSM-ref caches, but it does not refresh
the OSM snapshot or make every criterion known. Interactive lookup and ongoing
refinement remain available after a room opens.

## Refreshing and inspecting the data

From the repository root, with Node.js and either local `osmium` or Docker:

```bash
make venues
make venues-refresh
node scripts/build-area-snapshot.mjs sf-soma
```

`make venues` rebuilds from extracts in `data/osm/`, downloading missing inputs.
`make venues-refresh` downloads fresh extracts first. The single-area command
limits the rebuild to that registry entry. Review and commit the generated
snapshot changes; restart/deploy the application because snapshots are cached
in process memory.

The builder and its measured fields are defined in
[build-area-snapshot.mjs](../scripts/build-area-snapshot.mjs). To inspect the
shipped manifests without a network request:

```bash
node --input-type=module - <<'JS'
import { readFileSync } from 'node:fs';
for (const id of ['berlin-mitte', 'sf-soma']) {
  const { manifest } = JSON.parse(readFileSync(`packages/contracts/data/areas/${id}.json`, 'utf8'));
  console.log(JSON.stringify({ id, extract: manifest.extract, coverage: manifest.coverage }, null, 2));
}
JS
```

## Fallback chain

1. The area's committed snapshot is the normal source.
2. If Berlin's snapshot is missing, the legacy
   [curated dataset](../packages/contracts/data/berlin-mitte-venues.json) is a
   fallback. The local `room_demo` fixture also uses that data.
3. If no source can create a usable room, creation reports unavailable data.

The curated dataset contains explicitly marked demo fiction and heuristic
values. Its `curated:demo-2026-08` overlay makes scripted negotiation scenarios
repeatable; it must not be presented as verified information about real venues.
The normal city snapshots do not contain that overlay. A room records whether
its initial source was `osm-snapshot` or `curated`.

## Verification and limits

Relevant suites cover [places](../tests/unit/places.test.ts),
[pool growth](../tests/api/pool-growth.test.ts), [steps](../tests/api/steps.test.ts),
[hours](../tests/unit/hours.test.ts), [eligibility](../tests/unit/eligibility.test.ts),
and [prepopulation](../tests/api/prepopulate.test.ts).

The current product does not provide worldwide search, live occupancy,
reservations, transit routing, or guaranteed opening/price/attribute accuracy.
See [Known limitations](KNOWN-LIMITATIONS.md) for the decision, privacy, and
operational boundaries.
