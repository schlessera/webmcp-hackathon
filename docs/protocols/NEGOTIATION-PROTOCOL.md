# Agent Negotiation Protocol — `negotiation/v1`

Status: maintained implementation reference, checked 2026-09-07. This document
explains the negotiation behavior currently implemented by Spokes. The
[spatial protocol](SPATIAL-PROTOCOL.md) defines its domain payloads; the
[WebMCP binding](INTERACTION-AND-BINDING.md) defines the registered tools,
result budgets, authentication, and browser limitations. Executable inputs
live in [commands.ts](../../packages/contracts/src/commands.ts), result types
in [envelope.ts](../../packages/contracts/src/envelope.ts), and behavior in
[engine.ts](../../apps/server/src/engine.ts).

## 1. Purpose and position

A participant can contribute through the page or a personal agent. Both use
the same authenticated command bus, revision checks, ownership checks, and
participant-specific projections. The server owns the shared decision; the
map and tool results present views of it.

```text
Page gestures ─┐
               ├─> HTTP command bus ─> Engine ─> Event log ─> Viewer projections
WebMCP tools ──┘                                      │
                                         WebSocket + HTTP sync
```

Negotiation concepts are intended to transfer to other domains. The current
engine nevertheless imports spatial eligibility, scope, candidate, and plan
logic; an independent negotiation package or second domain is not implemented.
WebSocket carries state and presentation updates, not a second public mutation
bus. There is no SSE transport.

## 2. Design principles

1. **Server projections enforce visibility.** Private fields are omitted
   before a response reaches a peer. Hiding a field in the page is insufficient.
2. **Mutations carry the state they were based on.** Every command in the
   revisioned bus requires `baseRevision`; every stale command is rejected.
3. **Identity comes from authentication.** The server derives the acting
   participant, room, and role from the bearer token. Callers do not select
   another actor through command arguments.
4. **Ownership and delegated authority are separate.** An owner can edit
   their own need. The council can propose an adjustment; an out-of-bound
   grant requires a staged page confirmation. Organizer scope changes are a
   separate direct authority, described in the spatial protocol.
5. **Failures should be actionable.** Command failures normally return a
   structured code, message, and recovery instruction. Browser callbacks
   still have error-normalization gaps; callers must also handle rejection.
6. **The WebMCP catalog is static.** Phase/identity errors occur in results
   rather than by adding and removing tools as the room changes.

## 3. Core objects

### 3.1 Session (Room)

A room has a stable ID, goal, prepared data area, shared scope, monotonically
increasing event revision, phase, participants, requirements, and proposals.
A room can also contain an ordered plan of up to three steps. Only the active
step's pool and needs participate in its current decision.

Revision increases for each stored event, so one command can advance it by
several revisions. An idempotency replay appends no second event sequence.
The protocol's version and agreement rule are returned in the capability
manifest; they are not repeated in every command body. There is no public
room policy input for participant departure, automatic room closure, or
cross-session preference promotion. Token and invitation expiry are separate
from room state; see binding §5.1.

### 3.2 Participant

A participant has an ID, display name, and `organizer` or `member` role. The
roster projection contains `readyState: "contributing" | "ready"`, `arrived`
(has opened the room), and `present` (has a live socket). The caller's own
roster row may also carry their application-private origin.

Presence is advisory. Agreement includes **every participant in the room**,
including those disconnected or not ready. There is no departure/removal
command or automatic exclusion of idle participants. The previous sync
revision is tracked per participant, across that identity's tabs/surfaces,
and returned as top-level `lastSyncedRevision`, not a per-agent watermark.

### 3.3 Requirement

A requirement belongs to one participant and, for a plan, to the step on
which it was submitted. Its command fields are:

