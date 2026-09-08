# Enriching a place beyond the map

Implementation reference, checked against `main` on 2026-09-07. The
[base inventory](DATA-QUALITY.md) is a prepared OSM snapshot. Enrichment adds
source-labelled facts, links, evidence, and images to places already known to
the application. It does not replace the inventory with worldwide live search.

The main implementation is [enrich/index.ts](../apps/server/src/enrich/index.ts),
with [refinement](../apps/server/src/refine/worker.ts),
[focused inspection](../apps/server/src/spatial.ts), and the
[regional prepopulation command](PREPOPULATE.md) sharing its caches and evidence
rules. Dated crawl reports in [research](research/enrichment-crawl-2026-09-02/)
are historical measurements, not current coverage or provider-price guarantees.

## Sources

| Source | What the application reads | Result |
|---|---|---|
| OpenStreetMap tags | Diet/accessibility/service tags, cuisine, hours, website/menu links, descriptions, image/Commons references, Wikidata IDs | Base record and discovery metadata, with extract timestamp |
| Venue website and linked menu | JSON-LD and visible text, hours, cuisine, price range, accessibility, self-published rating, menu/reservation/delivery links | Parsed facts and evidence with venue source URLs |
| Wikidata | Tagged entity, description, official website, Wikipedia link, awards, image metadata | Source-labelled supplemental facts; not a general name-based Wikidata crawl |
| DataForSEO business listings | Category-filtered businesses near the room or prepared region, joined locally to known places | Likely Google-profile claims, published hours/rating, and website discovery |
| Search provider | Bounded results for unanswered admissible criteria | Cited evidence passed to a separate tool-less evaluator |
| Participant | An attestation or fact confirmation submitted by an authenticated member | Evidence confined to that room, with actor and provenance |

Ratings are source-specific. Website ratings are presented as published by the
place; listing ratings are labelled as Google-profile data. Neither is a
Spokes rating. Booking and delivery URLs are handoffs; the application does not
make reservations or purchases.

Model interpretation of menu files, source text, and photos is described below.
A small [deterministic guess table](../apps/server/src/guess.ts) also supplies
explicitly labelled likely facts from cuisine or venue class. Guessing is a
separate evidence source, not an OSM fact.

## Outbound routing and caching

Venue, menu, image, metadata, search, and listings requests use the policy-aware
[outbound client](../apps/server/src/net/outbound.ts). The model Responses
transport has its own direct keyed-API path and shares process-wide resource
limits. Browsers request venue images from authenticated same-origin routes;
map tiles are a separate browser-side OpenFreeMap dependency.

Configured residential proxy routing applies to eligible venue-site, menu,
image, CDN, and robots requests. Keyed APIs and open-data hosts stay direct.
Interactive fetches prefer direct and can retry block-shaped responses through
the configured proxy. Purpose, host state, circuit breakers, a stable direct
control group, concurrency, and pacing determine the actual route; the
scheduler's selected pool is not a substitute for these transport checks.

Direct socket connections validate the DNS addresses actually used by the
transport, rejecting internal and transition addresses. Redirect destinations
are checked and cross-origin redirects drop authorization/cookie headers. A
forward proxy performs its own resolution outside that direct-socket check.
[Known limitations](KNOWN-LIMITATIONS.md) covers the remaining deployment boundary.

### Stored material and freshness

[cache.ts](../apps/server/src/enrich/cache.ts) and
[enrich/index.ts](../apps/server/src/enrich/index.ts) define source-shaped caches:

| Material | Usual freshness | Storage scope |
|---|---|---|
| Parsed website facts | 7 days | Shared by OSM ref |
| Selected homepage/menu text and image candidates | 7 days | Server-side `page_cache`, keyed by URL |
| Robots response | 24 hours | Page cache |
| Wikidata / Commons metadata | 30 days | Shared metadata cache |
| Listing facts | 7 days | Shared by matched OSM ref |
| Validated inference claims | 7 days | Shared by OSM ref and criterion |
| Explicit inference omission | 24 hours | Same criterion cache |
| Search output | 7 days | Provider-specific rules below |
| Processed images / image classification | Images: 1–30 days; classification: 30 days | Image source max-age/s-maxage is clamped to 1–30 days; no-store/private/no-cache responses rejected |
| Participant confirmations | No expiry | Originating room and OSM ref/criterion |

These are freshness/retry windows, not a complete automated data-deletion
policy. An expired cache row can remain stored until refresh or maintenance.
Website and Wikidata have independent clocks and errors. A temporary failure
preserves the last good provider value and normally shortens its retry window
to an hour. OSM-ref database leases suppress overlapping source refreshes;
workers acquire bounded process capacity before a lease.

