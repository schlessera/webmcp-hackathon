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

## Images

Place photos use the following precedence. At most three are stored and no
more than eight candidates are considered:

1. `image` and `wikimedia_commons` on the OpenStreetMap record;
2. Wikidata P18, for a place whose OSM record carries a `wikidata` id;
3. Wikimedia Commons file geosearch (`list=geosearch`, namespace 6) within
   40 m of the POI;
4. vision-approved declarations from the place's own homepage.

The first three sources are curated: a person associated the image with the
record/place, or Commons metadata locates and names it. A nearby Commons file
is still accepted only when its file title or one of its categories carries
the place name after case, punctuation and diacritics are normalised. All
meaningful name words must match; generic words such as `cafe`, `restaurant`,
`bar` and `hotel` do not count. A random nearby file is therefore rejected.
Accepted geosearch images retain the existing Commons Creative Commons
licence and artist checks and read `photo near this place · <credit>`.

The homepage contributes only explicit representative-image declarations:
`og:image`, `twitter:image`, schema.org `image` in JSON-LD or microdata, and
`<link rel="image_src">`. Ordinary `<img>` elements are never candidates;
there is no largest/first-fold fallback. A declared site candidate is rejected
before download when its extension or declared type is SVG, ICO or GIF, or
when its URL path, alt text or class has a word-like match for `flag`, `icon`,
`logo`, `sprite`, `lang`/`language`, `avatar`, `badge`, `banner`,
`placeholder`, `pixel` or `tracking`. Matching is boundary-aware and examines
the path rather than the host, so `flagship-hotel.jpg` and a photo hosted at
`bannerman.de` remain eligible.

When website facts are fetched in the same pass, homepage candidates travel
only on that in-memory result and are stripped before the `website` JSON is
persisted. When that cache is warm but images are due, a candidate-only read
uses the same robots, SSRF, redirect and User-Agent boundary: an advisory HEAD
followed by a GET whose body stops at 512 KB. The existing image refresh clock
keeps that fallback to at most once per image refresh period. It runs only
`extractImageCandidates`, never the full website parser. A Wikidata P18 or
Commons file tag is resolved through the Commons `imageinfo`
API with `extmetadata`; the image is accepted only when the metadata names a
usable Creative Commons licence. Its actual licence and cleaned artist credit
are retained. An image linked directly by the OSM `image` tag retains the OSM
record as its source; the application does not invent a licence or credit the
source did not supply.

Every image fetch is server-side and passes through the website reader's same
DNS/IP SSRF guard, manual redirect checks and robots.txt policy, with the
project's identifying User-Agent. Inputs are capped at 6 MB and ten seconds.
The decoder rejects SVG, ICO and GIF content, dimensions below 480 × 320, and
aspect ratios outside 1:2 through 3:1. Remaining images are resized to at most
960 px wide and encoded as WebP quality 72; results above 200 KB are rejected.
A response that forbids shared caching is rejected; a shorter usable freshness
hint shortens the stored copy. The database stores only those WebP
bytes, dimensions, MIME, source and source URL, source page, credit, licence,
and fetch/expiry timestamps. Rows expire after seven days and are re-fetched;
expired bytes are never served.

Every non-curated (site) image is classified before storage by
`config.nlFastModel` (default `gpt-5.6-luna`). One strict-schema Responses call
carries all of a place's downloaded/resized candidates (up to eight) as WebP
data URIs at `detail: low`; there is never one model call per image. Its one
entry per input image is `{ kind, confidence }`, where `kind` is one of
`venue_exterior`, `venue_interior`, `food_or_drink`, `people`, `logo`,
`flag_or_icon`, `map_or_screenshot`, `text_or_graphic`, or `other`. Exterior,
interior and food/drink are kept at confidence ≥ 0.6. The prompt assigns people
inside or directly in front of a visible place to the corresponding venue
kind; `people` is reserved for portraits/stock/crowd shots with no place
visible and is rejected. A short, malformed or failed answer rejects the whole
batch rather than storing an unclassified image.

`place_image_verdicts` caches kind, confidence, model and decision time for 30
days under the SHA-256 of the candidate URL (the URL itself is not stored in
that table). The cache is consulted before downloads: a cached rejection is
not fetched, while a cached acceptance reuses a still-live local copy when one
exists. The filter is off without `OPENAI_API_KEY` or with
`PLACE_IMAGE_CLASSIFIER=0`; while off, no site image is stored at all and the
band is curated-only. One structured log line per fresh place batch records
the place name, input/kept counts, rejected kinds, model, duration and token
usage, without candidate URLs.

