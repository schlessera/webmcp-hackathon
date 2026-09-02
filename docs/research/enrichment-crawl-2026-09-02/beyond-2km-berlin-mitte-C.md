# Berlin Mitte slice C: depth-2 enrichment crawl

Run on 2026-09-02 over all 1,426 supplied venues, with concurrency 10, a 10 s request timeout, the specified research User-Agent, robots checks, a 2 MB body cap, and no more than one homepage plus one selected-menu fetch per venue. “Reachable” below means a successful HTML/XML homepage that reached `parseWebsite`, not merely any HTTP response. The implementation itself similarly only parses HTML/XML homepages (`apps/server/src/enrich/website.ts:397-400`).

## A. Yield

| Fact | Venues | % of all 1,426 | % of 1,108 reachable |
|---|---:|---:|---:|
| Reachable/parseable homepage | 1,108 | 77.7% | 100.0% |
| Menu URL | 720 | 50.5% | 65.0% |
| Hours | 126 | 8.8% | 11.4% |
| Cuisine | 107 | 7.5% | 9.7% |
| Price level | 61 | 4.3% | 5.5% |
| Rating | 5 | 0.4% | 0.5% |
| Wheelchair | 0 | 0.0% | 0.0% |
| Description | 213 | 14.9% | 19.2% |
| Reservation URL | 43 | 3.0% | 3.9% |
| Delivery URL | 64 | 4.5% | 5.8% |

The fact semantics follow the extractor: facts are taken field-by-field from ranked food/business JSON-LD nodes (`apps/server/src/enrich/website.ts:301-316`); opening-hours specifications are folded into strings (`apps/server/src/enrich/website.ts:141-155`, `apps/server/src/enrich/website.ts:323-330`); navigation supplies a menu, reservation, and delivery URL when markup does not (`apps/server/src/enrich/website.ts:371-375`). Zero wheelchair results means no supported `amenityFeature` value was extracted in this slice; it does **not** establish that no venue is accessible, because only wheelchair/accessibility-named features with boolean-like values are accepted (`apps/server/src/enrich/website.ts:343-354`).

| Selected-menu outcome | Count | % of selected 720 |
|---|---:|---:|
| HTML/text | 597 | 82.9% |
| PDF | 103 | 14.3% |
| Other | 5 | 0.7% |
| No kind determined (failed, blocked, oversized, or non-success response) | 15 | 2.1% |
| No menu URL selected | 706 | — |

The resulting all-venue `menuKind` split in `summary.json` is HTML 597, PDF 103, other 5, none 721; “none” combines 706 venues without a selected URL and 15 selected links whose kind could not be established. This matches the extractor’s behavior of assigning kinds only after a successful follow and silently retaining homepage facts when follow-up fails (`apps/server/src/enrich/website.ts:423-442`).

Menu-page dietary mentions were: vegetarian 160, vegan 111, gluten-free 19, lactose-free 10, and halal 5. There were 205 venues with at least one mention (categories overlap). These are word-level evidence, not verified dietary claims: the scanner strips scripts/styles/tags and tests its five expressions (`apps/server/src/enrich/website.ts:262-276`). PDF contents were not text-extracted, so PDF dietary yield cannot be determined.

Independent broad anchor discovery found 81 records with at least one vocabulary candidate but no chosen menu URL. Many are deliberate noise (for example franchise PDFs, postcards, customer/gift cards, and news PDFs), but the genuine misses below expose a systematic vocabulary gap.

## B. Remaining misses and false positives

### Top 10 genuine misses

Each snippet is under 200 characters. All ten are caused by `MENU_STRONG` lacking common compounds or the umlaut plural (`apps/server/src/enrich/website.ts:205-210`); the scorer consequently reaches `score === 0` and discards the link (`apps/server/src/enrich/website.ts:236-246`).