| Field | Current meaning |
|---|---|
| `requirementId?` | Omit to create; provide an owned ID to update |
| `visibility` | `shared`, `application-private`, or `agent-private` |
| `hardness` | `hard` or `soft` |
| `delegation` | `mode`: `locked`, `approval_required`, `negotiable`, or `soft`; optional typed bound |
| `payload?` | Required for shared/application-private; omitted for agent-private |
| `scopeHint?` | Optional candidate-eligibility hint, with optional closed category |
| `note?` | At most 200 characters; omitted for agent-private |

`baseRevision` is also required. The spatial protocol §5 defines payloads and
bounds. There is no top-level `lifetime` or `disclosureLevel` input.
Cuisine inclusion/exclusion payloads accept a lifetime value, but do not
create a durable preference reused in other rooms.

Hard needs participate in eligibility. Soft needs are stored but currently
neither exclude nor affect ranking. The only protected vocabulary key
currently enforced as `hard + locked` is `wheelchair-accessible`; do not
assume all dietary, medical, or safety wording receives that treatment.

`WithdrawRequirement` removes an owned need from consideration.
`SetRequirementActive` sets an owned need aside or restores it while keeping
its row and history. A need on an already settled step cannot be reactivated
through that command. Ownership still applies to shared needs: seeing a
peer's need does not authorize editing it.

### 3.4 Proposal

`ProposeDestination` creates a proposal on a current candidate. The proposal
has its own ID, candidate ID, creator, creation revision, and status:
`open`, `vetoed`, `staged`, `committed`, or `withdrawn`.

A candidate can be proposed even when its evidence-based classification is
uncertain or excluded. Neither proposal creation nor agreement commit requires
an eligible classification. The classifier informs the decision; explicit
participant stances determine agreement. A duplicate live proposal on the
same candidate is rejected.

### 3.5 Stance

`RespondToProposal` accepts `proposalId`, `disposition`, `visibility`, optional
`reason`, and `baseRevision`. Its four dispositions are:

| Disposition | Meaning |
|---|---|
| `accept` | Accept this proposal; also mark the author ready |
| `reject` | Standing veto; blocks staging while it remains |
| `abstain` | Satisfies the stance condition for agreement, but does not itself mark ready |
| `conditionally_accept` | Records a conditional stance and blocks agreement until replaced |

A reason, when supplied, is `{kind: "history" | "domain", note?: string}`.
Agent-private stances must omit the reason. No conditions payload, executable
condition, `request_information`, `offer_relaxation`, or
`require_user_approval` disposition is accepted.

The latest stance replaces the same participant's prior stance. Stances apply
to open or vetoed proposals; staged, committed, and withdrawn proposals reject
stance changes. A private stance's existence/decision effects can be visible,
but its content is not published as a named public stance. Candidate screening
is a separate verdict table, not a proposal stance (§5.3).

### 3.6 Adjustment (counterfactual)

The deterministic council computes adjustments when no verified option
satisfies the current hard needs and private screening is resolved. Supported
kinds are `scope_change` and `requirement_relaxation`. There is no
`evidence_request` or `disclosure_request` adjustment workflow.

The addressee receives an `adjustment_request` outstanding item with
`requestId`, `issuedAtRevision`, `kind`, `change`,
`projectedGain: {newCandidates}`, `withinDelegatedBound`, and `staged`.
A requirement adjustment can also include the owner's `delegatedBound`.
Gain is recomputed over the current candidate set, not a prediction about
unfetched places.

`ResolvePrivateRequest {baseRevision, requestId, decision: "grant" | "deny"}`
applies only to the addressee. A grant within the delegated bound applies
immediately **when the addressee grants it**; the council does not silently
auto-accept it. Other grants enter `staged_grant`, return `staged: true`, and
emit an owner-only `adjustment_grant_staged`. The page must then send
`ConfirmPrivateRequest` with its confirmation nonce. Denial is terminal for
that request; recovery expires outstanding proposals for adjustment.

Nonces, restaging, and the limits of the page-confirmation boundary are
specified in binding §5.4. This is participant authorization, not proof that
a human made a gesture.

