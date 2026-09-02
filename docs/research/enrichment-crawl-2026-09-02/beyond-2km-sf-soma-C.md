# San Francisco outer slice C: website-enrichment investigation

Run date: 2026-09-02. Population: all 349 venues in the supplied slice, 4,896–11,074 m from the demo centre. The crawl used concurrency 10, a 10 s per-request timeout, the requested `spokes-research/0.3` user agent, the repository's `robotsAllows`, a streaming 2 MB body ceiling, and at most one homepage plus the menu link chosen by `parseWebsite` per venue. Robots files were fetched separately and cached per origin. Counts are venues, not links.

## A. Yield of the new extractor at depth 2

| Extracted result | Venues | Share of 349 |
|---|---:|---:|
| Reachable 2xx HTML homepage parsed | 253 | 72.5% |
| Menu URL | 175 | 50.1% |
| Hours | 56 | 16.0% |
| Cuisine | 35 | 10.0% |
| Price level | 27 | 7.7% |
| Rating | 2 | 0.6% |
| Wheelchair fact | 0 | 0.0% |
| Description | 38 | 10.9% |
| Reservation URL | 18 | 5.2% |
| Delivery URL | 22 | 6.3% |

The full homepage-status distribution was 250 HTTP 200, 4 HTTP 202, 1 HTTP 401, 23 HTTP 403, 5 HTTP 404, 14 HTTP 429, 4 HTTP 500, and 48 with no status. One 2xx response was not parsed as HTML, hence 253 reachable/parsed versus 254 total 2xx responses. Three bodies crossed 2 MB and were skipped: Star India, Seafood Station, and Donairo’s Pizza.

The current extractor collects JSON-LD recursively and indexes `@id` nodes (`website.ts` lines 102–143, 285–298), merges each field across ranked food/business nodes (`website.ts` lines 300–312), and folds `openingHoursSpecification` into hours (`website.ts` lines 150–165, 321–327). These are descriptions of the measured implementation, not re-reported gaps.

| Followed-menu classification | Venues | Share of 349 |
|---|---:|---:|
| HTML/text | 163 | 46.7% |
| PDF | 9 | 2.6% |
| Other | 2 | 0.6% |
| None | 175 | 50.1% |

“None” includes 174 venues with no menu URL and one chosen menu that could not be classified after following. The implementation assigns PDF, other, and HTML from response content type (`website.ts` lines 433–445); it does not inspect PDF text.

| Menu-page mention | Venues |
|---|---:|
| Vegetarian options | 38 |
| Vegan options | 32 |
| Gluten-free options | 25 |
| Halal options | 4 |
| Lactose/dairy-free options | 3 |

These are word mentions, not verified accommodation claims; that evidentiary scope is explicit in the result type and scanner (`website.ts` lines 39–41, 262–277).

Independent broad anchor discovery found a candidate while `parseWebsite` chose none for 6 venues (1.7%).

## B. Remaining misses and false positives

Only six records met the requested miss condition, so a top 10 cannot be produced. Moreover, four are broad-matcher noise rather than extractor misses. Snippets below are under 200 characters.