| Venue | Homepage | Anchor snippet | Proposed fix |
|---|---|---|---|
| Sonnenschein Café & Restaurant | `https://www.cafe-sonnenschein-berlin.de/` | `Wochenkarte => /wochenkarte/` | Add `wochenkarte` to the strong vocabulary at line 209. |
| Burgerhelden | `https://www.die-burger-helden.de/home.html` | `Menüs => /berlin/burgermenues/` | Extend `menü`/`menue` to accept plural `s` at line 209. |
| Asia Time | `https://asiatime-berlin.de/` | `Speisenkarte => …/uploads/2026/05/Menue-2026.pdf` | Add the widely used `speisenkarte` spelling at line 209. |
| Funa Sushi Pankow | `https://funasushi.de/` | `Sushi Menüs => https://funasushi.simplywebshop.de` | Accept `menüs`; retain the existing platform exclusions at line 228. |
| Restaurant Split | `http://split-berlin.de/` | `Speisenkarte Kroatische & internationale Spezialitäten => karten/Speisenkarte-Normal.pdf` | Add `speisenkarte`; the existing PDF safeguard at line 245 will still require menu-like text. |
| Trattoria Siciliana | `https://www.trattoria-siciliana-berlin.de/trattoria-siciliana-berlin.de/index.html` | `Speisenkarte => images/pdf/Speisenkarte.pdf` | Add `speisenkarte` at line 209. |
| Heuriger Nußbaumerin | `https://nussbaumerin.de/` | `Speisenkarte => …/uploads/2026/01/Speisekarte-Januar-2026.pdf` | Add `speisenkarte` at line 209. |
| LIEBO | `https://www.cafeliebo.de/` | `Menükarte => …e9fdc75e08b74227a16becfde7a6d…` | Add `menükarte` and ASCII `menuekarte` at line 209. |
| Royal Gourmet Chinarestaurant | `https://www.royalgourmet.de/` | `Menükarte => https://www.royalgourmet.de/menuekarte/` | Add both compound spellings at line 209. |
| Reuter Terrassen | `https://www.reuter-terrassen.de/` | `Menükarte => menuekarte.html` | Add both compound spellings at line 209. |

Across all 81 broad-candidate/no-choice records, 25 records contained at least one of `Wochenkarte`, `Speisenkarte`, `Menükarte`, or `Menüs`. That is the observed upper bound for the immediate vocabulary fix; a few may be duplicate venues or non-current menus, so exact post-fix gain cannot be determined without rerunning the modified extractor.

### Reproducible random sample of 20 chosen links

The sample was shuffled with a fixed xorshift seed (`0x5eed2026`) from all 720 selected links. Judgement uses only final URL and returned page title, exactly as requested; generic titles/fragments are marked plausible where the URL or page context remains menu-like, but their actual visible content cannot be proven from this audit method.

| Venue | Selected URL / title cue | Judgement |
|---|---|---|
| Co.me.in | `/speisekarte/`; “Speisekarte - CO.ME.IN…” | Plausible |
| Call a Pizza (Niederschöneweide) | location URL with order-action query; location title | Plausible |
| Ayo | `/table-reservation`; “Online Food Delivery Application” | **False positive: reservation page** |
| SüdOstAsien | `/restaurant-menu/`; “Restaurant Menu” | Plausible |
| Café Wetterstein | `#!/speisekarte`; venue title | Plausible |
| Epavlis | `/speisekarte`; title says Speisekarte | Plausible |
| Marende | same-page section; venue title | Plausible, not provable from title |
| Bella Vista | `Speisekarte.pdf`; PDF | Plausible |
| Kashana | `/speisekarte/`; title says Speisekarte | Plausible |
| Ristorante Rossosiena | `/speisen`; title says Speisekarte | Plausible |
| Yoko Sushi | `#grve-hidden-menu`; venue title | Plausible |
| Gallo Nero | same-page `#`; venue title | Plausible, not provable from title |
| Dana Pani | `/karte.php`; “Fischgerichte bestellen” | Plausible |
| Bohnenranke | `#menu`; venue title | Plausible |
| Nam Kio | same-page section; venue title | Plausible, not provable from title |
| Charlotte | `/speisekarte/`; title says Speisekarte | Plausible |
| Das Pi | `#cat5`; “Essen online bestellen” | Plausible |
| Call a Pizza | `/bestellen`; ordering title | Plausible |
| Burger City | homepage; “Berlin Helal Burger Essen” | Plausible, not provable from title |
| Weichardts Hofladen | `slowfood.de`; “Slow Food Deutschland” | **False positive: external organization homepage** |

