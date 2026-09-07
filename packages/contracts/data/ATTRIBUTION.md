# Data Attribution

The root [MIT license](../../../LICENSE) covers the project's source code.
Geographic data derived from OpenStreetMap is © OpenStreetMap contributors and
is available under the Open Database License (ODbL). The ODbL terms apply to
that database content independently of the source-code license. Dataset-specific
sources and notices follow.

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

Area snapshots contain supported named OpenStreetMap places inside each city
bounding box, together with a bounded landmark index. The
[place-class table](../src/place-classes.ts) includes `amenity`, `leisure`,
`tourism`, and `shop` classes: food/drink places, cinemas, theatres, libraries,
parks, museums, bookshops, and the other classes listed there. Snapshot tags
are limited to the fields consumed by [dossier mapping](../src/dossier.ts).

Derived from **OpenStreetMap**, © OpenStreetMap contributors, under the
ODbL 1.0.

- Source: Geofabrik extracts (`berlin-latest.osm.pbf`,
  `norcal-latest.osm.pbf`), clipped with `osmium`, built by
  [build-area-snapshot.mjs](../../../scripts/build-area-snapshot.mjs)
  (`make venues`). No public query API is used for runtime place lookup.
- Extract timestamp: recorded per file in `manifest.extract.timestamp`, and
  carried on mapped attributes as `observedAt`. This is distinct from the
  snapshot's build time and from runtime enrichment timestamps.
- The snapshot mapping adds no demo overlay or price guesses. Missing source
  tags remain unknown; runtime guesses and external evidence are separate
  layers with their own source labels.
- Coverage numbers in `manifest.coverage` are measured from the same file at
  build time. Its fixed pool sample is measurement metadata, not the current
  room seeding rule. See [Data quality](../../../docs/DATA-QUALITY.md).

Refreshing: `make venues-refresh` re-downloads the extracts and rebuilds both
files. The prepared extracts live in `data/osm/` and are not committed.
Minutely update feeds are recorded in the manifest but are not consumed at
runtime.

## Looked-up facts and images (runtime caches, not committed)

Runtime enrichment supplements the OSM record using the following sources.
Its complete transport, caching, evidence, and image handling is documented in
[Enrichment sources](../../../docs/ENRICHMENT-SOURCES.md). The source-code MIT
license does not assign a new license to externally sourced content. Cache
windows below describe application behavior, not a redistribution grant.

| Source | Retained material and provenance | Usual freshness |
|---|---|---|
| The place's website and linked HTML menu | Parsed facts, links, descriptions, and bounded source evidence; `web:<host>` and related evidence labels | 7 days |
| Wikidata | Description, Wikipedia link, official site, awards and image references; `wikidata:<id>` | 30 days |
| Google business-profile data through DataForSEO | Locally matched likely claims, hours, published rating and website; `listing:google`, with source link | 7 days |
| Search providers | Validated cited claims, with provider-specific handling of bounded snippets | 7 days |
| Menu PDF/image reading | Model-derived likely claims and short evidence, labelled `menu:<host>` | 7 days |
| Place images | Processed WebP bytes, source/source page, dimensions, and available credit/license metadata | Up to 30 days, subject to source cache policy |

Wikidata is provided under
[CC0](https://creativecommons.org/publicdomain/zero/1.0/). Wikimedia Commons
images are selected using file-specific license and credit metadata; accepted
Commons files retain their actual CC0, CC BY, or CC BY-SA notice. Website
images and images linked directly by OSM remain attributed to their source;
an OSM link does not itself establish an image license.

Selected homepage and HTML-menu text **is stored** in the server's page cache,
up to 6,000 characters per page, normally for a seven-day freshness window.
It is evaluator input and can be supplied to the model. Raw HTML is not
retained by this cache, and the full cached text is not a dossier field;
validated short excerpts/context can appear in evidence. Robots responses,
HTTP validators, and image candidates have separate cache handling.

Menu file bytes are read for interpretation and discarded. Only the resulting
claims and bounded evidence are retained, with menu-model confidence capped
below verified status. Processed venue photographs use the separate image
cache described above.

Parallel snippets use room-specific cache keys and are not cached without a
room ID. Tavily can use a shared bounded snippet cache; built-in model search
stores validated claims and answered-cell metadata rather than raw snippets
or responses. Regional [prepopulation](../../../docs/PREPOPULATE.md) uses these
same rules and caches without creating participant or negotiation records.

Website and Wikidata refreshes have independent failure/retry clocks and can
preserve the last good result through temporary failures. Expiry is not a
complete automatic deletion policy. Provider-specific behavior and controls
are defined by the implementation linked from the enrichment reference.

Participant attestations and confirmations are a separate source of evidence.
They retain their actor/note/source attribution and are limited to their
originating room; they do not modify this committed dataset or other rooms.
