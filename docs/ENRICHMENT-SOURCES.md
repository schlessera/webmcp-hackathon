# Enriching a place beyond the map: sources, what they give, what we use

Researched and measured 2026-09-02. Companion to `docs/DATA-QUALITY.md`
(the base layer) — this document is about everything a room can learn about
a place **beyond** its OpenStreetMap record: menus, links, descriptions,
ratings, awards, more attributes.

The constraints are the same as for the base layer: no third-party call from
a participant's browser; nothing committed that is not redistributable;
nothing cached in violation of a source's terms; no fabricated facts; every
fact labelled with where it came from.

## Summary

Three sources ship, all server-side, all evidence-labelled:

| # | source | licence | gives | how |
|---|---|---|---|---|
| S1 | OpenStreetMap's own long tail | ODbL | menu URL, opening-hours page, Instagram, description, vegan / gluten-free / halal, takeaway, delivery, Wikidata id | more tags kept in the snapshot (`KEPT_TAGS`); no request at all |
| S2 | the place's own website | the venue's | schema.org facts (cuisine, price range, hours, accessibility, self-published rating, menu, reservations), menu link discovery, one-line description; selected visible text for same-pass inference only | one homepage fetch plus an optional menu follow, robots.txt honoured; parsed facts cached 7 days, page text held only in memory for that lookup pass |
| S3 | Wikidata | CC0 | description, Wikipedia article, official site, awards (Michelin star, Bib Gourmand) | one entity fetch for places carrying a `wikidata` tag, cached 7 days |

Ratings from review platforms are **not** available under our constraints
(details below). What a room sees as a rating is what the place publishes
about itself, labelled "as published by the place", or an award on record.

## What was measured

### S1 — what OpenStreetMap already carried and we were dropping

Focus discs (1.4 km around each default centre), named places with the
product's amenity tags:

| tag | Berlin Mitte (890) | SF SoMa (957) |
|---|---|---|
| `website` / `contact:website` | 501 | 473 |
| `website:menu` | 48 | 59 |
| `opening_hours:url` | — | 99 |
| `contact:instagram` | 48 | 128 |
| `description` | 23 | 34 |
| `diet:vegan` | 190 | 33 |
| `diet:gluten_free` | 15 | — |
| `diet:halal` | 17 | 17 |
| `takeaway` | 133 | 206 |
| `delivery` | 52 | 15 |
| `toilets:wheelchair` | 190 | 15 |
| `wikidata` | 13 | 13 |
| `brand:wikidata` | 80 | 97 |
| `contact:yelp` | — | 30 |

Kept now. The five booleans became attributes (`vegan-options`,
`gluten-free-options`, `halal-options`, `takeaway`, `delivery`), which also
makes them needs a room can state and pills the composer can offer.

### S2 — what venues publish on their own sites

Crawled the 80 nearest pool venues with a website tag per city
(`data/osm/crawl.mjs`, one request each, identifying User-Agent):

| | Berlin | SF |
|---|---|---|
| reachable (HTTP 200) | 65 / 80 | 60 / 80 |
| any JSON-LD | 40 | 41 |
| a business-typed node | 34 | 32 |
| a food-typed node (Restaurant, Cafe, Bar…) | 13 | 13 |
| `servesCuisine` | 4 | 7 |
| `priceRange` | 6 | 7 |
| `openingHours` | 14 | 15 |
| `aggregateRating` | 4 | 3 |
| `amenityFeature` | 1 | 4 |
| `hasMenu` / `menu` | 5 | 3 |
| **a menu link anywhere on the page** | **46** | **45** |

Read: the structured facts are thin (4–18 % of sites), but a **menu link
is found on 56 %** of sites, and the facts that do exist are the venue's
own word, published for machines. So the menu link is the reliable win,
the facts a bonus, and both carry a `web:<host>` source.

### S2, second pass — 1,400 sites through four parallel crawlers

Four Codex runs (`gpt-5.6-sol`, low effort), one per half-slice of each
city's venues within 2 km that carry a website tag, each crawling the
homepage and the first discovered menu link. Reports and the crawlers they
wrote: `docs/research/enrichment-crawl-2026-09-02/`.

