# Data Attribution

## berlin-mitte-venues.json

Venue names, locations, categories, opening hours, and real-world attribute
tags (vegetarian, wheelchair, outdoor seating, dog, cuisine) are derived from
**OpenStreetMap**.

**© OpenStreetMap contributors**

This data is made available under the Open Database License (ODbL) 1.0:
<https://opendatacommons.org/licenses/odbl/1-0/>

- Extract date: 2026-08-31 (OSM base timestamp `2026-08-31T21:52:21Z`)
- Source: Overpass API (<https://overpass-api.de>, with
  <https://overpass.kumi.systems> as fallback mirror), one-time extract via
  `scripts/extract-venues.mjs`; curated by `scripts/curate-venues.mjs`
- Bounding box: 52.515, 13.37, 52.53, 13.41 (Berlin Mitte)

## Demo overlay disclaimer

Attributes whose `source` is `curated:demo-2026-08` are **curated fiction for
the scripted demo** (from `scripts/demo-overlay.json`) and are **not**
verified facts about the real venues — e.g. lactose-free menu claims and some
price levels. They exist only to make the demo's negotiation impasse
deterministic. Attributes with `source` starting `osm:` reflect real
OpenStreetMap tags at extract time; `curated:berlin-mitte-2026-08` marks
heuristic values (price-level guesses, default opening hours) that are best
effort, not verified.

## areas/berlin-mitte.json, areas/sf-soma.json

Area snapshots: every named place tagged `amenity` in
`cafe|restaurant|bar|pub|biergarten|fast_food` inside the city bounding box,
with the subset of tags the product reads (`packages/contracts/src/dossier.ts`,
`KEPT_TAGS`). Derived from **OpenStreetMap**, © OpenStreetMap contributors,
under the ODbL 1.0.

- Source: Geofabrik extracts (`berlin-latest.osm.pbf`,
  `norcal-latest.osm.pbf`), clipped with `osmium`, built by
  `scripts/build-area-snapshot.mjs` (`make venues`). No public query API is
  used.
- Extract timestamp: recorded per file in `manifest.extract.timestamp`, and
  carried on every attribute as `observedAt`.
- No overlay, no heuristics: every attribute's `source` is `osm:*`. A tag
  OpenStreetMap does not carry is `unknown`; prices are never guessed.
- Coverage numbers in `manifest.coverage` are measured from the same file at
  build time (`docs/DATA-QUALITY.md`).

Refreshing: `make venues-refresh` re-downloads the extracts and rebuilds both
files. The prepared extracts live in `data/osm/` and are not committed.

## Looked-up facts (runtime cache, not committed)

`docs/ENRICHMENT-SOURCES.md`. The server may look a place up and cache the
parsed result for seven days in the `enrichments` table:

- **The place's own website** (from its OSM `website` tag): schema.org
  JSON-LD facts, a menu link, a one-line description. Facts carry the source
  `web:<host>`; a rating is shown only as "as published by the place". Page
  text is never stored. robots.txt is honoured; the User-Agent names this
  project.
- **Wikidata** (from the OSM `wikidata` tag): description, Wikipedia link,
  official site, awards. CC0 — <https://creativecommons.org/publicdomain/zero/1.0/>.
  Source `wikidata:<id>`.

- **Menus that are pictures** (a PDF or image the venue links): read once
  by a vision model; only the resulting claims are cached, each capped at
  "likely" with its confidence and labelled `menu:<host>`. The bytes and the
  text are not stored.

No review platform is used: none permits redistribution or caching on terms
this project can meet.
