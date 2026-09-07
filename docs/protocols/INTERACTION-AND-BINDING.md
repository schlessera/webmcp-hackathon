# Protocol Interaction and WebMCP Binding

Implementation reference, checked against `main` on 2026-09-07. This describes
the binding Spokes currently ships. The companion
[negotiation](NEGOTIATION-PROTOCOL.md) and
[spatial](SPATIAL-PROTOCOL.md) documents also contain design goals; deferred
behavior is called out here and in [Known limitations](../KNOWN-LIMITATIONS.md).

The executable sources are the [tool catalog](../../packages/contracts/src/tools.ts),
[command schemas](../../packages/contracts/src/commands.ts),
[response types](../../packages/contracts/src/envelope.ts), and
[browser adapter](../../apps/web/src/webmcp.ts).

## 1. Layering

```text
Page controls / external WebMCP agent / approved built-in agent action
                              │
                    authenticated HTTP
                              │
       command bus: authorization, revisions, consent, domain rules
                              │
              PostgreSQL state and revisioned events
                              │
             viewer-specific HTTP reads + WebSocket updates
                              │
                        page projection
```

1. Negotiation supplies participant identity, requirements, stances,
   adjustments, readiness, and agreement. Spatial payloads supply place
   criteria, search scope, evidence, destinations, and arrival plans. The
   implementation shares an engine; a separately reusable, domain-opaque
   negotiation package remains an architectural goal.
2. A veto on a map pin uses `RespondToProposal`, just like an agent stance.
   Domain commands use the same authorization and revision checks.
3. The shared map reflects server state. `focus_destination` changes the
   caller's map focus; the mounted page can publish viewing presence and
   start enrichment for that place. Realtime delivery uses WebSocket; catch-up uses
   HTTP sync. There is no SSE transport.
4. Page gestures and WebMCP mutations converge on the same
   [command bus](../../apps/server/src/engine.ts). The built-in tool-calling
   agent proposes a command for owner approval before it reaches that bus
   (§5.5). Reads and enrichment have separate endpoints and can start
   background work without becoming negotiation commands.
5. The manifest declares negotiation and domain protocol versions separately.

## 2. WebMCP binding

### 2.1 Registration model: static surface

The page feature-detects `document.modelContext.registerTool()` and starts
registering the entire catalog once, before React mounts. Registration is
asynchronous and bootstrap does not await its completion, so it can overlap
rendering and authentication. Tools stay registered across room phases;
authorization and phase failures are results. The page remains usable when
WebMCP is unavailable.

