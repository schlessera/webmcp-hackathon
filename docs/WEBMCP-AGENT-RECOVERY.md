# Recovering an agent connection to Spokes

The September 8, 2026 export contains successful discovery, reads and a
successful vegetarian requirement mutation. The `pageTools is not defined`
errors happen in the host's JavaScript REPL before a tool reaches Spokes.
The later required-documentation error interrupts reconnection before
`pageTools` is initialized. The export does not establish why the first
binding disappeared. Re-registering tools on every room update would not fix
that host state, and would invalidate otherwise usable document handles.

## Host recovery recipe

Follow the installed browser skill and its current API documentation. The
export's absolute Windows plugin path and browser-selection helper are not
portable. Preserve existing browser/tab handles when they remain valid.

1. Check only binding existence, without printing tokens, private room state,
   or invitation URLs:

   ```js
   nodeRepl.write({
     agent: typeof agent,
     browser: typeof browser,
     tab: typeof tab,
     pageTools: typeof pageTools,
   });
   ```

2. If bootstrap bindings are absent, run the installed skill's bootstrap. If
   the browser still exists, recover a missing/released tab from that browser
   using its documented claiming flow. Do not reselect a browser to repair a
   tab. A new user turn does not itself require either operation.

3. Read required documentation in a separate cell before tool acquisition.
   In the exported runtime the missing documents were:

   ```js
   nodeRepl.write(await agent.documentation.get("confirmations"));
   nodeRepl.write(await agent.documentation.get("webmcp"));
   ```

   A failed multi-statement cell can leave earlier bindings alive and later
   ones undefined. Inspect existing bindings before declaring them again.
   Use `let` for handles that may need reassignment, then assign rather than
   redeclare. If an existing `const` prevents recovery, use a fresh local name
   in accordance with the REPL's documentation.

4. When the tool binding is absent, or the document changed, acquire it:

   ```js
   let webmcp = await tab.capabilities.get("webmcp");
   let pageTools = await webmcp.fetchTools();
   ```

   This example assumes both names are absent. Reuse a valid handle on the
   same document. If notifications already listed the current catalog, do
   not print `pageTools.description()` again. Print it once only when the
   installed skill requires discovery and no current list is available.

5. Call `sync_session` with `{}` after connecting. For a summary, call
   `get_spatial_context`; inspect only the candidate IDs/details needed.
   Consume every event-delta page before acting. Candidate pagination is a
   separate snapshot and does not advance event watermarks.

6. On `sync_required`, consume missed events, reconsider the intended action,
   and retry using the current revision. If a mutation lost its response,
   an exact retry in the same document can recover the retained idempotency
   receipt. After reload, cache expiry or changed arguments, first check
   current requirements/proposals to avoid repeating an already committed
   action. Store receipt IDs for updates and undo.

Page annotations describe effects; they cannot grant user authority or
disable host confirmation policy. Apply current system/user authorization
and host policy, rather than interpreting every shared-room write as an
automatic additional approval requirement. Explain the actual data and
destination if that policy requires a confirmation. Spokes has no special
API for suppressing a host approval gate.

## What version 4 changes

- Candidate pages have consistent counts and real continuations, query and
  eligibility filtering. Plan, visible need IDs, absolute time windows,
  roster, source dates and outstanding work survive projection.
- Inspection is passive by default and by contract. Evidence source/time and
  requested key/detail groups replace arbitrary recursive truncation.
- Read annotations match execution. Page connection owns background recovery;
  explicit lookup/focus tools disclose their effects.
- Requirement/proposal receipts identify the affected entity. Applied settings
  reflect normalization, and unknown evidence remains a separate class.
- Schemas use enums and shared local definitions without weakening validation.
  Tool names remain stable and registration remains once per document.

The application cannot fix host REPL persistence, redundant host catalog
printing, or a host's interpretation of confirmation policy. If those recur,
file an upstream report with the host/plugin version, exact error, document
transition, and binding-existence output. Redact invite fragments and tokens.

## Repeatable verification

Use an isolated migrated database; API fixtures clear shared evidence caches.
From the worktree, with `DATABASE_URL` set to that database:

```sh
rtk proxy pnpm test:communication
rtk proxy env WEBMCP_NATIVE_FLAGS=1 CHROME_PATH=/path/to/chrome pnpm test:native
```

The first command runs the callback shim. The second uses native Chrome and
fails if `document.modelContext` is absent; it never falls back to a shim.
The native feature flag was probed on Chrome for Testing 151.0.7922.34.
Chromium's [runtime feature definitions](https://chromium.googlesource.com/chromium/src/+/1c6a39e31d935331af4492fb707e0983fc86f873/third_party/blink/renderer/platform/runtime_enabled_features.json5)
declare `WebMCPTesting` and its implication of `WebMCP`. This local development
flag does not establish production origin-trial eligibility. The original
native lane also accepts an origin-trial token for its fixed test origin.

The conversation regression covers summary, passive inspection, filtering,
a response lost after commit, exact retry, reload/re-discovery, retained
participant identity, expired candidate cursors, a concurrent stale write,
catch-up and undo. Unit tests cover all 343 candidate IDs through compact
pages, immutable snapshots, expiry, private projections, and schema equivalence.
These are browser and application tests, not an automated real Codex session.

Current API references: [Chrome imperative WebMCP](https://developer.chrome.com/docs/ai/webmcp/imperative-api),
[Chrome best practices](https://developer.chrome.com/docs/ai/webmcp/best-practices),
and [OpenAI WebMCP integration](https://learn.chatgpt.com/docs/webmcp).

Verified on September 8, 2026: 800 unit tests, 267 API tests, two native Chrome
tests and one shim conversation test passed. `pnpm typecheck`, `pnpm build`
and the generated contract-manifest check passed. The environment used Node
22.18.0 (the repository declares Node 24+) and Chrome for Testing 151.0.7922.34.

For the complete API suite use
`rtk proxy pnpm exec vitest run tests/api --maxWorkers=1` with the isolated
`DATABASE_URL`. Unbounded parallelism exhausted the test database's connection
limit; two workers also exposed an existing assumption in the provider fixture
that no other suite had populated shared OSM evidence. The serial run passed
all 267 tests. This work does not redesign global test-cache isolation.

The serialized catalog decreased from 31,477 to 28,766 characters. The
requirement schema decreased from 9,175 to 6,191. These measurements exclude
host-added origin/URL metadata and pretty-printing; duplicate host catalog
printing is covered by the recovery recipe, not by these size reductions.
