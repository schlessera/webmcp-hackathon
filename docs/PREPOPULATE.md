# Prepare and resume a region

`pnpm prepopulate` warms shared enrichment caches by OSM reference. It creates no rooms, participants, needs or candidates. Use Node.js 24+, the application's provider configuration, and the database that will serve the region.

```bash
node --env-file-if-exists=.env apps/server/src/migrate.ts
pnpm prepopulate --area berlin-mitte --limit 100 --dry-run
pnpm prepopulate --area berlin-mitte --limit 100 --max-requests 800 --max-cost-usd 5
```

The dry run loads only the committed snapshot and reports configuration availability. It does not contact a database or provider, or verify that an Overture extract has been imported. `sf-soma` selects San Francisco. The default radius is 2,000 metres and the default selection includes every supported place class.

## Checkpoints and limits

Each run prints a `runId`. Stages are stored in `prepopulation_stages`; successful work survives process exits. Eight prepared places form an evaluation buffer, with at most `--concurrency` simultaneous preparation tasks (default 4, maximum 8). The next buffer waits until the current buffer is evaluated and saved. Matrix evaluation still uses the shared eight-place/five-criterion cache and literal-evidence rules.

```bash
pnpm prepopulate:maintenance --run RUN_UUID
pnpm prepopulate --area berlin-mitte --limit 100 --resume RUN_UUID --max-requests 1200 --max-cost-usd 8
```

Resume with the same area, radius, limit, sources and profile. A selection hash rejects accidental changes. A live lease prevents two processes from owning the same run. After an abrupt process exit, its lease expires within two minutes. Completed stages are skipped; deferred stages become eligible at `retryAt`. `--retry-failed` explicitly retries failed/backed-off stages, including stages that reached the normal five-attempt ceiling. Provider and run limits still apply.

A quota refusal stops admission and exits with status `deferred` and exit code **75**. An interruption exits **130** after in-flight work is saved. Failed work exits **1**; a completed run exits **0**. `completed` counts visited places, so use the run's `status` and stage table to decide whether its work finished.

`--max-requests` caps cumulative admitted outbound/model attempts, including retries and redirects. Pending model reservations also occupy this allowance before search. `--max-cost-usd` caps **estimated spend at admission**, reconciled when the provider supplies actual cost. It is not a guaranteed billing ceiling: model prices/usage and unreported provider charges can differ from reservations; proxy bandwidth charges are not included. Unknown costs stay reserved; they are never reported as zero. Raising caps on resume does not reset spend. Missing required schema columns stop the CLI before provider work begins.

`provider_attempts` records wire/model attempts, safe task IDs/status codes, workload, reported or reserved costs, failures and durations. Status output separates these from accepted claims and cache hits. For plain fetches, timing ends at response headers; model/provider reconciliation may extend it. Those timings are not end-to-end place latency.

## Shared resource allocation

The app and CLI use Postgres admission for hourly/daily resource limits. Windows follow UTC hour/day boundaries. Existing process concurrency guards, timeouts, retry policies and proxy circuit breakers remain active. Unrelated clients using the same provider account outside this database are not counted.

| Environment | Default |
|---|---:|
| `OUTBOUND_CALLS_PER_HOUR` / `OUTBOUND_CALLS_PER_DAY` | 5000 / 20000 |
| `LLM_CALLS_PER_HOUR` / `LLM_CALLS_PER_DAY` | 600 / 2000 |
| `OUTBOUND_INTERACTIVE_RESERVE_PERCENT` / `LLM_INTERACTIVE_RESERVE_PERCENT` | 10 |
| `OUTBOUND_BACKGROUND_RESERVE_PERCENT` / `LLM_BACKGROUND_RESERVE_PERCENT` | 20 |
| `MODEL_CALL_COST_RESERVATION_USD` | 0.05 |