| | Berlin A (377) | Berlin B (377) | SF A (323) | SF B (323) |
|---|---|---|---|---|
| homepage 2xx | 296 | 309 | 247 | 266 |
| any JSON-LD | 152 | 147 | 151 | 163 |
| menu URL, extractor as it was | 181 | 177 | 161 | 150 |
| menu link, anchor-based discovery | 233 | 234 | 189 | 174 |
| `openingHoursSpecification` seen / hours extracted | 30 / 10 | ≥3 / 21 | 31 / — | many / 7 |
| reservation platform linked from the homepage | 32 | 24 | 33 | 27 |
| delivery platform linked | 21 | 34 | 23 | 23 |
| menu pages carrying a dietary word (of HTML menus) | 95 / 188 | 104 / 196 | 68 / 189 | 104 / 154 |
| menu targets: same-host HTML / PDF / third party | 179 / 40 / 9 | 194 / 29 / 10 | 162 / 6 / 21 | 146 / 9 / 9 |

All four reached the same three conclusions, in the same order: parse
navigation anchors (text as well as href, English and German, scored, same
host preferred, legal pages excluded), fold `openingHoursSpecification`
into hours, and merge facts across JSON-LD nodes with `@id` dereferencing
instead of reading the first node. Two suspected gaps were checked and
cleared by every run: `@type` arrays and nested `@graph` were already
handled.

Folded into `website.ts` the same day: all three, plus reservation and
delivery platform links found in the navigation (OpenTable, Resy, Quandoo,
TheFork, SevenRooms, Tock, Lieferando, Wolt, Uber Eats, DoorDash,
Deliveroo, Grubhub), a `WebPage` description fallback, and a second
request per venue that follows the menu link and records what it mentions
by word (vegan, vegetarian, gluten-free, lactose-free, halal, in English
and German). A word on a menu is evidence, not a verdict: it lifts an
`unknown` to `unverified` ("mentioned on the menu") so the room sees there
is something to check, and never touches a known fact. Numeric price
ranges ("15€–25€") were left alone: mapping them to bands needs a currency
policy the contract does not have.

### S2, reading menus that are pictures

Across the 5,331 sites, 5–17 % of the menus a slice found were PDFs, a few
more were images, and an unknown share of HTML menu pages carried the
menu only as a picture. None of those could say anything about a diet by
word search.

They are read by a vision model (`apps/server/src/enrich/menu-reader.ts`):
one Responses API call with the PDF or image attached, a fixed schema back
— legible?, rough dish count, cuisine words, a price band, and for each of
the five dietary facts a lean with a confidence and a few words of
evidence. Chosen over Tesseract because one call handles a scanned PDF, a
photo taken at an angle and a page image, reads German and English, and
answers the questions directly instead of returning text to regex through.

