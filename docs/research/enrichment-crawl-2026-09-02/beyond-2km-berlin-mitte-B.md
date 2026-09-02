# Berlin-Mitte slice B: depth-2 website-enrichment investigation

Final crawl: 1,428 venues, concurrency 10, 10 s request timeout, required research User-Agent, robots.txt honoured, homepage plus at most one selected menu page per venue, and a 2 MiB streamed-body ceiling. The final run took about 3.5 minutes. Counts below refer to the final `results.json` only.

## A. Yield of the new extractor

| Result | Venues | % of all 1,428 | % of 1,121 reachable |
|---|---:|---:|---:|
| Reachable, HTML/XML, parsed | 1,121 | 78.5% | 100.0% |
| Menu URL | 707 | 49.5% | 63.1% |
| Hours | 145 | 10.2% | 12.9% |
| Cuisine | 88 | 6.2% | 7.9% |
| Price level | 59 | 4.1% | 5.3% |
| Rating | 15 | 1.1% | 1.3% |
| Wheelchair value | 1 | 0.1% | 0.1% |
| Description | 226 | 15.8% | 20.2% |
| Reservation URL | 81 | 5.7% | 7.2% |
| Delivery URL | 86 | 6.0% | 7.7% |

The structured-fact results exercise the rewritten merge: food/business nodes are ranked and each field is taken from the first eligible node that supplies it ([website.ts:300](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:300)); hours combine `openingHours` and folded `openingHoursSpecification` ([website.ts:321](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:321)); navigation supplies menu, reservation, and delivery fallbacks ([website.ts:368](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:368)).

| Followed-menu outcome | Venues |
|---|---:|
| HTML/text | 586 |
| PDF | 59 |
| Other | 4 |
| None | 779 |

“None” comprises 721 venues with no selected menu URL and 58 whose selected URL did not produce a classifiable successful response. Of those 58, 46 exceeded 2 MiB. Dietary word evidence on successfully read HTML/text menu bodies was: vegan 173, vegetarian 161, gluten-free 33, lactose-free 17, and halal 10. These are mentions, not verified attributes, consistent with the function contract ([website.ts:270](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:270)); scripts, styles, and markup are removed before matching ([website.ts:271](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:271)). PDF dietary content cannot be determined by this crawl because PDFs were classified but not text-extracted.

Independent broad-vocabulary anchor discovery found candidates on 82 pages where `parseWebsite` selected no menu. Many are deliberate non-matches (maps, gift cards, privacy PDFs, food-product links, or JavaScript controls), not extractor misses.

## B. Remaining misses and false positives

### Top 10 actionable misses

Anchor snippets are capped at 200 characters. These are the clearest real menu candidates among the 82 broad-discovery disagreements.

| Venue | Page | Candidate anchor snippet | Proposed fix |
|---|---|---|---|
| Ungarisches Restaurant | https://www.ungarische-gaststaette.de/ | `Karten und Preise` → `/karten` | Add plural `karten` in the strong vocabulary at [website.ts:209](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:209). |
| Victoria Eis | https://viktoria-eis.de/ | `Eiskarte` → `https://eiskarten.de/viktoria-eis/#viktoria-eis/1` | Add food-specific compounds such as `eiskarte(n)?` at [website.ts:209](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:209). |
| Cafeteria im PTZ | https://cafeteria-im-ptz.de/ | `WOCHENSPEISEKARTE (31.08. - 04.09.2026) ALS PDF LADEN` → `…/speisekarte-2.pdf` | Accept `wochenspeisekarte`; this currently fails the letter-boundary helper ([website.ts:205](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:205)) and is then rejected by the PDF text guard ([website.ts:245](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:245)). |
| Bistro 125 | http://www.integral-berlin.de/integral/werkstatt/dienstleistungsangebote/Bistro-125-und-Kantine-49.php | `Frühstücks- und Imbiss-Flyer` → `…/Speisekarte_21x21_18_11_2025.pdf` | Extend breakfast morphology to `frühstücks…`, and let a strongly menu-like PDF path satisfy the guard at [website.ts:245](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:245). |
| Bertolini | https://www.bertolini-feinkost.de/ | `Speisenkarte` → `speisenkarte.html` | Add `speisenkarte(n)?` at [website.ts:209](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:209). |
| Pasta Laden | http://www.pastaladen.com/ | `Unsere Tageskarte` → `/Unsere-Tageskarte/` | Add `tageskarte(n)?` at [website.ts:209](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:209). |
| Werksküche | https://werkskueche.berlin/ | `Werksküche Speiseplan Kalenderwoche 36` → `/pdf/speiseplan/2026/36` | Add `speiseplan` at [website.ts:209](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:209). |
| Ratskeller | https://gerresheim-berlin.de/rathaus-schoeneberg-ratskeller | `Speiseplan als PDF` → `…/36-KW-2026-Rath.pdf` | Add `speiseplan`; because the URL is opaque, text scoring at [website.ts:237](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:237) is essential. |
| Pizzeria Capri | https://pizzeriacapri25.de/ | `PDF herunterladen` → `…/Speisekarte%20Capri%20PDF.pdf` | Permit a strong decoded PDF path to pass even when anchor text is merely “PDF”; path decoding/scoring already occurs at [website.ts:229](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:229), but the text-only PDF guard at [website.ts:245](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:245) discards it. |
| K-King Karaoke | https://www.kingkaraoke-berlin.de/ | `Menükarte` → `…/pdf24_bilder_zusammengefuegt-6-1.pdf` | Add `menükarte`/`menuekarte` at [website.ts:209](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:209), which also lets this opaque PDF pass the guard at [website.ts:245](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:245). |

