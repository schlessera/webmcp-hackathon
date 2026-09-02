# San Francisco slice A: depth-2 website enrichment survey

Survey run 2026-09-02 over all 350 supplied venues, using concurrency 10, a 10 s request timeout, the required `spokes-research/0.3` user agent, robots checks, a 2 MiB body ceiling, and no more than one homepage plus one selected-menu fetch per venue. No web search was used. The repository was read-only; all outputs are in the requested temporary directory.

## A. Yield of the new extractor

| Signal | Venues | % of all 350 | % of 251 reachable |
|---|---:|---:|---:|
| Reachable HTML homepage | 251 | 71.7% | 100.0% |
| Menu URL | 168 | 48.0% | 66.9% |
| Hours | 48 | 13.7% | 19.1% |
| Cuisine | 43 | 12.3% | 17.1% |
| Price level | 31 | 8.9% | 12.4% |
| Rating | 7 | 2.0% | 2.8% |
| Wheelchair value | 0 | 0.0% | 0.0% |
| Description | 68 | 19.4% | 27.1% |
| Reservation URL | 40 | 11.4% | 15.9% |
| Delivery URL | 22 | 6.3% | 8.8% |

`parseWebsite` collects and ranks food/business JSON-LD nodes before taking the first available field (`website.ts:300-312`), folds both plain and specification-form hours (`website.ts:321-327`), extracts structured menu/reservation data (`website.ts:349-360`), then falls back to navigation links for menus and platforms (`website.ts:368-373`). These implementation facts explain what the table measures; no earlier known gap is re-reported.

Menu follow outcomes:

| Kind | Venues |
|---|---:|
| HTML/text | 151 |
| PDF | 5 |
| Other | 0 |
| None/no successful classified menu response | 194 |

Of the 168 selected menu URLs, 156 produced a classified body; 12 therefore retained the URL but had no successful classifiable follow result. Menu classification treats PDF separately, accepts HTML/XML/text for mention scanning, and otherwise records `other` (`website.ts:427-446`). “None” includes 182 venues with no selected URL and those 12 follow failures.

| Dietary mention | Venues |
|---|---:|
| Vegetarian options | 34 |
| Vegan options | 28 |
| Gluten-free options | 25 |
| Lactose/dairy-free options | 5 |
| Halal options | 2 |

These are word mentions, not verified claims: the scanner strips scripts, styles, and tags and applies five vocabulary regexes (`website.ts:262-276`).

## B. Remaining misses and false positives

Independent broad anchor discovery found a candidate while `parseWebsite` selected no menu for only eight venues, so a top 10 does not exist. All eight are listed; snippets are at most 200 characters.

| # | Venue and homepage | Anchor snippet | Assessment and proposed fix |
|---:|---|---|---|
| 1 | Taco Rouge — `https://www.tacorouge.com/` | `Buka Menu Saya` → `javascript:;` | Hijacked gambling page; not a real menu miss. Keep rejecting non-HTTP links in scoring (`website.ts:196-203`, `website.ts:223-225`). No yield fix warranted. |
| 2 | Ollei — `https://qr.imenupro.com/1j0o-4` | `Powered by iMenuPro` → `https://imenupro.com/` | Credible miss: the supplied homepage is already a QR menu. Add conservative current-page detection when the title is exactly menu-like and the host/path is a known menu publisher, before navigation fallback (`website.ts:368-370`). |
| 3 | Dandelion Chocolate Factory & Café — `https://www.dandelionchocolate.com/` | `Sourcing Report` → `…/Final_20Sourcing_20Report_202024_20-_20Small_20File.pdf.pdf` | Unrelated PDF; correct rejection. The PDF guard requires menu-like anchor text (`website.ts:245`). No fix. |
| 4 | Saint Frank — `https://www.saintfrankcoffee.com/` | CSS/JS text beginning `body{background:#FFF}@keyframes…` → malformed `window.location…` href | Parser artefact, not a real menu candidate. Harden anchor extraction so `<a…>` inside script/template payload cannot be interpreted as DOM anchors; the current regex scans raw HTML (`website.ts:182-193`). This improves diagnostics, not expected menu yield. |
| 5 | Burma Love — `https://burmafoodgroup.com/burma-love.html` | `Products` / `Burma Love Foods` → `burma-love-foods.html` | Merchandise/products page, not a menu. Add `products?` to the negative vocabulary if broad weak matching is ever expanded; current negative filter is at `website.ts:211-212`, applied at `website.ts:235`. |
| 6 | Osito — `https://ositosf.co/` | `Fridge Freezing Food? Here’s Why and How to Fix It` → `/blog/food-tech/fridge-freezing-food/` | Expired/content-farm site, not venue navigation. Existing `blog` negative filtering correctly rejects it (`website.ts:211-212`, `website.ts:235`). No fix. |
| 7 | Beque — `https://bequekoreangrill.com/` | `Daftar` → `https://menu.bequekoreangrill.com/` | Hijacked gambling page. Although the host contains “menu,” login-like anchor text is rejected by the negative vocabulary (`website.ts:211-212`, `website.ts:235`); this is desirable. No fix. |
| 8 | Toronado — `https://www.toronado.com/index.html` | `Powered by BeerMenus` → `https://www.beermenus.com/?ref=widget` | Credible beverage-menu miss. Recognize `beermenus.com` or compound/camel-case `BeerMenus` as a strong menu token. The current letter-boundary construction prevents matching `menu` inside `BeerMenus` (`website.ts:205-210`), and scoring occurs at `website.ts:236-246`. |

### Deterministic random sample of 20 selected links

The sample used a fixed seed (`20260902`) so it is reproducible.

