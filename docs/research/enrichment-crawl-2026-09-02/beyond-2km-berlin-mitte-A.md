# Berlin Mitte slice A — depth-2 enrichment crawl

The crawl covered all 1,428 supplied venues, using concurrency 10, a 10 s request timeout, the specified research User-Agent, cached per-origin `robots.txt` checks, one homepage and at most one chosen menu-page request per venue, and a hard 2 MB body limit. Results are in `results.json`; aggregate counts are in `summary.json`. “Reachable” means a successful HTML/XML homepage response that was parsed.

## A. Yield of the new extractor

| Measure | Count | % of all 1,428 | % of 1,110 reachable |
|---|---:|---:|---:|
| Reachable | 1,110 | 77.7% | 100.0% |
| Menu URL found | 692 | 48.5% | 62.3% |
| Hours | 146 | 10.2% | 13.2% |
| Cuisine | 96 | 6.7% | 8.6% |
| Price level | 80 | 5.6% | 7.2% |
| Rating | 15 | 1.1% | 1.4% |
| Wheelchair | 4 | 0.3% | 0.4% |
| Description | 225 | 15.8% | 20.3% |
| Reservation URL | 60 | 4.2% | 5.4% |
| Delivery URL | 120 | 8.4% | 10.8% |

Menu-page outcomes were 592 HTML, 78 PDF, 3 other, and 755 none. “None” includes the 736 venues for which no menu URL was selected plus 19 selected links whose follow-up did not yield a classifiable successful body. This distinction is necessary because `menuKind` is only assigned after a successful menu response in the production fetch path (`apps/server/src/enrich/website.ts:427-448`).

Dietary mentions on fetched HTML/text menu pages were: vegan 181, vegetarian 168, gluten-free 37, lactose-free 13, and halal 21. These are word-presence evidence, not verified venue attributes, matching the extractor’s stated semantics and implementation (`apps/server/src/enrich/website.ts:262-276`).

Independent broad-vocabulary anchor discovery found at least one candidate on 69 parsed homepages where `parseWebsite` chose no menu. The extractor obtains navigation candidates with `extractAnchors` and delegates selection to `pickMenuLink` (`apps/server/src/enrich/website.ts:368-373`); that picker uses strong/weak token sets, exclusions, host preference and PDF safeguards (`apps/server/src/enrich/website.ts:205-248`).

## B. Remaining misses and false positives

### Ten high-confidence remaining misses

These are the most actionable genuine misses among the 69 broad-candidate records; the broader set also contains lexical collisions such as “Prüfungskartei”, “Anflugkarte”, “Superfoods”, and “Passwort vergessen”, which should remain rejected.

