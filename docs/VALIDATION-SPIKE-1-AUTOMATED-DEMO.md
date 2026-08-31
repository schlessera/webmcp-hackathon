# Validation Spike 1: Automated Three-User WebMCP Demo Environment

Research current as of August 31, 2026.

## Recommendation

Use one shared deployment, one authoritative room, and three tab-scoped
participant sessions. Do not create three app instances, three builds, or three
protocol configurations.

The target developer experience should be:

```text
make demo
  |-- starts app + PostgreSQL
  |-- runs migrations
  |-- idempotently seeds one room and three participants
  |-- starts code watching
  |-- opens Sarah and Joe in isolated Chromium contexts
  `-- prints the organizer URL for ChatGPT's built-in browser
```

Every browser receives the same application bundle and protocol definitions.
Participant identity and authorized projections are runtime data.

The only step that cannot be made fully deterministic is the final ChatGPT
acceptance check: model-side discovery and invocation occur inside the signed-in
desktop product, behind rollout, model, workspace, site-permission, and safety
controls.

## Platform assumption

Working assumption: the ChatGPT Linux desktop app runs on this machine
(Omarchy/Arch x86_64) even though Arch is outside OpenAI's officially supported
list (Ubuntu 24.04/26.04, Debian 13, Fedora 43/44). The Gate 0 entitlement
preflight below is the empirical check of that assumption. If it fails, switch
to a supported demo machine and expose this machine's app through the fixed
HTTPS hostname — nothing else in this plan changes. See the
[OpenAI Linux desktop documentation](https://learn.chatgpt.com/docs/linux/linux-app).

## What ChatGPT currently requires

OpenAI's current requirements are:

- The latest ChatGPT desktop application.
- The built-in browser, not Codex CLI or the IDE extension.
- GPT-5.6 Sol or GPT-5.6 Terra. WebMCP is disabled on Luna.
- A non-Enterprise/non-Edu workspace.
- `Enable site tools` enabled under Settings > Browser > Permissions.
- Feature rollout must have reached the account.
- The page must remain open; navigating away removes its tools.
- Imperative JavaScript registration in the top-level page.
- No declarative WebMCP tools and no tools registered inside iframes.

These are explicit in the
[OpenAI Site tools documentation](https://learn.chatgpt.com/docs/webmcp). The
built-in browser uses a profile separate from the user's regular browser and
supports local routes such as `http://127.0.0.1:4173`; website access can require
approval. See the
[OpenAI Browser documentation](https://learn.chatgpt.com/docs/browser).

No OpenAI API key, backend MCP server, or plugin is required for the spike.

### Best entitlement preflight

Before testing our code, open OpenAI's own documentation in ChatGPT's built-in
browser and inspect **Available site tools**. OpenAI documents tools such as
`search_openai_docs` and `lookup_page` on that site.

- If those tools are absent, the problem is the ChatGPT app, account, workspace,
  selected model, setting, or rollout.
- If those tools appear but ours do not, the problem is our page, registration,
  origin, or lifecycle.

This gives us a clean go/no-go before debugging application code.

## Recommended topology

```text
                         one repository
                              |
                 shared contracts + one app build
                              |
           +------------------+------------------+
           |                                     |
      Node application                       PostgreSQL
  UI + API + WebSocket + WebMCP       rooms, events, projections,
           |                           invites, revisions, versions
           |
     one shared room
       /    |     \
      /     |      \
ChatGPT   Chromium   Chromium
Organizer  Sarah       Joe
```

Recommended concrete stack:

- TypeScript monorepo.
- React/Vite frontend.
- Fastify or another small Node HTTP server.
- Native WebSocket transport.
- PostgreSQL.
- TypeBox plus Ajv, or an equivalent JSON-Schema-first library, as the single
  protocol-schema source.
- Playwright for isolated three-user and native WebMCP tests.
- Docker Compose for all non-GUI infrastructure.

One Node process should serve the production UI, API, and WebSocket endpoint.
Avoid Redis, a separate realtime service, and multi-instance deployment until
the vertical slice passes.

## Critical path

### Gate 0: Provision the real ChatGPT surface

Required once:

- Supported desktop machine.
- Latest ChatGPT desktop app.
- Eligible account/workspace.
- Sol or Terra selected.
- Site tools enabled.
- OpenAI documentation's own tools visible.

If this does not pass, stop. The app cannot compensate for missing product
availability.

### Gate 1: Validation spike 1

Build a deliberately tiny top-level page containing one imperative tool — the
real first tool of the protocol, not a throwaway:

```text
sync_session
```

This is the tool defined in INTERACTION-AND-BINDING.md §2.3 (the sketch-era
`connect_to_session` was merged into it; there is no separate connect tool, and
v1 tool names carry no version suffix — `_v2` appears only on a breaking
change). Its description should say it is the first tool to call on this
planning page. Input schema: `{ "sinceRevision"?: integer }` with
`additionalProperties: false`; annotations `readOnlyHint: true` and
`untrustedContentHint: true`.

Without `sinceRevision` it returns the first-connection result: the shared
result envelope carrying the capability manifest from
INTERACTION-AND-BINDING.md §2.2, extended with the environment versions Gate 5
needs:

```jsonc
{
  "ok": true,
  "revision": 0,
  "buildId": "...",                    // environment addition, drives Gate 5
  "toolContractVersion": "1",          // environment addition, drives Gate 5
  "identity": { "participantId": "...", "displayName": "...", "role": "organizer" },
  "manifest": {
    "protocols": { "negotiation": "v1", "domain": "spatial-destination/v1" },
    "capabilities": [ ... ],
    "privacy": { "allowedVisibilities": [...], "disclosureLevels": [...],
                 "hintTaxonomy": [...] },
    "agreement": { "rule": "all-accept-organizer-commit" },
    "attributeVocabulary": [ ... ],
    "conduct": "You act for exactly one participant. ..."
  },
  "brief": "...",
  "outstanding": []
}
```

With `sinceRevision` it returns the delta + brief + outstanding shape from
NEGOTIATION-PROTOCOL.md §6.1 (for the spike, the delta may be a stub over a
near-empty event log, but the field must exist). Field names follow the
protocol documents exactly: `outstanding`, not `outstandingActions`;
`protocols.domain`, not `protocols.spatial`. The spike page hand-rolls this
result; Gate 2 replaces the hand-rolled shape with the generated contracts
package, which must produce these same names.

Register through `document.modelContext.registerTool()` **at page load**, not
after authentication completes — the binding mandates a static surface
registered at load, and late registration races whatever discovery snapshot
ChatGPT takes. Until the invite-token exchange finishes, the tool returns a
structured `{ ok: false, error: { code: "not_authenticated", recovery: ... } }`
result rather than being absent. Feature-detect the API and show registration
errors visibly in a development diagnostics panel.

Acceptance:

1. **Available site tools** lists `sync_session`.
2. ChatGPT selects and invokes it from a natural-language request.
3. Sources/recent activity shows the invocation.
4. The returned identity, protocol versions, and room revision match the
   visible page.
5. A server log with the same correlation ID confirms which participant
   executed it.
6. Invoking it before token exchange completes returns the structured
   `not_authenticated` result (verifiable in the diagnostics panel).

ChatGPT supports only the imperative top-level subset, so using a form
declaration or iframe would produce a false failure. See the
[OpenAI WebMCP limitations](https://learn.chatgpt.com/docs/webmcp).

### Gate 2: One contract shared everywhere

Create one `contracts` package containing:

- Tool names, descriptions, annotations, and input schemas.
- Negotiation and spatial protocol versions.
- Command and result envelopes.
- Error shapes.
- Realtime messages.
- Authorized projection shapes.

The frontend registration layer, server validation, test fixtures, and
documentation snapshots must all import or generate from this package.

Use three separate version concepts:

- `buildId`: changes with every deployed bundle.
- `toolContractVersion`: changes when tool names, schemas, or result contracts
  change.
- Domain versions: negotiation and spatial versions evolve independently.

Generate a canonical contract manifest and hash it. CI should fail if the
manifest changes without an appropriate version bump.

If a tool's schema changes incompatibly, change its versioned name rather than
rapidly unregistering and re-registering the same name. The current draft
identifies a race in that situation. See the
[WebMCP draft specification](https://webmachinelearning.github.io/webmcp/).

### Gate 3: Three identities against one room

The demo seeder should transactionally upsert:

- One stable demo scenario.
- One room.
- Organizer, Sarah, and Joe.
- Three participant-scoped invitation secrets.
- Prepared initial room data.

Use tab-scoped authorization:

1. The invitation URL carries the secret in the URL fragment, not the query
   string.
2. Page JavaScript exchanges it for a participant token.
3. The token is stored in `sessionStorage`.
4. API calls send it as a bearer token.
5. WebSocket authenticates with its first message.
6. Actor identity is always derived server-side; never accept `actorId` from a
   tool argument.

This allows multiple participants to use the same browser profile without
cookie collisions and prevents secrets from appearing in normal server access
logs or referrers. Reloads preserve identity, which is essential for automatic
protocol reloads. This `sessionStorage` participant token is the normative
identity mechanism; INTERACTION-AND-BINDING.md §5 has been aligned to it (a
session cookie would collide across tabs in one profile, defeating the
three-users-one-profile demo).

For public environments, generate the invite secrets once and retain them
across code deploys. For local-only development, deterministic HMAC-derived
demo tokens are acceptable.

### Gate 4: Revisioned shared state

Implement the smallest real event stream:

- Room revision is monotonically increasing.
- Every command contains `baseRevision`.
- A transaction locks or atomically updates the room revision.
- Stale mutations return `sync_required` with the participant-authorized delta.
  This deliberately resolves NEGOTIATION-PROTOCOL.md §6.2's open
  commutative-rebase question (INTERACTION-AND-BINDING.md §7 open question 1)
  to **always reject** for the POC — simpler and safer; rebase can be added
  later without a contract break.
- Every committed event is projected separately for each participant.
- Private fields are omitted server-side, not hidden by the UI.
- WebSocket notifications are sent only after the database transaction commits.

UI actions and WebMCP callbacks must call the same `submitCommand()` function.
A successful WebMCP result should not return until the visible client state
reflects the committed revision, matching
[Chrome's WebMCP reliability guidance](https://developer.chrome.com/docs/ai/webmcp/best-practices).

### Gate 5: Automatic update propagation

Use two update paths:

- Ordinary UI/CSS code: normal Vite hot reload.
- Contract, tool, authentication, or state-store changes: force a complete page
  reload.

Every client WebSocket welcome message should contain `buildId` and
`toolContractVersion`. If either differs from the loaded page:

1. Preserve the participant token in `sessionStorage`.
2. Reload the page.
3. Reauthenticate.
4. Re-register the complete tool catalog.
5. Fetch the participant projection from the latest revision.

This ensures all three users change together. It also avoids depending on
subtle WebMCP unregistration/HMR timing.

**ChatGPT-surface exception.** The static-surface rule exists because ChatGPT
binds tools at page level and may not observe mid-conversation tool changes;
tools also disappear when the page navigates away. Whether ChatGPT's built-in
browser re-discovers tools after a *programmatic* reload — and whether its
separate-profile browser preserves `sessionStorage` across it — is unverified.
Therefore:

- Chromium participants (Sarah, Joe, Playwright) auto-reload silently.
- The client detects the ChatGPT in-app browser surface (or any surface where
  reload safety is unproven) and shows a "protocol updated — tap to refresh"
  banner instead of silently reloading, so the human refreshes with the
  conversation visible.
- The manual release gate (lane 5) includes one reload-while-conversation-open
  check to measure the actual behavior. If re-discovery proves reliable, the
  banner can be dropped later.

On the server, reject commands from incompatible client contract versions with
`upgrade_required`; the client then reloads (or banners) automatically.

## Docker automation

Use these Compose services:

| Service | Purpose |
|---|---|
| `db` | Pinned PostgreSQL image and durable development volume |
| `migrate` | One-shot migrations; must complete successfully |
| `app` | UI, API, WebSocket, and WebMCP registration bundle |
| `seed-demo` | Idempotent scenario/participant seeding |
| `e2e` | Optional profile with pinned Chrome and Playwright |
| `cloudflared` | Optional public-demo profile using a fixed tunnel |

Compose should wait for PostgreSQL's health check and for migrations to finish
successfully before starting the app. Docker explicitly supports
`service_healthy` and `service_completed_successfully` for this ordering. See
[Docker Compose startup ordering](https://docs.docker.com/compose/how-tos/startup-order/).

Use Compose Watch:

- Sync source directories into the app container.
- Let Vite handle HMR.
- Rebuild when the lockfile, package manifest, Dockerfile, or generated contract
  artifacts change.
- Restart for server configuration changes.

Compose Watch is supported from Compose 2.22; the current development machine
has Compose 5.5.0. See
[Docker Compose Watch](https://docs.docker.com/compose/how-tos/file-watch/).

Suggested command surface:

```text
make doctor        verify Docker, ports, configuration, browser image
make dev           start app/db/migrations with watch enabled
make demo          start/upsert scenario and open/print three participant URLs
make demo-reset    reset only the named demo room, then reseed
make test          unit, contract, API, privacy, and three-user tests
make test-native   native WebMCP discovery and execution in pinned Chrome
make demo-public   enable the fixed HTTPS tunnel
make logs          follow correlated app/demo logs
```

`make demo` should never wipe the volume. Destructive reset belongs only in the
explicitly named reset command.

## Automated test lanes

### 1. Deterministic unit and contract tests

Test:

- Every tool schema with valid, missing, extra, malformed, and oversized
  arguments.
- Server-side Ajv validation; the browser schema is guidance and must not be
  trusted as enforcement.
- Tool descriptions and outputs against recommended character budgets.
- Contract hash and version bump policy.
- Tool return serialization and error normalization.
- Direct UI and WebMCP commands producing identical domain commands.

Chrome recommends concise descriptions and outputs, `readOnlyHint`, and
`untrustedContentHint` for external or user-generated data. See
[Chrome's WebMCP security guidance](https://developer.chrome.com/docs/ai/webmcp/secure-tools).

### 2. Three-user API tests

Create one room and three tokens, then verify:

- All resolve to different participants in the same room.
- No caller can provide or override an actor ID.
- Shared mutations reach all projections.
- Private content appears only in its owner's response.
- Unauthorized fields are absent from serialized network payloads.
- **Agent-private tier**: submitting a requirement with
  `visibility: "agent-private"` stores a declaration only — no payload row
  exists in the database, no payload string appears in server logs
  (NEGOTIATION-PROTOCOL.md invariant 5) — and peers receive only
  existence/aggregate projections. An `evaluate_candidates` verdict batch is
  recorded disposition-only and folds into eligibility.
- Simultaneous conflicting commands produce one commit and one structured
  stale-revision response.
- Reconnecting from an old revision returns the correct authorized delta.

### 3. Three-browser Playwright trajectory

Run one test with three isolated `BrowserContext`s. Playwright specifically
recommends multiple contexts for multi-user scenarios and isolates cookies,
storage, and in-memory state. See
[Playwright browser-context isolation](https://playwright.dev/docs/browser-contexts).

The trajectory should:

1. Join all three invite URLs.
2. Assert unique identities and identical room/protocol/build values.
3. Submit a shared action from Sarah.
4. Submit a private requirement from Joe.
5. Verify all live revisions converge.
6. Verify only Joe's network responses contain the private payload.
7. Dispatch one tool callback through the page's registration layer (in this
   lane via the test-only shim, since stock Playwright Chromium has no
   `document.modelContext`) and assert it produces the identical domain
   command as the equivalent UI gesture. Native discovery/execution is lane 4;
   the shim here proves command-bus convergence only, not WebMCP
   compatibility.
8. Change the contract/build and verify all Chromium clients reload and retain
   identity (the ChatGPT banner path is covered in the manual gate, lane 5).

### 4. Native WebMCP browser test

Do not rely solely on a mock or polyfill.

Primary automated path — the two mechanisms our own WEBMCP-REFERENCE.md
actually documents:

- Register the test origin for the Chrome WebMCP **origin trial** (live since
  Chrome 149) and inject the token as an `Origin-Trial` response header.
- Run a pinned Chrome 149+ stable image headless against that origin.

This avoids depending on undocumented internal feature-flag names.
`chrome://flags/#enable-webmcp-testing` is documented only as an interactive
toggle; no command-line `--enable-features` equivalent is documented, so any
flag-based headless launch must first be verified against current Chromium
source as its own mini-spike before the test lane may rely on it.

Then discover through `document.modelContext.getTools()` and execute through
`executeTool()` (note: `executeTool` takes its arguments as a JSON *string*,
per WEBMCP-REFERENCE.md §6.8). The test should fail immediately if
`document.modelContext` is absent — never silently fall back to the shim. See
[Chrome's WebMCP setup documentation](https://developer.chrome.com/docs/ai/webmcp).

Keep any WebMCP shim test-only. A polyfill passing is not proof that ChatGPT can
discover the native page tools.

### 5. Short manual ChatGPT release gate

This should take about three minutes:

1. Run `make demo`.
2. Open the organizer invitation in ChatGPT's built-in browser.
3. Verify the expected names under **Available site tools**.
4. Ask: "Connect to this session and tell me my participant name, protocol
   versions, current revision, privacy rules, and outstanding actions."
5. Verify `sync_session` appears in recent activity/Sources.
6. Change the room from Sarah's Chromium window.
7. Ask ChatGPT to synchronize (a `sync_session` call with `sinceRevision`).
8. Verify the delta and latest revision.
9. Reload the organizer page while the conversation stays open (or trigger the
   Gate 5 refresh banner); verify **Available site tools** repopulates and the
   participant identity survives. Record the outcome — this is the empirical
   answer to the ChatGPT-reload question in Gate 5.
10. Save a screenshot and correlated server log as a release artifact.

This is the only recurring human gate.

## Public demo access

For same-machine development, expose the app as `http://127.0.0.1:4173`;
OpenAI's browser documentation explicitly supports local pages.

For a supported remote ChatGPT machine or judges, use a fixed HTTPS hostname.
A named Cloudflare Tunnel is suitable:

- `cloudflared` runs as an optional Compose service.
- Only a tunnel token is required at runtime.
- The hostname remains stable across restarts.
- WebSockets are fully supported. See
  [Cloudflare Tunnel's WebSocket support](https://developers.cloudflare.com/cloudflare-one/faq/cloudflare-tunnels-faq/).

Avoid making a Quick Tunnel the standard demo path: it generates a new random
hostname, invalidating bookmarked invite links, site permissions, and any
Chrome origin-trial token.

Register the fixed HTTPS origin (and the local test origin) for the Chrome
WebMCP origin trial and inject the token as an `Origin-Trial` response header —
this is both the native test lane's mechanism and the judging fallback for
ordinary Chrome. Origin trials are temporary, so retain feature detection.

One caution: `make demo` and `make demo-public` print invite URLs whose
fragments carry participant secrets. Locally that is fine; when the tunnel
profile is active, treat terminal output and CI logs as secret-bearing (or
regenerate the demo room's secrets after a public run).

## What not to put on the critical path

- Three application deployments or three frontend builds.
- Three separate databases.
- Three ChatGPT accounts; the repository MVP only requires one ChatGPT
  participant.
- Cookie-only guest identity.
- WebMCP inside an iframe.
- Declarative WebMCP.
- `navigator.modelContext`; the current API is `document.modelContext`.
- A production polyfill as proof of ChatGPT compatibility.
- Full database resets after code changes.
- ChatGPT UI automation through Playwright.
- Cloudflare Browser Run's experimental lab.
- ChatGPT Sites hosting.

OpenAI's documentation materially affects the last point: Sites currently has
no standalone CLI deployment/management workflow, so it conflicts with the
requested repeatable automation. Use an ordinary Docker-backed deployment or
fixed tunnel instead. See the
[OpenAI Sites documentation](https://learn.chatgpt.com/docs/sites).

## Definition of done

The environment is ready when:

- One command produces the same room and three working participant URLs.
- All three pages report the same build and protocol versions.
- Source changes appear automatically.
- Protocol changes force all Chromium clients to reload and re-register; the
  ChatGPT surface shows the refresh banner (or reloads, once step 9 of the
  manual gate proves that safe).
- Identity survives reload without shared-cookie collisions.
- Database migrations and demo seeding are idempotent.
- Three-context Playwright tests pass.
- Native Chrome discovers and calls the real tool registry.
- Privacy tests inspect actual network responses, including the agent-private
  declaration path (no payload stored or logged; peers see aggregates only).
- The ChatGPT desktop app discovers `sync_session`.
- ChatGPT receives the correct participant-specific manifest
  (INTERACTION-AND-BINDING.md §2.2 shape).
- A peer action is later returned as a revision delta.
- A fixed HTTPS demo URL works from the intended presentation machine.

The first action should be Gate 0 plus the one-tool Gate 1 fixture. Until that
passes on a supported ChatGPT desktop environment, map work and the broader
negotiation protocol are off the critical path.
