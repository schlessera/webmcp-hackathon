# System architecture

Implementation reference, checked against `main` on 2026-09-07. Spokes runs a
shared room with participant-specific views over prepared place data. The
configured stack is a browser client, one application process, and PostgreSQL;
external evidence/model providers are optional dependencies.

## Architectural thesis

Keep source evidence, negotiation rules, and participant advocacy distinct:

```text
Prepared OSM snapshots       External evidence sources / models
         |                              |
         +------> Place records and reusable evidence caches
                                      |
Page controls / WebMCP tools / approved built-in agent suggestion
                                      |
                     Authenticated application service
                                      |
            Command validation, ownership, revisions, consent
                                      |
                    PostgreSQL room state and events
                                      |
            Viewer-specific HTTP reads and WebSocket updates
                                      |
                      Participant browser projection
```

The implementation shares a domain-aware server engine. Protocol versioning
and typed payloads separate concepts at the interface; a separately packaged,
domain-opaque negotiation engine is an architectural goal rather than a
component currently deployed.

## Major components

### Participant web client

[apps/web](../apps/web/) contains the React/Vite client: onboarding, plan
review, invitation/claim flows, map, brief, place evidence, personal controls,
and confirmation/review cards. Guest browser credentials establish identity;
there is no account login.

The client registers a static WebMCP catalog when
`document.modelContext.registerTool` exists. It remains usable without native
WebMCP. Page controls and external-agent mutations use the same authenticated
command API; local map focus and opening a room have separate handlers.
Detailed registration, compact response, retry, and completion semantics are
in the [binding reference](protocols/INTERACTION-AND-BINDING.md).

The browser holds server-projected room state and consumes WebSocket frames.
It requests venue images from the application but loads the OpenFreeMap
basemap directly. The map is a presentation of room state, not the state store.

### Authoritative session service

[server.ts](../apps/server/src/server.ts) serves HTTP and the web bundle;
[ws.ts](../apps/server/src/ws.ts) provides the realtime connection. HTTP reads,
commands, enrichment-triggering operations, and natural-language routes have
separate handlers. There is no SSE transport.

