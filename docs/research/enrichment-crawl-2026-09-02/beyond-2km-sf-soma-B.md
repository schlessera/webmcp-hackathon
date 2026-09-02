# San Francisco SOMA slice B: depth-2 website enrichment survey

Survey run 2026-09-02 over all 350 supplied venues, with concurrency 10, a 10 s request timeout, the specified `spokes-research/0.3` user agent, cached per-origin robots checks, no more than one homepage and one selected menu-page fetch per venue, and a 2 MiB body limit. “Reachable” means a 2xx HTML/XML homepage that could be passed to `parseWebsite`; it does not mean merely that an HTTP server responded. The extractor recursively collects JSON-LD nodes and ranks food types before generic businesses (`website.ts:102-117`, `website.ts:300-312`), then supplements structured facts with navigation links (`website.ts:368-373`).

## A. Yield

| Measure | Venues | % of all 350 | % of 255 reachable |
|---|---:|---:|---:|
| Reachable/parseable homepage | 255 | 72.9% | 100.0% |
| Menu URL | 166 | 47.4% | 65.1% |
| Hours | 60 | 17.1% | 23.5% |
| Cuisine | 42 | 12.0% | 16.5% |
| Price level | 31 | 8.9% | 12.2% |
| Rating | 7 | 2.0% | 2.7% |
| Wheelchair | 0 | 0.0% | 0.0% |
| Description | 52 | 14.9% | 20.4% |
| Reservation URL | 33 | 9.4% | 12.9% |
| Delivery URL | 25 | 7.1% | 9.8% |

The hours count includes both `openingHours` and folded `openingHoursSpecification` values (`website.ts:150-165`, `website.ts:321-327`). Wheelchair data is deliberately narrow: it is emitted only from boolean-valued accessibility-like `amenityFeature` entries (`website.ts:338-348`). Price level accepts only one to four repeated currency symbols (`website.ts:80-84`, `website.ts:319-320`), and ratings are range-checked aggregate ratings (`website.ts:328-337`). Descriptions are clipped to one line of at most 220 characters (`website.ts:86-94`, `website.ts:361-366`).

| Selected-menu outcome | Count |
|---|---:|
| HTML/text | 158 |
| PDF | 5 |
| Other (image) | 1 |
| None | 186 |

“None” includes 184 venues with no chosen menu and two with a chosen URL but no classifiable response. The production follower classifies PDF, HTML/text, and other content using response content type (`website.ts:427-447`); this survey retained the raw status, type, and byte size separately. Menu-page word scanning found: vegan 36, vegetarian 36, gluten-free 32, lactose/dairy-free 5, and halal 2. These are mentions, not verified dietary claims, exactly as the extractor documents and implements (`website.ts:262-277`).

Independent broad anchor discovery found a candidate while `parseWebsite` chose none at 4 venues (1.1%). Only one of those four is a genuine menu miss.

## B. Remaining misses and false positives

### Candidate-without-selection records

There are only four records, so a truthful top 10 cannot be produced; the complete set is below. Snippets are under 200 characters.

| Venue | Homepage | Anchor snippet | Judgment and proposed fix |
|---|---|---|---|
| California Wine Merchant | `https://www.californiawinemerchant.com/` | `Wine Bar list → /s/2026-Q3-Menu-72026.pdf` | **True miss.** The URL path contains “Menu”, but a PDF is rejected unless its anchor text itself matches strong/weak vocabulary (`website.ts:237-245`). Add `wine list` / `wine bar list` to the strong vocabulary at `website.ts:209`, or permit a strong path match to satisfy the PDF guard at `website.ts:245`. The narrower vocabulary addition is safer. |
| La Palma Mexicatessen | `https://lapalmasf.com/` | `food@lapalmasf.com → mailto:food@lapalmasf.com` | Not a miss. Broad discovery intentionally overmatched an email; the selector correctly discards non-HTTP links during resolution (`website.ts:196-203`, `website.ts:223-225`). No extractor change. |
| Dumpling Kitchen | `https://dumplingkitchenca.com/` | `Privacy Policy → …Client+Website+Privacy+Policy.pdf` | Not a miss. Broad discovery overmatched “pdf”; the selector correctly rejects privacy paths/text via `NOT_MENU` (`website.ts:211-212`, `website.ts:235`). No change. |
| St. Francis Yacht Club | `https://www.stfyc.com/` | `Site by Clubessential → https://www.clubessential.com` | Not a miss. Broad discovery matched the substring “essen” inside “Clubessential”; the extractor’s Unicode word-boundary regex avoids substring matches (`website.ts:205-210`). No change. |

### Fixed-seed random sample of 20 chosen links

The sample was shuffled with seed `20260902`. Judgment uses only selected URL and returned page title as requested.

| Venue | Selected URL / title signal | Judgment |
|---|---|---|
| Super Duper Burgers | `/menus/` — “Menus …” | Plausible |
| Pizza Due | `/menu/` — “Menu …” | Plausible |
| Rosamunde Sausage Grill | `/food-menu` — “Food Menu” | Plausible |
| Restaurante Guatemalteco Ebenezer | venue-like path redirected to `/locations/` — “Online Ordering \| Locations” | **False positive**: location/ordering landing page, not a menu |
| Il Casaro Pizzeria | `/menu` — “North Beach Menu” | Plausible |
| Falasteen | `/menu` — “Menu” | Plausible |
| Bottega | PDF URL | Plausible |
| Buddy | `/menu` — “menu” | Plausible |
| The Laughing Monk | `/food-menu` — “Food Menu” | Plausible |
| Bean Bag Cafe | `/menu/95535591` — “Menu …” | Plausible |
| Pancake Boy | ordering-domain root — “Attention Required! \| Cloudflare” | **Cannot be determined** from URL/title; access was blocked |
| Paprika | `/our-menus-list` — “Explore Our Menus” | Plausible |
| World Wrapps | `/menu/` — “Menu …” | Plausible |
| Tacolicious | `/menus/` — “Menus …” | Plausible |
| A16 | `/san-francisco/menu` — “A16 San Francisco : Menu” | Plausible |
| Maria Isabel | `/menus` — “Food & Drinks” | Plausible |
| Greens Restaurant | `/menu` — “Menu” | Plausible |
| Primo Pizza | `/menu` — “Pizza Menu” | Plausible |
| Domino's | `/en/menu` redirected to `/en/pages/international/` — “Domino's Home Page …” | **False positive**: final page is a homepage, not a menu |
| Souvla | `/menus/` — “Menus …” | Plausible |

