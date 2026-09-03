# Deploying Spokes on Coolify

The app is a single Docker image (Fastify API + WebSocket + the pre-built React
bundle) plus Postgres. `compose.coolify.yaml` is a deploy-ready compose that
Coolify can run directly; local development uses `compose.yaml` with the same
outbound proxy variables passed through to the app service.

## 1. Create the resource

1. In Coolify: **New Resource → Docker Compose**, pointed at this git repo.
2. Set the compose file path to `compose.coolify.yaml`.
3. Coolify builds the `Dockerfile` (production stage: `NODE_ENV=production`,
   server serves the pre-built web bundle via `@fastify/static`).

## 2. Environment variables (set in Coolify)

| Var | Required | Notes |
|---|---|---|
| `DEMO_SECRET_KEY` | **yes** | Any strong random string. HMAC key for guest invite secrets. Must be stable across redeploys or existing invite links break. The compose refuses to seed if it is unset. |
| `APP_URL` | recommended | The public URL Coolify assigns (e.g. `https://spokes.example.coolify.app`). The seed prints participant invite URLs against it. |
| `ORIGIN_TRIAL_TOKEN` | for the ChatGPT/WebMCP path | Chrome WebMCP origin-trial token registered **for the deployed origin** (see §4). Without it the page still works as a normal web app, but ChatGPT's built-in browser will not discover the WebMCP tools on the hosted origin. |
| `OPENROUTER_API_KEY` | recommended | Enables the natural-language surface, matrix evaluation, menu reading, and model-backed refinement through OpenRouter. Leave both provider keys empty for a deterministic no-model deployment. |
| `OPENROUTER_PROVIDERS` | optional | Comma-separated OpenRouter provider slugs to pin, in order (`allow_fallbacks` off). Unset: free routing among endpoints that honour the request. Pin when benchmark runs must be comparable. |
| `OPENAI_API_KEY` | fallback only | Enables the retained OpenAI Responses backend when `LLM_PROVIDER=openai`, or when no OpenRouter key exists. |
| `LLM_PROVIDER` | optional | `openrouter` or `openai`. Defaults to OpenRouter when `OPENROUTER_API_KEY` exists, otherwise OpenAI. |
| `LLM_MODEL` | optional | Default for every LLM job; defaults to `z-ai/glm-5.3-flash`. |
| `LLM_MODEL_ROUTE` | optional | Composer understanding/routing model. Empty inherits `LLM_MODEL`. |
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
| `REFINE_PLAN_WATCHDOG_MS` | optional | Maximum wait for one room plan before replanning; defaults to `REFINE_TICK_MS * 120`. |
| `REFINE_MODEL_CALLS_PER_HOUR` | optional | Per-room model-call budget; defaults to `200`. |
| `REFINE_SEARCHES_PER_HOUR` | optional | Per-room search budget; defaults to `150`. |
| `PIPELINE_TIMEOUT_FETCH_SITE_MS` | optional | Site-dispatch deadline in milliseconds; defaults to `30000`. |
| `PIPELINE_TIMEOUT_FETCH_ASSET_MS` | optional | Asset-dispatch deadline in milliseconds; defaults to `30000`. |
| `PIPELINE_TIMEOUT_FETCH_SEARCH_MS` | optional | Search-dispatch deadline in milliseconds; defaults to `45000`. |
| `PIPELINE_TIMEOUT_PROCESS_JUDGE_MS` | optional | Matrix-judging deadline in milliseconds; defaults to `120000`. |
| `PIPELINE_TIMEOUT_PROCESS_ADJUDICATE_MS` | optional | Adjudication deadline in milliseconds; defaults to `120000`. |
| `PIPELINE_TIMEOUT_PROCESS_VISION_MS` | optional | Vision deadline in milliseconds; defaults to `60000`. |
| `PIPELINE_TIMEOUT_PROCESS_DECODE_MS` | optional | Image-decode deadline in milliseconds; defaults to `30000`. |
| `SEARCH_PROVIDER` | optional | Search provider: `parallel`, `openai`, or `tavily`. Parallel is always the default; `openai` names the built-in search path, which now runs through OpenRouter. |
| `PARALLEL_API_KEY` | when using Parallel | Parallel Search credential. Results are cached per room under its End Customer restriction. |
| `PARALLEL_SEARCH_MODE` | optional | Parallel search processor; `turbo` by default (same price as `fast`, quicker, slightly lower quality), `fast` when quality matters more than latency. |
| `TAVILY_API_KEY` | when `SEARCH_PROVIDER=tavily` | Tavily credential for the optional fallback search provider. |
| `DATAFORSEO_LOGIN` | when listings are enabled | DataForSEO API login for one structured business-listings batch per room pool. |
| `DATAFORSEO_PASSWORD` | when listings are enabled | DataForSEO API password. Treat it as a secret; it is never logged. |
| `LISTINGS` | optional | Set to `0` to disable DataForSEO listings. Enabled when both DataForSEO credentials exist. |
| `PROXY_URL` | optional | Authenticated outbound proxy URL for venue pages, robots, and non-Commons image hosts. Treat it as a secret; it is never logged. |
| `PROXY` | optional | Set to `0` to force all proxy-eligible traffic direct; defaults to enabled when `PROXY_URL` is present. |
| `POSTGRES_PASSWORD` | optional | Defaults to `webmcp`. Set a real one for a public deployment. |
| `SOURCE_COMMIT` | auto | Coolify injects this; it becomes `BUILD_ID` so clients detect new deploys and reload. |

