# System Architecture

## Architectural thesis

Separate facts, mediation, and advocacy:

```text
World-knowledge backend
        |
        | Candidate dossiers: facts, sources, timestamps, confidence
        v
Shared council and session coordinator
        |
        | Participant-specific projections and negotiation commands
        v
Personal agents participating through WebMCP

Humans <------> Live participant map views <------> Shared session
```

An opaque model must not both invent available options and decide which person
should compromise.

## Major components

### Participant web client

- Renders the shared map, activity feed, candidate cards, and personal prompts.
- Establishes the participant's session identity from a guest invite or account.
- Receives a server-generated projection rather than the complete session.
- Registers contextual WebMCP tools on `document.modelContext`.
- Sends human and WebMCP actions through the same domain command path.
- Maintains live UI updates through WebSockets or Server-Sent Events.

### Authoritative session service

- Stores participants, goals, requirements, visibility, delegation, and state.
- Appends all accepted commands to a monotonically revisioned event stream.
- Produces a separately authorized projection for every participant.
- Enforces optimistic concurrency and rejects or rebases stale operations.
- Tracks which revision an agent last observed.
- Records acceptance and consent as explicit events.

### Constraint and council engine

- Separates hard constraints from soft preferences.
- Applies verified attributes to candidate eligibility.
- Ranks remaining candidates using aggregate utility and tradeoffs.
- Detects fragile, infeasible, or uncertain states.
- Finds small conflicting constraint sets and grounded counterfactuals.
- Never automatically relaxes a constraint beyond delegated authority.

Deterministic logic should decide eligibility and calculate counterfactuals. An
internal generative model may normalize ambiguous evidence or phrase useful
explanations, but it must not invent feasibility facts.

### World-knowledge service

- Searches a bounded geographic and temporal area.
- Normalizes destinations into stable candidate dossiers.
- Attaches provenance, retrieval time, and confidence to claims.
- Supports neutral expansions such as a wider area or later time.
- Keeps provider-specific APIs behind adapters.

The POC can prepopulate and cache a selected geographic area to provide
reliable, low-latency experimentation without pretending to operate at global
scale.

### Refinement scheduler and outbound routing

The process-global refinement scheduler chooses which named concurrency pool
may admit an item. It uses room-level deficit round robin, item priority,
ready-buffer backpressure and the read-only `hostGateOpen(host)` hint. It never
reserves or mutates host state in the outbound client.

Each priority class is indexed by pool, so an admission probe considers only
work that can use the pool being filled. Queued items are reprioritised against
the latest room plan and queued work that left the active scope is rejected;
already-running work finishes and may still populate shared evidence caches.
Scope and need changes bump the room epoch and wake the planner immediately.

Pool choice and route choice are separate decisions. The scheduler consults
`routeFor(host, purpose)` when work is enqueued and again when it is dispatched,
because the circuit breaker may change while it waits. `net/outbound.ts` is the
route authority at dispatch and still owns purpose routing, the stable direct
control group, per-host limits, session pacing and the circuit breaker. A
dispatcher reports the actual route; accounting follows that report rather
than the enqueue-time prediction. Interactive fetches prefer direct, with one
same-priority proxy retry for a block-shaped result.

Every dispatch has a kind-specific deadline. Expiry aborts signal-aware fetches,
settles the item, clears its progress state and releases the pool slot. The room
planner submits at most 32 places per tick and has its own plan watchdog, so one
unsettled plan cannot prevent the next replan. Site evaluation releases the
LLM-matrix slot before its search leg and reacquires it only for post-search
evaluation.

The scheduler and its progress volume are process-local. The socket-holding
process emits the room frame; no cross-process counter is claimed.

Asset materialisation does not ride inside the site-fetch slot. Only an
on-demand place detail can schedule it: image
bytes use the route-selected proxy/direct pool, Sharp decode/resize uses the
image-decode pool, and one per-place classifier batch uses the vision pool.
Background refinement and room warming schedule none of those three stages.

### Realtime transport

The application, not ChatGPT, is the realtime bus. Browser clients receive live
session projections. ChatGPT is not assumed to maintain a background
subscription; it catches up through WebMCP on its next interaction.

## State and event model

The canonical event stream has a monotonically increasing revision. Example
events include:

```text
participant_joined
requirement_added
requirement_changed
option_proposed
option_vetoed
participant_ready
option_accepted
meeting_point_selected
impasse_detected
private_adjustment_requested
search_scope_change_proposed
requirement_relaxed
impasse_resolved
```

