# San Francisco SoMa website-enrichment investigation

Run date: 2026-09-02. Slice: all 323 records in `venues.json`. The crawler used concurrency 8, a 12 s per-request timeout, the requested user agent, robots checks, a 2 MB response-body ceiling, and at most one homepage plus one selected menu fetch per venue. Counts below are venue counts, not link counts.

## A. Coverage at depth 2

| Measure | Count | Share of 323 |
|---|---:|---:|
| Homepage returned 2xx | 266 | 82.4% |
| Homepage returned 403 / 404 / 429 | 20 / 8 / 2 | 6.2% / 2.5% / 0.6% |
| No HTTP status (timeout/network/robots) | 27 | 8.4% |
| Robots-disallowed homepage | 2 | 0.6% |
| Parseable HTML response (including non-2xx bodies) | 296 | 91.6% |
| Any JSON-LD type extracted | 163 | 50.5% |
| `servesCuisine` extracted | 25 | 7.7% |
| price level extracted | 17 | 5.3% |
| hours extracted | 7 | 2.2% |
| rating extracted | 4 | 1.2% |
| wheelchair fact extracted | 0 | 0.0% |
| menu URL found by `parseWebsite` | 150 | 46.4% |
| menu-pattern anchor found by broad crawl matcher | 174 | 53.9% |
| selected menu fetch returned 2xx | 164 | 50.8% (94.3% of discovered menus) |
| Homepage over 2 MB and skipped | 0 | 0.0% |

The status distribution is exhaustive: 262 HTTP 200 + 4 HTTP 202 + 20 HTTP 403 + 8 HTTP 404 + 2 HTTP 429 + 27 without status = 323. “Parseable HTML” is deliberately not synonymous with reachable: some 4xx responses supplied HTML that could be inspected, whereas the production fetch wrapper rejects non-2xx before parsing (`website.ts` lines 203–212). The production constants also differ from this survey (8 s and 1.5 MB at `website.ts` lines 39–41), while this run used the requested 12 s and 2 MB.

Builder fingerprints occurred on 187 sites (57.9%). The leading hints were Squarespace 52, WordPress 45, Toast 31, Wix 27, BentoBox 25, Shopify 13, Weebly 13, GoDaddy 11, Webflow 6. Fingerprints are heuristic and a site can count in more than one family.

## B. Top 10 concrete extractor gaps

Each snippet is whitespace-collapsed and at most 200 characters. The first five are structured-hours misses: the extractor only reads `venue.openingHours` (`website.ts` lines 143–144), despite the page exposing `openingHoursSpecification`. The next five are anchor misses: the fallback tests only the **href**, and only `menu|speisekarte|men[üu]|carte|karte` (`website.ts` lines 169–172).

| # | Venue and URL | Observed page snippet | Proposed fix |
|---:|---|---|---|
| 1 | Hang Ah Tea Room — https://hangahtearoom.com/ | `"GeoCoordinates","latitude":"37.7933773","longitude":"-122.4073616"},"openingHoursSpecification"...` | At lines 143–144, convert each `OpeningHoursSpecification` into compact day/time strings; accept arrays and a singleton object. |
| 2 | Chaat Diner — https://chaatdinersf.com/ | `postalCode":"94103","addressCountry":"US"},"telephone":"(415) 947-7434","openingHoursSpecification"...` | Same change at lines 143–144; map `dayOfWeek`, `opens`, and `closes`. |
| 3 | Z & Y Restaurant — https://www.zandyrestaurant.com/ | `"openingHoursSpecification": [` | Same change at lines 143–144; preserve multiple intervals for a day rather than overwriting them. |
| 4 | Roka Akor — https://rokaakor.com/san-francisco/ | `"openingHoursSpecification": [` | Same change at lines 143–144; normalize schema URLs such as `https://schema.org/Monday` to `Monday`. |
| 5 | Mountain Boba — https://mountainboba.com/ | `"openingHoursSpecification": [` | Same change at lines 143–144. This page also exposes a `"@type": "Menu"` node; resolve referenced nodes by `@id` rather than treating the fragment itself as the menu URL (current URL extraction is lines 91–97 and menu extraction lines 161–162). |
| 6 | Hi Dive — https://www.hidivesf.com/ | `<a href="/eat--drink.html" class="wsite-menu-item">` | At lines 169–172, inspect decoded anchor text as well as href and add `drinks?`: e.g. parse anchors, then test `/(?:menu|menü|speisekarte|karte|carte|drinks?)/i`. |
| 7 | Caffè Macaroni — https://www.caffemacaroni.com/ | `<a href="CAFFEM.pdf">Menu</a>` | At lines 169–172, match visible anchor text; optionally add `/\.pdf(?:$|[?#])/i` as a lower-confidence href signal. |
| 8 | Bix — https://bixrestaurant.com/ | `<a href="https://bixrestaurant.com/food/"><span>Food<i...` | At lines 169–172, add `food` to the anchor href/text vocabulary. |
| 9 | upcider — https://www.upcidersf.com/ | `<a href="/drinks"> Drinks </a>` | At lines 169–172, add `drinks?` to the anchor href/text vocabulary. |
| 10 | Tricolore — https://www.tricoloresf.com/ | `<a href=".../_files/ugd/552b2e_2eb7568800d24dfaabb4f1f4b3db4923...">Menu</a>` | At lines 169–172, test normalized visible text; the opaque Wix asset URL cannot be recognized from href vocabulary alone. |