Spokes uses imperative registration in the top-level document. This is an
application choice, not a claim that WebMCP lacks dynamic discovery,
declarative tools, or frame support. Chrome currently documents all of those;
its API remains experimental. Native use requires a browser with WebMCP
enabled, for example through Chrome's testing flag or an applicable origin
trial. See [Chrome's overview](https://developer.chrome.com/docs/ai/webmcp)
and [imperative API](https://developer.chrome.com/docs/ai/webmcp/imperative-api).

`?shim=webmcp` installs a test dispatcher only when the native API is absent.
It records schemas and invokes the same callbacks, but does not implement
native discovery or schema validation. Passing shim tests proves application
integration, not browser or agent-host compatibility.

### 2.2 First-connection contract

Before a room exists, call `describe_regions`, then `open_room` with `goal`,
`organizerName`, and a returned `regionId`. Opening previews the goal, creates
the plan and room, authenticates its organizer, mints one member invitation,
and schedules navigation into the room. It uses the same preview and creation
endpoints as onboarding, but does not pause at the page's plan-review screen.
It can fall back to a single food step if preview returns no steps.

Once authenticated in a room, call `sync_session({})`. Omit **both**
`sinceRevision` and `cursor` to receive the manifest. The sync result also
includes identity, phase, room revision, `buildId`, `toolContractVersion`, a
brief, participant presence/readiness, and outstanding decisions. A
continuation returns a delta instead of the manifest (§3.1).

The [live manifest](../../packages/contracts/src/manifest.ts) contains:

| Field | Current value or meaning |
|---|---|
| `protocols` | `negotiation: "v1"`, `domain: "spatial-destination/v1"` |
| `capabilities` | `destination-search`, `map-selection`, `navigation-handoff`, `private-screening`, `impasse-resolution` |
| `privacy.allowedVisibilities` | `shared`, `application-private`, `agent-private` |
| `privacy.disclosureLevels` | `verdicts-only`, `category-hint`, `predicate`, `shared` |
| `privacy.hintTaxonomy` | `dietary`, `accessibility`, `budget`, `distance`, `time`, `personal-history`, `atmosphere`, `other` |
| `agreement.rule` | `all-accept-organizer-commit`; readiness and accept/**abstain** rules are detailed in §4.5 |
| `attributeVocabulary` | `vegetarian-options`, `vegan-options`, `gluten-free-options`, `halal-options`, `lactose-free-options`, `wheelchair-accessible`, `outdoor-seating`, `dog-friendly`, `wifi`, `takeaway`, `delivery`, `price-level`, `cuisine` |
| `attributeLabels` | Human-readable labels for those keys |
| `priceLevelEur` | Estimated upper per-person bands: `1 → 10`, `2 → 15`, `3 → 25`, `4 → 40` |
| `conduct` | Act for one participant, submit authorized changes, use privacy controls, and supply the last synced revision |

The disclosure-level strings are vocabulary, **not an implemented disclosure
request workflow**. Outstanding items currently cover candidate evaluation,
stances, and adjustments. `resolve_private_request` resolves adjustments only.

### 2.3 The tool surface (24 tools)

The tables match the registered catalog: two opening tools, ten negotiation
tools, and twelve spatial tools. **RO** and **UGC** report the actual
`readOnlyHint` and `untrustedContentHint` annotations. They are hints, not an
authorization or content-sanitization boundary.

| Opening tool | RO | UGC | Behavior |
|---|---|---|---|
| `describe_regions` | ✓ | | Prepared regions, place classes, and recorded fact coverage; no participant required |
| `open_room` | | | Creates a room from a goal and enters it; no prior participant required |

| Negotiation tool | RO | UGC | Behavior |
|---|---|---|---|
| `sync_session` | ✓ | ✓ | Manifest on first connection; paginated events on catch-up; identity and outstanding decisions |
| `submit_requirement` | | | Create/update the caller's need; agent-private declarations contain no payload or note |
| `withdraw_requirement` | | | Withdraw the caller's need |
| `set_requirement_active` | | | Set the caller's need aside or restore it |
| `evaluate_candidates` | | | Up to ten verdicts for the caller's agent-private needs |
| `respond_to_proposal` | | ✓ | Accept, reject, abstain, or conditionally accept; accepting also marks the caller ready |
| `resolve_private_request` | | | Grant/deny an addressed adjustment; over-bound grants stage for page confirmation |
| `set_ready_state` | | | Mark the caller ready or contributing |
| `set_origin` | | | Set the caller's private starting point; live sharing is a separate page control |
| `confirm_agreement` | | | Organizer stages a proposal for final page confirmation |

| Spatial tool | RO | UGC | Behavior |
|---|---|---|---|
| `find_landmarks` | ✓ | | Resolve a name to landmark IDs and locations in the room's area |
| `get_spatial_context` | ✓ | ✓ | Compact scope, feasibility, candidates, proposals, agreement, and outstanding work |
| `inspect_candidates` | ✓ | ✓ | Compact records for one to three IDs; optional `intent` (open/read) and `force` |
| `set_search_scope` | | | Organizer directly changes the room's area/transport scope |
| `add_candidates` | | | Add up to 40 stable place refs discovered through the page's explore layer |
| `look_up_places` | | | Start lookup for one to three candidates, optionally focusing up to six `keys`; supports `force` |
| `propose_destination` | | | Create a shared proposal for a current candidate |
| `focus_destination` | ✓ | | Pan/highlight the caller's map; viewing presence and enrichment can follow |
| `plan_arrival` | | | Record the caller's walk/bike/car plan and optional pickup note after agreement |
| `confirm_fact` | | | Record a fact the caller verified, shared within this room |
| `attest_attribute` | | | Add shared participant evidence, confidence, and a note |
| `prepare_navigation` | ✓ | | Build `geo:`, Google Maps, and Apple Maps handoff links from held coordinates |

Snake-case room mutations map to the equivalent PascalCase command
(`confirm_fact` → `ConfirmFact`, for example). Spatial reads, sync, opening,
and local focus use dedicated handlers. `CommitAgreement`,
`ConfirmPrivateRequest`, `SetOriginSharing`, and `UnconfirmFact` have page
controls but no registered tool. The built-in agent's approval endpoint is
also outside this catalog.

Schemas use closed objects, bounded arrays/strings, enums, and stable IDs.
Free text is intentionally supported for goals, names, search queries, text
needs, reasons, and notes. A text need can become a question criterion with
evidence; it is not automatically treated as satisfied. Fetch current IDs
from results rather than inventing candidate, requirement, or proposal IDs.

### 2.4 What an agent actually receives

Tool results are compact projections, not copies of the full page API.
`get_spatial_context` starts with at most eight candidates, ordered by
eligibility then walking estimate. It omits the HTTP context's detailed
facets/needs, origins, pool/refinement progress, and plan fields (`goal`,
`steps`, `activeStepId`). Further budget compaction may remove more.
Proposal summaries expose `accepts` counted from viewer-visible accept
stances, `vetoStands`, and the caller's `ownStance`; that count is not a tally
of peers' hidden private stances.

`inspect_candidates` returns compact attribute/verdict summaries and each
candidate's `mapRevision`. It omits detailed provenance rows, hours,
coordinates, and image URLs; images become a count. Passing two or three IDs
reads several records but does not open the page's comparison panel. Use
`intent: "read"` for a passive reread; `intent: "open"` can initiate background
fact work despite the read-only annotation. Omitting `intent` also starts
lookup/adjudication, with a bounded wait before returning. `look_up_places` can perform
paid I/O and cache writes, so it has no read-only hint.

`focus_destination` has no negotiation command, but the mounted page reports
its selected place through WebSocket viewing presence. Peers can see who is
looking at a place, and the server can start enrichment. It does not pan
other participants' maps. Its read-only hint does not mean the focus is private
or free of background work.

Some catalog descriptions currently overstate behavior: soft needs do **not**
yet affect ranking, and evidence adjudication can mark an explicit venue/chain
statement verified. Lookup is not restricted to likely results. Use the
behavior documented here when interpreting those descriptions.

## 3. Results, errors, and output budgets

A registered callback returns a WebMCP text-content wrapper. Its `content`
array contains one `{type: "text", text: "<serialized JSON>"}` entry, and
`truncated` reports whether encoding required compaction.

The embedded JSON for a successful **command** has `ok`, `revision`, and
`outstanding`, with optional `effect`, `staged`, `syncHint`, and `replayed`.
`staged: true` means the requested consequence still awaits confirmation.
`replayed: true` identifies a successful idempotency replay. Read, opening,
and local-focus results have their own shapes; not every success has a room
revision or outstanding list.

The shared failure shape is `{ok:false,error:{code,message,recovery}}`, with
an optional `delta` for `sync_required`. The
[closed error enum](../../packages/contracts/src/errors.ts) is:

```text
sync_required          not_authorized       invalid_input
not_found              phase_unavailable    consent_required
bound_exceeded         not_authenticated    upgrade_required
temporarily_unavailable
```

Most command/transport failures use this shape. It is not universal: some
read errors lack recovery text, and the callback wrapper rethrows unexpected
exceptions after recording diagnostics. Callers must handle promise rejection
as well as `{ok:false}`.

Application budgets are 30 characters per tool name, 500 per description,
150 per parameter description, 200 per effect/note, and 400 per sync brief.
Serialized result JSON normally has a 1,500-character allowance;
`sync_session` and **any result containing `delta`** receive 8,000. These are
JavaScript string-length limits, not byte limits or browser-enforced quotas.

The adapter compacts ordinary results structurally, preserves valid JSON,
and reports `truncated` plus omitted item/field/character counts. A manifest
or delta that still exceeds its allowance fails explicitly instead of
silently deleting protocol state. A compact result is not an exhaustive
candidate list or evidence ledger.

### 3.1 Revisions, catch-up, and retries

Every revisioned mutation carries `baseRevision`. The server rejects all
stale mutations with `sync_required`; there is no commutative stale-write
rebase. Consume missed events, reconsider the action, then submit against
the current revision.

For incremental sync, send `sinceRevision`; while `delta.truncated` is true,
continue with its opaque `cursor`. `throughRevision` is the last stored
event consumed by that page, including events omitted by the viewer's privacy
projection. It can trail the response's room-head `revision`. Do not skip to
the head while pages remain. `resyncRequired: "backlog_too_large"` requests a
fresh full projection. A future `sinceRevision` or a cursor whose consumed
revision is ahead of the room is rejected. A cursor's target revision is
clamped to the room head.

The browser separates its latest known room revision from its consumed
projection watermark. Ordered WebSocket frames carry continuity information;
a gap triggers catch-up. Sockets use 30-second pings, expire without a pong
after 45 seconds, and reconnect with jittered backoff. This is one process's
fan-out, not durable cross-worker delivery.

HTTP command idempotency is participant-scoped for ten minutes. A key binds
the canonical **entire request body, including `baseRevision`**. An identical
retry can replay the stored result. After a known stale rejection, changing
the revision requires a new key; reusing the old key with changed arguments
is invalid.

There are remaining browser integration gaps: the page's automatic stale
retry currently reuses its explicit key after changing the revision, and a
fresh WebMCP invocation generates a new key. Reinvoking a tool after an
ambiguous timeout therefore does not guarantee exactly-once execution.
Inspect current state before repeating a consequential action. See
[the command client](../../apps/web/src/api.ts) and
[page command runner](../../apps/web/src/App.tsx).

### 3.2 Cancellation and visible completion

Abort signals reach authenticated read/command fetches and landmark lookup.
Aborting a mutation does not prove it failed to commit. `open_room` checks
cancellation before and after preview, but its subsequent creation, exchange,
and invitation calls are not cancelled through that signal.

After a successful room mutation the adapter awaits a spatial refetch
targeting the returned revision. This normally updates the page store before
returning. A failed refetch can retain the previous projection, and there is
no React paint barrier. `open_room` schedules navigation rather than waiting
for the room view to mount. These are best-effort presentation guarantees.

## 4. Interaction sequences

### 4.1 Open or join, then orient

An organizer can open through onboarding or `describe_regions` → `open_room`.
A member claims a `#join=` invitation on the page. After authentication,
`sync_session({})` establishes identity and revision; `get_spatial_context({})`
provides candidate IDs and the current decision state. Inspect relevant
candidates before proposing or screening them. Opening a room is not a
decision on a destination.

### 4.2 Private requirements and screening

For an external agent, `submit_requirement` with `visibility: "agent-private"`
registers a declaration with hardness/delegation and no payload or note.
The agent retains the condition. When `outstanding` contains an
`evaluation_request`, inspect its candidate IDs and send up to ten verdicts
through `evaluate_candidates`. The call carries `baseRevision` and a
`verdicts` array; each item carries `candidateId`, `verdict` (`acceptable`,
`unacceptable`, or `needs_info`), and the dossier's `mapRevision` as
`screenedMapRevision`. `needs_info` also requires `infoNeeded`. Verdicts cover
the participant's active agent-private conditions together, rather than
selecting a requirement ID.
See the [input schemas](../../packages/contracts/src/commands.ts) for the
exact object shapes.

Verdicts with missing or old candidate revisions remain stale. Changed
facts increment `mapRevision` and generate new screening work for active
private needs. A private rejection affects eligibility without publishing
the condition. It does not hide every effect or the existence/ownership of
the need (§5.6). The built-in agent's different data path is described there.
Its screening adapter currently omits the required `infoNeeded` field when
producing `needs_info`; a batch containing that verdict is rejected and can
leave screening pending. External callers can submit the valid schema above.

### 4.3 Propose and respond

`propose_destination` creates a proposal; `respond_to_proposal` records a
participant's stance on it. `reject` is a veto while it stands. A reason is
optional; agent-private stances are disposition-only. Shared stances may be
named in the page, while peers' private stances are hidden and aggregate
blocking effects remain visible. `conditionally_accept` has no executable
condition workflow and blocks agreement until replaced.

### 4.4 Impasse and adjustments

When hard needs leave no eligible candidate, the engine can identify a
minimal conflict set using greedy deletion and offer bounded adjustments.
Current suggestions include radius expansion, a higher EUR price band, and
relaxing cuisine inclusion/exclusion. This is not an exhaustive optimizer or
a guarantee that a compromise exists.

An `adjustment_request` appears only for its addressee. They can deny it;
an authorized grant within a delegated bound applies immediately. An
over-bound grant returns success with `staged: true`, then needs the page
confirmation in §5.4. Locked/protected needs cannot be silently relaxed.
Organizer `set_search_scope` remains a separate direct authority path and
does not route through affected members' consent.

### 4.5 Agreement, subsequent steps, and arrival

To stage an agreement, **every participant must be ready and have accepted
or abstained**, with no standing veto. Accepting also marks that participant
ready; abstaining does not. Disconnected participants still count. The
organizer calls `confirm_agreement`, then confirms on the page.

Commit rechecks the blockers. If they changed, a successful
`agreement_stage_aborted` effect reopens the proposal instead of committing.
Neither proposing nor committing requires the candidate to be classified
eligible: evidence-based feasibility and the group's decision are separate.

For a plan with another step, commit settles the current destination,
deactivates its needs, replaces the live candidate pool for the next step,
searches around the chosen location, and returns to `gathering`. For the
final step, commit enters `agreed`; the first `plan_arrival` enters `arrival`.
`prepare_navigation` supplies external handoff links. It does not calculate a
street route or book transport. Plans currently contain at most three steps.

## 5. Security binding

### 5.1 Participant identity and lifetime

The server derives room, participant, and role from the bearer token, never
from a caller-selected actor ID. Tokens are held in `sessionStorage`, with
an in-memory fallback, and expire after 24 hours. New member links use
`#join=`: an unused link expires after one hour and its first claim binds it
to a browser-held secret in `localStorage`. Same-browser recovery can mint a
fresh token. Organizer recovery uses `#invite=` and expires after seven days.

Claimed member-link recovery has no final expiry or self-service revocation.
Browser binding proves possession, not a person's identity. Read the
[invite implementation](../../apps/server/src/invites.ts) and
[authentication rules](../../apps/server/src/auth.ts) for the exact checks.

### 5.2 Validation and versions

The server validates command inputs with Ajv, then checks ownership, role,
revision, phase, and command-specific rules. Sync and major spatial POST
reads also have server schemas. Not every browser callback independently
validates its entire published schema: local focus, landmark lookup,
context, and onboarding have narrower checks. The test shim adds no schema
validation.

Command requests carry `x-tool-contract-version`; a mismatch returns
`upgrade_required`. WebSocket authentication checks build/contract versions.
Read endpoints are not uniformly version-gated. Reload when the page
reports an incompatible environment rather than carrying IDs or schemas
across deployments.

### 5.3 Untrusted content and origin boundaries

Participant text and venue/provider content are untrusted data, including
when a tool does not carry `untrustedContentHint`. Hints do not sanitize
content or authorize actions. Notes have bounded lengths, and server
projection controls which viewer can receive private fields.

Spokes does not opt into cross-origin WebMCP exposure. Production responses
block framing and use CSP and other browser security headers. Native WebMCP
origin/permission rules still depend on the browser; see the Chrome links
in §2.1. No particular external agent host's per-call review behavior is
assumed by this binding.

### 5.4 Page confirmation: authority, not proof of a human gesture

`ConfirmAgreement` and over-bound adjustment grants only stage their
consequence. Their applying commands, `CommitAgreement` and
`ConfirmPrivateRequest`, have no WebMCP route. The server mints a random
24-byte, single-use nonce valid for 120 seconds, bound to room, participant,
confirmation kind, and subject. It is delivered on that participant's
authenticated realtime channel, never in the tool result.

The page submits the nonce with the applying command. Restaging replaces
the previous nonce; reconnecting receives the existing live nonce when
available. The registry is process-local. A bearer-token holder can open
their own authenticated socket and obtain their nonce, so this is a
participant-authority boundary, not cryptographic evidence that a person
clicked. See [confirmation.ts](../../apps/server/src/confirmation.ts).

### 5.5 Built-in agent action review

The built-in tool-calling model can read as its participant and propose a
mutation. The server stores its exact command arguments and original
revision, then returns an owner-only review card. Approval uses a random
256-bit action ID, is participant-bound and single-use, and expires after
five minutes. Only one current suggestion is retained per participant.
Approval executes the stored command through normal authorization and
consent checks; it cannot substitute new arguments.

This is separate from §5.4: approving a suggested agreement stage does not
also commit it. It is also separate from ordinary need interpretation and
tool-less private screening. External WebMCP agents retain the authority of
their participant session and do not use this built-in approval wrapper.
See [approvals.ts](../../apps/server/src/nl/approvals.ts).

### 5.6 Privacy boundary

| Mode | Where the condition goes | What other participants can learn |
|---|---|---|
| Shared | Application and room projections | Requirement content and shared actions |
| Application-private | Application server and durable room state; owner projection | Eligibility effects and private-need metadata, not the predicate/text |
| Agent-private, external agent | Agent retains the condition; server receives a declaration and candidate verdicts | Existence/ownership and decision effects, not the retained condition |
| Agent-private, built-in agent | Text reaches the server, is held in process memory, and is sent to tool-less interpretation and screening models | The same projected effects; text is omitted from requirement/event records and the tool-calling model's context |

Private effects can include an owner's participant ID, counts, an optional
hint, and per-place aggregate verdicts. Private events use reduced
projections, but the whole system does not promise anonymous ownership or
protection against inference in a small group. Application-private storage
is operator-accessible; these are access controls, not end-to-end encryption.

Restarting loses built-in agent-held condition text, so it must be re-entered
for fresh screening. Provider routing/no-storage request settings do not
independently establish provider retention guarantees. See
[Known limitations](../KNOWN-LIMITATIONS.md) and the
[security review](../SECURITY-REVIEW-2026-09-07.md) for the current threat model.

## 6. Versioning and evolution

Current [versions](../../packages/contracts/src/versions.ts) are negotiation
`v1`, domain `spatial-destination/v1`, and tool contract `"3"`. The repository
generates its contract hash from executable schemas and response/message
types. Build identity additionally detects page/server deployment mismatch.

The current policy keeps compatible optional fields and accepted inputs
additive. Breaking changes require an explicit compatibility decision;
renaming an incompatible tool avoids replacing a discovered schema in place.
Do not infer the catalog count from the version number: the current v3
catalog has 24 tools. A future domain should extend the domain vocabulary
and commands while preserving negotiation meanings; that portability has
not yet been demonstrated with a second backend.

## 7. Current implementation boundaries

The manifest's disclosure escalation L1–L3 has no request workflow. Soft
needs do not rank candidates. There is no commutative stale-write rebase,
participant removal/room closing, plan editing/reopening, transit routing,
or protocol-level meeting-point negotiation.

The binding also has abbreviated plan/evidence output, descriptions that
currently overstate some behavior, uneven callback validation/error
normalization, and retry/visible-completion limits described above. The
[limitations document](../KNOWN-LIMITATIONS.md) covers data quality, location
handling, model boundaries, and deployment constraints in more detail.