| Venue | Homepage | Anchor snippet (≤200 chars) | Proposed fix |
|---|---|---|---|
| Kantine | https://www.zander-catering.de/kantine | `Wochenkarte \| https://cdn1.site-media.eu/images/document/27700485/Tagesgericht2026-36WochePreise-…` | Add `wochenkarte` (and preferably `tagesgericht`) as strong compounds. Current strong words do not include them (`website.ts:209`), so the embedded `karte` is blocked by the intentional Unicode word boundaries (`website.ts:205-210`). |
| Suriya Kanthi | http://www.suriya-kanthi.de/ | `[empty text] \| speisekarte0.html` | Recognize a menu token followed by a small numeric variant in a path, e.g. `speisekarte\d*`. Current whole-token matching rejects the trailing `0` (`website.ts:207-210`, path scoring at `website.ts:229-243`). |
| Jolie | https://jolie-berlin.com/ | `DE \| #menuDE` / `EN \| #menuEN` | Recognize language-suffixed menu fragments such as `#menuDE` and `#menuEN`. Hashes are included in the scored path (`website.ts:229-233`), but whole-token matching rejects the attached language code (`website.ts:207-210`). |
| Anjoy | https://www.anjoy-restaurant.de/ | `Menu Kontakt \| #menu` | Apply `NOT_MENU` to the URL path independently, and treat excluded words in anchor text as a penalty rather than veto when the path is an exact strong match. The current early veto rejects the whole anchor because its combined mobile-nav text contains “Kontakt” (`website.ts:211-212`, `website.ts:235`). |
| Viet & My II | https://www.vietmyii-berlin.de/ | `Menükarte \| /` | Add `menükarte`/`menuekarte` as strong compounds. Neither is in the strong vocabulary (`website.ts:209`), and whole-token boundaries prevent `menü` or `karte` matching inside it (`website.ts:205-210`). |
| Why Not Kaffee Restaurant | https://www.whynotkaffee.de/ | `Menükarte \| /` | Same `menükarte` compound fix (`website.ts:205-210`). The root target is still useful here because the anchor itself explicitly labels the in-page menu. |
| Lecker Song | https://www.leckersong.de/ | `Menükarte \| /` | Same `menükarte` compound fix (`website.ts:205-210`). |
| Blue Nordic Coffee | https://www.nordischebotschaften.org/kantine-kaffebar-im-felleshus/ | `Speiseplan \| …/31082026SpeiseplanexterneGaeste.pdf` | Add `speiseplan` as a strong term. It is absent from both vocabularies (`website.ts:209-210`); once recognized in text, the PDF safeguard would permit it (`website.ts:245`). |
| Mitteleuropa | https://mitteleuropa-berlin.de/ | `Tageskarte \| https://mitteleuropa-berlin.de/tagesangebot/` | Add `tageskarte` and `tagesangebot` as strong terms. Current strong vocabulary has only standalone `karte` (`website.ts:209`) and weak vocabulary has lunch/midday variants but not these compounds (`website.ts:210`). |
| Swadishta | https://swadishta.de/ | `Order Online \| https://swadishta.online-karte.com` | Score decoded host labels as well as pathname/hash, with a modest third-party penalty. At present only pathname and hash are searched (`website.ts:229-243`), so `online-karte` in the hostname is invisible. Keep the existing reservation/delivery-host exclusions (`website.ts:214-215`, `website.ts:228`). |

### Fixed-seed random sample of 20 selected links

Judgment is deliberately limited to URL and returned page title, as requested. On that evidence, 19/20 are plausibly menus. One is a likely false positive: HOA’s `/home-a`, whose returned title is “Home | capheHOA_new”. Estimated false-positive rate: **1/20 = 5%**. It cannot be determined from URL/title alone whether a generic homepage contains an embedded menu, so this is a plausibility estimate, not ground truth.

| # | Venue | Selected URL (abridged where long) | Returned title/type | Judgment |
|---:|---|---|---|---|
| 1 | Prometeo | `/menu` | Prometeo — Authentische Pizzeria… | plausible |
| 2 | Alpenwirt | `/speisekarte` | Speisekarte | plausible |
| 3 | Le midi | `/mittags-und-abendkarte/` | Le Midi Mittagskarte | plausible |
| 4 | Woof Berlin | `/getraenke-karte-drink-menu/` | GETRÄNKE KARTE / DRINK MENU | plausible |
| 5 | Antichi Aromi | `/#speisekarte` | Antichi Aromi… | plausible embedded menu |
| 6 | Cantina Lubitsch | `/?c=SPEISEKARTE` | Cantina Lubitsch | plausible from query |
| 7 | SUUUD Brauerei | `…getraenkekarte…pdf` | PDF | plausible |
| 8 | Bornholm’s Gartenlokal | `/speisen/` | Speisen | plausible |
| 9 | Burger & Döner City | homepage | Burger City — Berlin Helal Burger Essen | plausible embedded menu, uncertain |
| 10 | HOA | `/home-a` | Home \| capheHOA_new | **likely false positive** |
| 11 | Lao Xiang | `/menus/` | LaoXiang — Menüs | plausible |
| 12 | Irma La Douce | `/speisekarte` | DINNER | plausible |
| 13 | Roji | `…Speisekarte…pdf` | PDF | plausible |
| 14 | papaya | `…Speisekate…pdf` | PDF | plausible |
| 15 | Cafe Amelie | `/general-6` | Menu \| Cafe Amelie | plausible |
| 16 | Suzette Crêperie | opaque `.pdf` | PDF | plausible from selected anchor/PDF, title unavailable |
| 17 | bagel coffee culture | `/en/menu` | Menu — Bagel Coffee Culture | plausible |
| 18 | Baraka | `/#menu` | Marokkanisches Restaurant… | plausible embedded menu |
| 19 | Van Hoa | `/#menu` | Van Hoa Restaurant… | plausible embedded menu |
| 20 | moa | `/getraenke/` | Getränke \| moa - café & bar | plausible |