| # | Venue and homepage | Broad anchor snippet | Assessment and proposed fix |
|---:|---|---|---|
| 1 | Oishinbo Sushi — `https://oishinbosushi.menu11.com/` | `text="Home" href="https://oishinbosushi.menu11.com"` | False discovery: “menu” occurs only in the provider hostname. No extractor fix; its word-boundary/path scoring correctly chooses none (`website.ts` lines 207–210, 229–243). Exclude hostname from the audit matcher. |
| 2 | The Food Pavillion — `https://www.thegrandpavilionsf.org/` | `text="ENTER" href="https://project-food-pavilion-events-hub-342.magicpatterns.app/"` | False discovery: “food” is project/brand text in a hostname, not menu navigation. No extractor fix; continue scoring pathname and visible text only (`website.ts` lines 229–243). |
| 3 | BB Tea — `https://kwickmenu.com/` | `text="KwickMENU" href="https://www.kwickmenu.com/"` | False discovery: provider brand/home link. No extractor fix; the boundary-aware matcher avoids matching embedded `MENU` (`website.ts` lines 205–210). |
| 4 | Lion West Portal — `https://lionwestportal.com/` | `text="" href="//img1.wsimg.com/.../New.pdf"` | Plausible miss, but menu identity cannot be determined from an empty label and opaque PDF URL. Extract `aria-label`, `title`, and image `alt` while building anchor text (`website.ts` lines 182–193), then retain the safety rule that unlabeled PDFs are rejected (`website.ts` line 245). |
| 5 | grubbin' — `https://grubbinsf.com/` | `text="Uber Eats" href="https://www.ubereats.com/san-francisco/food-delivery/grubbin/..."` | False discovery: delivery link. No fix; reservation/delivery hosts are intentionally excluded from menu selection (`website.ts` lines 214–215, 228) and separately captured as platforms (`website.ts` lines 251–257, 371–373). |
| 6 | Venice Pizza — `https://venicesfpizza.com/` | `text="Menu" href="https://venicesfpizza.com/shop/"` | Confirmed selection miss: strong visible text is vetoed because `shop` appears in the path. Let strong visible menu text override a path-only `NOT_MENU` match, while retaining text-level negatives (`website.ts` lines 212, 235–246). |

### Random sample of 20 chosen links

The sample was selected by an unseeded cryptographic shuffle of the 175 chosen links. Judgment uses only chosen/final URL and fetched page title as requested.

| Venue | Target/title evidence | Judgment |
|---|---|---|
| Shoshin Sushi | `/Gallery#scroll-161566`; title “Gallery - Shoshin Sushi” | False positive |
| Papa John's | `/order/viewStoreMenu/...`; redirected to `papajohns.de`, title “Startseite - Papa John's” | False/invalid final target |
| Subway | `/en-us/menunutrition/menu`; “Our Menu” | Plausible |
| Cantina Los Mayos | Wix PDF target | Plausible |
| Balompié Cafe No. 3 | `/team`; title “Menu” | Plausible |
| Jijime | `/menu-1`; title “Menu” | Plausible |
| La Playa Taqueria | nominal menu URL redirects to `/locations/`; title “Online Ordering \| Locations” | False/invalid final target |
| Submarine Center | `/submarine-sandwiches`; product title | Plausible |
| Unwine'd | `/food-menu`; “Food Menu” | Plausible |
| Masala Dosa | online-ordering branch, no title | Plausible, but uncertain |
| Subway | `/en-us/menunutrition/menu`; “Our Menu” | Plausible |
| The Coffee Movement | `/menu`; “Menu” | Plausible |
| Breakfast at Tiffany's | `/menu`; “Menu” | Plausible |
| The Den By Craftsman And Wolves | `/food-menu`; “Food Menu” | Plausible |
| Butter Love | `/pie-menu.html`; “pie menu” | Plausible |
| Ghien Banh Mi | `/menu`; “Menu” | Plausible |
| Twin Peaks Pizza | `/menu`; “Menu” | Plausible |
| Hummus Bodega | `/food-menu/`; “Menu” | Plausible |
| Pinhole Coffee | Wix PDF target | Plausible |
| Ike's Love and Sandwiches | `/menu/`; “Menu” | Plausible |

Observed false-positive/invalid-target rate: **3/20 = 15%**. With only URL/title evidence, Masala Dosa cannot be determined confidently; counting it as false would make the rate 20%, so 15% is not a precision estimate. The true selection false positive was a generic weak “Food” link to a gallery: weak visible words receive two points plus a same-host point (`website.ts` lines 239–246). Require weak-text choices to have menu-like path/title corroboration, or reduce the same-host bonus for weak terms. The other two began as explicit “Menu” links but redirected to non-menu destinations. `followMenu` follows redirects and marks any HTML/text response as a menu without validating the final URL or title (`website.ts` lines 433–445); retain the homepage fact but suppress `menuKind`/mentions when a cross-country or clearly non-menu final title/path contradicts the selection.