Interactive work may use the total allowance. Noninteractive work can use at most 90%; prepopulation can use at most 70%, leaving room for ordinary background work too. Keyed fetch providers have additional account counters configured by `PARALLEL_*`, `TAVILY_*`, `DATAFORSEO_*` and `ACCESSIBILITY_*` `CALLS_PER_HOUR`/`CALLS_PER_DAY` settings. These can also override their reserve percentages.

Queue dispatch preserves the submitting workload and reservation. Bulk photos use background routing/priority. Model capacity is reserved before paid discovery, and an evaluator failure cannot become an evidence omission. Successful empty research and explicit abstentions remain distinct from provider, extraction, persistence and admission failures.

## Sources and profiles

`--sources` accepts `overture,accessibility,listings,sites,images,search`; all are selected by default, with unavailable integrations reported and skipped. `--profile` accepts `explore` (default), `dining` and `accessibility`. Accessibility restricts criteria to wheelchair accessibility; general exploration omits food-specific criteria for other place classes. The dining profile visits food venues first within the selected nearest-place set. Both general profiles retain non-food venues. Queries use public place identity and the server's criterion vocabulary; private room needs are never read by the CLI.

- **Listings:** DataForSEO root/task validation, bounded pagination (`LISTINGS_MAX_PAGES_PER_BATCH`, default 5), immediate matched-fact persistence and durable offsets. Equivalent regional requests can reuse successful batches across rooms and CLI runs. Provider errors retain prior matches and costs.
- **Sites:** websites, linked menus and Wikidata. Readers share permitted extracted-page text, validators and leases. Up to two relevant same-origin navigation pages supplement the homepage/menu. Raw HTML is not retained.
- **Images:** tagged/explicit and website candidates first; Commons geosearch only if those yield no usable image. No candidate is a normal outcome. Operational failure preserves prior images and remains retryable.
- **Search:** the configured Parallel/Tavily/OpenAI adapter, followed by the shared evaluator. Parallel tries up to four result pages to obtain two useful literal spans. Public page copies obey their own cache controls. Parallel API excerpts remain excluded from a roomless shared search cache; validated claims and explicit matrix answers can be reused.

### Overture Places

Overture is a regional discovery source for identity and websites. It does not establish dietary/accessibility claims, and `operating_status: open` does not mean open at the current time. Matching requires both strong name agreement and proximity, rejects domain conflicts, and abstains on ambiguous nearby records. Release, upstream source IDs and attribution remain attached.

