# WebMCP Hackathon — Automated Three-User Demo Environment

Implementation of [docs/VALIDATION-SPIKE-1-AUTOMATED-DEMO.md](docs/VALIDATION-SPIKE-1-AUTOMATED-DEMO.md):
one shared deployment, one authoritative room, three tab-scoped participant
sessions (ChatGPT organizer + two Chromium participants).

## Layout

```
packages/contracts   single protocol-schema source (TypeBox): tools, commands,
                     envelopes, errors, realtime messages, manifest + hash
apps/server          Fastify: UI serving, API, WebSocket, command bus,
                     event log with revisions, per-participant projections
apps/web             React/Vite: invite exchange, sessionStorage identity,
                     WebMCP registration at page load, diagnostics panel
tests/unit           lane 1 — schemas, budgets, contract hash, error model
tests/api            lane 2 — three-user API + privacy-at-the-wire tests
tests/e2e            lane 3 — three-context Playwright trajectory
                     lane 4 — native WebMCP in real Chrome 149+ (origin trial)
```

## Quick start

```
make doctor        # verify Docker, ports, configuration
make dev           # app + db + migrations with compose watch (HMR)
make demo          # idempotently seed; prints three participant URLs
make demo-reset    # reset ONLY the demo room, then reseed
make test          # lanes 1-3 (needs `docker compose up -d db` + migrations)
make test-native   # lane 4 (needs real Chrome >= 149 + ORIGIN_TRIAL_TOKEN)
make demo-public   # fixed HTTPS tunnel (needs TUNNEL_TOKEN)
make logs          # follow correlated app logs
```

Local without Docker: `docker compose up -d db`, then

```
DATABASE_URL=postgres://webmcp:webmcp@127.0.0.1:5432/webmcp \
  node apps/server/src/migrate.ts && node apps/server/src/seed.ts && \
  node apps/server/src/server.ts
```

## The one registered tool (Gate 1)

`sync_session` — registered through `document.modelContext.registerTool()` at
page load from the top-level document (imperative only; no iframes, no
declarative forms). Before the invite-token exchange finishes it returns a
structured `not_authenticated` result. First call (no `sinceRevision`) returns
the capability manifest; later calls return delta + brief + outstanding.

## Version concepts (Gate 2/5)

- `buildId` — per deployed bundle (`BUILD_ID` env; random per dev start).
- `toolContractVersion` — bumped when tool names/schemas/result contracts
  change; CI-checked via `packages/contracts/contract-manifest.json`
  (regenerate: `pnpm --filter @webmcp-hackathon/contracts generate:manifest`).
- Protocol versions — `negotiation/v1`, `spatial-destination/v1`, independent.

Contract-version mismatch on a command returns `upgrade_required`; a WS welcome
with a different `buildId`/`toolContractVersion` silently reloads all known
surfaces. Manual gate step 9 was run on 2026-08-31: ChatGPT's built-in browser
re-discovers the tools after a programmatic reload and identity survives, so
the ChatGPT surface reloads silently too; only unknown non-Chromium surfaces
keep the "protocol updated — tap to refresh" banner.

## Manual ChatGPT release gate (lane 5)

See the spike doc's five-lane section. Entitlement preflight first: open
OpenAI's docs in ChatGPT's built-in browser and confirm their own site tools
appear under **Available site tools** before debugging this app.

## Secrets

Invite URLs carry participant secrets in the URL fragment. Locally fine; with
the tunnel profile active, treat terminal/CI output as secret-bearing or
regenerate the demo room's secrets afterwards (`make demo-reset`). Demo
secrets are HMAC-derived from `DEMO_SECRET_KEY` (local development only).
