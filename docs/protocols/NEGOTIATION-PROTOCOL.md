# Agent Negotiation Protocol — `negotiation/v1`

Status: initial design, 2026-08-31. This document is the authoritative design
for the domain-independent negotiation layer. The spatial domain payloads it
carries are defined in [SPATIAL-PROTOCOL.md](SPATIAL-PROTOCOL.md); the WebMCP
tool binding, shared result envelopes, and error model are defined in
[INTERACTION-AND-BINDING.md](INTERACTION-AND-BINDING.md).

## 1. Purpose and position

The negotiation protocol defines how a participant — through direct UI action
or through a personal agent — represents themselves in a shared decision
without revealing more than necessary. It is transport-agnostic: the same
commands arrive via WebMCP tools, UI gestures, and (internally) the realtime
channel. It knows nothing about maps, destinations, or coordinates; those are
opaque, typed domain payloads.

```text
UI gestures ─┐
             ├─> Command bus ─> Negotiation engine ─> Event log ─> Projections
WebMCP tools ┘        │                                    │
                domain payloads                     per-participant views
                (spatial-destination/v1)            (WS/SSE + tool results)
```

## 2. Design principles

1. **One event log, many projections.** Every accepted command appends exactly
   one or more events to a single monotonically revisioned log. Nothing is
   client-side-hidden; the server omits what a viewer may not see.
2. **Revision discipline everywhere.** Every mutation carries `baseRevision`.
   Stale mutations are rejected with a `sync_required` result carrying the
   delta — never silently applied against old state.
3. **The server owns identity.** `actorId` is derived from the authenticated
   page/session context. No command accepts an actor identifier as input.
4. **Agents advocate; the council mediates; only humans consent.** No
   constraint is relaxed and no privacy level is escalated outside the owner's
   explicitly delegated authority, and consequential steps are confirmed in
   the page UI, not by the agent alone.
5. **Return, don't throw.** Failures are structured results with recovery
   information, because WebMCP gives rejected promises no error detail channel.
6. **Static capability surface.** The tool set does not change with session
   phase (ChatGPT's browser may not observe mid-conversation `toolchange`).
   Phase applicability is expressed in results, not in tool availability.

## 3. Core objects

### 3.1 Session (Room)

```jsonc
{
  "sessionId": "room_7f3a",
  "revision": 42,                    // monotonic, increments per accepted command
  "phase": "deliberation",           // see §7 state machines
  "goal": "Dinner tonight near Kreuzberg",
  "domain": "spatial-destination/v1",
  "policy": {
    "agreementRule": "all-accept-organizer-commit",
    "allowedVisibilities": ["shared", "application-private", "agent-private"],
    "guestAccess": true,
    "expiresAt": "2026-09-01T02:00:00Z"
  }
}
```

### 3.2 Participant

```jsonc
{
  "participantId": "p_sarah",
  "displayName": "Sarah",
  "role": "organizer" | "member",
  "connection": "live" | "idle",     // realtime channel presence, informational
  "readyState": "contributing" | "ready",
  "lastSyncedRevision": 37           // server-tracked, per agent surface
}
```

A participant is **active** if joined and not departed/expired. The agreement
rule quantifies over active participants.

### 3.3 Requirement

A participant-owned condition. The negotiation layer owns its lifecycle,
hardness, visibility, and delegation; the *content* is a domain payload.

```jsonc
{
  "requirementId": "req_19",
  "ownerId": "p_joe",
  "visibility": "application-private",     // shared | application-private | agent-private
  "hardness": "hard" | "soft",
  "delegation": {
    "mode": "locked" | "approval_required" | "negotiable" | "soft",
    "bound": { /* domain payload, e.g. { "dimension": "radius_m", "max": 1500 } */ }
  },
  "lifetime": "session" | "durable",       // durable requires explicit promotion
  "payload": { /* domain payload; ABSENT when visibility = agent-private */ },
  "disclosureLevel": 0                      // agent-private only, see §5.3
}
```

**Agent-private requirements have no server-side payload.** Submitting one
creates a *declaration*: the server learns only that an undisclosed constraint
exists, its hardness, its delegation envelope, and optionally a domain scope
hint (see §5.3). Content stays in the agent's context.

Hardness × delegation defaults: requirements tagged with protected categories
by the domain (medical, allergy, safety, accessibility) default to
`hard + locked` and the council must prefer scope changes over relaxation
requests against them.

### 3.4 Proposal

A candidate shared outcome, referenced by a stable domain ID.

```jsonc
{
  "proposalId": "prop_3",
  "domainRef": { "candidateId": "place_42" },
  "createdBy": "p_org",                    // or "council"
  "createdAtRevision": 31,
  "status": "open" | "withdrawn" | "vetoed" | "staged" | "committed"
}
```

### 3.5 Stance

One participant's structured position on a proposal (or, pre-proposal, on a
candidate during private screening — see §5.3).