Install the official [Overture Python client](https://docs.overturemaps.org/getting-data/overturemaps-py/) on the machine doing the import. Choose an explicit available release from `overturemaps releases list`:

```bash
pnpm prepopulate:overture --area berlin-mitte --release YYYY-MM-DD.N --file /tmp/berlin.geojsonseq --download
```

The command requests only the region's bounding box, writes a SHA-256 manifest, filters the exact regional radius and replaces that region atomically. An invalid or empty import preserves the previous release. Limits are 128 MiB and 100,000 records. For an existing regional GeoJSON-sequence extract, replace `--download` with `--sha256 EXPECTED_HASH`.

Set **`OVERTURE=1`** in the server/CLI environment after importing. The application reads the same database table; it does not need the Python client at runtime. Attribution follows the [Overture source licence information](https://docs.overturemaps.org/attribution/).

### accessibility.cloud

Configure **`ACCESSIBILITY_CLOUD_TOKEN`** and a comma-separated **`ACCESSIBILITY_CLOUD_SOURCE_IDS`** allowlist in the server/CLI environment. These settings are forwarded by the Compose definitions. Do not paste tokens into commands or reports.

The integration uses the documented cached tile endpoint with bounded pagination and one-day tile caching, following the [API's export guidance](https://github.com/sozialhelden/accessibility-cloud/blob/main/app/docs/json-api.md). It includes source and licence metadata, retains original IDs, and accepts explicitly selected CC0/Public Domain, CC BY or ODbL records. Restricted or unidentified licences are skipped. Review selected sources' terms and attribution when configuring access.

The shared adapter reads pet/assistance-dog policy, Wi-Fi qualifiers, quietness, wheelchair assessments, entrances and attached toilets. Reports remain likely; partial access and missing data stay uncertain. Entrance facts do not establish whole-venue access. Independent surveys can contribute to the same place, while ambiguous branches within a source abstain. Conflicting claims retain a disagreement note and their separate source observations. Only identified OSM mirrors/lineage are excluded, rather than every Wheelmap-labelled survey.

Tiles include places without an accessibility block, so standalone toilets are retained. Up to three toilets within 300 m become nearby context, never venue attributes. Distances are straight-line estimates; routes, opening hours, fees and public access remain unconfirmed. Cache version 3 and a source-selection fingerprint invalidate earlier wheelchair-only results. Empty successful matches are cached too, avoiding repeated work for uncovered places. Original observation dates, when supplied, remain separate from download dates.

The reviewed everyday selection is:

```dotenv
ACCESSIBILITY_CLOUD_SOURCE_IDS=ZyDaF8ZrJeGL3m4Cq,Yra2ze6vW9ttX7Tiz,Rf3E4jqTcyTQvGNcP,zFpoqetHjgGbmyHnR,ghEw4XyFpQNLMC45w,ZgrxE24pTiDfv7J5P
```

These IDs are DogMap, Pfotenpiloten, Travelable, Ginto, Places and Facilities Survey, and Berlin public toilets. Token access is still required. The 2011 SF parking snapshot and Berlin parking feeds with inconsistent attribution are held by the adapter pending review. Station/equipment feeds are outside this selection. The [capability registry](../apps/server/src/enrich/accessibility-facts.ts) and [catalogue review](research/spokes-data-and-requirements-2026-09-08.md) document the choices. Each used source retains its own licence and attribution links; token-bearing request URLs are neither cached nor logged.

Live responses can contain language maps for place names; the parser accepts these alongside plain strings. ODbL licences marked `CCSA` are recognized by their canonical Open Data Commons URL, while restricted and unsupported Creative Commons variants remain excluded. The [September 8 activation check](research/accessibility-cloud-2026-09-08.md) records the selected sources and measured regional coverage.

Neither source is enabled by deployment alone: Overture needs an imported extract and its flag; accessibility.cloud needs credentials and suitable source IDs.

## Repair and maintenance

Audit a bounded historical run window first. This command does not make provider requests:

```bash
pnpm prepopulate:maintenance --area berlin-mitte --from 2026-09-07T19:41:00Z --to 2026-09-07T20:15:00Z
```

Add `--apply` to requeue website errors explicitly caused by local budget/capacity refusals and remove unsupported search-attempt markers from omissions in that selection/window. It retains the omissions, valid claims, successful provider data and matrix-backed explicit abstentions. Unsupported markers are uncertain work, not proof of incorrect facts. A subsequent bounded search pass can revisit them.

`pnpm prepopulate:maintenance --prune` removes expired leases/reservations, old quota windows, expired source tiles/batches and unowned provider-attempt history older than 30 days. Run-linked audit history is retained.

## Verification and rollout

The implementation is exercised with injected providers and a dedicated local Postgres database. The [200-place scripted replay](research/data-pipeline-replay-2026-09-08.json) retains a fixed stratified Berlin/SF selection: both arms answer 1,000 cells; batching uses 25 model requests instead of 200. These are scripted abstentions, not measured production accuracy or network speed. Reproduce with:

```bash
node scripts/benchmark-data-pipeline.ts /tmp/data-pipeline-replay.json
```

Deploy the code and migrations together, configure sources, then use a capped regional pilot and monitor its run ID. Measure incremental website/attribute coverage, entity matches, actual cost, retries and visible-room responsiveness before a broad run. No production repair, new provider activation or production rerun is performed by this implementation.