[engine.ts](../apps/server/src/engine.ts) validates commands, derives the actor
from bearer authentication, checks room ownership/role and phase, enforces
revision and consent rules, and writes domain state/events in transactions.
All stale domain mutations require catch-up; commutative rebasing is not
implemented. Idempotency is participant-scoped and bounded in time; the
[binding's retry limits](protocols/INTERACTION-AND-BINDING.md#31-revisions-catch-up-and-retries)
apply.

[projection.ts](../apps/server/src/projection.ts),
[sync.ts](../apps/server/src/sync.ts), and
[spatial.ts](../apps/server/src/spatial.ts) build the requesting participant's
view. Authorization removes private predicates before transmission; CSS or
client hiding is not the privacy boundary.

### Constraint and council engine

[eligibility.ts](../apps/server/src/eligibility.ts) evaluates active hard and
bounded-negotiable needs against source evidence and current private verdicts.
It distinguishes decisive, likely, and unknown evidence. Soft/optional needs
are stored but do not yet supply a utility ranking. Candidate ordering is based
on classification and distance rather than an optimized group-utility score.

[impasse.ts](../apps/server/src/impasse.ts) finds conflicting requirements and
bounded counterfactual adjustments. These are heuristics over the current pool,
not an exhaustive search over all possible outings. Addressed private
adjustments use delegation bounds, with over-bound grants staged for a separate
confirmation. The organizer can also change the shared search scope directly;
that path does not route affected members through consent.

Agreement requires every participant to be ready and to accept or abstain,
without a veto or unresolved conditional acceptance. The organizer stages and
then commits. Eligibility classification is informative: the command engine
does not require the chosen place to be classified eligible before agreement.

### World-knowledge service

[places.ts](../apps/server/src/places.ts) queries committed OSM snapshots inside
the process. Place names/locations/classes, a landmark index, scope filling,
and viewport exploration do not call a public geocoder. The active plan step
selects pool classes, and background filling adds places in the current circle
up to the pool cap.

[enrich/](../apps/server/src/enrich/) supplements records with venue/menu text,
Wikidata, optional business listings, evaluated evidence, and images.
[refine/](../apps/server/src/refine/) schedules continuing work on uncertain
criteria. Source claims carry provenance, confidence, and observation times;
models can interpret those sources, including accepting explicit venue claims
as verified evidence. They do not independently establish real-world truth.

[Prepopulation](PREPOPULATE.md) can warm the same caches before rooms exist.
It creates no participant or negotiation state. Coverage, refresh, and fallback
rules are in [Data quality](DATA-QUALITY.md); provider/cache handling is in
[Enrichment sources](ENRICHMENT-SOURCES.md).

### Built-in participant agent

The [natural-language layer](NL-AGENT.md) interprets needs, previews short plans,
and supplies an agent that reads one participant's room view. Parsed needs
return to the page for ordinary submission. Tool-calling mutations become
participant-bound review cards with stored exact arguments, a five-minute
expiry, and single-use approval. Approval executes at the original revision
through the command engine; it does not bypass final agreement or over-bound
consent checks.

Agent-private screening is a separate tool-less model job. The built-in
condition text reaches the server and its interpretation/screening providers;
it is held in process memory rather than requirement/event storage. External
agents can instead retain their condition outside the application and submit
only content-free declarations and verdicts. The tool-calling built-in model
does not receive the held condition.

## State and event model

PostgreSQL stores room state and revisioned events, not a replay-only event
sourcing system. Commands can update rows and append several events. Candidate
facts have their own revisions so changed evidence can invalidate prior
screening. Presence, viewing focus, and some progress data are transient rather
than part of the durable event stream.

| Data | Purpose |
|---|---|
| `rooms` | Goal, phase, scope, revision, plan steps and active step |
| `participants`, token/invite tables | Room membership, role, readiness, private origin, browser-bound guest access |
| `requirements` | Owner, typed payload, visibility, hardness, delegation, active/withdrawn state, step |
| `candidates` | Room/step place rows, source records and candidate fact revision |
| `proposals`, `stances`, `adjustments` | Suggested destinations, participant decisions, private compromise requests |
| `arrival_plans` | Participant transport choice and optional pickup note |
| `events` | Revisioned activity used by per-viewer sync and realtime projections |
| `attestations`, `confirmed_facts` | Participant evidence scoped to its room |
| `enrichments`, page/search/image caches | Reusable place evidence with source-shaped freshness rules |
| `nl_pending_actions` | Exact proposed built-in agent commands awaiting owner review |

Examples of actual events include `participant_joined`, `proposal_created`,
`stance_submitted`, `ready_state_changed`, `impasse_detected`,
`adjustment_proposed`, `scope_change_applied`, `agreement_committed`,
`step_advanced`, and `arrival_plan_updated`.

Normal rooms start in `gathering`. A proposal or impasse enters `deliberation`;
agreement enters `agreed`; arrival planning enters `arrival`. In a multi-step
plan, committing an intermediate agreement opens the next step and returns to
`gathering`. The current participant readiness values carry forward. `setup`
and `closed` exist in the type vocabulary but are not reached by the ordinary
creation/command flow. There is no close, leave/removal, or settled-step-reopen
command. See [phase.ts](../apps/server/src/phase.ts) and
[steps.ts](../apps/server/src/steps.ts).

## ChatGPT connection and catch-up

An external WebMCP agent participates through the active browser document.
`describe_regions` and `open_room` cover creation. Once authenticated,
`sync_session({})` supplies the first-connection manifest, identity, versions,
revision, brief, and outstanding decisions. Cursor/revision continuations
return paged deltas rather than repeating the manifest.

The application WebSocket updates browser projections while an agent is idle.
There is no assumption that an external conversation is a continuously running
subscriber. Its next tool interaction catches up to the current room. Tools
return abbreviated semantic views, so the binding documents omissions from
full HTTP/page records as well as stale-write and UI-refresh limits.

## Refinement scheduler and outbound routing

The [pipeline](../apps/server/src/pipeline/) uses a process-local scheduler with
room fairness, priority, named concurrency pools, bounded ready evidence, and
deadlines. An interactive pool serves opened places independently of background
work. Queued work is rechecked against current scope/needs; a completed source
fetch can still populate reusable caches after focus changes.

Fetch, search, judgement, adjudication, image download, decode, and vision are
separate work stages. The room planner prioritizes uncertain active needs,
then stale facts and background vocabulary. Ordinary warming/refinement does
not materialize images; opening a detail or explicitly prepopulating images
does. Network waits do not hold a room lock or checked-out database client.

The [outbound client](../apps/server/src/net/outbound.ts) remains the route and
network-policy authority at dispatch. It checks destinations, DNS at direct
socket connection, redirects, host pacing, attempt budgets, and circuit state.
The model transport has separate provider handling and shared resource quotas.
Source defaults and deployment overrides can differ; see
[deployment configuration](DEPLOY-COOLIFY.md) rather than assuming a pool-size
constant is the effective production limit.

## Privacy boundaries

| Recipient | What it can receive |
|---|---|
| Peers | Shared needs/stances, participant roster/readiness, private activity metadata, aggregate compatibility and outstanding counts; opted-in live coordinates through presence |
| Participant and authorized agent | Their own private predicates/notes and addressed requests, plus the shared view; compact tools can omit page details |
| Application operator | Stored application-private data and process memory, including a built-in agent's held condition |
| Sentence/screening model | Submitted text and the context supplied for that tool-less job |
| Built-in tool-calling model | Participant-visible room context and the current request, excluding the separately held agent-private condition |
| Evidence evaluator | Public source text and criteria, including application-private criteria where the implementation evaluates them |
| Search provider | Place identity/city and admissible shared or background-vocabulary words; private criterion text is not used as a query |

The existence and aggregate effects of private contributions remain observable;
owner IDs or optional hints can also appear in authorized views. Access controls
are not end-to-end encryption or anonymity. Latest origins are stored privately;
only opt-in live coordinates enter peer presence, without the private label.

Guest tokens expire after 24 hours, unclaimed member invitations after one
hour, and organizer recovery after seven days. Claimed member recovery still
has no final lifetime or self-service revocation. Confirmation nonces bind to
an authenticated participant channel, not cryptographic proof of a person
clicking. [Known limitations](KNOWN-LIMITATIONS.md) and the
[binding's authority section](protocols/INTERACTION-AND-BINDING.md#5-security-binding)
describe these boundaries.

## Persistence and deployment limits

PostgreSQL persists the room, evidence, and revisioned activity. Realtime
fan-out/presence, confirmation nonces, held conditions, refinement queues,
progress, and traffic/model quotas are process-local. There is no shared
Redis/LISTEN-NOTIFY bus, durable outbox, or shared quota store. Multiple app
replicas need coordination beyond the current configuration, and process
restarts reset transient state.

The application has bounded HTTP/WebSocket, model, outbound, and durable-room
resource controls. Those controls do not provide edge protection, persistent
spending ceilings, automated data retention, or verified production restores.
Operational requirements live in [Deployment](DEPLOY.md); the dated
[September 7 security review](SECURITY-REVIEW-2026-09-07.md) records the evidence
and remaining operator work for that review.