The page cache stores selected, cleaned evaluator text, capped at 6,000
characters per page, rather than raw HTML. It can retain validators and image
candidates. Conditional requests reuse `ETag` / `Last-Modified`; a 304 refreshes
timestamps without replacing extracted material. Cache policy can prohibit
storage. Full cached page text is not returned as a public dossier field, but
it can be sent to the model, and validated excerpts/context can survive in
reader-facing evidence claims.

Inference writes prune entries older than 30 days and cap unbounded question
and legacy time-key partitions separately at 64 per place. Question-cache
keys are hashes; the original participant question and its label are not
stored in the shared inference blob. That is not cryptographic secrecy: model
evaluation can receive application-private criteria, and the operator controls
the database and process.

### Text and robots handling

[text.ts](../apps/server/src/enrich/text.ts) parses HTML, removes executable and
page-chrome subtrees, normalizes text, and preserves readable boundaries.
The same cleaner is used for source text, proposed spans, snippets, labels,
and stored evidence. This keeps extraction and span validation consistent;
it does not make untrusted venue prose authoritative instructions.

The website reader implements a limited robots policy: `Disallow` lines in the
`*` group. It is not a full RFC 9309 implementation and failures to fetch a
robots file can allow the read. The reader does not execute venue JavaScript.
Dynamically rendered sites, inaccessible pages, or unsupported menu formats
can therefore remain unresolved.

## Listings

[listings.ts](../apps/server/src/enrich/listings.ts) maps current pool classes
to DataForSEO business categories and batches at most ten categories per
request. The provider request radius has a one-kilometre floor; matching still
uses the known place coordinates. Returned data does not create arbitrary new
room candidates.

A match needs proximity within 60 metres and accepted normalized-name or
website-domain evidence. Conflicting domains reject a pair. A contained name
with extra branch words has a tighter 25-metre bound and additional word/length
checks. Unmatched listing records are discarded; they are not named in batch
logs or retained as a second venue inventory.

Boolean/price claims use `listing:google` at confidence 0.65 and remain likely.
Both affirmative and negative profile values can contribute. Hours, rating,
and website remain companion fields; a discovered website can be used when
OSM supplies none. Each rendered listing fact has its source link.

Room-triggered requests use a durable scope-aware daily admission rule.
Regional prepopulation has a separate seven-day selection admission, including
successful batches that found no matches; failed regional batches retry after
an hour. Both reuse the same matched-OSM-ref facts. `LISTINGS=0` disables the
provider; otherwise `DATAFORSEO_LOGIN` and `DATAFORSEO_PASSWORD` are required.
Cache lifetime here describes the implementation, not a grant of source
redistribution rights. Provider account terms and costs are not encoded by the
evidence confidence or TTL.

## Search providers

`SEARCH_PROVIDER=parallel|openai|tavily` selects the split search path. Parallel
is the default; it requires `PARALLEL_API_KEY` and uses `PARALLEL_SEARCH_MODE`
(default `turbo`). Tavily requires `TAVILY_API_KEY`. The `openai` compatibility
value uses the configured Responses backend's built-in web-search tool.

Search and judging are separate calls. The search result supplies bounded
source material; the tool-less matrix evaluator then validates claims against
that material. Parallel excerpts are discovery hints: the server can fetch up
to two result pages and retain literal spans it locates in those pages rather
than treating a stitched excerpt as a verbatim quote.

Search cache policy is explicit in [cache.ts](../apps/server/src/enrich/cache.ts):
Parallel snippets require a room-specific key, and no room ID means no snippet
cache. Regional prepopulation therefore does not persist Parallel snippets.
Tavily can reuse a shared bounded snippet cache. Built-in model search stores
validated claims and answered-cell metadata, not raw search responses or
snippets. All paths can persist validated claims through the ordinary shared
inference store.

### Search privacy

A query is capped at 400 characters and contains place identity, city, and
criterion words allowed by [searchableCriterion](../apps/server/src/refine/worker.ts).
An active need contributes its words only if it is shared. With no active need,
the background sweep may search the application's closed attribute vocabulary.
Free-text questions can travel only as active shared needs; synthetic `open:*`
keys never become search terms. Tagged street addresses and categories are
not added to this query shape.