## C. What this slice adds

Across all 349 venues, 186 (53.3%) yielded at least one room-usable item: menu link, hours, dietary mention, reservation/delivery link, or description. Individual gains were 175 menus, 56 hours, 63 venues with at least one dietary mention, 36 with booking or delivery (18 reservation, 22 delivery; overlap exists), and 38 descriptions.

Distance bands are equal-count terciles of this already distance-ordered slice; boundaries therefore describe this dataset rather than universal geographic thresholds.

| Distance from centre | N | Menu | Hours | Dietary mention | Booking/delivery | Description | Any usable gain |
|---|---:|---:|---:|---:|---:|---:|---:|
| 4,896–6,168 m | 117 | 63 (53.8%) | 20 (17.1%) | 20 (17.1%) | 23 (19.7%) | 15 (12.8%) | 67 (57.3%) |
| 6,171–7,830 m | 116 | 59 (50.9%) | 22 (19.0%) | 21 (18.1%) | 8 (6.9%) | 9 (7.8%) | 63 (54.3%) |
| 7,854–11,074 m | 116 | 53 (45.7%) | 14 (12.1%) | 22 (19.0%) | 5 (4.3%) | 14 (12.1%) | 56 (48.3%) |

Menu and overall yield decline modestly with distance; booking/delivery drops sharply. Dietary mention yield is essentially flat. This crawl establishes association only, not a causal distance effect.

## D. Recommendations ranked by expected gain

1. **Validate weak menu choices and followed redirects.** This targets the observed 15% random-sample problem and prevents dietary evidence from an unrelated destination. Tighten weak scoring at `website.ts` lines 239–246 and validate final URL/title before assigning HTML/mentions at lines 433–446. Expected gain is primarily correctness across as many as 175 selected links, not more coverage.
2. **Allow explicit visible “Menu” to override a path-only `shop` negative.** This recovers the one confirmed miss in the six-record audit while preserving text-level exclusions. Change the ordering/interaction of negatives and strong scoring at `website.ts` lines 235–246. Measured direct gain: 1/349 (0.3%).
3. **Use accessibility labels for otherwise empty anchors.** Add `aria-label`, `title`, and descendant image `alt` to extracted anchor text at `website.ts` lines 182–193, then score labeled PDFs under the existing rule at line 245. This may recover Lion West Portal and similar image/PDF navigation, but the exact gain cannot be determined without examining linked PDF content.

## E. Residual uncertainty

- This is a one-time crawl of one outer San Francisco slice. Forty-eight venues produced no HTTP status, while 23 returned 403 and 14 returned 429; their extractable yield cannot be determined.
- The repository's robots parser is intentionally minimal: it considers `*`-group `Disallow` prefixes but not `Allow`, full wildcard precedence, or agent-specific groups (`website.ts` lines 58–78). “Honoured robots” means consistent use of that exported function, not complete RFC 9309 interpretation.
- JavaScript-rendered content, image menus, and PDF text were not rendered/OCRed/extracted. Dietary content in the nine PDFs and menu identity of Lion West Portal's opaque PDFs cannot be determined.
- Page titles and URLs are enough to identify obvious mistakes, not to prove menu content. The 20-link assessment is a small random sample with an unseeded draw and no confidence-worthy precision.
- Mention scanning strips scripts, styles, and tags and applies five word patterns (`website.ts` lines 262–277). Mentions are evidence only and can occur in disclaimers or boilerplate.
- The three 2 MB skips are intentional coverage losses. Production uses a smaller 1.5 MB HTML slice and an 8 s timeout (`website.ts` lines 49–52, 409–418), so production yield may be lower than this requested research run.