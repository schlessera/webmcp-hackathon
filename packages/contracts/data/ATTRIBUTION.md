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
