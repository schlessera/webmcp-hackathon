# Production Compose configuration

Maintained configuration reference, checked against the repository on
2026-09-07. Use [DEPLOY.md](DEPLOY.md) for the configured Caddy/Hetzner
workflow. The base file is named `compose.coolify.yaml`; it is also usable as
the basis of a Coolify resource, but that alternative has not been validated
against a live resource in this documentation review.

## 1. Stack and optional Coolify setup

The production image contains Fastify, WebSocket handling, and the prebuilt
React bundle. The base Compose runs Postgres plus one-shot migration and seed
services before starting the app. The app uses a non-root image user, drops
Linux capabilities, and has memory/CPU/process limits. It expects one app
process for realtime state and quotas.

For Coolify, create a Docker Compose resource using
[compose.coolify.yaml](../compose.coolify.yaml), supply the environment below,
and route its domain to the `app` service's internal port 4173. Validate the
platform's proxy network, health checks, WebSocket upgrades, and release
label yourself. The Caddy deployment instead adds
[compose.prod.yaml](../compose.prod.yaml).

## 2. Environment variables

The table describes **production Compose defaults and pass-throughs**. Bare
Node defaults can differ: for example, the refinement worker defaults to
1,000 model and 750 search calls per room/hour, while this Compose sets
200 and 150. A host `.env` value only reaches a container when Compose passes
it. Check [server config](../apps/server/src/config.ts),
[security admission](../apps/server/src/security.ts), and the Compose file
when adding overrides.

| Var | Required | Notes |
|---|---|---|
| `DEMO_SECRET_KEY` | **yes** | Strong stable HMAC key for deterministic local demo fixture secrets. Compose requires it for seed and app. Ordinary room recovery/join secrets are random. |
| `APP_URL` | **yes** | Exact public HTTPS origin. Used for origin checks and printed invite URLs; the Hetzner bootstrap sets it from `APP_DOMAIN`. |
| `TRUSTED_PROXIES` | **yes** | Actual ingress proxy IPs/CIDRs. Use an isolated trusted proxy network or explicit proxy addresses; never trust arbitrary forwarded headers. |
| `ROOM_LIMIT` | optional | Combined room-creation and plan-preview requests per IP per hour; defaults to `50`. |
| `ORIGIN_TRIAL_TOKEN` | for origin-trial enablement | Chrome WebMCP token for the exact deployed origin when using the origin trial. Browser/host support must be verified separately (§4). |
| `OPENROUTER_API_KEY` | recommended | Enables the natural-language surface, matrix evaluation, menu reading, and model-backed refinement through OpenRouter. Leave both provider keys empty for a no-model deployment; other network-backed sources can still run. |
| `OPENROUTER_PROVIDERS` | optional | Comma-separated OpenRouter provider slugs to pin, in order (`allow_fallbacks` off). Unset: free routing among endpoints that honour the request. Pin when benchmark runs must be comparable. |
| `OPENAI_API_KEY` | fallback only | Enables the retained OpenAI Responses backend when `LLM_PROVIDER=openai`, or when no OpenRouter key exists. |
| `LLM_PROVIDER` | optional | `openrouter` or `openai`. Defaults to OpenRouter when `OPENROUTER_API_KEY` exists, otherwise OpenAI. |
| `LLM_MODEL` | optional | Default for every LLM job; defaults to `openai/gpt-5.6-luna`. |
| `LLM_REASONING_EFFORT` | optional | Reasoning effort for every LLM job; defaults to `xhigh`. Accepts `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`; support depends on the model/provider. An explicit deployment value overrides the default. |
| `LLM_MODEL_ROUTE` | optional | Composer/goal understanding model. Empty inherits `LLM_MODEL`. |
| `LLM_MODEL_JUDGE` | optional | Matrix, inference, adjudication, screening, and built-in-search model. Empty inherits `LLM_MODEL`. |
| `LLM_MODEL_AGENT` | optional | Participant tool-loop model. Empty inherits `LLM_MODEL`. |
| `LLM_MODEL_VISION` | optional | Place-image and menu-reader model. Empty inherits `LLM_MODEL`. |
| `NL_FAST_MODEL` | deprecated | Compatibility setting retained in config; job call sites use `LLM_MODEL_ROUTE` or `LLM_MODEL_JUDGE`. |
| `NL_SMART_MODEL` | deprecated | Compatibility setting retained in config; job call sites use `LLM_MODEL_AGENT` or `LLM_MODEL_JUDGE`. |
| `MENU_READER_MODEL` | deprecated | Compatibility setting retained in config; menu reading uses `LLM_MODEL_VISION`. |
| `REFINE` | optional | Set to `0` to disable the continuous refinement worker; enabled by default when network and model access are available. |
| `REFINE_IDLE_STOP_MS` | optional | How long refinement remains alive after the last room participant leaves; defaults to `600000`. |
| `REFINE_TICK_MS` | optional | Working-loop interval in milliseconds; defaults to `1000`. |
| `REFINE_IDLE_TICK_MS` | optional | Empty-queue polling interval in milliseconds; defaults to `30000`. |
| `REFINE_MODEL_CALLS_PER_HOUR` | optional | Per-room model-call budget; defaults to `200`. |
| `REFINE_SEARCHES_PER_HOUR` | optional | Per-room search budget; defaults to `150`. |
| `SEARCH_PROVIDER` | optional | Search provider: `parallel` (default), `openai`, or `tavily`. `openai` selects model-backed search through the configured LLM backend. |
| `PARALLEL_API_KEY` | when using Parallel | Parallel Search credential. Results are cached per room under its End Customer restriction. |
| `PARALLEL_SEARCH_MODE` | optional | Parallel search processor; defaults to `turbo`. Check provider support before overriding. |
| `TAVILY_API_KEY` | when `SEARCH_PROVIDER=tavily` | Tavily credential for the optional fallback search provider. |
| `DATAFORSEO_LOGIN` | when listings are enabled | DataForSEO login for structured business-listing enrichment, including regional prepopulation. |
| `DATAFORSEO_PASSWORD` | when listings are enabled | DataForSEO password. Treat it as a secret. |
| `LISTINGS` | optional | Set to `0` to disable DataForSEO listings. Enabled when both DataForSEO credentials exist. |
| `PROXY_URL` | optional | Authenticated outbound proxy URL for eligible venue/page/image traffic. Treat it as a secret. Proxy-side DNS is outside direct-fetch address validation. |
| `PROXY` | optional | Set to `0` to force all proxy-eligible traffic direct; defaults to enabled when `PROXY_URL` is present. |
| `POSTGRES_PASSWORD` | **yes** | Existing database password; no production default. The Hetzner bootstrap generates it once on first deployment. Preserve it across redeploys. |
| `SOURCE_COMMIT` | auto | Release label passed as `BUILD_ID`; the Hetzner bootstrap writes it from `.commit`. Set it explicitly for another deployment workflow. |
| `GLOBAL_ROOM_LIMIT` | optional | Combined room creation and plan preview ceiling across clients; production Compose defaults to 100/hour. |
| `LLM_CALLS_PER_HOUR` / `LLM_CALLS_PER_DAY` | optional | Process-wide model admission ceilings; defaults 600/hour and 2,000/day. |
| `LLM_CONCURRENCY` | optional | Process-wide simultaneous model calls; default 6. |
| `OUTBOUND_CALLS_PER_HOUR` / `OUTBOUND_CALLS_PER_DAY` | optional | Process-wide outbound admission ceilings; defaults 5,000/hour and 20,000/day. |