```jsonc
{
  "participantId": "p_sarah",
  "subject": { "proposalId": "prop_3" },   // or { "candidateId": "place_42" }
  "disposition": "accept" | "reject" | "abstain" | "conditionally_accept"
                | "request_information" | "offer_relaxation"
                | "require_user_approval",
  "visibility": "shared" | "application-private" | "agent-private",
  "conditions": [ { /* domain payload */ } ],   // conditionally_accept only
  "reason": { "kind": "domain", "payload": {} } // OPTIONAL; never required
}
```

`reject` is a veto: it blocks agreement while it stands. Soft objections are
expressed as `conditionally_accept` or left to ranking. A stance with
`visibility: "agent-private"` reaches the council as disposition-only; peers
see at most its aggregate effect.

**Implemented binding note.** `respond_to_proposal` currently carries no
condition argument. `conditionally_accept` records only that disposition and
blocks agreement; the participant must later submit `accept` or `abstain`
after the condition is resolved. The `conditions` example above is deferred,
not silently inferred from `reason`.

### 3.6 Adjustment (counterfactual)

Council-computed, quantified recovery option during an impasse.

```jsonc
{
  "adjustmentId": "adj_2",
  "kind": "scope_change" | "requirement_relaxation" | "evidence_request"
        | "disclosure_request",
  "target": { "requirementId": "req_19" },      // or a domain scope dimension
  "change": { /* domain payload: from → to */ },
  "projectedGain": { "newCandidates": 3 },
  "requiresConsentOf": "p_joe",
  "withinDelegatedBound": false,
  "expiresAtRevision": 55
}
```

`withinDelegatedBound: true` adjustments may be auto-accepted by the council
under the owner's `negotiable` envelope; everything else becomes a private
outstanding decision for the owner.

Granting an adjustment outside that envelope first changes its durable status
to `staged_grant` and appends `adjustment_grant_staged`. That event advances
the room revision but projects only to the addressee; peers receive no content
or existence signal. Restaging the same request replaces its prior live
confirmation nonce, so only the latest credential can apply it.

### 3.7 Agreement

```jsonc
{
  "proposalId": "prop_3",
  "rule": "all-accept-organizer-commit",
  "confirmations": [
    { "participantId": "p_sarah", "disposition": "accept", "atRevision": 61 }
  ],
  "stagedAtRevision": 62,
  "committedAtRevision": 63
}
```

**Commit precondition (v1 rule):** every active participant's latest stance on
the proposal is `accept` or `abstain`; a current `conditionally_accept` must be
re-stanced because condition arguments/lifecycle are deferred; every active
participant is `ready`; the committer is the
organizer. Commit is a two-step: `agreement_staged` (organizer initiates,
in-page confirmation UI appears) then `agreement_committed` (human confirms in
the page). A high rank is never agreement.

**Readiness follows acceptance (2026-09-02).** An `accept` stance also sets
its author's `readyState` to `ready` (emitting `ready_state_changed` when it
changed): accepting a place is the strongest "done contributing" a person can
say, and the page must never offer a stage button that fails on a toggle
nobody was told about. Readiness stays the participant's own status —
`SetReadyState { contributing }` takes it back. Every `ProposalView` carries
`staging: { ready, notReady[], unaccepted, vetoStands }` so the organizer's
card can name what staging waits on: readiness by participant id (the roster
publishes it), the acceptance gap as a count only (a private stance must stay
indistinguishable from silence).

## 4. Canonical events

Every accepted command appends events from this vocabulary. The revision after
appending is the command's resulting revision.

```text
session_created            participant_joined         participant_left
requirement_submitted      requirement_updated        requirement_withdrawn
private_requirement_declared                          requirement_relaxed
candidates_updated         proposal_created           proposal_withdrawn
stance_submitted           evaluation_requested       evaluation_recorded
scope_change_proposed      scope_change_applied
origin_updated              origin_sharing_changed
impasse_detected           adjustment_proposed        adjustment_resolved
disclosure_requested       disclosure_resolved
ready_state_changed        agreement_staged           agreement_committed
adjustment_grant_staged
phase_changed              arrival_plan_updated       session_closed
```