JSON-LD shape audit: `@type` arrays are already normalized by `typesOf` (`website.ts` line 89), and recursively nested `@graph` arrays are already traversed by `nodesOf` (`website.ts` lines 79–85); this crawl does not establish either as a miss. A concrete remaining shape risk is separately declared or `@id`-referenced `Menu` objects: all nodes are collected, but only the first selected food/business node is read (`website.ts` lines 133–138), and `firstUrl` returns an object's `@id` without dereferencing it (`website.ts` lines 91–97). More generally, selecting only `typed[0] ?? business[0]` can leave facts on later relevant nodes unused (`website.ts` lines 133–136). The measured gaps above justify merging facts across same-entity food nodes, with `@id` dereferencing, rather than special-casing one publisher.

## C. What the menu targets are, and platform findings

Among the 164 successful selected menu fetches:

| Menu target class | Count | Share |
|---|---:|---:|
| HTML on the same host | 146 | 89.0% |
| PDF | 9 | 5.5% |
| Image-only response | 0 | 0.0% |
| Third-party platform | 9 | 5.5% |

These classes are mutually exclusive and sum to 164. Classification uses the final URL and response content type. “Image-only” means the fetched target itself had an image MIME type; it cannot detect an HTML menu whose meaningful content is only an embedded image without image/OCR analysis.

At least 104/164 successful menu targets (63.4%) carried a dietary marker. Restricting the denominator to the 154 HTML/text responses where marker scanning was possible gives 104/154 (67.5%). Marker presence in the 9 PDFs is unknown because this crawl intentionally did not extract PDF text; therefore 63.4% is a lower bound across all successful targets, not a complete content estimate.

Reservation links appeared on 27 venue homepages. Platform counts (venues, with one venue able to list multiple platforms) were OpenTable 16, Resy 7, SevenRooms 3, and Tock 2; Quandoo and TheFork were 0. Delivery links appeared on 23 venue homepages: DoorDash 14, Uber Eats 11, Grubhub 10; Lieferando, Wolt, and Deliveroo were 0. Social links were much more common: Instagram 159 and Facebook 136.

## D. Recommendations ranked by expected gain for a room

1. **Broaden and properly parse homepage menu anchors.** Parse `<a>` elements, normalize visible text, resolve URLs, reject non-HTTP schemes, and score same-host links first. Add at least `food`, `drinks?`, `lunch`, `dinner`, `essen`, `mittag`, and `.pdf`. This directly recovered 24 additional venues over `parseWebsite` in this slice (174 versus 150), a 7.4-point gain across the room. The present regex and href-only behavior are at `website.ts` lines 169–172.

2. **Support `openingHoursSpecification`.** Convert its day/open/close fields into the existing raw-hours representation, including multiple intervals. Hours were extracted for only 7 venues, while numerous concrete misses were observed because only `openingHours` is read (`website.ts` lines 143–144). This likely has the greatest structured-fact gain after menu discovery, although the exact increment cannot be determined from the retained snippets alone.

3. **Merge and dereference related JSON-LD nodes.** Build an `@id` map, resolve references (especially `Menu`), and merge fields across candidate food/business nodes rather than reading only the first. Node collection/type-array support should remain (`website.ts` lines 79–89); selection is the limiting step (`website.ts` lines 133–138), together with non-dereferencing URL extraction (`website.ts` lines 91–97). Expected gain is below the two changes above but improves correctness on CMS-generated graphs.

## E. Residual uncertainty

- This is one geographic slice and one point-in-time fetch. Dynamic, geo-gated, bot-protected, JavaScript-rendered, or intermittently failing sites may behave differently later. In particular, 20 sites returned 403 and 2 returned 429.
- Some OSM website tags appear stale, parked, or redirected to unrelated content (for example, the observed final domains for 15 Romolo and Henry's Hunan were unrelated-looking). The crawl reports what the tagged URL served; venue ownership cannot be determined without external verification, which the rules prohibited.
- Anchor discovery is intentionally recall-oriented. Generic words such as “food” and “drinks,” template markup, hidden navigation, and `href="#"` can create false positives. Following only the first same-host-preferred match means the selected target is not guaranteed to be the canonical menu.
- Builder hints are markup fingerprints, not verified vendor declarations, and can overlap.
- Dietary counts are raw case-insensitive token counts, not claims that a venue accommodates a diet. `(v)` and `vg` are ambiguous, and PDFs/images were not text-extracted.
- The robots helper is deliberately minimal: it reads only the `*` group and prefix-style `Disallow` rules (`website.ts` lines 45–64). It does not implement `Allow`, wildcard/end-anchor precedence, or user-agent-specific matching. Thus “honoured robots.txt” here means consistency with the repository’s `robotsAllows`, not full RFC 9309 evaluation.
- The crawl retained only targeted snippets, not complete HTML, so the exact number of additional hours recoverable and all multi-node merge opportunities cannot be determined. Re-fetching solely to enlarge evidence would have violated the one-homepage-fetch constraint.