Observed false-positive rate: **2/20 = 10%**. With only 20 observations, this is descriptive rather than a precise population estimate. The Ayo case comes from a structured `menu`/`hasMenu` URL being accepted without semantic URL validation (`apps/server/src/enrich/website.ts:356-363`). The Slow Food case comes from weak word scoring plus no penalty for a third-party host: weak text earns 2 points and same-host merely adds 1 (`apps/server/src/enrich/website.ts:239-246`). Fixes: reject or separately classify structured menu URLs whose path clearly indicates reservation; and require strong menu evidence for unrelated external hosts (or impose an external-host penalty). A post-fetch title/redirect sanity check could flag both, while the current follow-up only classifies MIME kind and scans mentions (`apps/server/src/enrich/website.ts:423-442`).

## C. What this slice adds

“Something a room can use” means at least one of: menu URL, hours, menu dietary mention, reservation/delivery URL, or description. Counts overlap across columns. The three bands are equal-count distance tertiles defined from this slice, not city-planning zones.

| Distance from demo centre | Venues | Reachable | Menu | Hours | Dietary mention | Booking or delivery | Description | Any useful gain |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 6,751–9,224 m | 475 | 371 | 236 | 42 | 82 | 40 | 64 | 254 (53.5%) |
| 9,225–13,054 m | 475 | 359 | 239 | 36 | 55 | 38 | 69 | 269 (56.6%) |
| 13,055–26,562 m | 476 | 378 | 245 | 48 | 68 | 29 | 80 | 274 (57.6%) |
| **All** | **1,426** | **1,108** | **720** | **126** | **205** | **107** | **213** | **797 (55.9%)** |

Useful yield does not decline with distance in this slice: “any” rises modestly from 53.5% to 57.6%, menu yield from 49.7% to 51.5%, and description yield from 13.5% to 16.8%. Booking/delivery falls from 8.4% to 6.1%. These are descriptive associations only; venue mix, chain duplication, and website quality were not controlled.

## D. Recommendations, ranked by expected gain

1. **Expand the strong menu vocabulary.** Add `speisenkarte`, `wochenkarte`, `menükarte`, `menuekarte`, `menüs`, and `menues` to the expression at `apps/server/src/enrich/website.ts:209`. It addresses up to 25 of the 81 observed broad-candidate misses, the largest directly measured opportunity, while the PDF text safeguard remains at `apps/server/src/enrich/website.ts:245`.

2. **Recognize common German ordering providers as delivery rather than losing them or treating them as generic menus.** The fixed allowlist currently covers only the hosts at `apps/server/src/enrich/website.ts:214-215`, and platform extraction is exact-host-regex based (`apps/server/src/enrich/website.ts:251-257`). This slice exposed `online-karte.com`, `foodmato.com`, `simplywebshop.de`, `digibes.de`, `clickfood.de`, and `consumer.vectron.cloud` among unresolved broad candidates. Validate provider semantics first, then extend the delivery rules; exact gain cannot be determined from anchor URL/title alone.

3. **Add semantic validation for selected external/structured menu URLs.** Reject clear reservation paths from structured `menu`/`hasMenu` values and require strong evidence for unrelated external-host navigation links. This directly targets both false-positive patterns in the 20-link audit. The relevant acceptance paths are `apps/server/src/enrich/website.ts:356-363` and `apps/server/src/enrich/website.ts:220-248`; optional post-fetch validation belongs alongside `apps/server/src/enrich/website.ts:423-442`.

## E. Residual uncertainty

- Network results are a single run: transient failures, bot defenses, geolocation, redirects, and content changes can alter yield. The crawler honored decisions made by the extractor’s minimal robots model, which considers only the `*` group and prefix-style `Disallow` rules (`apps/server/src/enrich/website.ts:53-72`); it does not implement the full robots standard.
- The false-positive audit uses URL and page title, not rendered-page inspection. Four plausible generic-title/fragment cases cannot be conclusively validated; therefore 10% is the clear-error rate, not a guaranteed full-error rate.
- `scanMenuMentions` operates on HTML/text only (`apps/server/src/enrich/website.ts:270-276`). Dietary information inside the 103 PDFs, images, client-rendered applications, or menu content loaded after JavaScript execution cannot be determined.
- Broad-anchor discovery is intentionally over-inclusive. Its 81 misses include obvious non-menu uses of “card,” “food,” and “PDF”; only the listed recurring genuine patterns should drive a vocabulary change.
- Distance-band comparisons are unadjusted and do not prove distance causes the observed differences.