Migration 017 deletes every `place_images` row whose source starts `web:` and
clears the affected enrichment image clocks. Those pre-classifier bytes are
then eligible for a fresh harvest under these rules; curated rows are left
alone.

The participant receives only an authenticated, same-origin `/api/places/…`
URL. No participant IP ever reaches the place, Wikimedia Commons, or another
third-party image host. This is the same rule as every other enrichment
source, not a browser optimization.

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

Inference normally remains below verification. An explicit statement quoted
from the venue's own recorded website is the one exception described below;
all other accepted claims merge as `likely_true` or `likely_false`, with
source `infer:<model>:<source-bucket>` and their evidence span in `note`. They
fill only a slot that is still `unknown`; record, web, deterministic guess and
attested facts keep their precedence. The server drops a claim unless its evidence is at least 12
characters and two words, appears case-insensitively at whole-word boundaries
in the exact input bucket the model named, and is not just the attribute key
or label. Whitespace runs are collapsed to one ASCII space on both sides before
that comparison. Control and markup characters are stripped before the note is
stored; notes are fenced as untrusted venue data whenever a tool result enters
agent context.

The model's stated confidence is capped by the evidence ladder in “Batched
evaluation” below.

Time-window criteria whose keys start with `open:` are never sent to the model
and model output for such a key is rejected at the evaluator boundary. A time
need is a deterministic predicate over structured opening hours, so prose must
never manufacture its answer or promote it to a verified fact.

Accepted claims are cached per criterion in `enrichments.inferred` for seven
days. Only a cell the model explicitly returns with `lean: "abstain"` gets a
24-hour omission sentinel. A cell missing from a partial or truncated answer
stays open, as does every cell in a transport or JSON-parse failure, and is
re-queued on the next pass. Every upsert also physically removes inference
entries older than 30 days. Closed-vocabulary entries have no cardinality cap;
question entries and legacy `open:` entries are separately capped at 64 per
place, with the oldest evicted first, because both keyspaces are unbounded.
Inference is completely off when `ENRICH_NETWORK=0`, when
`OPENAI_API_KEY` is absent, or when `INFER=0`; those paths make no model call
and write no inference cache entry. Menu image reading remains a separate
smart-tier job.

### Batched evaluation

Live lookups evaluate a matrix rather than calling the model once per place:
one strict-schema call carries many places and every open criterion, including
free-text questions. Cuisine criteria carry their normalized wanted values and
an explicit “Does this place serve … food?” question; their value-specific ids
keep distinct cuisine asks in distinct cache cells. Each returned cell names its `candidateId`, `criterionId`
and source index. `abstain` is the expected answer where the cited material
does not support a lean and creates no fact. Before storing any other cell, the
server checks that its evidence is a verbatim, case-insensitive,
whitespace-normalized span from that exact place and source, contains at least
12 characters and two words, and is not an echo of the criterion.

The hard call limits are **8 places × 5 criteria (40 cells)** and **6,000 text
characters per place**. Larger matrices split on both axes and their validated
results merge. Each successful batch is persisted before the next call starts,
so a later failed batch cannot discard earlier validated claims. A failed batch
is isolated and the remaining bounded batches continue. For each place, empty
text is removed and sources are ordered shortest first. Whole shorter sources
are kept before the longest source, which is last and is the first/only source
shortened when the 6,000-character aggregate budget is exhausted.

Model confidence is an input to `Math.min`, never authority:

| evidence source bucket | maximum confidence |
|---|---:|
| OSM tag / source record | not a model claim |
| venue-site fetch (homepage text) | 0.60 |
| venue menu text or reading | 0.69 |
| explicit statement on the exact recorded venue host | 0.72 (record-grade) |
| domain-scoped web search | 0.55 |
| open-web search | 0.50 |
| name or category only | 0.45 |

Every accepted value passes through `graded()`. It stays likely unless the
model marks the claim explicit, the validated span came from a `web` or `menu`
venue-site bucket, and the cited URL's hostname exactly matches the OSM
`website` hostname after lowercasing and stripping one leading `www.`. Only
that conjunction grades the claim at 0.72 and changes the source to `web:<host>`;
sibling subdomains and registrable-domain-only matches fall back to the normal
ladder. Successful bounded batches use one bulk `INSERT … ON CONFLICT`
statement apiece. Question facts use only their `q:<sha1>` key plus evidence
fields in the cross-room cache: normalized question text and reader-facing
labels are never stored there. A dossier recovers the label only from a
viewer-authorized matching requirement. Any web-derived fact shown to a reader
carries a visible, clickable `sourceUrl`; uncited web output does not qualify
as reader-facing evidence.

### Residual exposure: venue-authored text

