# Berlin Mitte A: depth-2 website enrichment investigation

Scope: all 377 records in `venues.json`, crawled 2026-09-02 with concurrency 8, a 12 s request timeout, the specified `spokes-research/0.2` user agent, robots.txt checks, a 2 MB body ceiling, and no more than one homepage plus one selected menu-page fetch per venue. Percentages below use all 377 venues unless another denominator is stated. “Reachable” means a 2xx HTML homepage. Counts are venue counts, not link counts.

## A. Coverage

| Measure | Venues | Share |
|---|---:|---:|
| Slice | 377 | 100.0% |
| Reachable 2xx HTML homepage | 296 | 78.5% |
| Robots-disallowed homepage | 12 | 3.2% |
| Homepage body over 2 MB | 3 | 0.8% |
| Any JSON-LD | 152 | 40.3% overall; 51.4% of reachable |
| Broken JSON-LD block | 2 | 0.5% |
| Any discovered menu-pattern link | 233 | 61.8% overall; 78.7% of reachable |
| `parseWebsite` menu URL | 181 | 48.0% overall; 61.1% of reachable |
| Parsed cuisine | 18 | 4.8% overall; 6.1% of reachable |
| Parsed price level | 19 | 5.0% overall; 6.4% of reachable |
| Parsed hours | 10 | 2.7% overall; 3.4% of reachable |
| Parsed rating | 6 | 1.6% overall; 2.0% of reachable |
| Parsed wheelchair value | 2 | 0.5% overall; 0.7% of reachable |
| Parsed description | 22 | 5.8% overall; 7.4% of reachable |
| Parsed reservations URL | 2 | 0.5% overall; 0.7% of reachable |
| Reservation-platform link found | 32 | 8.5% |
| Delivery-platform link found | 21 | 5.6% |
| Instagram / Facebook link found | 201 / 166 | 53.3% / 44.0% |

Homepage status counts were 296×200, 17×403, 19×404, 4×429, 3×500, 2×503, and one each of 401, 423, and 520. Another 20 failed at the network layer, one timed out, 12 were robots-disallowed, and three crossed the body limit. Thus failures without an HTTP status cannot be assigned a server status.

Builder hints were WordPress 130, Wix 21, Shopify 17, Squarespace 13, TYPO3 11, Webflow 9, Gastronovi 9, Jimdo 5, Drupal 5, Joomla 3, and Weebly 1. These are markup hints and can overlap; they are not definitive platform identifications.

## B. Top 10 concrete extractor gaps

1. **Bredouille Bar — <https://bredouille-bar.de/>.** Snippet: `DRINKS FOOD` linked to `/drinks-food`. The fallback tests only a short keyword set inside `href`, not link text ([website.ts:169](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:169), [website.ts:171](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:171)). Fix: parse anchors and test decoded text and URL with `/(?:menu|menü|speisekarte|karte|carte|getränke|drinks?|food|essen|mittag|lunch|dinner|\.pdf)/i`.

2. **Dorotheá — <https://www.dorothea-restaurant.de/>.** Snippet: `Menükarte DE` linked to `https://dcsmjrhynn8lk.cloudfront.net/.../88ccba167146484ee9c50495c5f7ec6a.pdf`. The opaque PDF URL defeats the `href`-only fallback ([website.ts:171](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:171)). Fix: apply the same anchor-text regex and accept `.pdf` URLs when menu-like anchor text supplies the semantics.

3. **Hoa Rong — <https://www.hoa-rong.com/>.** Snippet: `Menü - Regulär` linked to `https://drive.google.com/file/d/.../view`. Neither the opaque URL nor platform name is menu-like, although the anchor text is ([website.ts:171](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:171)). Fix: match normalized anchor text before resolving the `href`.

4. **Van-Long — <https://www.van-long.de/>.** Snippet: `LUNCH` linked to `/s/LUNCH.pdf`. `lunch` and generic PDFs are outside the fallback vocabulary ([website.ts:171](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:171)). Fix: add `mittag|lunch|dinner|drinks?|food|essen|\.pdf`, preferably requiring a menu-like text term for generic PDFs to limit false positives.

