# Berlin Mitte B: depth-2 website investigation

Scope: all 377 records in `venues.json`; run 2026-09-02 with concurrency 8, a 12 s request timeout, the required user agent, robots.txt checks, a 2 MB body ceiling, and no more than one homepage plus one selected menu fetch per venue. Percentages below use all 377 venues unless another denominator is stated.

## A. Coverage

| Measure | Count | Share |
|---|---:|---:|
| Venues in slice | 377 | 100.0% |
| robots.txt disallowed | 6 | 1.6% |
| Homepage HTTP response received | 338 | 89.7% |
| Homepage HTTP 200 | 309 | 82.0% |
| Homepage parsed as HTML/text | 337 | 89.4% |
| Any parsed JSON-LD type | 147 | 39.0% (43.6% of parsed pages) |
| `parseWebsite` cuisine | 32 | 8.5% |
| `parseWebsite` price level | 23 | 6.1% |
| `parseWebsite` hours | 21 | 5.6% |
| `parseWebsite` rating | 6 | 1.6% |
| `parseWebsite` wheelchair value | 0 | 0.0% |
| `parseWebsite` menu URL | 177 | 46.9% |
| Any survey menu-pattern link | 234 | 62.1% |
| Menu response received | 233 | 61.8% |

Homepage statuses were 309 × 200, 7 × 403, 15 × 404, 1 × 410, 2 × 429, 4 × 500, and 39 without an HTTP response. Builder hints were WordPress 134, Shopify 17, Webflow 16, Wix 15, TYPO3 11, Squarespace 8, Jimdo 7, Joomla 3, Drupal 2, and Weebly 1. These are markup hints, not definitive CMS identifications; a page may count for more than one hint.

The parser extracts only the selected venue node after collecting JSON-LD blocks ([website.ts:121](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:121), [website.ts:133](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:133)). Its current field reads are cuisine/price/hours/rating ([website.ts:139](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:139)), accessibility ([website.ts:154](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:154)), and menu/reservation/description ([website.ts:161](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:161)).

## B. Top 10 concrete extractor gaps

Snippets are whitespace-normalized and capped at 200 characters.

1. **Brauhaus Georgbräu — https://www.georgbraeu.de/**  
   Snippet: `"url":"https://www.georgbraeu.de","telephone":"+49 30 24 24 244","openingHoursSpecification":[{"@type":"OpeningHoursSpecification","dayOfWeek":"Tuesday","opens":"12:00","closes":"23:59:59"}`  
   Miss: no hours returned. The parser reads only `openingHours`, not `openingHoursSpecification` ([website.ts:143](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:143)). Fix: handle `openingHoursSpecification[]`, formatting `dayOfWeek`, `opens`, and `closes` into raw hour strings.

2. **+84 Vietnamese Vegan Kitchen — https://www.plus84-berlin.com/**  
   Snippet: `"url":"https://www.plus84-berlin.com","telephone":"+ +493040751791","openingHoursSpecification":[{"@type":"OpeningHoursSpecification","dayOfWeek":"Sunday","opens":"12:30","closes":"23:00"}`  
   Miss and fix: same structured-hours gap at [website.ts:143](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:143). This is a separate concrete page and confirms the issue is not site-specific.

3. **Ça Va Sàigòn Bánh Mì — https://www.cavasaigon.de/**  
   Snippet: `"https://www.tiktok.com/@ca.va.saigon.banh.mi" ], "openingHoursSpecification": [ { "@type": "OpeningHoursSpecification", "dayOfWeek": ["Monday", "Wednesday"`  
   Miss: no hours despite the array-shaped `dayOfWeek`. Extend the same handler at [website.ts:143](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:143) to accept either a string or array for `dayOfWeek`.

4. **Mensa HfS “Ernst Busch” — https://www.stw.berlin/mensen/einrichtungen/mensa-hfs-ernst-busch.html**  
   Snippet: `"menu":"/assets/speiseplaene/533/aktuelle_woche_de.pdf","hasMenu":{"@id":"/#menu-533-2026-09-02"}`  
   Miss: the parser returned the `hasMenu` fragment instead of the directly downloadable PDF because it always prefers `hasMenu` to `menu` ([website.ts:161](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:161)). Fix: collect both URLs and prefer a concrete HTTP/PDF URL over a same-page `#` identifier.

5. **Mama Vân — http://www.mamavan.de/**  
   Snippet: `"hasMenu":{"@type":"Menu","name":"Speisekarte Mama Vân – Sài Gòn Deli","hasMenuSection":[{"@type":"MenuSection","name":"Bánh Mì"`  
   Miss: inline schema.org `Menu` objects have no `url`/`@id`, so `firstUrl` cannot represent them ([website.ts:91](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:91)); the eventual `#themenu` came only from fallback markup. Fix: when `hasMenu`/`menu` is a `Menu` object without a URL, mark an inline-menu fact or retain the page URL, and traverse `hasMenuSection` for future menu facts.

6. **Zur Gerichtslaube — https://www.gerichtslaube.de/**  
   Snippet: `menu-item menu-item-type-post_type menu-item-object-page menu-item-34"> Speisen &#038; Getränke`  
   Miss: `/speisen-getraenke/` was found by the survey but not by `parseWebsite`. Its fallback tests only the href and a narrow vocabulary ([website.ts:169](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:169)). Fix: parse anchors and test decoded href plus text with `/(?:menu|menü|speise(?:n|karte)|getr(?:ä|ae)nke|drinks?|food|essen|mittag|lunch|dinner|\.pdf)/iu`.