### 4.1 Projection policy

Each event is stored once and projected per viewer at one of four levels:

| Level | Example rendering |
|---|---|
| `full` | "Sarah requires a vegetarian option." |
| `existence` | "Joe added a private requirement." |
| `aggregate` | "A private requirement was updated. 2 candidates are no longer eligible." |
| `omit` | (event absent from this viewer's delta) |

Default matrix (owner and owner's agent always receive `full` for what the
server holds; agent-private content is `full` only in the agent's own context):

| visibility \ viewer | owner | peer | council |
|---|---|---|---|
| shared | full | full | full |
| application-private | full | aggregate¹ | full |
| agent-private | full (agent-side) | aggregate¹ | existence + disposition |

¹ The room owner may configure `existence` instead of `aggregate` per
requirement ("show that I added something, hide what"). Aggregate projections
must not include per-person scores or wording precise enough to identify the
owner or reason. **Server-side redaction is mandatory: unauthorized fields
never appear in another client's network payload.**

## 5. Privacy tiers — full v1 semantics

### 5.1 `shared`

Content and ownership visible to the room. Evaluated server-side.

### 5.2 `application-private`

Content visible to the server (council) and the owner only. The council
evaluates candidate eligibility with it; peers observe only aggregate effects
and redacted feed entries. The world-knowledge service receives attribute-only
queries, never the owner identity or free-text explanation, whenever an
attribute query suffices.

### 5.3 `agent-private` — declaration, screening, progressive disclosure

The strongest tier: the server never receives the constraint. Three
mechanisms make it workable:

**a) Declaration.** The agent submits a content-free declaration:

```jsonc
{
  "visibility": "agent-private",
  "hardness": "hard",
  "delegation": { "mode": "approval_required" },
  "scopeHint": { "affects": "candidate-eligibility" }   // optional, coarse
}
```

The council now knows it cannot classify feasibility for this participant on
its own: affected candidates are `uncertain`, not `eligible`.

**b) Screening loop.** Because the council cannot evaluate, it asks. It emits
`evaluation_requested` with a batch of candidate IDs; this appears in the
owner's `outstanding` list on their next sync. The agent evaluates locally
against its private knowledge and returns bulk verdicts:

```jsonc
// evaluate_candidates input
{
  "baseRevision": 44,
  "verdicts": [
    { "candidateId": "place_42", "verdict": "acceptable", "screenedMapRevision": 8 },
    { "candidateId": "place_17", "verdict": "unacceptable", "screenedMapRevision": 3 },
    { "candidateId": "place_29", "verdict": "needs_info",
      "infoNeeded": "attribute:dairy-free-options", "screenedMapRevision": 5 }
  ]
}
```

Verdicts are recorded as agent-private stances (disposition only), stamped with
the dossier `mapRevision` the agent actually screened. An omitted revision is
accepted for additive compatibility but recorded already stale; a revision
behind the candidate remains stale and one ahead is rejected. The council
folds only current verdicts into eligibility; peers see aggregate effects. Screening requests
are batched (≤ ~10 candidates) and re-issued only for new or changed
candidates, tracked by `mapRevision` on each dossier.

**c) Progressive disclosure ladder.** When screening stalls resolution (e.g.
impasse, or too many `needs_info`), the council may request escalation — never
force it. Levels:

| Level | What the server learns | Example |
|---|---|---|
| L0 | Verdicts only (default) | "place_17: unacceptable" |
| L1 | Categorical hint from the domain's hint taxonomy | "a dietary constraint" |
| L2 | Machine-checkable predicate, held application-private | `requires attribute lactose-free = verified_true` |
| L3 | Shared content | full requirement, visible to room |

Escalation flow: council emits `disclosure_requested { requirementId,
requestedLevel, reason, projectedGain }` → owner's outstanding list → the
human confirms **in the page UI** (agent may recommend, not consent) →
`disclosure_resolved { decision: grant | deny, newLevel }`. A grant to L2
converts evaluation from screening-loop to server-side for that predicate,
which is the efficiency payoff. Denial is always safe and terminal for that
request.

### 5.4 Inference honesty

The protocol minimizes disclosure; it cannot prevent small-group inference
from observed outcome changes. Aggregate projections are worded to avoid
naming owners or reasons, and the product must not claim cryptographic
secrecy from the operator. (See PRODUCT-CONCEPT.md privacy promise.)

## 6. Synchronization and catch-up

### 6.1 Sync request/response

