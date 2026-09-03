# Spokes

A shared map where a small group and their personal AI agents privately
negotiate a meeting venue — state requirements (shared / application-private /
agent-private), see live eligibility, resolve impasses with quantified
counterfactuals under in-page consent, reach an organizer-committed agreement,
and hand off to navigation. Built on **WebMCP**: 20 tools on
`document.modelContext` expose two custom protocols (`negotiation/v1` +
`spatial-destination/v1`), so a personal agent acts in the same live session the
human sees, one command model for clicks and tool calls alike.

**Status: pre-submission.** The vertical slice is built and passes 364 automated
tests (222 unit + 128 three-user API + 14 browser e2e); two adversarial reviews ran
with the critical findings fixed. Not yet done: live eyes-on verification, the
WebMCP-in-ChatGPT gate for the new tools, UX polish. Read
[docs/PROJECT-STATUS.md](docs/PROJECT-STATUS.md) first, then
[docs/DEMO-RUNBOOK.md](docs/DEMO-RUNBOOK.md).

Product concept and protocol design live in [docs/](docs/) and
[docs/protocols/](docs/protocols/). The original transport core came from
[docs/VALIDATION-SPIKE-1-AUTOMATED-DEMO.md](docs/VALIDATION-SPIKE-1-AUTOMATED-DEMO.md):
one shared deployment, one authoritative room, three tab-scoped participant
sessions (ChatGPT organizer + two Chromium participants).

## Layout

```
packages/contracts   single protocol-schema source (TypeBox): tools, commands,
                     envelopes, errors, realtime messages, manifest + hash;
                     data/ — Berlin Mitte venue dataset (OSM/ODbL) + attribution
apps/server          Fastify: UI serving, API, WebSocket, command bus, event log
                     with revisions, per-participant projections, council
                     (eligibility + impasse counterfactuals), spatial read routes
apps/web             React/Vite: MapLibre map UI (pins, requirement/decisions
                     panels, arrival), invite exchange, sessionStorage identity,
                     19 WebMCP tools registered at page load, diagnostics panel
scripts              one-time OSM extract + curation; open-participants launcher
tests/unit           lane 1 — schemas, budgets, contract hash, eligibility,
                     projection redaction
tests/api            lane 2 — three-user API + privacy-at-the-wire + impasse flow
tests/e2e            lane 3 — three-context Playwright trajectory + product UI
                     lane 4 — native WebMCP in real Chrome 149+ (origin trial)
```

Places: two areas (Berlin Mitte, San Francisco SoMa) on OpenStreetMap
snapshots built by `make venues`; what was measured about each city's data,
why no public place API is in the request path, and the engine decision are
in [docs/DATA-QUALITY.md](docs/DATA-QUALITY.md); what a room looks up about
a place beyond its record (menus, links, descriptions, awards) and which
sources were rejected are in [docs/ENRICHMENT-SOURCES.md](docs/ENRICHMENT-SOURCES.md).

Deploy: [docs/DEPLOY-COOLIFY.md](docs/DEPLOY-COOLIFY.md)
(`compose.coolify.yaml`). Handoff/status: [docs/PROJECT-STATUS.md](docs/PROJECT-STATUS.md).

## Quick start

```
make doctor        # verify Docker, ports, configuration
make dev           # app + db + migrations with compose watch (HMR)
make demo          # idempotently seed; prints three participant URLs
make demo-reset    # reset ONLY the demo room, then reseed
make update        # after git pull: rebuild all images, migrate, restart, reseed
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

## WebMCP tools (19)

All registered through `document.modelContext.registerTool()` at page load from
the top-level document (imperative only; no iframes, no declarative forms;
static surface — no phase-gated registration). 9 negotiation + 10 spatial:
`sync_session`, `submit_requirement`, `withdraw_requirement`,
`set_requirement_active`, `evaluate_candidates`, `respond_to_proposal`,
`resolve_private_request`, `set_ready_state`, `confirm_agreement`;
`get_spatial_context`, `inspect_candidates`, `look_up_places`,
`set_search_scope`, `add_candidates`, `propose_destination`,
`focus_destination` (page-local), `plan_arrival`, `attest_attribute`,
`prepare_navigation`. Two
applying commands (`ConfirmPrivateRequest`, `CommitAgreement`) are UI-only —
in the schema registry but bound to no tool, so an agent can stage but only a
human commits on the page. `sync_session`'s first call (no `sinceRevision`)
returns the capability manifest that teaches both protocols; later calls return
delta + brief + outstanding. Before the invite-token exchange finishes, tools
return a structured `not_authenticated` result. Binding details:
[docs/protocols/INTERACTION-AND-BINDING.md](docs/protocols/INTERACTION-AND-BINDING.md).

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
