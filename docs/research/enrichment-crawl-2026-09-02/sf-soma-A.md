# San Francisco SoMa website-enrichment investigation

Run date: 2026-09-02. Slice: all 323 records in `venues.json`. The crawl used eight workers, a 12 s request timeout, the specified user-agent, per-origin cached `robots.txt` checks, a 2 MB body ceiling, and no more than one homepage and one selected-menu request per venue. `results.json` is the per-venue record; `summary.json` is the compact aggregate.

## A. Coverage

“Homepage 2xx” is the reachability denominator below. Some non-2xx servers returned parseable HTML, but those bodies are excluded from the 2xx-derived rates. No homepage was disallowed by the site's `*` robots group under the extractor's robots semantics; 2 homepage bodies and 5 menu bodies crossed the 2 MB ceiling and were stopped.

| Measure | Count | Share |
|---|---:|---:|
| Venues attempted | 323 | 100.0% |
| Homepage HTTP 200 | 247 | 76.5% of slice |
| HTTP 403 / 404 / 429 / 521 | 28 / 10 / 13 / 1 | 16.1% combined |
| Network failure / timeout | 21 / 3 | 7.4% combined |
| Any JSON-LD on a 200 page | 151 | 61.1% of 200 pages |
| Any fact extracted by `parseWebsite` beyond URL/host/time/types | 171 | 69.2% of 200 pages |
| Any requested menu-pattern link on a 200 page | 189 | 76.5% of 200 pages |
| Any requested menu-pattern link across all returned bodies | 195 | 60.4% of slice |
| Menu request returning HTTP 200 | 189 / 195 | 96.9% of menu attempts |
| Instagram / Facebook links on 200 pages | 163 / 146 venues | 66.0% / 59.1% |
| Reservation / delivery platform links on 200 pages | 33 / 23 venues | 13.4% / 9.3% |

Builder hints on the 247 HTTP-200 pages were WordPress 62, Squarespace 51, Toast 33, Wix 20, Shopify 15, Weebly 14, GoDaddy 5, Webflow 2, and Jimdo 1. These are markup hints, not mutually exclusive or independently verified products.

The implementation deliberately treats only HTML/XML as enrichable in its normal fetch path (`website.ts:208-212`) and caps stored HTML at 1.5 MB (`website.ts:39-40,211`); this research crawl used the requested 2 MB ceiling instead. The implementation's robots parser considers only the `User-agent: *` group and prefix-style `Disallow` rules (`website.ts:45-64`), so “robots allowed” here cannot establish compliance with wildcard, `Allow`, or user-agent-specific rules.

## B. Top extractor gaps

On HTTP-200 pages, 28 venues had a requested menu-pattern link but no `facts.menuUrl`. The ten highest-confidence concrete misses are below. Snippets are normalized anchor excerpts reconstructed from the captured href and anchor text (maximum 200 characters); they omit unrelated attributes. All are missed because the fallback only tests the `href` for `menu`, `speisekarte`, `menü/menu`, `carte`, or `karte`, and never tests anchor text (`website.ts:169-173`).