Every event is stored once but projected differently. A participant may see:

```text
Joe added a private requirement.
```

Joe and Joe's authorized agent may instead see the full content. For stronger
inference minimization, even ownership can be redacted:

```text
A private requirement was updated.
```

Client-side hiding is insufficient. The server must omit unauthorized fields
and events from responses entirely.

## ChatGPT connection and catch-up

WebMCP tool descriptions and schemas are the discovery mechanism. WebMCP does
not provide a separate standardized application-protocol instruction channel,
so the application defines a first-connection contract.

An initial `connect_to_session` or `sync_session` result should include:

- Negotiation protocol and map-domain protocol versions.
- The current participant identity and permissions.
- Privacy and delegation rules.
- Current session revision.
- Current goal and concise participant-specific state.
- Events since the agent last participated.
- Supported actions and domain capabilities.
- Any outstanding decision that requires this participant.

Every mutation includes the base revision the agent observed. If the session is
stale, the application returns a structured `sync_required` result with a
concise delta rather than silently acting on old information.

The map may already have updated in realtime while ChatGPT was idle. This is not
fake push. ChatGPT receives the semantic delta when it next invokes a tool.

## Asynchronous personal agents

## Interactive lane

Opening a place admits its fetch, search, and model work to a dedicated
three-slot pool (`POOL_INTERACTIVE` overrides the limit), independent of the
background sweep. Focus is participant-local: moving to another place demotes
queued work for the old place and abandons its remaining model/search legs,
unless another participant is still focused there; an in-flight site read may
finish into cache. Opens run once per place and needs epoch with a 60-second
floor (`force` bypasses it), stream queued/site/needs/photos/web progress, and
spend separate hourly model and search budgets.

A ChatGPT conversation participating through WebMCP is not a continuously
running daemon. The application therefore stores a bounded delegation policy:

- **Locked:** never relax automatically.
- **Approval required:** ask the human before changing.
- **Negotiable range:** may compromise within an explicit bound.
- **Soft:** optimize when possible but do not block.

The server can continue mediation within that envelope. Anything outside it is
queued privately until the participant or their agent returns.

## Privacy boundaries

### What peers may receive

- Shared requirements and statements.
- Aggregate candidate compatibility.
- Redacted private activity.
- Group-level explanations and outstanding decisions.

### What a participant and their agent may receive

- Their own private requirements and delegation policy.
- Private adjustment requests directed to them.
- The same shared information every authorized participant receives.

### What the coordinator may receive

- Application-private requirements needed for server-side evaluation.
- Agent-private stances without their hidden reasons.
- Authorization metadata and audit events.

### What the world-knowledge service should receive

- Geographic, temporal, and attribute search queries.
- No participant identity or personal explanation unless strictly required.

When possible, the coordinator should fetch a broader candidate set and apply
sensitive filters itself so the provider does not receive a user-linked query.

## Data model sketch

```text
Room
  id, revision, goal, area, time, status

Participant
  id, displayName, role, connectionState

Requirement
  id, ownerId, domainPayload, hardness, visibility, delegation

Candidate
  id, facts[], evidence[], freshness, confidence

Proposal
  id, candidateId, createdAtRevision, status

Stance
  participantId, proposalId, disposition, visibility, conditions

Agreement
  proposalId, confirmations[], committedAtRevision
```

## Core invariants

- UI actions and WebMCP actions invoke the same application commands.
- The map is a projection, not the authoritative source of session truth.
- Candidate facts reference evidence and freshness.
- Every direct remote request goes through the policy-aware outbound client at
  `apps/server/src/net/outbound.ts`; nothing else calls global `fetch` for a
  remote host except the deliberately separate OpenAI transport.
- Personal agents advocate but do not invent map facts.
- The world backend supplies possibilities but does not negotiate.
- Only the council commits shared agreement.
- No participant can alter another participant's requirements.
- No constraint is relaxed outside its owner's delegated authority.
- Tool results update the visible UI before returning where appropriate.
- Protocol versions and domain capabilities are explicit.
- No work holds a database client outside a transaction. A held client is a
  client no request can have: background jobs that each kept one as a lock
  holder took the whole pool at boot and the app could not answer an invite
  exchange. Serialize with a transaction-scoped lock inside the statement that
  needs it, or with a process-local gate, never with a session-scoped advisory
  lock on a pooled connection.
