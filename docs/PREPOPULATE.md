# Prepare a demo region

Current CLI reference, checked against the implementation on 2026-09-07.

`pnpm prepopulate` runs the application's ordinary providers ahead of a demo.
It writes to the same Postgres caches the app reads by OSM reference, so both
existing and newly opened rooms can reuse the results. It creates no room,
participant, need or candidate rows. Keep `DATABASE_URL` pointed at the database
that will serve the demo; warming a different database cannot help it.

From this checkout, with Node.js 24+ and dependencies installed:

```bash
pnpm prepopulate --area berlin-mitte --dry-run
node --env-file-if-exists=.env apps/server/src/migrate.ts
pnpm prepopulate --area berlin-mitte
```

The root command reads `.env` when present; exported environment variables take
precedence. Use the same provider/proxy settings as the application. Postgres
must already be running and migrations must be current. The preview does not
connect to Postgres or call providers, and lists unavailable sources explicitly.

For the production stack in [DEPLOY.md](DEPLOY.md), run from the host's
deployment directory after rebuilding the app image and running migrations:

```bash
docker compose -f compose.coolify.yaml -f compose.prod.yaml exec app node apps/server/src/prepopulate.ts --area berlin-mitte --dry-run
docker compose -f compose.coolify.yaml -f compose.prod.yaml exec app node apps/server/src/prepopulate.ts --area berlin-mitte
```

This uses the running app container's database and provider environment. It
does not need a browser or any participants to stay connected.
For local development with `compose.yaml`, use `docker compose exec app`
instead. Neither form reads host environment overrides that were not passed
into the container.

Select `sf-soma` for San Francisco. The default is every snapshot place within
2,000 metres of the selected demo centre, including museums, parks and other
classes visible in the explore layer. The city-wide snapshot itself is already
stored locally; this command does not download a new OSM extract.

For a smaller trial or a specific source pass:

```bash
pnpm prepopulate --area sf-soma --radius-m 800 --limit 10 --concurrency 2
pnpm prepopulate --area berlin-mitte --sources sites,images
```

Places run nearest first. `--limit` applies after deduplication and the radius
filter; `--radius-m` accepts 1–2,000 metres. The default concurrency is 4, with
a maximum of 8. Provider calls use
the configured accounts and their usual billing; `--limit` bounds the number
of places, not a dollar amount. Search uses the selected `SEARCH_PROVIDER`,
rather than querying every alternative search vendor for the same evidence.

| Source | What runs | Reuse |
|---|---|---|
| `listings` | DataForSEO category batches, existing name/distance matching, website discovery, hours and normalized claims | Matched listing facts and regional admission: 7 days; failed batch: 1 hour |
| `sites` | Venue homepage, linked menus, menu image/PDF reading when enabled, tagged Wikidata, and evidence evaluation | Website facts and bounded evaluator text: 7 days; Wikidata: 30 days; failures: 1 hour |
| `images` | Website/tagged images, Commons discovery, decoding, classification and blurhash generation | 1–30 days; source max-age/s-maxage is clamped to this range; no-store/private/no-cache responses rejected; image failure backoff applies |
| `search` | One ordinary search for a place's unresolved vocabulary criteria, followed by evidence validation | Validated claims: 7 days; provider-specific snippet policy below |

Listings run first so their discovered websites are available to all later
passes. Unmatched listing records are not stored. Repeating the same regional
listing selection within its TTL does not spend another batch, even when it
found no matches. Changing the selected scope creates a separate admission.

All passes retain the existing robots, outbound routing, cache-control,
licence, source citation and evidence validation rules. Page text is bounded
server-side evaluator input. Raw HTML, menu document bytes and raw model-search
responses are not retained. Website and image refreshes honor the ordinary
cache lifetime rather than the panel's ten-minute interactive reread window.

`DATAFORSEO_LOGIN` and `DATAFORSEO_PASSWORD` enable listings. The app's configured
model key enables evidence and menu/image interpretation, subject to its usual
feature switches. Search also needs a model for validation and the selected
provider's credentials: `PARALLEL_API_KEY`, `TAVILY_API_KEY`, or the configured
model backend for `SEARCH_PROVIDER=openai`. Missing keys skip the relevant
optional work and appear in the plan. `ENRICH_NETWORK=0` refuses a live run.

Parallel snippets require a room-specific cache key in the application. A
regional run supplies no room id, so it does not persist those snippets. It
still stores validated claims through the normal enrichment path. Tavily can
reuse its shared seven-day bounded snippet cache; built-in model search stores
only validated claims and answered-cell metadata. Regional searches use only
place identity, city and the server's attribute vocabulary. They never load
participant requirements. Value-specific cuisine questions, opening-at-a-time
predicates, arrival plans and other live participant context remain demand-driven.

The command prints a plan, progress counts, periodic activity messages and a
final JSON summary. `completed` counts processed places, including those served
from cache. `failed` counts places with incomplete work; `sourceErrors` also
includes a regional listing failure. An unavailable source in the plan is a skip,
not a provider failure. Exit status is 0 on completion, 1 for errors and 130
after interruption. If every selected source is unavailable, the run fails.

Ctrl-C stops admitting new places and lets current work finish persisting.
Rerun the same command to continue: each pass checks durable freshness, so
successful work is reused. An explicit model abstention stays unknown and
normally backs off for a day; a local abstention with an unfinished search can
resume its search on the next run. Provider/model failures do not become facts.
No guarantee is made that every place has evidence, a working site or a usable
image; gaps remain unknown in the app.