| # | Venue and URL | Captured HTML snippet | Proposed fix |
|---:|---|---|---|
| 1 | Dirty Habit — https://www.zhotelssf.com/hotels/dirty-habit | `<a href="/hotels/dirty-habit/best-restaurants-in-san-francisco">Menus</a>` | Parse anchors and match visible text too: `/(?:menu|menü|speisekarte|karte|carte)/iu`; replace the href-only fallback at `website.ts:169-173`. |
| 2 | ¡Venga! Empanadas — https://www.vengaempanadas.com/ | `<a href="/?page_id=57">MENU</a>` | Same anchor-text fix at `website.ts:169-173`; resolve with the existing URL resolver at `website.ts:101-108`. |
| 3 | Sutter Station Tavern — https://sutterstationtavern.com/ | `<a href="#drinks">Drinks</a>` | Add `drinks?` to the text/href pattern at `website.ts:171`; fragment links are already resolvable by `website.ts:101-108`. |
| 4 | La Fromagerie — https://lafromageriesf.com/ | `<a href="/collections/lunch">Lunch Pick Up</a>` | Add `lunch` (and `mittag`) to the menu vocabulary at `website.ts:171`. |
| 5 | Hotel Utah Saloon — https://hotelutah.com/ | `<a href="#food">MENU</a>` | Match anchor text, not only href, at `website.ts:169-173`. |
| 6 | Barebottle Brew Co. — https://www.barebottle.com/salesforce-park-beer-garden | `<a href="#salesforce-park-taplist">«DRINKS MENU»</a>` | Match text and add `drinks?\|taplist` at `website.ts:171`. |
| 7 | Sushirrito — https://www.sushirrito.com/ | `<a href="/food/index.php">Food</a>` | Add bounded `food` to the href/text vocabulary at `website.ts:171`. |
| 8 | Johnny Foley's Irish House — https://www.johnnyfoleys.com/ | `<a href="/drink">DRINK</a>` | Add `drinks?` at `website.ts:171`. |
| 9 | Bar Fluxus — https://www.barfluxus.com/ | `<a href="/cocktails">DRINKS &amp; FOOD</a>` | Match text and add `drinks?\|food\|cocktails?` at `website.ts:171`. |
| 10 | Kin Khao — https://www.kinkhao.com/ | `<a href="/lets-drink">Drink</a>` | Add `drinks?` at `website.ts:171`. |

The most important structured-data gap is hours. Thirty-one HTTP-200 pages contained `openingHoursSpecification`; 30 produced no `facts.hours`. A representative detected excerpt is Fogo de Chão, `https://fogodechao.com/location/san-francisco/`: `<script type="application/ld+json">…"openingHoursSpecification":…</script>`. The parser reads only `venue.openingHours` (`website.ts:143-144`). Proposed change: normalize each specification's `dayOfWeek`, `opens`, and `closes` into raw hour strings, accepting a single object or array, while preserving the existing 14-item cap (`website.ts:143-144`).

JSON-LD shape audit:

- `@type` arrays are **not** an identified bug: six 200 pages used them, and `typesOf` explicitly coerces scalar or array types (`website.ts:89`); venue selection then tests every type (`website.ts:133-136`).
- Top-level and recursively nested `@graph` arrays are already walked (`website.ts:79-85`). Arbitrary nested objects are not walked, however: the walker only descends through `@graph` (`website.ts:81-85`). A safe improvement is a recursive traversal of object values with cycle/depth guards, followed by `@id` indexing.
- Two 200 pages contained `Menu` objects (Mixt and Mastro's). The extractor does not select `Menu` nodes; it only takes `hasMenu`/`menu` from the chosen venue node (`website.ts:133-136,161-162`). Both happened to expose a usable URL through the venue, so this shape caused no observed miss in this slice. Proposed change: index nodes by `@id`, dereference `hasMenu` references, and accept a `Menu.url`/`Menu.@id` fallback (`website.ts:91-98,161-162`).
- Only the first food-typed node, otherwise the first generic business node, is used (`website.ts:133-136`). Consequently, facts distributed across multiple same-entity nodes are not merged. Proposed change: rank nodes by URL/name match and merge referenced or same-`@id` nodes before reading direct fields (`website.ts:133-168`).
- One 200 page had broken JSON-LD. Parse failures are silently discarded (`website.ts:124-131`), so the failure cannot be distinguished from absent data. Recording a parse diagnostic alongside facts would make coverage measurable without retaining page text.

The research pattern is intentionally broader than the production fallback, but words such as `food`, `menu`, and `pdf` also produced false positives—for example, an unrelated Samsung installation PDF on the currently redirected Henry's Hunan URL. Any production expansion should score text/href together, reject boilerplate/plugin-credit links, and prefer same-host links; a single broad regex alone would reduce precision.

## C. What menus are, and platform findings

Of the 189 successful menu responses:

| Response class | Count | Share of successful menu responses |
|---|---:|---:|
| HTML/text on the same host | 162 | 85.7% |
| PDF | 6 | 3.2% |
| Image-only response | 0 | 0.0% |
| Different host (“third-party” operational definition) | 21 | 11.1% |

The other six menu attempts returned 403 (4), 404 (1), or 429 (1). Across all 195 selected links, the URL/final-host classification was 163 same-host HTML, 6 PDF, 0 image-only, and 26 different-host. “Different host” cannot reliably mean independent platform: it includes corporate-domain transitions such as Subway (6), Chipotle (4), Jamba (2), and Bluestone Lane ordering (2), as well as clearer platforms such as SpotApps (3), SmartTab (1), and SpotOn (1). It also includes discovery false positives (Food & Wine 2, Essential Plugin 1, and KQED 1). Therefore the true third-party-menu-platform share cannot be determined from host inequality alone.

Sixty-eight of 189 successful menu responses carried at least one requested dietary marker: 36.0% (34.9% if all 195 attempts are the denominator). By marker, vegan appeared on 37 menus, vegetarian/vegetarisch on 37, gluten-free/glutenfrei on 30, allergen/allergene on 19, halal on 6, `vg` on 2, `(v)` on 1, and lactose-free/laktosefrei on 0. The six PDFs were classified but not text-extracted, so their marker status is unknown rather than confirmed absent. Counts are lexical occurrences and may include scripts, navigation, disclaimers, or negated prose; they are not verified dish-level labels.

Reservation platforms linked by HTTP-200 homepages, counted once per venue: OpenTable 26 (25 `opentable.com` plus 1 `qr-scan.opentable.com`), Resy 4, Tock/ExploreTock 3, and SevenRooms 2. Delivery: DoorDash 20, Uber Eats 10, and Grubhub 8. No links were observed for Quandoo, TheFork, Lieferando, Wolt, or Deliveroo. A venue can link more than one platform, so platform counts do not sum to the 33 reservation-link venues or 23 delivery-link venues. The extractor itself only reads `acceptsReservations` from the chosen JSON-LD venue and requires an absolute HTTP URL (`website.ts:163-164`); it has no HTML platform-link fallback.

## D. Recommendations ranked by expected gain for a room

1. **Extract and rank HTML menu anchors.** Parse anchors, score both visible text and href with the expanded English/German vocabulary, prefer same-host targets, reject known social/plugin/news links, and retain the current resolver. This directly addresses 28 observed 200-page misses and raises menu discovery on reachable pages from 161/247 via `parseWebsite` to as many as 189/247 before precision filtering. The present fallback is the narrow href-only expression at `website.ts:169-173`.
2. **Support `openingHoursSpecification`.** Normalize schema.org day/open/close objects, including arrays, and merge same-entity JSON-LD nodes. This addresses 30 direct misses among 31 200 pages carrying the field. Current extraction only reads `openingHours` (`website.ts:143-144`) from one selected node (`website.ts:133-136`).
3. **Add platform-link fallbacks and depth-2 menu inspection.** Capture reservation/delivery URLs from scored anchors, and inspect one selected menu page for dietary markers while labeling source and confidence. The slice exposes reservation platforms on 33 reachable homepages, delivery platforms on 23, and dietary language on 68 successful menu responses. Today reservations are JSON-LD-only (`website.ts:163-164`), and the normal fetch performs only one venue-page request after robots (`website.ts:193-212`).

## E. Residual uncertainty

- This is one geographically and distance-selected SoMa slice, not a random sample of San Francisco venues; rates should not be generalized without another sample.
- Results are a single live snapshot. Redirects, bot defenses, transient 403/429 responses, timeouts, and stale or hijacked website tags affect both reachability and semantic precision. Final URLs and statuses are preserved per venue in `results.json`.
- The crawler used the requested minimal `robotsAllows` function. Because that function ignores `Allow`, wildcard semantics, and non-`*` groups (`website.ts:45-64`), standards-complete robots authorization cannot be determined.
- Menu selection uses the first discovered candidate after same-host preference. Broad vocabulary generated known false positives, so 195 is discovery coverage, not 195 verified menus.
- Image-only menus embedded inside an HTML page are not detectable from response content-type alone. The measured zero means no selected menu request itself returned `image/*`; the share of HTML pages whose meaningful menu is only an embedded image cannot be determined without DOM/media inspection or OCR.
- Dietary scanning was performed only on HTML/text bodies. PDF contents and image text were not extracted, and lexical matches were not semantically validated.
- Builder detection is heuristic markup matching. Multiple hints can occur on one page, and absence of a hint does not prove absence of that builder.