5. **Toca Rouge — <http://tocarouge.de/>.** Snippet: `FOOD` linked to `/food`. `food` is not recognized ([website.ts:171](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:171)). Fix: add `food|essen` to the anchor URL/text pattern.

6. **Bredouille Bar — <https://bredouille-bar.de/>.** JSON-LD snippet: `"openingHours":"Mo 11:30-01:00, Tu 11:30-01:00, ..."` on a `LocalBusiness`, but no hours were returned. The extractor takes only the first food node or first generic business node ([website.ts:133](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:133)–[website.ts:143](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:143)); an earlier `Organization` wins over the later `LocalBusiness`. Fix: rank candidates by food type and number of supported fields, or merge supported fields across compatible business nodes instead of using `typed[0] ?? business[0]`.

7. **Bombay — <https://www.bombay-berlin.de/>.** JSON-LD snippet: `[{"@type":"OpeningHoursSpecification","dayOfWeek":"Tuesday","opens":"11:00","closes":"23:59:59"}, ...]`. The extractor reads only `openingHours` ([website.ts:143](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:143)–[website.ts:144](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:144)). Fix: normalize `openingHoursSpecification` objects into strings such as `Tu 11:00-23:59`, preserving arrays of days and validity dates. This pattern caused 30 concrete hours misses in the slice.

8. **Telefónica Basecamp — <https://www.basecamp.digital/>.** JSON-LD snippet: `{"@type":"Menu","name":"Speisekarte","hasMenuSection":{"@type":"MenuSection",...}}`. `firstUrl` accepts only a string, `url`, or `@id` ([website.ts:91](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:91)–[website.ts:97](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:97)); the `Menu` object is therefore discarded when assigned through `hasMenu` ([website.ts:161](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:161)–[website.ts:162](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:162)). Fix: when an embedded `Menu` has sections/items but no URL, represent menu presence separately or use the current page URL as `menuUrl`.

9. **Peter Pane — <https://peterpane.de/standorte/berlin/friedrichstrasse/>.** JSON-LD snippet: `"priceRange":"15€-25€"`. `priceRangeToLevel` accepts only one to four repeated currency symbols ([website.ts:67](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:67)–[website.ts:72](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:72)). Fix: additionally recognize numeric ranges, for example `/^(?:[$€£]\s*)?\d+(?:[.,]\d+)?\s*[$€£]?\s*[-–]\s*(?:[$€£]\s*)?\d+(?:[.,]\d+)?\s*[$€£]?$/`, then map thresholds only with an explicit documented currency policy. Eight published price ranges were not converted; their semantics cannot be safely collapsed to levels without that policy.

10. **Brechts — <https://brechts.de/>.** JSON-LD snippet: `"description":"Das BRECHTS Steakhaus in Berlin steht für den ultimativen Genuss ..."` on a `WebPage`; the page has no recognized food/business venue node, so the description is lost. Description extraction is gated on the selected venue ([website.ts:138](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:138), [website.ts:165](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:165)–[website.ts:167](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:167)). Fix: if no venue description exists, fall back to a non-empty `WebPage` description whose `url`/`@id` matches the fetched page, then apply the existing clipping behavior.

Two suspected JSON-LD problems were **not** substantiated: `@type` arrays are explicitly flattened ([website.ts:89](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:89)), and nested `@graph` arrays are recursively traversed ([website.ts:79](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:79)–[website.ts:85](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:85)). The real graph-related loss is first-node selection, not graph traversal. Also, boolean `acceptsReservations: true` says that booking is accepted but cannot determine a reservation URL; the extractor asks `firstUrl` for one ([website.ts:163](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:163)–[website.ts:164](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:164)), so a separate boolean would be needed rather than inventing a link.

## C. What the selected menu links are

The crawler selected and attempted one menu-pattern link for 233 venues; 228 returned an HTTP status. Classification among those 228 was:

| Selected target type | Count | Share |
|---|---:|---:|
| Same-host HTML/text | 179 | 78.5% |
| PDF | 40 | 17.5% |
| Third-party HTML/text | 9 | 3.9% |
| Image-only response | 0 | 0.0% |

Of the 228 classified responses, 221 were 200, six were 404, and one was 429. The nine third-party targets resolved to top10berlin.de (2), Google, Storekit, Productmate, Atlassian, Menury, Big Mamma’s menu host, and Lightspeed (1 each). Because the required discovery vocabulary is intentionally broad—especially `food`, `karte`, and any PDF—some selected targets are false positives (for example, a map or legal PDF). Therefore these figures describe the first pattern-matched links, not a manually verified set of menus.

Dietary markers could be inspected only in 188 HTML/text responses; PDFs were recorded but not text-extracted, as required. Ninety-five of 188 eligible pages (50.5%) carried at least one marker, or 41.7% if all 228 classified responses are used as the denominator and uninspected PDFs are conservatively counted as unknown/no marker. Per-marker venue counts within the 188 were vegan 58, vegetarian/vegetarisch 44, allergen/allergene 32, `(v)` 20, gluten-free/glutenfrei 19, lactose-free/laktosefrei 10, `vg` 10, and halal 5. Dietary-marker presence in PDFs cannot be determined from this crawl.

Reservation-platform links appeared on 32 venues: OpenTable 18, Quandoo 8, TheFork 3, SevenRooms 3, Tock 1, Resy 0. Delivery-platform links appeared on 21 venues: Wolt 14, Lieferando 7, Uber Eats 6, Deliveroo 1, DoorDash 0, Grubhub 0. Platform totals exceed their venue totals because a venue may link more than one platform.

## D. Recommendations ranked by expected gain for a room

1. **Replace the fallback menu regex with lightweight anchor parsing and scoring.** Match decoded anchor text and URL using the expanded bilingual vocabulary, prefer same-host links, and down-rank maps, privacy/legal PDFs, press articles, and reservation links. The direct ceiling in this slice is 55 additional venues with a discovered candidate but no parser menu URL, the largest immediately actionable gain. This replaces the narrow `href`-only logic at [website.ts:169](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:169)–[website.ts:173](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:173).

2. **Normalize `openingHoursSpecification` and merge/rank JSON-LD venue nodes.** Thirty venues published structured specifications but returned no hours, versus only ten current hours successes. Merging supported fields also fixes pages where an early generic node masks a richer later node; current single-node selection is at [website.ts:133](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:133)–[website.ts:143](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:143).

3. **Represent menu and reservation presence separately from URLs, then enrich platform links from anchors.** Embedded `Menu` objects can establish menu availability without a URL, and boolean `acceptsReservations` cannot yield one ([website.ts:91](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:91)–[website.ts:97](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:97), [website.ts:161](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:161)–[website.ts:164](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:164)). Anchor discovery found booking links for 32 venues while the parser returned two, a 16× coverage difference, but the schema should distinguish “accepts booking” from “booking URL.”

## E. Residual uncertainty

- This is one geographically ordered half-slice, not a random Berlin or global sample; it should not be generalized without replication.
- Dynamic links rendered only after JavaScript execution are absent because the crawler fetched raw responses only.
- Robots checks use the repository’s deliberately minimal `*`-group parser. It handles prefix `Disallow` rules but not `Allow`, wildcard precedence, named-agent groups, or full RFC-style matching ([website.ts:45](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:45)–[website.ts:64](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:64)).
- Builder detection is heuristic and overlapping. Platform counts cover only the named allowlists, so other booking/delivery providers cannot be determined from the reported counts.
- The first-match menu policy and broad vocabulary introduce false positives; no manual semantic validation of all 233 targets was performed. Conversely, menus exposed only through scripts, forms, buttons, images, or unlisted vocabulary remain unknown.
- Dietary counts are literal, case-insensitive token counts, not claims that a venue accommodates a diet. PDF contents and image-only menus were not OCRed, so their dietary content cannot be determined.
- HTTP reachability is a single observation. Network failures, anti-bot responses, and transient 429/5xx statuses may change on a later run.