### 3.7 Agreement

The manifest names the rule `all-accept-organizer-commit`. Its executable
precondition is: every participant is ready and has accepted or abstained on
the proposal; no rejection or conditional acceptance stands; the actor is
the organizer.

`ConfirmAgreement {baseRevision, proposalId}` stages an open proposal and
returns `staged: true`. The organizer's page receives a nonce separately over
WebSocket. Page-only `CommitAgreement` consumes it and checks the precondition
again. If a blocker has appeared, such as changed readiness or a new member,
the result is a successful `agreement_stage_aborted` transition that reopens
the proposal. It does not commit the destination.

Commit retires competing proposals. On the final plan step it enters
`agreed`. On an intermediate step it records the settlement, advances the
plan, starts a new pool around the chosen location, sets aside the prior
step's needs, and returns to `gathering`. Readiness carries forward, but
proposals in the new step require their own stances.

The HTTP proposal projection includes
`staging: {ready, notReady, unaccepted, vetoStands}`: readiness can name roster
members; the missing-acceptance count does not reveal private stance owners.
WebMCP's compact context does not preserve that whole object. A high score,
large matching count, or live presence is never agreement.

## 4. Canonical events

The stored event log records domain transitions such as:

```text
session_created            participant_joined
requirement_submitted      requirement_updated        requirement_withdrawn
requirement_toggled        private_requirement_declared
requirement_relaxed        evaluation_requested       evaluation_recorded
candidates_added           candidates_updated         attribute_attested
proposal_created           proposal_withdrawn         stance_submitted
scope_change_proposed      scope_change_applied
origin_updated             origin_sharing_changed
impasse_detected           impasse_resolved
adjustment_proposed        adjustment_grant_staged     adjustment_resolved
ready_state_changed        agreement_staged           agreement_stage_aborted
agreement_committed        step_advanced              phase_changed
arrival_plan_updated
```

This is a guide to current producers, not a closed schema for event names.
`ConfirmFact` and `UnconfirmFact` use `attribute_attested` with distinguishing
payload fields. There are no implemented `participant_left`,
`disclosure_requested`, `disclosure_resolved`, or `session_closed` actions.
Presentation frames such as presence, fact lookup progress, images, and
confirmation credentials are separate from this durable event sequence.

### 4.1 Projection policy

An emitted projection has `revision`, `type`, `level`, and server-composed
`text`; viewer-authorized full projections may add `payload` and `actorId`.
Levels are `full`, `existence`, and `aggregate`; omission means the event is
absent, not a fourth wire value.

The policy is event-specific in
[projection.ts](../../apps/server/src/projection.ts). Shared requirements
carry content to peers; application-private requirement submissions produce
an anonymous aggregate line for peers; an agent-private declaration can name
who added a private need. Screening requests and staged adjustment grants
are omitted from peers' deltas. Aggregate candidate changes carry neither
private predicate nor explanation.

There is no user-configurable per-requirement choice of projection level.
Do not infer anonymity from a reduced event: spatial context separately
exposes private-need ownership, counts, optional hints, and aggregate verdicts.
Owners can receive only what the server actually stores, not the external
agent's retained condition or a full audit of provider reasoning.

## 5. Privacy tiers

### 5.1 `shared`

Requirement content and ownership are visible to the room. The application
can evaluate the payload and request evidence about shared criteria.

### 5.2 `application-private`