## 3. Domain and ingress

- Assign the domain to the **`app`** service, port **4173**, in the Coolify UI
  (or set `SERVICE_FQDN_APP`). Coolify's proxy terminates TLS and routes to
  `app:4173` over the internal network — that is why the compose exposes the
  port instead of binding it to the host.
- WebSockets: the app serves `/ws` on the same port/origin, so no extra proxy
  config is needed — Coolify's proxy upgrades it automatically.
- Health check hits `/api/meta`; Coolify waits for it before routing.

## 4. Chrome WebMCP origin trial (for the ChatGPT demo)

WebMCP (`document.modelContext`) is behind a Chrome origin trial. The token is
**origin-specific**, so the localhost token used during the spike does not cover
the Coolify domain. Register the deployed origin at the Chrome Origin Trials
console for the WebMCP trial, put the token in `ORIGIN_TRIAL_TOKEN`, and
redeploy. The server injects it as an `Origin-Trial` response header on every
document response (including the Vite/static-served HTML). The page degrades
cleanly without it — it is fully usable as a normal web app; only ChatGPT's
tool discovery on the hosted origin depends on it.

## 5. After deploy

- `migrate` runs once and gates `app`; `seed` runs once (idempotent) and tops
  up `room_demo` with the 31 Berlin Mitte venues and the three participants.
- The two area snapshots (`packages/contracts/data/areas/`) ship inside the
  image; the area picker and `POST /api/rooms` need no extra service, volume
  or environment variable (`docs/DATA-QUALITY.md`, "Engine decision").
- Get the participant invite links from the `seed` container logs (the
  organizer link carries `?surface=chatgpt` for ChatGPT's built-in browser), or
  regenerate them locally with `node scripts/open-participants.mjs` pointed at
  `APP_URL`. The links embed the guest secret in the URL fragment — treat the
  logs as secret-bearing.
- Redeploying keeps the database volume; the seed tops up rather than wiping, so
  a session's widened search scope survives a redeploy. To reset the demo room
  to its initial 800 m scope, run `node apps/server/src/seed.ts --reset` against
  the deployment (Coolify **Execute Command** on the `app` container) — scoped
  to `room_demo`, it never touches the volume.

## 6. Reset / troubleshooting

- **Map stuck on "Loading the shared map…"**: `room_demo.scope` is NULL — an old
  row from before this slice. Run the seed with `--reset` once.
- **Invite link says not authenticated after a redeploy**: `DEMO_SECRET_KEY`
  changed. Set it once and leave it.
- **ChatGPT lists no site tools**: `ORIGIN_TRIAL_TOKEN` missing or registered
  for the wrong origin (§4).