Venue text remains untrusted input embedded verbatim in the matrix JSON. Span,
place/source-index, host and confidence validation contain prompt injection,
but a venue can still publish a statement that supports a favorable answer on
many criteria. C4's explicit-own-site rule deliberately widens this surface:
a venue's outright false statement about itself can now receive record-grade
0.72 standing, just as false schema.org markup can. Provenance remains visible
and a participant may dispute the fact by attestation, but the evaluator cannot
independently establish the truth of the venue's assertion.

Negative leans from the venue-site bucket remain accepted. Rejecting them would
make an explicit own-site statement such as “dogs are not allowed” impossible
to represent as `verified_false`, contradicting the symmetric record-grade
decision and discarding useful direct evidence. Silence still requires
abstention: a `no` lean needs explicit negative wording and, for record grade,
must pass the same explicit/span/exact-host gate.

### Continuous refinement

Each room has one process-local refinement loop. It starts when the room gains
a present socket and stops ten minutes after the last participant leaves. A
new or reactivated need moves its unknown places to the front immediately.
The loop first checks in-scope places that the shared eligibility classifier
currently calls `uncertain` for an active need, nearest to the scope centre
first. An unrelated unknown attribute alone does not qualify for tier 1. A
place the classifier already excludes on decisive active evidence is skipped:
refining another gap cannot bring it back. The loop then checks facts last
observed more than seven days ago, then unknown keys from the remaining
vocabulary. A place already being looked up is skipped.

One tick takes at most 12 places. It reads each place's site at most once and
reuses selected homepage and menu prose from a bounded, ten-minute in-memory
LRU when provider freshness prevents another fetch. That prose is never
persisted, logged, put in a dossier, or sent in a realtime frame. One matrix
evaluation covers the batch's whole open criterion set. For each place whose
site material leaves criteria unanswered, one search covers all of those
criteria together. When this pass successfully read usable text from the
place's tagged website, search goes straight to the open web instead of
re-searching that same domain. A tagged domain is allowed only when its fetch
failed or yielded no usable text; a place with no website tag has no domain to
allow and also uses open search. The confidence bucket follows the mode
actually used: 0.55 for domain search and 0.50 for open web.

`REFINE_SEARCH_MODE=split|combined` selects the search leg; `split` is the
default. In split mode, each unresolved place yields cited snippets and one
second matrix call evaluates the whole snippet batch. Evidence is checked
against snippet text the server itself holds. Combined mode instead makes one
strict-schema Responses call per unresolved place, with that place, all its
open criteria and the `web_search` tool. It returns the complete row directly,
so there is no second matrix call. The server requires each `sourceUrl` to be
a URL the tool really retrieved in that same call, read from the
`web_search_call.action.sources` items, ignoring the tool's `utm_source`
parameter. Under a strict JSON schema the API returns no citation annotations
at all, so the retrieved-source list is the only anchor available; a validator
built on annotations rejects every row and was measured at zero yield for that
reason alone.

Combined mode's guarantee is materially weaker, and the weakness is worth
naming. The answer *is* the JSON object, so checking that the evidence span
occurs in the answer proves nothing: the span is there because the model wrote
it there. What is enforced is that the cited URL was really retrieved, plus the
length, echo, cap and never-verified rules. A combined claim is therefore a
supervised guess about a real page, not a quotation the server checked. Split
holds the snippet text and checks the span against words the server read.
Neither mode can create a verified fact.

Combined claims carry a final `:combined` source suffix so presentation can
distinguish a retrieved-page anchor from split mode's checked snippet span.

Every outbound search query is capped at 400 characters and contains the place
name, the city, and criterion words admitted by one of two rules.

A criterion belonging to an **active need** may contribute its words only when
that need is shared. A private need's words stay in, because a search would
reveal both the words and the fact that this room is asking, and its label
being server vocabulary does not change that.

A criterion belonging to **no active need** is the background sweep: the loop
walks the whole vocabulary over every place regardless of what anyone wants,
so the query is evidence of nobody's need. Those criteria may contribute their
words, but only when the label is server vocabulary from `ATTRIBUTE_LABELS`. A
question criterion carries a person's own sentence and can therefore travel
only as an active shared need, never through the sweep. Synthetic keys such as
`open:*` are not vocabulary and never travel at all.

That is what lets the stale-fact and vocabulary tiers keep improving the whole
pool over time, which is the point of continuous refinement. The hourly search
bucket bounds what it can cost, and searches are handed out in queue order, so
a short bucket is spent on active needs first and the sweep takes what is left.