The observed false-positive rate is **2/19 determinable links = 10.5%** (or **2/20 = 10.0%** if the blocked case is conservatively retained in the denominator). The interval is necessarily noisy at n=20. Both false positives are redirect/landing-page failures: selection scores the original anchor text/path and same-host status (`website.ts:217-248`), while the follow step records menu kind and mentions but does not validate the final URL or title (`website.ts:427-447`). A practical fix is to reject or flag an HTML result when redirects remove all menu vocabulary and the title contains only location/home wording; retain ordering pages when their final URL/title still says menu. Separately, same-page fragments can be legitimate menus, so blanket rejection would lose true positives; the selector explicitly resolves and scores hashes (`website.ts:229-245`).

## C. What this slice adds

Distance bands are equal-width across the observed 3,122–4,889 m range (rounded boundaries), rather than equal-count quantiles. “Dietary” means at least one menu mention. “Booking/delivery” is the union, so it is smaller than the sum of the two individual yield rows. “Any usable gain” is the union of menu URL, hours, dietary mention, booking/delivery URL, and description.

| Distance from centre | Venues | Reachable | Menu | Hours | Dietary mention | Booking or delivery | Description | Any usable gain |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 3,122–3,710 m | 162 | 137 (84.6%) | 91 (56.2%) | 31 (19.1%) | 34 (21.0%) | 28 (17.3%) | 33 (20.4%) | 101 (62.3%) |
| 3,711–4,299 m | 94 | 63 (67.0%) | 40 (42.6%) | 17 (18.1%) | 19 (20.2%) | 20 (21.3%) | 13 (13.8%) | 49 (52.1%) |
| 4,300–4,889 m | 94 | 55 (58.5%) | 35 (37.2%) | 12 (12.8%) | 14 (14.9%) | 7 (7.4%) | 6 (6.4%) | 35 (37.2%) |
| **All** | **350** | **255 (72.9%)** | **166 (47.4%)** | **60 (17.1%)** | **67 (19.1%)** | **55 (15.7%)** | **52 (14.9%)** | **185 (52.9%)** |

The slice adds at least one room-usable item for 185 venues. Yield declines with distance mainly because homepage reachability falls from 84.6% to 58.5%; this survey cannot determine whether distance itself causes the decline or merely correlates with venue/site mix.

## D. Recommendations, ranked by expected gain

1. **Validate followed HTML against its final URL and title, and preserve a “suspect menu” state.** Expected gain is primarily precision: the random audit found two redirect/landing failures among 19 determinable choices. The current follower only checks status/content type and scans mentions (`website.ts:427-447`), so it cannot downgrade these. Avoid strict deletion because blocked pages and same-page menus remain uncertain.
2. **Add narrowly targeted beverage-list language, starting with `wine (bar) list`.** This recovers the sole confirmed broad-anchor miss in this slice. Add it to the strong vocabulary (`website.ts:209`) so the explicit-text PDF condition remains protective (`website.ts:245`). Do not add bare `list`, which would invite retail/event false positives.
3. **Expand platform recognition using evidence from future crawls, with ordering platforms classified deliberately.** Platform extraction is currently a fixed host allowlist (`website.ts:214-215`, `website.ts:251-257`) and navigation populates reservation/delivery URLs only from those lists (`website.ts:368-373`). Several selected menu URLs in the audit use ordering hosts; deciding whether such a link is a menu, delivery link, or both requires a product policy. Add hosts only after labeling them, because moving them into the delivery exclusion path would also stop menu selection (`website.ts:228`).

## E. Residual uncertainty

- Ninety-five venues were not parseable as reachable homepages. This includes robots denial, timeouts, DNS/TLS failures, non-2xx responses, invalid supplied URLs, and responses that were not usable HTML/XML; their true enrichment yield cannot be determined from this run.
- Twenty-eight homepages returned HTTP 429, making rate limiting a material part of the 72.9% reachability result. Retrying later could raise yield, but was outside the one-homepage-fetch constraint.
- Robots handling intentionally mirrors the extractor’s minimal `User-agent: *` prefix-based `Disallow` interpretation (`website.ts:58-78`, `website.ts:381-389`); it does not implement full RFC wildcard, `Allow`, or user-agent precedence semantics.
- Dietary counts are lexical evidence only and can include disclaimers or prose rather than actual dishes (`website.ts:260-277`). PDFs are classified but not text-extracted by the production follower (`website.ts:433-437`), so dietary mentions inside five fetched PDFs remain unknown.
- The false-positive audit is based only on URL/title, not visual or semantic inspection, and one sampled page was blocked. The 10.5% determinable rate should not be generalized tightly beyond this sample.
- The crawl saved no response bodies, so page changes cannot be replayed; `results.json` retains statuses, final URLs, full `parseWebsite` output, broad matching anchors, menu metadata, titles, sizes, and menu mentions. No web search was used.