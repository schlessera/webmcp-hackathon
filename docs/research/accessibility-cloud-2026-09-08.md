# accessibility.cloud activation check — 2026-09-08

The application token supplied through the local `.env` authenticated successfully against the cached API. The catalogue returned 168 source entries and 76 licence entries. These counts describe the visible catalogue, not coverage in our regions.

Live tile responses exposed two parser defects: place names were language maps rather than strings, and ODbL licences were classified as `CCSA`. The fix accepts language maps, recognizes canonical ODbL URLs, and changes the tile cache version so previously discarded records can be fetched again. Unsupported and restricted licences remain excluded, including misleading `CCBY` classifications for noncommercial, no-derivatives or share-alike Creative Commons variants.

## Configured sources

The token and the following comma-separated source IDs were configured locally and staged in `/root/spokes/.env`. The running application has not been restarted with them; activation requires deployment of the parser fix. The production prepopulation run remains interrupted.

| Source | ID | Usable records in the prepared 2 km regions |
| --- | --- | ---: |
| Ginto.Guide | `zFpoqetHjgGbmyHnR` | Berlin: 1 |
| Places from ‘Places and Facilities Survey’ | `ghEw4XyFpQNLMC45w` | Berlin: 1 |
| Travelable Booking.com Mapathon | `Rf3E4jqTcyTQvGNcP` | Berlin: 1 |
| Public toilets in Berlin | `ZgrxE24pTiDfv7J5P` | Berlin: 13 |
| StaDa | `Q9jzJMxydegZYfFbK` | Berlin: 7 |
| Berlin Behindertenparkplätze | `XWATLf3NA778iPJTp` | Berlin: 12 |
| Behindertenparkplätze Fhain Kberg | `bWaRzazK7tEq2hcGA` | Berlin: 10 |
| Behindertenparkplätze Spandau und Tempelhof-Schöneberg | `nhwd59iv6nMPcHkuW` | Berlin: 1 |
| San Francisco Disabled Parking | `dvxYrDLdMv3tdiHck` | SF: 260 |

Requests used the documented tile endpoint, source filtering, and bounded pagination. An initial broad Berlin probe hit HTTP 502 responses; the subsequent filtered probe completed all tiles covering both regions. Counts above require a usable name and an explicit wheelchair boolean; they are not new verified venue claims.

The fixed parser accepted 46 Berlin and 260 SF records. Matching against the committed area snapshots with the existing strict name, distance, domain and ambiguity rules yielded **one Berlin match** (`node/4153838983`, café und bistro freysinn) and **zero SF matches**. Most available records describe parking spaces, toilets or stations rather than venues in the current selection. Matching thresholds were not relaxed.

The allowlist excludes the Wheelmap/OSM mirror, restricted or unidentified licences, and sources that did not add usable wheelchair facts. Clean your Cup was also left out because the sampled records describe toilets named after venues; those should not establish whole-venue accessibility through name/proximity matching alone.

## Validation

Sixteen discovery unit tests, eleven pipeline integration tests and the server typecheck passed. Tests used a dedicated local PostgreSQL database; integration tests ran on Node 26.8.1, matching production. A live smoke check through the actual discovery code fetched two tiles, persisted the freysinn match in that test database, and reused the cache on a second call. The token did not appear in stored tiles, provider attempts or enrichment records. No production enrichment records were written by these checks.

The [official API documentation](https://github.com/sozialhelden/accessibility-cloud/blob/main/app/docs/json-api.md) describes authentication, tile queries, related licence metadata and source filtering. No token, authenticated URL or private application metadata is included in this report.