Tagged addresses and categories never enter a query. An application-private
criterion may still be evaluated in the plain matrix call over place-site text
or snippets already returned for another criterion's search. That matrix call
has no tools, so its contents do not become search terms or reach a search
index. If a place has no criterion admitted by either rule, it causes no
search. Combined mode excludes application-private criteria from the entire
tool-enabled call. Agent-private content never enters refinement.

There is one query shape and no setting for it. A richer shaper once carried
the street address, the category and a German lexicon behind
`REFINE_QUERY_SHAPING`; the privacy rule forbids all of those words leaving the
server, so the setting had stopped changing anything and was removed rather
than left to mislead. For the record, the plain query also measured better:
over three live twelve-place Berlin runs it returned 14 validated claims to the
richer query's 11.

A queue emptied only because its places already have lookups in flight is busy,
not idle, and keeps the working cadence. A need toggled while a tick is running
survives that tick: the wake is remembered and re-ticks as soon as the tick
ends, and the finishing tick does not write its cursor back over the
invalidation the wake just made. Without those three, the background sweep
could hold a woken need behind a thirty-second backoff.

With nothing left to refine the loop backs off to `REFINE_IDLE_TICK_MS`
(thirty times the working cadence) so an idle room is not reloaded every
second; a need commit wakes it at once. A batch matrix call is a long prompt on
a background path, so it waits `MATRIX_TIMEOUT_MS`, 45 seconds by default,
rather than the interactive twenty.

The per-room budgets refill continuously: `REFINE_MODEL_CALLS_PER_HOUR`
defaults to 200 model calls and `REFINE_SEARCHES_PER_HOUR` to 150 searches.
A room working flat out for a full hour therefore costs on the order of
**$1.80**, almost all of it the roughly one cent each search tool call is
billed at; the fast-tier tokens for a twelve-place tick add well under a cent.
A room only works flat out while somebody is watching it, and the loop stops
ten minutes after the last person leaves, so the hourly ceiling is a worst
case rather than a running rate.

The earlier ceilings of 60 and 40 were measured too low: in a 343-place room
the search budget was gone sixteen seconds after the first need, and the loop
then reported itself paused for the rest of the hour.

An empty search bucket no longer pauses anything. The loop keeps reading site
text and running the batch matrix, which costs no search at all and still
answers cells and clears the queue; only the search leg goes quiet. A tick
pauses only when the model-call bucket is empty, because without a model call
there is nothing for the tick to run. `refine.paused` on the spatial context
says which is true: `"budget"` when model calls ran out, `"idle"` when nobody
is present, and `null` while the loop is working.

`refine.queued` counts places still needing work for an **active** need. The
stale-fact and background vocabulary sweeps are real work but are not counted
there, because a number that climbs while the room sits still is a number
nobody can trust. `REFINE=0` disables the loop. `ENRICH_NETWORK=0` disables all
of its outbound work. `SEARCH_PROVIDER=tavily` selects the Tavily fallback and needs
`TAVILY_API_KEY`; otherwise split search uses OpenAI Responses `web_search` on
`NL_FAST_MODEL` with low search context. Combined mode is intrinsically an
OpenAI Responses tool call.

Every frame the loop emits carries `reason: { kind: "refine" }`, with a label
only when one shared need is behind the whole batch. When a pool warm-up is
running at the same time, refinement wins the frame's single reason slot: it
is the work a person is watching, and before this a concurrent fill left every
busy ring either labelled `pool` or unattributed. Each tick also writes one
structured log line with its place, criterion, call, search, claim and queue
counts and an estimated cost. That line carries counts and dollars only, never
a place name, a criterion, or a query, because a private need must not be
readable from a log either.

An unresolved place-and-criterion cell records each spent search leg in its
small omission sentinel. After three attempts on the same UTC day, that cell
is not queued again until the day changes. The marker is persisted in the
cross-room `enrichments.inferred` blob, follows its 24-hour omission lifetime,
and is pruned and cardinality-capped with the other synthetic keys. A local
matrix abstention without a search does not spend an attempt.

The only search-derived data stored is a claim that passed criterion, source,
span, confidence and status validation, plus its `sourceUrl`. Search queries,
snippets and raw responses are not stored. An abstention remains unknown and
may leave only an omission sentinel. Any web-derived fact shown to a person
must carry a visible, clickable citation. A citation without a usable exact
span is dropped rather than paraphrased. The provider annotates the inline
citation marker rather than the sentence it supports, so a snippet is the
prose running up to that marker, with markers and emphasis removed. The
annotated span itself is a bare link and is never evidence.

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
  read the revision and build the dossier. Image download and the batched
  vision call remain inside that same background lookup promise: the existing
  3.5-second race was not extended, so slow images land for the next read.
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