Application-private criteria can still reach the separate model evaluation
call with already-fetched source material. Having no search tool prevents that
call from issuing searches; it does not keep its input away from the model
provider. Agent-private held text is not input to refinement; the built-in
agent uses the distinct [condition-screening path](NL-AGENT.md#agent-private-conditions).

## Evidence and precedence

Facts use the [five-state contract](../packages/contracts/src/status.ts).
Source records, parsed venue statements, listing claims, guesses, model claims,
and participant evidence retain provenance rather than being flattened into
an unlabelled truth value. An accepted verified record normally wins over
weaker evidence; contrary participant evidence can produce a dispute.

Participant attestations are per room. A confirmation is keyed by
`(room_id, osm_ref, criterion_id)`, with confidence 0.95 on the person-evidence
merge path. It can answer a vocabulary fact or hashed text question, but cannot
confirm an absolute `open:*` window. The confirmer or room organizer can undo
it. It does not change the OSM snapshot or another room's evidence.

### Batched evaluation

[evaluate.ts](../apps/server/src/enrich/evaluate.ts) evaluates at most eight
places by five criteria per model call, with up to 6,000 text characters per
place. Larger matrices split on both axes. Each non-abstaining cell identifies
its place, criterion, source index, confidence, and evidence span.

The server requires a span of at least twelve characters and two words,
matched case-insensitively with normalized whitespace and word boundaries
against that exact place/source. A criterion echo is insufficient. Missing or
malformed cells and transport errors are not facts; an explicit abstention
can be cached as an unanswered claim/omission. `open:*` time predicates never
go to this evaluator.

| Evidence bucket | Maximum ordinary model confidence |
|---|---:|
| Venue-site prose | 0.60 |
| Menu evidence | 0.69 |
| Domain-scoped search | 0.55 |
| Open-web search | 0.50 |
| Name/category context | 0.45 |
| Explicit statement on the exact recorded venue host | 0.72, verified |

The last row requires explicitness, a validated span from the website/menu
bucket, and an exact normalized host match with the recorded venue website.
A sibling subdomain or shared registrable domain is insufficient. The source
becomes `web:<host>`. This is acceptance of the venue's own assertion, not
independent proof that the assertion is true.

Matrix answers are cached by place, criterion, and evidence-text hash before
new rectangular batches are built. Forced rereads can bypass the answer cache
while reusing suitable page text. Source freshness and the interactive reread
window still govern network work; `force` is not a promise to download every
source again.

### Evidence never regresses on re-read

The [inference resolver](../apps/server/src/enrich/index.ts) preserves an
existing claim when a later call abstains or omits it. Same-lean evidence must
strengthen confidence/source to replace it. Opposite-lean evidence must meet
explicitness and source-rank rules; otherwise it records a contradiction
without erasing the earlier claim. Missing text does not by itself disprove
an old claim. Writes are serialized per OSM ref in database transactions.

### Focused adjudication

[adjudicate.ts](../apps/server/src/enrich/adjudicate.ts) rereads a likely claim
with a bounded context window, page title, and publisher identity. Quote and
publisher validation remain server checks. An explicit venue or chain
statement can become verified at 0.75 with an `adjudicated:<host>` source.
A third-party judgement remains likely at 0.69. Unclear or unsupported output
does not manufacture a decisive fact.

Source text remains untrusted. These gates limit unsupported output; they
cannot detect every false venue statement or model interpretation error.
Room eligibility and participant decisions should preserve that distinction.

## Menus and images

[menu-reader.ts](../apps/server/src/enrich/menu-reader.ts) can read a linked PDF,
image, or image-only menu using the configured vision model. It processes at
most one bounded file per venue and stores resulting claims, not menu bytes.
Menu readings stay likely, at no more than 0.69 confidence. Missing credentials
or `MENU_READER=0` disable this path.

[images.ts](../apps/server/src/enrich/images.ts) considers at most eight image
candidates and stores at most three. It prefers OSM/Commons references,
Wikidata images, and closely matched Commons geosearch results before website
declarations and a bounded homepage-image fallback. Nearby Commons matches
require place-name evidence and acceptable licence/credit metadata; proximity
alone is insufficient. Direct OSM image links do not acquire an invented
licence merely by appearing in OSM.

Images are fetched server-side, bounded, decoded, resized, and stored as WebP.
SVG/ICO/GIF, insufficient dimensions, unsuitable aspect ratios, oversized
outputs, and responses forbidding caching are rejected. Website candidates
also need the [image classifier](../apps/server/src/enrich/image-classifier.ts);
when disabled or unavailable, the stored band is limited to accepted curated
sources. A failed/malformed classifier batch is not treated as acceptance.

Image expiry is clamped to one through thirty days from source max-age or
s-maxage, so a shorter advertised lifetime is not honored exactly. Responses
with no-store, private, or no-cache are rejected. Expired image bytes are not
served. The page receives authenticated
same-origin image routes, provenance, dimensions, and blurhash metadata. A
source image being available does not establish that it depicts the current
venue accurately.

## The pipeline

The process-local [scheduler](../apps/server/src/pipeline/scheduler.ts) shares
bounded fetch/search/model/image/decode capacity across rooms, uses room-level
fairness and item priority, and applies ready-buffer backpressure. Current pool
limits and environment overrides live in [pools.ts](../apps/server/src/pipeline/pools.ts).
Deployment Compose values can override source defaults; use
[deployment configuration](DEPLOY-COOLIFY.md) when sizing a running instance.

Priorities are interactive work, uncertain active needs in scope, stale facts,
background vocabulary, then requested assets. Queued work is rechecked against
the current room plan/scope. Work already running may finish into reusable
caches. Network waits do not retain a room transaction or checked-out database
client. Source leases coordinate refreshes across processes; scheduler queues,
progress, focus, and rate budgets are still process-local.

### Fast track and speculative prefetch

The page's HTTP inspection route with `intent: "read"` starts no lookup. With `intent:
"open"`, it returns cached dossiers immediately and starts a bounded plan per
place. Omitting intent retains the compatibility path that waits at most three
seconds before returning the latest dossier while work may continue.
The version 4 WebMCP `inspect_candidates` tool always selects the passive
path; use `look_up_places` for an explicit lookup. Agent inspection accepts
`keys` and `details`, not the page route's `intent`/`force` options.

An open reuses cached material, reads the site and active criteria, materializes
due images, adjudicates likely claims, and may search unresolved shared needs.
Its [per-open budget](../apps/server/src/pipeline/interactive.ts) is one fetch
pass, one search, three non-vision model calls, and one vision call, with
additional room/process quotas. Focus changes can abandon remaining work unless
another participant still has the place open. After a successful open, the
same place/needs epoch is suppressed until the needs change or `force`
requests another pass; elapsed time alone does not currently reopen it.

Facts frames expose stages and completion reasons. Pipeline progress counts
active work rather than promising a completion time. Speculative hover/focus
prefetch is separately bounded and does not perform search or image work.
During ordinary room use, background warming/refinement does not materialize
images; an opened detail does. The explicit prepopulation command can also
warm images without an open participant page.

### Continuous refinement

Creation can start a room's planner before a browser connects. Presence keeps
it active; by default it stops ten minutes after the last participant leaves.
Need or scope changes wake and reprioritize it. It prioritizes in-scope
uncertainty affecting active needs, then stale evidence and vocabulary gaps.
Already decisively excluded candidates do not need unrelated evidence to
explain their exclusion.

When source text leaves admissible criteria unanswered, one bounded search
covers them together and a second matrix pass evaluates the result. A spent
search bucket disables that leg while site reading/judging can continue; an
empty model bucket pauses processing. Unresolved cells have a bounded
same-day search-attempt policy, so a persistently missing answer does not
trigger an unlimited loop. Current knobs live beside the
[worker](../apps/server/src/refine/worker.ts), rather than in a duplicated price
or throughput table.

`REFINE=0` disables the room loop. `ENRICH_NETWORK=0` disables enrichment's
outbound work; it is not a global switch for every application/model/browser
request. `INFER=0`, `MENU_READER=0`, `PLACE_IMAGE_CLASSIFIER=0`, and `LISTINGS=0`
disable their respective optional work.

## Diagnostics and verification

Outbound diagnostics aggregate host/route counts, status, timings, and bytes.
`GET /api/diag/outbound` is unavailable to ordinary participant tokens in
production. Progress and model cost counters are diagnostics with process-local
scope; they do not establish durable spending ceilings or provider prices.

Relevant suites include [enrichment reliability](../tests/api/enrichment-reliability.test.ts),
[evidence rereads](../tests/api/evidence-reread.test.ts),
[matrix evaluation](../tests/unit/evaluate-matrix.test.ts),
[adjudication](../tests/api/adjudication.test.ts),
[room confirmations](../tests/api/confirmed-facts.test.ts),
[listings](../tests/unit/listings.test.ts), [images](../tests/api/images.test.ts),
[outbound security](../tests/unit/outbound-dns.test.ts), and
[prepopulation](../tests/api/prepopulate.test.ts). Scripted/local tests validate
these rules, not current provider availability or complete real-world accuracy.