The observed false-positive pattern is generic template navigation selecting a generic CMS route (`/home-a`). A practical fix is to penalize paths beginning with `home` unless anchor text is a strong menu term, extending the current negative vocabulary (`website.ts:211-212`) and scoring loop (`website.ts:220-247`). Generic same-page/homepage selections are the residual uncertain pattern; fetching succeeds, but URL/title alone cannot establish that the page actually exposes a menu.

## C. What this slice adds

“Something a room can use” is the union of: menu link, hours, any dietary mention, reservation or delivery link, or description. The bands are explicit fixed geographic bands, not equal-sized quantiles.

| Distance band | Venues | Reachable | Menu link | Hours | Dietary mention | Booking or delivery | Description | Any usable gain |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 2.0–<3.0 km | 445 | 355 | 230 | 46 | 87 | 55 | 68 | 250 (56.2%) |
| 3.0–<4.0 km | 756 | 591 | 364 | 80 | 124 | 91 | 127 | 408 (54.0%) |
| 4.0–4.3 km | 227 | 164 | 98 | 20 | 33 | 27 | 30 | 112 (49.3%) |
| **Total** | **1,428** | **1,110** | **692** | **146** | **244** | **173** | **225** | **770 (53.9%)** |

Yield declines modestly with distance: any usable gain falls from 56.2% in 2–3 km to 49.3% beyond 4 km. The middle band contributes the most absolute gains because it contains 756 venues. Counts overlap across columns; the “any” column is deduplicated.

## D. Recommendations ranked by expected gain

1. **Expand strong menu compounds and common variants.** Add `menükarte`, `menuekarte`, `wochenkarte`, `tageskarte`, `tagesangebot`, `speiseplan`, `tagesgericht`, plus controlled numeric/language suffixes. This directly addresses at least 8 of the 10 high-confidence misses above and fits the existing strong/weak vocabulary design (`website.ts:205-210`).
2. **Replace the global negative-text veto with field-aware scoring.** An exact strong URL/hash should survive a combined mobile-nav label such as “Menu Kontakt”; negative terms can remain a decisive rejection when they occur in the URL or when no strong signal exists. The current all-or-nothing veto is at `website.ts:235`, before positive scoring at `website.ts:236-246`.
3. **Add conservative hostname and generic-route handling.** Search decoded hostname labels for explicit menu compounds, while penalizing third-party hosts and `home*` routes unless reinforced by strong anchor text. Current scoring derives its searchable path only from pathname plus hash (`website.ts:229-243`) and otherwise gives same-host links a bonus (`website.ts:244`). This should recover hosted ordering/menu microsites while reducing the sampled CMS-home false positive.

## E. Residual uncertainty

- The 20-link audit is a reproducible fixed-seed sample (seed `0x5eed2026`) but is small: a 5% point estimate has wide sampling uncertainty.
- Per the requested method, plausibility was judged only from URL and title. PDF contents were not interpreted, and generic homepages or fragments may or may not expose a real menu; those cases cannot be determined conclusively here.
- Dietary counts measure literal words on successfully fetched HTML/text menu pages only. PDFs were classified but not text-extracted, so PDF dietary yield cannot be determined. This is consistent with `scanMenuMentions` operating on supplied text/HTML (`website.ts:270-276`) and the production follow-up returning immediately for PDFs (`website.ts:434-438`).
- Reachability is a single-crawl observation under a 10 s timeout. Transient failures, bot protection and JavaScript-only rendering can lower observed yield; no browser rendering was performed.
- `robotsAllows` implements only the `User-agent: *` group and prefix-style `Disallow` handling (`website.ts:58-77`). The crawl honored that function exactly, but this is not a full RFC-grade robots parser.
- Anchor extraction is regex-based and capped at 600 anchors (`website.ts:182-193`); links injected only after client-side JavaScript execution are not visible. Therefore the reported 69 misses and 692 chosen URLs are lower bounds relative to a rendered-browser crawl.