The application stores and evaluates the condition; the owner receives its
content and peers receive reduced projections. This is operator-accessible
storage, not end-to-end encryption. Tool-less model evaluation can receive
private question text. Search and tool-enabled evidence calls exclude private
criteria; they use shared criteria or independent server vocabulary instead.
The [spatial evidence boundary](SPATIAL-PROTOCOL.md#10-world-knowledge-boundary)
describes this distinction.

### 5.3 `agent-private` — declaration and screening

An **external** personal agent keeps the condition in its own context and
sends a declaration through the room's tool surface:

```json
{
  "baseRevision": 44,
  "visibility": "agent-private",
  "hardness": "hard",
  "delegation": { "mode": "approval_required" },
  "scopeHint": { "affects": "candidate-eligibility" }
}
```

The declaration carries no payload or note. Without current verdicts, its hard
need leaves candidates uncertain. An `evaluation_request` outstanding item
supplies up to ten candidate IDs. Inspect those candidates, then submit the
verdicts with the room revision and each dossier's fact revision:

```json
{
  "baseRevision": 47,
  "verdicts": [
    { "candidateId": "place_42", "verdict": "acceptable", "screenedMapRevision": 8 },
    { "candidateId": "place_17", "verdict": "unacceptable", "screenedMapRevision": 3 },
    { "candidateId": "place_29", "verdict": "needs_info",
      "infoNeeded": "attribute:lactose-free-options", "screenedMapRevision": 5 }
  ]
}
```

These examples use illustrative IDs/revisions; actual values must come from
the room. `verdict` is `acceptable`, `unacceptable`, or `needs_info`.
`infoNeeded` is mandatory for `needs_info` and capped at 100 characters.
There is **no `requirementId` in a verdict**: the stored screening result is
per participant and candidate, covering that participant's private needs
together. Submitting or updating an agent-private declaration clears that
participant's previous verdicts.

`screenedMapRevision` is optional in the schema, but an omitted or older
value is stale and does not satisfy eligibility. A future candidate revision
is rejected. Missing, stale, and `needs_info` results remain outstanding.
Room revision and candidate fact revision serve different purposes; neither
can substitute for the other.

The **built-in** agent has a different trust boundary. Its condition text
reaches the application server, stays in process memory, and goes to a
tool-less interpretation model and a separate screening model. The tool-calling model and durable
requirement/event records do not receive that text. Restart loses the held
condition and requires re-entry for fresh screening. This mode does not mean
that the server never receives the condition; see [NL-AGENT.md](../NL-AGENT.md).
The built-in screening adapter currently omits required `infoNeeded` on
`needs_info` verdicts, causing batches containing them to be rejected. The
external verdict schema above supports that field correctly.

The manifest still lists `verdicts-only`, `category-hint`, `predicate`, and
`shared` disclosure vocabulary. Optional `scopeHint.category` implements a
coarse declared hint. There is **no L1–L3 escalation request/approval flow**,
no disclosure level stored on a requirement, and no automatic conversion
from screening to an application-private predicate. Owners can explicitly
edit their own requirement's visibility and payload through normal submission.

### 5.4 Inference honesty

Reduced disclosure does not prevent inference from a small group's changing
results. Private-need metadata can identify its owner; aggregate per-place
effects can reveal which places fail something private. Treat privacy as
control of condition content and authorized access, not anonymous ownership,
cryptographic secrecy, or proof of provider retention behavior.

## 6. Synchronization and catch-up

### 6.1 Sync request/response

Call `sync_session({})` after authentication. With **both** `sinceRevision`
and `cursor` absent, the result includes identity, revision, build and tool
contract versions, phase, capability manifest, feasibility, brief, outstanding
work, participant roster, and `lastSyncedRevision`. It omits `delta`.

For incremental catch-up, send `{sinceRevision: <last consumed revision>}`.
The response omits the manifest and carries a delta with `fromRevision`,
projected `events`, `truncated`, `throughRevision`, and an optional continuation
`cursor`. Returning a cursor is also incremental sync even if `sinceRevision`
is omitted. A sync brief is capped at 400 characters.

The room-head `revision` can be newer than the last event consumed. Continue
with the opaque cursor while `delta.truncated` is true; advance the consumed
event watermark using `throughRevision`, which also advances across events
omitted by the viewer's projection. Do not skip unread events by recording
the room head as consumed. Pages normally contain up to ten projected events
and may be smaller to fit the 8,000-character sync allowance.

`resyncRequired: "backlog_too_large"` explicitly requests replacement from
fresh full state reads rather than replaying an oversized backlog. A full
sync supplies negotiation summary; spatial context supplies the current map
projection. This is not recovery of every historical event. Invalid or
ahead-consumed cursors and a future `sinceRevision` return `invalid_input`.

WebSocket event continuity and HTTP catch-up complement each other. An HTTP
success proves a revision exists, not that the corresponding event frame
arrived. Presentation-only fact/presence frames do not advance the durable
event watermark. See binding §3.1 for delivery and reconnect details.

### 6.2 Mutation discipline

Every command carries `baseRevision`. The server applies only when it equals
the current room revision. Otherwise it returns `sync_required` with a delta.
**There is no commutative rebase.** After catch-up, an agent must reconsider
its intent before issuing another command at the new revision.

HTTP `Idempotency-Key` binds the authenticated participant to the complete
canonical request body for ten minutes. An identical retry replays the stored
result; changing `baseRevision` changes the body and requires a new key after
a known rejection. A timeout or cancellation can leave the outcome ambiguous.
The browser has remaining key-reuse gaps, so a repeated WebMCP invocation is
not guaranteed to be exactly once. See binding §3.1–3.2.

The built-in tool-calling agent's proposed mutation retains its original
arguments/revision in an owner-only review card. Page approval executes that
stored command through normal checks; it does not authorize a silent fresh-
revision rewrite. The approval card is separate from the nonce-backed
confirmation needed to commit agreement or apply an out-of-bound adjustment.

## 7. State machines

### 7.1 Session phase

```text
gathering ── proposal_created / impasse_detected ──> deliberation
                                                    │
                                             agreement_committed
                                                    │
                                                    v
                                                  agreed
                                                    │
                               final step: first arrival_plan_updated
                                                    v
                                                  arrival

agreed ── step_advanced (another plan step) ──> gathering
```

`impasse_active` is a flag, not a phase or an exclusive lock. `setup` and
`closed` are defined in the phase vocabulary but no normal room command
enters them. There is no room-close command.

Requirements, screening, stances, scope changes, candidate additions, and
fact attestations/confirmations are accepted in `gathering` or `deliberation`.
Agreement staging/commit requires `deliberation`. Arrival planning requires
`agreed` or `arrival`. Readiness and own-origin/sharing changes are allowed
throughout the live phases. Reads do not require a matching `baseRevision`.
The [phase gate table](../../apps/server/src/phase.ts) is the authority for
which command is currently legal.

### 7.2 Feasibility and impasse

Feasibility counts the five candidate classes separately:

| State | Current test |
|---|---|
| `feasible` | At least three eligible candidates |
| `fragile` | One or two eligible candidates |
| `uncertain` | No eligible candidates, but at least one likely, uncertain, or unlikely candidate |
| `infeasible` | No eligible candidate and no such unresolved/graded candidate |

The impasse detector uses its own conditions: there are candidates and hard
needs, no eligible option remains, and hard agent-private screening is
resolved. Missing or likely dossier evidence does not itself block an impasse.
The display can therefore report uncertain evidence while adjustment requests
are pending.

The council uses greedy deletion over hard requirements to find an irreducible
conflict set, then tests quantified changes. Current suggestions are a wider
radius, the next EUR price band, or removal of cuisine inclusion/exclusion.
Locked needs are not targeted. This is not an exhaustive optimizer, a
minimum-cardinality conflict proof, or an automatic change of scope. Owners
or the organizer receive the relevant private request and grant/deny it.

### 7.3 Proposal lifecycle

```text
open <── last veto replaced ── vetoed
  │ ───── standing rejection ──> │
  │
  └── stage with all blockers clear ──> staged ── confirm ──> committed
                                         │
                               blocker at commit recheck
                                         └──────────> open
```

A veto blocks a proposal without deleting it. Replacing the last rejection
reopens it. Staged proposals reject new stances; readiness or membership can
still change and invalidate commitment. Commit withdraws competing live
proposals. There is no general proposal-withdraw or standalone abort tool.

## 8. Command set

Every mutation below additionally requires `baseRevision`. Spatial commands
are listed in spatial protocol §6; all registered WebMCP names and annotations
are in binding §2.3.

| Command/read | Additional input | Authority/effect |
|---|---|---|
| `SyncSession` | `sinceRevision?`, `cursor?` | Authenticated participant projection |
| `SubmitRequirement` | `requirementId?`, `visibility`, `hardness`, `delegation`, `payload?`, `scopeHint?`, `note?` | Create/update own need |
| `WithdrawRequirement` | `requirementId` | Withdraw own need |
| `SetRequirementActive` | `requirementId`, `active` | Set aside/restore own need |
| `EvaluateCandidates` | `verdicts[1..10]` as §5.3 | Own aggregate private screening |
| `RespondToProposal` | `proposalId`, `disposition`, `visibility`, `reason?` | Own stance |
| `ResolvePrivateRequest` | `requestId`, `decision` | Addressee grants/denies adjustment |
| `SetReadyState` | `state` | Own readiness |
| `ConfirmAgreement` | `proposalId` | Organizer stages agreement |
| `ConfirmPrivateRequest` | `requestId`, `confirmationNonce` | Page-only application of staged grant |
| `CommitAgreement` | `proposalId`, `confirmationNonce` | Page-only organizer commit |

The page can read an owned or shared need for preview; no command edits
another participant's requirement. `ResolvePrivateRequest` accepts no
arbitrary payload or requested new value: it answers an existing request.

## 9. Envelope

The HTTP command bus receives `{type: "SubmitRequirement", input: {...}}`.
Authentication and tool-contract version are HTTP headers; room, actor,
protocol version, and visibility are not wrapped in a universal client-supplied
event envelope. Visibility belongs to the command input where its schema
allows it.

A command success contains `{ok:true, revision, outstanding}` and optional
`effect`, `staged`, `replayed`, or `syncHint`. A failure normally contains
`{ok:false, error:{code,message,recovery}}`, with `delta` on `sync_required`.
Read results have their own types. Projected events use the shape in §4.1.
The binding §3 defines the actual WebMCP text wrapper and structural result
compaction; raw HTTP responses and compact tool results are not identical.

## 10. Invariants and limits

The implementation and its tests enforce participant-derived identity,
owner-scoped writes, stale-write rejection, per-viewer content projection,
current-candidate screening revisions, delegated adjustment checks, and
agreement preconditions at stage and commit. Relevant coverage includes
[projection tests](../../tests/unit/projection.test.ts),
[phase/confirmation tests](../../tests/api/phase-and-confirmation.test.ts),
[protocol reliability tests](../../tests/api/protocol-reliability.test.ts), and
[multi-step tests](../../tests/api/steps.test.ts).

The following distinctions remain essential when using those guarantees:

1. A successful mutation's revision is at least its submitted revision;
   a failure need not contain a revision, and a replay is not a second change.
2. Server projection controls content access, not inference from outcomes or
   anonymous ownership of private needs.
3. An external agent's declaration omits its condition; the built-in
   screening mode sends condition text to the application/model as described
   in §5.3.
4. A locked need cannot be a council relaxation target, but its owner can
   edit or withdraw it; organizer scope authority remains independent.
5. Page confirmation has no registered agent-tool route. Its bearer-authenticated
   nonce is not cryptographic proof of a human gesture.
6. The implemented disclosure vocabulary, soft hardness, and domain-independent
   design intent do not imply escalation, ranking, or another domain exists.

See [Known limitations](../KNOWN-LIMITATIONS.md) for remaining operational,
privacy, evidence, and browser boundaries.