Personal agents are not daemons; they catch up on their next tool call.
`sync_session` (read-only) with optional `sinceRevision` or continuation
`cursor`:

```jsonc
// result (see INTERACTION-AND-BINDING.md §3 for the shared envelope)
{
  "ok": true,
  "revision": 47,
  "phase": "deliberation",
  "identity": { "participantId": "p_org", "role": "organizer" },
  "manifest": { /* included when sinceRevision is absent — first connect */ },
  "feasibility": { "state": "fragile", "eligible": 2, "uncertain": 1, "excluded": 9 },
  "brief": "2 candidates remain eligible. Joe added a private requirement (3 candidates excluded). Sarah vetoed Cedar Table.",
  "delta": {
    "fromRevision": 40,
    "events": [ /* projected events, stored-revision order, capped */ ],
    "truncated": true,
    "throughRevision": 44,
    "cursor": "opaque; return unchanged"
  },
  "outstanding": [
    { "type": "evaluation_request", "candidateIds": ["place_51"], "issuedAtRevision": 45 },
    { "type": "stance_needed", "proposalId": "prop_3" }
  ]
}
```

- With no `sinceRevision`, the result includes the **capability manifest**
  (protocol versions, domain capabilities, allowed visibilities, agreement
  rule — see INTERACTION-AND-BINDING.md §2.2) and a state summary instead of
  a delta. This is the first-connection contract.
- `brief` is a ≤400-character natural-language summary the agent can relay.
- The implementation may lower a delta's event count to keep the complete
  sync envelope within its declared allowance. It never deletes events from an
  already-described page; the cursor resumes at the first omitted stored revision.
- Deltas are forward pages capped at ten projected events. The server may use
  a smaller page when the complete envelope would exceed its allowance. A caller MUST
  return `cursor` unchanged while `truncated: true`; it MUST NOT advance its
  consumed-event watermark to the room's `revision` until every page is
  consumed. `throughRevision` is the last stored revision scanned and advances
  across events omitted from this viewer's projection, so private events do not
  stall continuation.
- `revision` is the room head, not proof that its projected events were
  consumed. Clients maintain it separately from `throughRevision`.
- If the stored backlog exceeds the replay safety cap, the delta contains
  `resyncRequired: "backlog_too_large"` and no cursor. The caller MUST replace
  its state projections from a full sync/read before moving its event
  watermark. This is an explicit loss of incremental history, never a silent
  truncation.

### 6.2 Mutation discipline

Every mutating command carries `baseRevision`. Server behavior:

1. `baseRevision == current`: apply, return `{ ok, revision, effect, outstanding }`.
2. `baseRevision < current` but the command is **commutative** with the missed
   events (touches disjoint state): apply (rebase), return new revision plus a
   compact `delta` of what was missed.
3. Otherwise: reject with `{ ok: false, error: { code: "sync_required" },
   delta }`. The agent reads the delta, reconsiders, retries with the new
   revision. The server never silently acts on stale intent for stances,
   agreement, consent, or disclosure — those are always case 1 or 3, never
   rebased.

An in-page agent carries the snapshot revision it reasoned from. It submits
against exactly that revision; a `sync_required` result is model input for the
next round, not permission for the runtime to replay the same arguments at a
fresh revision. The agent re-reads, reconsiders, and may then form a new move.
At most one mutating tool call executes per model round.

## 7. State machines

### 7.1 Session phase

```text
setup ──> gathering ──> deliberation ──(impasse detected)──> impasse
                             ^                                   │
                             └────────(impasse resolved)─────────┘
deliberation ──(agreement staged+committed)──> agreed ──> arrival ──> closed
```

`impasse` is a flag on deliberation rather than an exclusive lock: candidates
may still be inspected and requirements edited while adjustments are pending.
All phases accept `sync_session`; commands not applicable to the current phase
return `phase_unavailable` with the current phase and what *is* available.

**v1 narrowing (as implemented, `apps/server/src/phase.ts`).** The diagram
leaves two transitions unlabelled and treats `impasse` ambiguously; the
implementation reads them as follows.

- `impasse` is not a phase. It is `rooms.impasse_active`, exactly as the
  paragraph above describes it. Reaching an impasse is instead one of the two
  triggers into `deliberation`: a room that has hit a conflict has stopped
  gathering and started resolving.
- `gathering → deliberation` on the **first `proposal_created`** or the
  **first `impasse_detected`**, whichever comes first.