### Random sample of 20 selected links

The deterministic random sample used seed `20260902`. Judgment uses only the selected URL and fetched page title, as requested; PDFs have no HTML title, so their descriptive URLs are the available evidence.

| Venue | Selected URL / fetched title | Judgment |
|---|---|---|
| Roma | `…/#speisekarte` — “Ristorante Pizzeria Roma…” | Plausible |
| Chen's Beef Noodle House | `…/#mobile-menu` — “Home - CHEN'S BEEF NOODLE HOUSE” | **False positive**: mobile-navigation control |
| Pho Viet Aroma | `…/#pva-speisekarte` — “Pho Viet Aroma…” | Plausible |
| Sushi For You | `…/speisekarte.pdf` | Plausible |
| Heno Heno | `…/speisen.html` — “Heno Heno Berlin” | Plausible |
| Straßenbräu | `…/pages/taproom#` — “Unser Tap Room…” | Plausible; likely same-page menu control |
| Yellow Pizza | malformed `…/%22https:////www.vytal.org///%22` — “Yellow Pizza” | **False positive**: escaped URL/JSON captured as an anchor |
| Atuka | `…/menu-in-2024.pdf` | Plausible |
| Hūftgold | `…/speisekarte/` — “Speisekarte…” | Plausible |
| Schweighofer's | `…/speisekarte/` — “Speisekarte…” | Plausible |
| Khánh Linh Quán | `…/menu` — PDF | Plausible |
| Vaust | `…/Menue/` — “…Menü” | Plausible |
| Mama Kalo | `…/index.php/menu` — “Menü” | Plausible |
| Kindl Stuben | `…/Speisekarte_Kindl-Stuben.pdf` | Plausible |
| Özen Köfteci | third-party `…#section-speisekarte` — “…Speisekarte” | Plausible |
| Chon Thong | Wix `_files/…pdf` | Plausible from venue link, but opaque URL makes content purpose uncertain |
| Jelänger Jelieber | `…/speisekarte` — restaurant title | Plausible |
| Tokio-Haus | `…/karte/SKindex.html` — “Speisenkarte” | Plausible |
| focaccino | `…/#speisekarte` — restaurant title | Plausible |
| Restaurant Bieberbau | `…/#menue` — restaurant title | Plausible |

Observed false-positive rate: **2/20 = 10%**. This is a small sample, so it is an indicator rather than a precise population estimate. The two patterns are (1) UI fragments containing `menu`, especially `#mobile-menu`, and (2) malformed/template-derived anchors. Add `mobile-menu`, `nav-menu`, and comparable UI tokens to the exclusion vocabulary at [website.ts:212](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:212), or explicitly reject those fragments before scoring at [website.ts:229](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:229). Harden anchor extraction at [website.ts:183](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:183) by rejecting hrefs containing quotes, backslashes, template braces, or escaped protocol syntax before URL resolution; extraction is regex-based and currently accepts such malformed values ([website.ts:185](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:185)). A fetched-title/content confirmation could further down-rank generic home pages, but the current fetch path only classifies response type and scans mentions, without validating menu identity ([website.ts:420](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:420)).