What a reading may do: fill an unknown or guessed slot as `likely_true` /
`likely_false` at **no more than 0.69** confidence (SPATIAL-PROTOCOL §8.2)
with the source `menu:<host>` and the evidence kept as the value ("menu:
vegan bowl (vg)"). What it may never do: verify anything, or overwrite the
record. The bytes are read once and dropped; only the claims are cached.
Bounded to menus that are files (PDF, image) or image-only pages, at most
one file per venue, 4 MB, off without `OPENAI_API_KEY` or with
`MENU_READER=0`. Model: `MENU_READER_MODEL`, defaulting to the smart tier.

Not folded in: text extraction from text-layer PDFs without the model,
JavaScript-rendered navigation, RFC 9309 robots semantics (the parser
reads the `*` group's `Disallow` lines only).

### S3 — Wikidata

13 places per focus disc carry a `wikidata` tag; those are the notable ones
(historic cafés, starred restaurants). Wikidata models cuisine as P2012,
awards as P166 (Michelin star Q20824563, Bib Gourmand Q16143906), the
official site as P856, and links the Wikipedia article. CC0: storable,
redistributable, no attribution obligation (we attribute anyway).

## Inference: evidence-backed likely facts

When the record, looked-up web facts and the small deterministic guess table
still leave an active criterion unknown, the server may ask the fast NL model
for a lean. A criterion can be a vocabulary key or a normalized free-text
question. The input is limited to the place name, category, cuisine
tokens, OSM/Wikidata descriptions, parsed website facts and description,
menu words/readings, and — only when this lookup just fetched them — selected
visible text from the homepage and followed menu page. That transient text is
title, meta description, headings, paragraphs and list items after scripts,
styles, navigation and footer are stripped, capped separately at 6,000
characters per page. A cache-only read has no page text to replay.

Inference is never verification. Every accepted claim is merged through the
graded status path as `likely_true` or `likely_false`, with source
`infer:<model>:<source-bucket>` and its evidence span in `note`. It fills only a slot that is
still `unknown`; record, web, deterministic guess and attested facts keep
their precedence. The server drops a claim unless its evidence is at least 12
characters and two words, appears case-insensitively at whole-word boundaries
in the exact input bucket the model named, and is not just the attribute key
or label. Whitespace runs are collapsed to one ASCII space on both sides before
that comparison. Control and markup characters are stripped before the note is
stored; notes are fenced as untrusted venue data whenever a tool result enters
agent context.

The model's stated confidence is capped by the evidence ladder in “Batched
evaluation” below.

Accepted claims are cached per criterion in `enrichments.inferred` for seven
days. A requested criterion the model omits gets a 24-hour omission sentinel,
so reopening a place does not pay for the same unsupported question forever.
Inference is completely off when `ENRICH_NETWORK=0`, when
`OPENAI_API_KEY` is absent, or when `INFER=0`; those paths make no model call
and write no inference cache entry. Menu image reading remains a separate
smart-tier job.

### Batched evaluation

Live lookups evaluate a matrix rather than calling the model once per place:
one strict-schema call carries many places and every open criterion, including
free-text questions. Each returned cell names its `candidateId`, `criterionId`
and source index. `abstain` is the expected answer where the cited material
does not support a lean and creates no fact. Before storing any other cell, the
server checks that its evidence is a verbatim, case-insensitive,
whitespace-normalized span from that exact place and source, contains at least
12 characters and two words, and is not an echo of the criterion.

The hard call limits are **12 places × 8 criteria** and **6,000 text
characters per place**. Larger matrices split on both axes and their validated
results merge; an answer is never truncated to fit. For each place, empty text
is removed and sources are ordered shortest first. Whole shorter sources are
kept before the longest source, which is last and is the first/only source
shortened when the 6,000-character aggregate budget is exhausted.

Model confidence is an input to `Math.min`, never authority:

| evidence source bucket | maximum confidence |
|---|---:|
| OSM tag / source record | not a model claim |
| venue-site fetch (homepage or menu text) | 0.60 |
| domain-scoped web search | 0.55 |
| open-web search | 0.50 |
| name or category only | 0.45 |

Every accepted value passes through `graded()` and therefore stays likely,
never verified. Matrix results for all places are written with one bulk
`INSERT … ON CONFLICT` statement. Question facts use their `q:<sha1>` key and
retain both normalized `question` text and reader-facing `label` beside the
lean, confidence, evidence, source and observation time. Any web-derived fact
shown to a reader carries a visible, clickable `sourceUrl`; uncited web output
does not qualify as reader-facing evidence.

### Continuous refinement

Each room has one process-local refinement loop. It starts when the room gains
a present socket and stops ten minutes after the last participant leaves. A
new or reactivated need moves its unknown places to the front immediately.
The loop first checks in-scope places that are unknown for an active criterion,
nearest first. It then checks facts last observed more than seven days ago,
then unknown keys from the remaining vocabulary. A place already being looked
up is skipped.

One tick takes at most 12 places. It reads each place's site at most once and
reuses selected homepage and menu prose from a bounded, ten-minute in-memory
LRU when provider freshness prevents another fetch. That prose is never
persisted, logged, put in a dossier, or sent in a realtime frame. One matrix
evaluation covers the batch's whole open criterion set. For each place whose
site material leaves criteria unanswered, one search covers all of those
criteria together. A site URL makes that search domain-scoped; otherwise it
uses the open web. Cited snippets go through one more batch matrix evaluation.

The per-room budgets refill continuously: `REFINE_MODEL_CALLS_PER_HOUR`
defaults to 60 model calls and `REFINE_SEARCHES_PER_HOUR` defaults to 40
searches. `REFINE=0` disables the loop. `ENRICH_NETWORK=0` disables all of its
outbound work. `SEARCH_PROVIDER=tavily` selects the Tavily fallback and needs
`TAVILY_API_KEY`; otherwise search uses OpenAI Responses `web_search` on
`NL_FAST_MODEL` with low search context.

The only search-derived data stored is a claim that passed criterion, source,
span, confidence and status validation, plus its `sourceUrl`. Search queries,
snippets and raw responses are not stored. An abstention remains unknown and
may leave only an omission sentinel. Any web-derived fact shown to a person
must carry a visible, clickable citation. A citation without a usable exact
span is dropped rather than paraphrased.

## Sources evaluated and not used

| source | licence / terms | verdict |
|---|---|---|
| **Foursquare OS Places** (100M+ POIs, monthly, Parquet on S3 / Hugging Face, gated) | Apache-2.0 | 22 attributes: name, address, tel, website, email, socials, categories, dates. **No hours, ratings, price, photos, tips or menus** — those are the paid API. Would fill website / phone gaps (≈45 % of our focus places have no website tag). Not wired: an offline join against a multi-GB dataset for a gap the venue sites and OSM cover partly already. Documented as the next offline step. |
| **Overture Places** (53M+, monthly, Parquet on S3) | CDLA-Permissive-2.0 / Apache-2.0 | names, categories, websites, socials, phones, brand, confidence. Same shape as Foursquare OS; same verdict. |
| **Foursquare Places API** | commercial | 500 free Pro calls/month, then $15/1k; ratings, tips, hours and photos bill from the first call; content not storable. Key the judges cannot see working. |
| **Yelp Fusion** | commercial | no free tier in 2026; content may not be cached beyond 24 h. |
| **Google Places** | commercial | Places content may only be shown on a Google map; no caching; no lactose-free field. Rejected 2026-09-01 (`DATA-QUALITY.md`). |
| **HERE Places** | freemium | hours, contacts, categories; caching ≤30 days only to serve the end user; key-dependent. Not wired. |
| **TomTom Search** | freemium (2,500/day) | POI search; storage terms unclear; key-dependent. Not wired. |
| **Tripadvisor Content API** | legacy sunset 2026-08-31 | gone. |
| **Open Food Facts** | ODbL | packaged products, not venues; allergen data does not attach to a restaurant. Not applicable. |
| **Michelin Guide site** | proprietary | no API; the awards reach us through Wikidata instead. |
| **HappyCow / Find Me Gluten Free** | proprietary | no API; terms forbid extraction. |

## How it lands in a room

- `enrichments` (migrations 010, 013 and 015), keyed by OSM ref and shared by every
  room that holds the place. Website and Wikidata each carry their own fetch
  status, error and expiry. A successful provider value is kept for seven
  days; a transient failure preserves that provider's last good value and
  retries only that provider after about one hour. A short database lease per
  OSM ref prevents separate server processes from refreshing the same place at
  once. Website and menu HTML never enter this row: selected text lives only
  as a sibling of the fetched facts on the in-memory return value, reaches the
  inference validator during that same pass, and is then discarded. Only a
  validated short evidence span may survive inside an inferred claim.
- **When**: a new room's pool is warmed in the background (4 at a time);
  `inspect_candidates` (the place panel, or an agent) waits up to 3.5 s for
  a fresh lookup and otherwise opens with what is cached, the lookup
  finishing behind it. On-demand lookups share one global four-place
  semaphore. Inspection discovers targets before taking a room lock, waits
  without a checked-out database client, then opens one short transaction to
  read the revision and build the dossier. The classifier reads the cache
  only; it never waits on the network.
- **Precedence**: a verified record fact (`osm:*`, `curated:*`) is never
  overwritten. A looked-up fact fills `unknown` / `unverified` slots:
  cuisine, price band, wheelchair (verified, `web:<host>`), hours
  (unverified only). Attestations (`agent:*`) merge after and can dispute a
  looked-up fact like any other (`SPATIAL-PROTOCOL.md` §8.1).
- **What the panel shows**: links with server-authored labels (website,
  menu, opening hours, reservations, Wikipedia, Instagram), a one-line
  description with its source, awards, and a rating only when the place
  published one, labelled as such. Nothing in the client names a domain:
  link kinds, labels and sources are data.
- **Off switch**: `ENRICH_NETWORK=0` keeps a server off the network (test
  servers set it). `room_demo` is never warmed; opening a place there looks
  it up like anywhere else.

## Not done

- Foursquare OS Places / Overture as an offline join for website and phone
  gaps (Berlin ≈ 45 %, SF ≈ 50 % of focus places have no website tag).
- Resolving Wikidata cuisine item labels (P2012) — ids are stored, labels
  are not looked up.
- Parsing `openingHoursSpecification` objects into the hours table (only the
  `openingHours` string form is read, and only to `unverified`).
- Persisting or returning full homepage/menu text. It remains the venue's and
  is held only long enough to validate same-pass inference evidence.