| Venue | Selected URL / fetched title | Judgment from URL and title |
|---|---|---|
| Limoncello | `/menu.html` — “Menu \| Limoncello SF” | Plausible |
| Subway | `/en-us/menunutrition/menu` — “Our Menu \| Subway®” | Plausible |
| Surisan | `/menu` — “Surisan Online Menu…” | Plausible |
| House of Prime Rib | `/#menu` — venue title | Plausible |
| Akira | `/menu` — “Order Online \| Premium Sushi Takeout…” | Plausible |
| An Sushi | `/#menu` — “An Japanese Restaurant” | Plausible |
| Biergarten | `/#new-page-3-section` — “Biergarten” | Cannot be determined from URL/title |
| Che Fico Pizzeria | `/home#menus` — venue/order title | Plausible |
| Taqueria El Buen Sabor | `/menu-taqueria-san-francisco-elbuens` — title includes “Menu” | Plausible |
| Hard Rock Cafe | `https://www.hardrock.com/#` — global hotels/casinos/entertainment title | **False positive** |
| Giordano Bros. | `/northbeach/menu` — “gbros” | Plausible from URL |
| Mercury Cafe | venue-hosted `.pdf` | Plausible from selected PDF URL; PDF has no HTML title |
| Anina | `/#menus-section` — “Anina” | Plausible from fragment |
| Truly Mediteranean | `/valencia-menu` — “VALENCIA MENU…” | Plausible |
| Southern Pacific Brewing | `/menu` — “FOOD…” | Plausible |
| Piazza Pellegrini | `/menu` — “ANTIPASTI…” | Plausible |
| Fog Harbor Fish House | third-party `/place/fogharborfishhouse/menu`; HTTP 403, no title | Plausible from URL, but content unverified |
| Mochica | `https://mochicasf.com/#` — generic venue title | **False positive** from the available evidence |
| Harris' | `/menu`, redirected to `/harris-menu` — title includes “Menu” | Plausible |
| Pancho Villa | `/our-menu`; no title captured | Plausible from URL |

The observed false-positive rate is **2/20 = 10%** if the required denominator is the full sample. One additional item (Biergarten) cannot be determined, so among the 19 determinable judgments it is **10.5%**. The dominant pattern is an empty `#` accepted from structured `menu`/`hasMenu`: URL resolution permits fragments (`website.ts:196-203`), the structured candidate prefers a concrete URL but falls back to a fragment (`website.ts:349-355`), and navigation scoring is skipped once that value exists (`website.ts:368-370`). Fix by treating bare `#`, the base URL plus `#`, and non-menu-specific fragments as presence-only unless a matching menu anchor corroborates them. A secondary risk is generic section fragments; validate them against menu-like anchor text/title before following. The 403 response means Fog Harbor’s content cannot be verified.

## C. What this slice adds

“Something a room can use” means at least one menu link, hours value, dietary mention, booking/delivery link, or description. Categories overlap.

| Distance band | Venues | Reachable | Menu | Hours | Dietary mention | Booking or delivery | Description | Any usable gain |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 2.00–2.40 km | 108 | 86 | 64 | 17 | 18 | 25 | 30 | 69 (63.9%) |
| 2.40–2.80 km | 104 | 81 | 50 | 13 | 14 | 13 | 13 | 55 (52.9%) |
| 2.80–3.12 km | 138 | 84 | 54 | 18 | 19 | 20 | 25 | 64 (46.4%) |
| **All** | **350** | **251** | **168** | **48** | **51** | **58** | **68** | **188 (53.7%)** |

The absolute contribution remains material throughout the slice, but the usable-gain rate declines with distance: 63.9%, 52.9%, then 46.4%. This is descriptive, not causal: distance is entangled with which venues and website platforms occur in each band. Booking and delivery are combined uniquely per venue, so the all-slice value (58) is lower than simply adding 40 reservation and 22 delivery URLs.

## D. Recommendations ranked by expected gain

1. **Validate bare and generic structured fragments before accepting them.** This targets the only repeated clear false-positive pattern in the random sample (2/20), while preserving explicit `#menu`/`#menus-section` links. Change the structured-menu fallback at `website.ts:349-355` and require corroborating menu-like anchor text using the navigation evidence gathered at `website.ts:368-370`.
2. **Add explicit compound/provider recognition for BeerMenus.** It recovers one of only two credible misses in this slice with a narrow rule and low expected false-positive cost. Extend the strong vocabulary at `website.ts:205-210` or score the provider host near `website.ts:223-246`.
3. **Recognize a supplied URL that is itself a hosted menu, conservatively.** This recovers Ollei without inventing a second-page link. Gate it on a menu-specific provider/path plus an exact menu-like page title before the fallback at `website.ts:368-370`; do not use title alone because hijacked and content-farm domains were present.

## E. Residual uncertainty

- Judgments were intentionally limited to URL and fetched page title. Page semantics for Biergarten cannot be determined under that rule, and Fog Harbor returned 403.
- A title/URL check cannot prove that a plausible page contains current menu items, belongs to the exact venue location, or is not a soft-404. Conversely, bare fragments may point to real in-page menus even when the title is generic; Mochica is classified false only from the evidence the task permits.
- PDF dietary text was not decoded: the requested scanner operates on HTML/text bodies, while PDF follows only establish kind (`website.ts:435-446`). Dietary yield therefore excludes any mentions available solely inside the five PDFs.
- `robotsAllows` implements only the `User-agent: *` group and prefix-style `Disallow` rules (`website.ts:58-77`). The crawl honored that exported behavior exactly, but it is not a full robots.txt standard implementation.
- Counts are a single live-web snapshot. Redirects, bot defenses, transient timeouts, hijacked domains, and dynamic client rendering can change reachability and yield. No web searches or external ground truth were used, so venue/domain ownership for suspicious sites cannot be conclusively determined.