7. **Tudo — https://tudo.berlin/**  
   Snippet: `menu-item menu-item-type-post_type menu-item-object-page menu-item-92"> DRINKS`  
   Miss: `/drinks/` is outside the fallback vocabulary at [website.ts:171](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:171). Fix: add `drinks?` and inspect anchor text as in item 6.

8. **Yumcha Heroes — https://www.yumchaheroes.com/**  
   Snippet: `data-framer-name="Button" name="Button"> Menu`  
   Miss: the link points to `/food`; “Menu” exists only as anchor text, which [website.ts:171](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:171) ignores. Fix: extract the complete anchor and test normalized text as well as href.

9. **weingrün — https://rotisserie-weingruen.de/**  
   Snippet: `role="button" data-button-size="medium" data-button-type="primary"> ZUR SPEISEKARTE`  
   Miss: `/kulinarik` has no current href keyword although its link text is explicit. Apply the anchor-text fix at [website.ts:169](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:169)-[172](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:172).

10. **eleven — https://www.elevenbar.de/**  
    Snippet: `menu-item menu-item-type-post_type menu-item-object-page menu-item-522"> Speisen und Getränke`  
    Miss: `/speisen-und-getraenke/` is not covered by the current href regex ([website.ts:171](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:171)). Fix: add `speisen` and ASCII `getraenke`, preferably through decoded href-and-text matching as in item 6.

Two suspected shapes are **not** gaps here: `@type` arrays are normalized by `typesOf` ([website.ts:89](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:89)), and direct/nested `@graph` arrays are recursively flattened by `nodesOf` ([website.ts:79](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:79)). The observed gaps are `openingHoursSpecification`, inline/nested `Menu` semantics, URL preference, and link vocabulary/text handling.

## C. What menus and platform links are

Of the 233 menu responses:

| Menu response class | Count | Share |
|---|---:|---:|
| HTML/text on the same host | 194 | 83.3% |
| PDF on the same host | 29 | 12.4% |
| Image-only on the same host | 0 | 0.0% |
| Third-party host | 10 | 4.3% |

The third-party destinations were `cdn5.site-media.eu` (2), `cdn.prod.website-files.com` (2), `www.fiveguys.de` (2), and one each on `mylightspeed.app`, `www.top10berlin.de`, `www.opentable.de`, `onecdn.io`, and `order.storekit.com`. “Third-party” means host differs from the final homepage host; it does not prove independent platform ownership, and CDN-hosted files are included.

Dietary markers occurred on 104 of all 233 returned menu pages (44.6%). Under the required rule, marker counting was possible only for HTML/text responses: 104 of 196 inspectable text menus (53.1%) had at least one marker. The remaining 37 non-text responses, including PDFs, were not text-extracted, so whether they contain dietary markers cannot be determined from this crawl.

Reservation platform links, counted once per venue/platform, were OpenTable 14, TheFork 4, SevenRooms 3, Tock 2, and Quandoo 1; Resy was 0. Delivery platform links were Wolt 20, Lieferando 14, and Uber Eats 8; DoorDash, Deliveroo, and Grubhub were 0. Counts are linked venues, not bookings/orders and not necessarily unique businesses (the slice contains repeated brand/location records).

The parser itself does not inspect arbitrary platform anchors: its only reservation extraction is `acceptsReservations` from the selected JSON-LD venue and only when that value resolves to an HTTP URL ([website.ts:163](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:163)). This explains the large difference between 3 parser reservation URLs and 24 venue/platform reservation-link occurrences.

## D. Recommendations ranked by expected gain for a room

1. **Replace the fallback regex with real anchor extraction and bilingual href-plus-text matching.** Expected gain: up to 57 additional menu-bearing venues in this slice (234 survey detections versus 177 parser menu URLs), though some require false-positive filtering. Normalize entities/umlauts and use token boundaries so `essen` does not match `Adressen`; rank same-host, explicit “Speisekarte/Menu,” and PDF links above broad `food/drinks` links. This directly replaces the narrow href-only fallback at [website.ts:169](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:169)-[172](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:172).

2. **Support `openingHoursSpecification`.** At least the concrete pages in gaps 1–3, and many more retained evidence records, publish hours this way while the extractor reads only `openingHours` ([website.ts:143](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:143)). Normalize string/array `dayOfWeek` plus `opens`/`closes`; preserve raw values to match the current `WebFacts.hours` contract.

3. **Score all candidate venue/menu nodes instead of taking the first food node and first URL.** The extractor currently selects `typed[0] ?? business[0]` ([website.ts:133](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:133)-[136](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:136)) and gives `hasMenu` unconditional priority ([website.ts:161](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:161)). Prefer nodes matching the page URL/name, merge non-conflicting facts, and rank concrete menu URLs/PDFs over fragment identifiers or inline `Menu` objects.

## E. Residual uncertainty

- This is one geographic half-slice, not all Berlin or all Spokes cities; results should not be generalized without another slice.
- Network state is a single observation. The 39 no-response cases, 29 non-200 responses, redirects, bot defenses, and six robots exclusions may change.
- The broad survey vocabulary deliberately maximized recall. It produced some obvious non-menu candidates (for example `essen` inside “Adressen,” generic `food`, unrelated PDFs, or navigation “Menu”), so 234 is an upper-bound discovery count, not 234 confirmed restaurant menus.
- Only the first ranked menu candidate was fetched. A wrong first candidate can misclassify a venue even when a later link is the true menu.
- Builder detection is regex-based and can be triggered by migrated assets or embedded widgets.
- Image-only classification is based on response content type; no OCR or visual inspection was performed. PDFs and other non-text bodies were measured but not parsed, so their dietary content cannot be determined.
- Platform counts describe homepage links present at crawl time. They do not establish that ordering/reservation is currently available, nor that an unlinked platform relationship does not exist.