- `deliberation → agreed` on `agreement_committed`.
- `agreed → arrival` on the **first `arrival_plan_updated`**. The two are kept
  distinct rather than collapsed: `agreed` means the destination is settled,
  `arrival` means people are working out how they get there. `plan_arrival` is
  therefore legal in both.
- `setup` and `closed` are defined but unreachable in v1: rooms are seeded
  with their participants already joined, and no command closes a session.

Gating is a table, not a per-handler check. Requirements, stances, scope,
proposals, consent, and agreement are legal in `gathering` and `deliberation`
only (staging and committing narrow further to `deliberation`, the phase a
proposal creates); `plan_arrival` is legal in `agreed` and `arrival`;
`set_ready_state` is legal wherever the room is live, because readiness is a
participant's own status rather than a negotiation move. Everything else
returns `phase_unavailable` naming the phase and listing what the phase
accepts.

### 7.2 Feasibility classification (continuous)

After every relevant change the council recomputes:

```text
feasible    ≥3 eligible candidates
fragile     1–2 eligible candidates
infeasible  0 eligible; all screening resolved         → impasse_detected
uncertain   0 eligible but pending screening/evidence  → issue evaluation/evidence requests first
```

`infeasible` triggers the impasse pipeline: (1) confirm conflict vs missing
data, (2) attempt neutral expansions via the domain (wider area, later time),
(3) compute a minimal conflicting requirement set deterministically,
(4) generate quantified adjustments, (5) route private adjustment requests,
(6) apply consented changes, recompute, publish a redacted resolution.

### 7.3 Proposal lifecycle

```text
open ──> (stances accumulate) ──> staged ──> committed
  │                                  │
  ├──> vetoed (any standing reject)  └──> open (stage aborted / stance changed)
  └──> withdrawn
```

A veto does not delete a proposal; it blocks it while the stance stands. The
vetoer may withdraw or condition their stance later.

## 8. Command set (abstract)

The transport-agnostic commands, bound to WebMCP tools in
INTERACTION-AND-BINDING.md §2. Every mutation includes `baseRevision`.

| Command | Actor | Effect |
|---|---|---|
| `SyncSession { sinceRevision? }` | any | read-only projection + delta + outstanding |
| `SubmitRequirement { requirementId?, visibility, hardness, delegation, payload? }` | owner | create or update (upsert by ID); agent-private ⇒ declaration only |
| `WithdrawRequirement { requirementId }` | owner | requirement_withdrawn |
| `EvaluateCandidates { verdicts[{…, screenedMapRevision?}] }` | owner w/ agent-private declaration | bulk screening verdicts, authoritative only at the screened dossier revision |
| `RespondToProposal { proposalId, disposition, visibility, reason? }` | any | stance_submitted; `conditionally_accept` blocks commit until a later stance |
| `ResolvePrivateRequest { requestId, decision, payload? }` | addressee | resolves adjustment/disclosure requests; consent outside delegated bounds requires in-page confirmation |
| `SetReadyState { state }` | any | ready_state_changed |
| `ConfirmAgreement { proposalId }` | organizer | stages agreement; commit finalized by in-page human confirmation |

Deliberately absent: no command reads or edits another participant's
requirements; no command accepts an actor identity; no command relaxes a
constraint directly (relaxation is always an adjustment resolution or the
owner editing their own requirement).

## 9. Envelope

All commands and events share the envelope from the original sketch, now
normative:

```jsonc
{
  "protocolVersion": "negotiation/v1",
  "sessionId": "room_7f3a",
  "baseRevision": 17,            // commands only
  "revision": 18,                // events only
  "actorId": "p_joe",            // server-derived, never client-supplied
  "messageType": "requirement_submitted",
  "visibility": "application-private",
  "domain": "spatial-destination/v1",
  "payload": { /* typed by the domain protocol */ }
}
```

## 10. Invariants (testable)

1. No client payload ever contains a field its viewer is not authorized for.
2. Every mutation result's `revision` ≥ the request's `baseRevision`.
3. Stance/agreement/consent/disclosure commands are never rebased (§6.2).
4. `agreement_committed` implies the §3.7 precondition held at staging *and*
   at commit revision.
5. Agent-private requirement payloads never appear in any server log or store.
6. No adjustment outside `withinDelegatedBound` is applied without a
   `disclosure_resolved`/`adjustment_resolved` grant from its owner.
7. Locked requirements are never the target of relaxation adjustments;
   protected categories default to locked.
8. Every event appears in the owner's projection at `full` (server-held
   content) — participants can always audit their own data.