## C. What this slice adds

“Something a room can use” means at least one menu URL, hours value, dietary mention, reservation/delivery URL, or description. Overall, **809/1,428 (56.7%)** gained at least one such item: menu 707, hours 145, dietary mention 234, booking or delivery 158, and description 226. Categories overlap.

The three bands are equal-count distance thirds (476 venues each), based on the supplied `distanceM` values.

| Distance band | Menu | Hours | Dietary mention | Booking or delivery | Description | Any useful gain |
|---|---:|---:|---:|---:|---:|---:|
| 4,294–4,919 m | 234 (49.2%) | 56 (11.8%) | 80 (16.8%) | 55 (11.6%) | 79 (16.6%) | 270 (56.7%) |
| 4,920–5,634 m | 234 (49.2%) | 49 (10.3%) | 83 (17.4%) | 65 (13.7%) | 78 (16.4%) | 271 (56.9%) |
| 5,635–6,745 m | 239 (50.2%) | 40 (8.4%) | 71 (14.9%) | 38 (8.0%) | 69 (14.5%) | 268 (56.3%) |

Total usefulness is essentially flat by distance. Menu yield is also flat; hours, dietary evidence, descriptions, and especially booking/delivery links are somewhat lower in the farthest third. This crawl establishes association, not why the bands differ.

## D. Recommendations, ranked by expected gain

1. **Expand strong German menu compounds and `speiseplan`.** This directly repairs most of the clearest remaining misses: `karten`, `eiskarte`, `wochenspeisekarte`, `speisenkarte`, `tageskarte`, `menükarte`, and `speiseplan`. Implement in the strong vocabulary at [website.ts:209](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:209). Expected gain is highest because the pattern recurs across independent venues and often represents explicit navigation text.
2. **Revise the PDF guard to accept strong decoded paths.** The scorer already evaluates decoded paths ([website.ts:229](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:229)), yet the later guard requires menu-like anchor text ([website.ts:245](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:245)). Accept when either text is menu-like or the decoded final path segment is strongly menu-like; retain rejection for generic off-site PDFs. This recovers weekly menus and “PDF herunterladen” links without broadening all weak matches.
3. **Suppress UI/template false positives before scoring.** Reject navigation-control fragments (`mobile-menu`, `nav-menu`) and malformed hrefs with escaped quotes/backslashes/template syntax. Apply href sanitation in `extractAnchors` ([website.ts:183](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:183)) and UI-token exclusions alongside `NOT_MENU` ([website.ts:212](/home/alain/dev/webmcp-hackathon/apps/server/src/enrich/website.ts:212)). This mainly improves precision rather than gross yield, addressing both observed sample false positives.

## E. Residual uncertainty

- The live web is variable. A preliminary run immediately before the final run produced 1,106 reachable and 697 menu URLs versus 1,121 and 707 in the retained final run. Therefore single-run counts have transient network uncertainty; `results.json` and all reported statistics consistently use the final run.
- Forty-one venues were excluded by robots.txt. Five homepage bodies and 46 menu bodies exceeded 2 MiB. Seventeen homepage requests timed out; other failures included HTTP errors and TLS/certificate problems. Their extractable facts cannot be determined under this protocol.
- Menu dietary scanning covers HTML/XML/text only. Dietary content inside the 59 PDFs and 4 other-format responses cannot be determined without PDF/document extraction, which was outside the requested scan.
- The false-positive estimate is based on 20 selected links and URL/title evidence only. It does not establish whether every plausible page actually exposes a usable menu, and the opaque Chon Thong PDF remains uncertain without inspecting its contents.
- Broad anchor discovery is intentionally noisy. The 82 disagreements are not 82 false negatives: examples include map “Karte,” gift cards, privacy PDFs, food-shop products, delivery links deliberately excluded as menus, and non-fetchable JavaScript controls.

Artifacts: `crawl.mjs`, `results.json`, `summary.json`, and this report are all in `/tmp/codex-crawl2.t9dhS2/berlin-mitte-B/`; the repository was not modified.