The base Compose derives `DATABASE_URL` from `POSTGRES_PASSWORD`, sets
`NODE_ENV=production` and `PORT=4173`, and maps `APP_URL` to `PUBLIC_ORIGIN`.
The Caddy overlay additionally requires `APP_DOMAIN`; keep it consistent
with the HTTPS origin. Trusted proxy addresses must correspond to the actual
isolated ingress network, not arbitrary client-supplied forwarding headers.

Additional code-level switches such as `ENRICH_NETWORK`, `MENU_READER`,
`REFINE_PLAN_WATCHDOG_MS`, and `PIPELINE_TIMEOUT_*` require an explicit
container environment override if used. They are not passed through by the
base production Compose. See [refinement settings](../apps/server/src/refine/worker.ts)
and [pipeline deadlines](../apps/server/src/pipeline/scheduler.ts).

Provider quotas and application admission limits do not impose a currency
spending cap. Set provider-side controls separately. Quotas here are
process-local and reset on restart; see [Known limitations](KNOWN-LIMITATIONS.md).

## 3. Ingress and health

Serve the public page, API, and `/ws` on the same HTTPS origin. The app's
internal port is 4173. Caddy handles TLS and forwards WebSocket upgrades;
an alternative proxy must do the same. The app health check requests
`/api/meta`, and production responses enforce origin/browser security
boundaries. A responding health endpoint does not test model providers,
venue sources, room creation, or native WebMCP.

## 4. Chrome WebMCP enablement

The application registers tools through `document.modelContext` when the
browser exposes it. For an origin-trial-enabled browser, register the exact
deployed HTTPS origin and set `ORIGIN_TRIAL_TOKEN`; the server supplies the
response header. Check the token's scope and expiry. Local testing can use
Chrome's WebMCP testing flag instead. Native availability and tool discovery
also depend on the browser and agent host.

See [Chrome's current WebMCP documentation](https://developer.chrome.com/docs/ai/webmcp)
and [the application binding](protocols/INTERACTION-AND-BINDING.md).
The page remains usable without WebMCP.

## 5. Data and invitations

Berlin and San Francisco snapshots ship inside the image; room creation does
not need a separate geographic query service. Optional runtime enrichment
requires the configured providers. [Prepopulation](PREPOPULATE.md) can warm
the serving database's caches before a demo.

Seed creates/updates `room_demo`. Its logs include secret-bearing fixture
links. Seeded member recovery links are available only with explicit local
development fixture support; production members claim newly minted,
browser-bound `#join=` links. Follow [the demo runbook](DEMO-RUNBOOK.md) for
an isolated local fixture and [DEPLOY.md](DEPLOY.md) for deliberate resets.

## 6. Release checks

Run the release checks in [DEPLOY.md](DEPLOY.md), inspect migration/seed exit
status, compare the served `buildId` with the intended release, and validate
HTTPS and realtime behavior. Keep the existing database password and volume
across redeploys. App code rollback does not undo migrations. Credentials,
backups, restore testing, and provider spending controls are operator-owned.
