# Deploying Spokes on Coolify

The app is a single Docker image (Fastify API + WebSocket + the pre-built React
bundle) plus Postgres. `compose.coolify.yaml` is a deploy-ready compose that
Coolify can run directly; local dev keeps using `compose.yaml` (unchanged).

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
