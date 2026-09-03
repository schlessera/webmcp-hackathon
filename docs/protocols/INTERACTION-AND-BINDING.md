# Protocol Interaction and WebMCP Binding

Status: initial design, 2026-08-31. Companion to
[NEGOTIATION-PROTOCOL.md](NEGOTIATION-PROTOCOL.md) and
[SPATIAL-PROTOCOL.md](SPATIAL-PROTOCOL.md). This document defines how the two
protocols compose, and their single concrete binding to WebMCP: the tool
surface, shared result envelope, error model, security posture, and evolution
rules.

## 1. Layering

```text
┌──────────────────────────────────────────────────────────────┐
│ Transports:  WebMCP tools │ UI gestures │ WS/SSE projections │
├──────────────────────────────────────────────────────────────┤
│ Binding layer (this doc): tool schemas, result envelope,     │
│ error model, identity derivation, output budgets             │
├──────────────────────────────────────────────────────────────┤
│ negotiation/v1: identity, privacy, revisions, requirements,  │
│ stances, adjustments, consent, agreement    (domain-opaque)  │
├──────────────────────────────────────────────────────────────┤
│ spatial-destination/v1: scope, candidates, dossiers, routes, │
│ arrival — typed payloads + spatial commands                  │
└──────────────────────────────────────────────────────────────┘
```

Composition rules (normative):

1. The negotiation layer treats every spatial payload as opaque but typed; it
   validates the envelope, the spatial validator validates the payload.
2. Spatial commands with negotiation meaning **compile to negotiation
   commands** (veto pin → `RespondToProposal`). No spatial side channel exists
   for stances, consent, scope consensus, or agreement.
3. The negotiation engine never touches map state except by emitting events
   the spatial layer projects. The map is a projection, not a source of truth.
4. UI gestures and WebMCP tools converge on the same command bus; a command's
   effects are indistinguishable across entry surfaces.
5. The two protocol versions evolve independently and are both declared in the
   capability manifest.

## 2. WebMCP binding

### 2.1 Registration model: static surface

All tools are registered once at page load via
`document.modelContext.registerTool()` (feature-detected; the page is fully
usable without WebMCP). **No state-gated registration in v1**: ChatGPT's
in-app browser binds tools at page level and may not observe mid-conversation
`toolchange`; it also supports neither declarative form tools nor tools in
iframes. Therefore:

- Imperative API only, registered from the top-level document.
- Phase applicability lives in **results** (`phase_unavailable` error with
  guidance), not in tool presence.
- If a schema must change incompatibly, the tool is **renamed**
  (`…_v2`) rather than re-registered under the same name (schema-swap race in
  the spec; see WEBMCP-REFERENCE.md §6.11).

### 2.2 First-connection contract

The agent's first `sync_session` call (no `sinceRevision`) returns the
capability manifest — this is how the page *teaches* the agent both protocols,
since WebMCP itself carries only tool names/descriptions/schemas:

```jsonc
{
  "protocols": { "negotiation": "v1", "domain": "spatial-destination/v1" },
  "capabilities": ["destination-search", "map-selection",
                   "navigation-handoff", "private-screening", "impasse-resolution"],
  "privacy": {
    "allowedVisibilities": ["shared", "application-private", "agent-private"],
    "disclosureLevels": ["verdicts-only", "category-hint", "predicate", "shared"],
    "hintTaxonomy": ["dietary", "accessibility", "budget", "distance", "time",
                     "personal-history", "atmosphere", "other"]
  },
  "agreement": { "rule": "all-accept-organizer-commit" },
  "attributeVocabulary": ["vegetarian-options", "lactose-free-options",
                          "wheelchair-accessible", "outdoor-seating",
                          "dog-friendly", "price-level", "cuisine"],
  "conduct": "You act for exactly one participant. Submit only what your user authorizes. Private info can stay private: use visibility levels and screening verdicts instead of disclosing. Mutations need baseRevision from your last sync."
}
```

The `conduct` string is the application's one paragraph of protocol
instruction to the model — kept short because it rides in a tool result.

### 2.3 The tool surface (20 tools)

Names ≤30 chars, descriptions ≤500 chars, parameter descriptions ≤150 chars,
results ≤1.5K chars (Chrome budget guidance), except `sync_session`, whose
additive 8K allowance carries an intact first-connection manifest and complete
lossless delta pages. All schemas use
`additionalProperties: false`, `enum` over free strings, and stable IDs.
**No free-text catch-all parameters** — the one deliberate exception is
`note` fields, capped and documented as optional.

Negotiation tools:

| Tool | RO¹ | UGC² | Command | Notes |
|---|---|---|---|---|
| `sync_session` | ✓ | ✓ | SyncSession | First call returns manifest; later calls return delta + brief + outstanding |
| `submit_requirement` | | | SubmitRequirement | Upsert by optional `requirementId`; `visibility: agent-private` sends declaration only (no payload) |
| `withdraw_requirement` | | | WithdrawRequirement | |
| `set_requirement_active` | | | SetRequirementActive | Owner sets a need aside or restores it without withdrawing it |
| `evaluate_candidates` | | | EvaluateCandidates | Bulk verdicts for agent-private screening; ≤10 per call |
| `respond_to_proposal` | | ✓ | RespondToProposal | Stances incl. veto; `reason` optional. `conditionally_accept` carries no condition and blocks commit until re-stanced |
| `resolve_private_request` | | | ResolvePrivateRequest | Grant/deny adjustment & disclosure requests; grants outside delegated bounds are **staged** pending in-page confirmation |
| `set_ready_state` | | | SetReadyState | |
| `confirm_agreement` | | | ConfirmAgreement | Organizer only; **stages** — human commits in the page UI |

Spatial tools:

| Tool | RO¹ | UGC² | Command | Notes |
|---|---|---|---|---|
| `get_spatial_context` | ✓ | ✓ | GetSpatialContext | Scope + feasibility + candidate summary rows |
| `inspect_candidates` | ✓ | ✓ | InspectCandidates | 1–3 dossiers; 2–3 = comparison view |
| `set_search_scope` | | | SetSearchScope | **Organizer only**; applies area/transport scope for the room |
| `add_candidates` | | | AddCandidates | Adds stable refs from the explore layer to the room pool |
| `look_up_places` | ✓ | | read | Starts bounded fact lookup for 1–3 places |
| `propose_destination` | | | ProposeDestination | |
| `focus_destination` | ✓³ | | FocusDestination | Local presentation only; no shared state |
| `plan_arrival` | | | PlanArrival | Walk/bike/car mode and optional pickup note; routing and meeting points are deferred |
| `attest_attribute` | | | AttestAttribute | Records shared participant-supplied evidence |
| `prepare_navigation` | ✓ | | PrepareNavigation | Handoff links from held coordinates |

¹ `annotations.readOnlyHint: true`.
² `annotations.untrustedContentHint: true` — result may embed
participant-authored text (requirement notes, veto notes, feed lines) or
provider content. ³ Read-only from the session's perspective; mutates only
the caller's local view (documented in the description).

The 20-tool surface is static and each entry has a non-overlapping command or
read role. Consequential apply/commit commands remain page-only and are not
part of this count.

### 2.4 Description discipline

Descriptions state capability positively and distinguish **execution from
initiation** (staging tools say "stages X for the user to confirm on the
page"). Example:

> `confirm_agreement` — "Stage the group agreement on a proposal for final
> confirmation. Requires organizer role, all participants ready, and no
> standing veto. The human confirms on the page; this does not commit by
> itself."

## 3. Shared result envelope and error model

Every tool **resolves** (never rejects — rejected promises lose all detail)
with one of:

```jsonc
// success
{
  "ok": true,
  "revision": 48,
  "effect": "Vetoed Cedar Table. 2 candidates remain eligible.",  // ≤200 chars
  "outstanding": [ /* decisions now pending for THIS participant */ ],
  "syncHint": { "eventsSinceYourLastSync": 3 }    // present when the agent is behind
}

// failure
{
  "ok": false,
  "error": {
    "code": "sync_required",
    "message": "Session moved from revision 44 to 48.",
    "recovery": "Review the delta, then retry with baseRevision 48."
  },
  "delta": { /* included for sync_required */ }
}
```

Error codes (closed enum):

| Code | Meaning | Recovery guidance in result |
|---|---|---|
| `sync_required` | Stale `baseRevision`, non-rebasable command | Delta included; reconsider and retry |
| `not_authorized` | Role/ownership violation | States required role; never leaks target's existence details |
| `invalid_input` | Failed server-side validation (schemas are hints, not enforcement) | Names the field, received value, and actual allowed values when the field is closed |
| `not_found` | Unknown stable ID | Suggests `get_spatial_context`/`sync_session` to refresh IDs |
| `phase_unavailable` | Command not applicable in current phase | States current phase and applicable actions |
| `consent_required` | Action exceeds delegated authority | States that the human must confirm on the page |
| `bound_exceeded` | Adjustment outside a delegation envelope | Returns the bound's dimension and limit (owner only) |
| `temporarily_unavailable` | Cancellation, transport/parse failure, or unexpected server failure | Sync the room to check an ambiguous outcome before deciding whether to try again |

Design intents:

- **Self-correcting errors**: every failure tells the model what to do next.
- **Output budget**: `effect` and `brief` strings are capped; candidate lists
  are summary rows (≤8 by default) with counts for the remainder; full detail
  is pull-based via `inspect_candidates`. Every registered tool crosses one
  structural encoder: its final text block is valid JSON at ≤1,500 characters,
  retains the shared error shape, and reports counts of omitted array items,
  object fields, and string characters. `sync_session` uses its declared 8K
  allowance instead: the manifest is never compacted, and an oversized delta
  becomes a smaller forward page with a continuation cursor before encoding.
  Its events are never deleted after `throughRevision` has been chosen.
- **Cancellation**: read tools pass the invocation's abort signal through to
  their fetch. Mutation cancellation is an ambiguous outcome and is safe to
  retry only with the pass-1 idempotency key.
- **UI-before-return**: mutation results resolve only after the local view
  reflects at least the result's `revision`, so an agent inspecting the page
  sees consistent state. A caller joining an older in-flight projection read
  waits for the queued revision-targeted successor.

### 3.1 Reliable mutation and event delivery

HTTP mutation requests MAY carry `Idempotency-Key`. The browser generates one
key for the logical mutation, separate from per-attempt correlation IDs, and
reuses it after `sync_required` catch-up and any transport retry. For ten minutes the server
binds `(participant, key)` to the canonical request hash and completed
response. A success is stored in the command transaction; a failure is stored
after its transaction has rolled back. An identical repeat returns that
response without a second mutation, event sequence, broadcast, or confirmation
nonce; the same key with a different body returns `invalid_input`. This header
is additive and clients that omit it retain the existing
at-most-once-per-request behavior.

`POST /api/nl/say` uses the same participant-scoped header for the complete
natural-language turn. Duplicate turns serialize before model work and replay
the completed response, so retrying an ambiguous request cannot run the agent's
mutations twice.

The browser maintains two revision values. `knownRoomRevision` is advanced by
sync, welcome, event, and HTTP success and is safe as the base for a new page
gesture. `projectedThroughRevision` is advanced only by an in-order event frame
or by fully consumed delta pages. Every welcome starts catch-up from the latter,
even when it equals `knownRoomRevision`, because an HTTP response is not proof
that the corresponding WebSocket frame arrived.

Server event frames are serialized per room and MAY include additive
`fromRevision`, the revision immediately before the frame's first stored event.
A client that sees `fromRevision` differ from its projection watermark MUST
discard that frame as a direct update and invoke paginated sync. Participant-
private `outstanding` responses are revision-gated so a slower old sync cannot
overwrite a newer one.

`sync_session` accepts additive optional `cursor`, returned by a truncated
delta. Events are forward pages over stored revisions; `throughRevision`
advances across viewer-omitted events. Callers continue until `truncated` is
false before advancing to the room head. `resyncRequired:
"backlog_too_large"` explicitly requires replacement from a full state read;
the server never silently advances past an unreplayed backlog.
Cursor targets above the current room revision are clamped to the room head;
a cursor whose consumed revision is already ahead is rejected as
`invalid_input`, matching the non-cursor `sinceRevision` guard.

The single serving process sends WebSocket ping control frames every 30
seconds and terminates a connection that has not ponged within 45 seconds.
Termination uses normal close cleanup, so advisory presence and viewing state
expire after half-open network loss. Browser reconnects use randomized
exponential backoff capped at 15 seconds. Cross-process presence and event
fan-out remain deferred.

## 4. End-to-end sequences (demo beats)

### 4.1 Join and first sync (async catch-up built in)

```text
Agent                    Page (tools)              Session server
  │  sync_session()          │                          │
  │─────────────────────────>│  SyncSession             │
  │                          │─────────────────────────>│ derive identity from
  │                          │                          │ page session token
  │  manifest + brief +      │<─────────────────────────│
  │  revision 12 + outstanding                          │
  │<─────────────────────────│                          │
```

### 4.2 Agent-private requirement and screening

```text
Joe's agent: submit_requirement { visibility: "agent-private",
             hardness: "hard", delegation: { mode: "approval_required" } }
  → event private_requirement_declared (rev 15)
  → peers' feeds: "Joe added a private requirement."   [existence/aggregate]
  → council: affected candidates → uncertain; emits evaluation_requested

Joe's agent (next turn): sync_session { sinceRevision: 15 }
  → outstanding: [{ type: "evaluation_request", candidateIds: [ ... ] }]
Joe's agent: evaluate_candidates { verdicts: [ …acceptable/unacceptable… ] }
  → evaluation_recorded (rev 17); eligibility recomputed
  → peers' maps update: "2 candidates are no longer eligible." (no owner, no reason)
```

### 4.3 Veto from the map, agent catches up

```text
Sarah (UI): pin card → Veto → reason "visited too recently"
  → RespondToProposal(reject) → stance_submitted (rev 23)
  → all projections update live via WS/SSE

Organizer's ChatGPT (was idle): respond_to_proposal { baseRevision: 20, … }
  → { ok: false, error: sync_required, delta: [rev 21–23 projected] }
  → agent reads delta ("Sarah vetoed Cedar Table"), reconsiders, retries at 23
```

### 4.4 Impasse → private adjustment → consent → recovery

```text
Council: 0 eligible, screening resolved → impasse_detected (rev 30)
  room feed (all): "No option satisfies every confirmed requirement.
                    The council is privately checking adjustments."
  minimal conflict set → { Joe's budget req, scope radius }
  adjustments: [{ radius 800→1400, +3 candidates, needs organizer },
                { budget 15→18 EUR, +2, needs Joe, withinDelegatedBound: false }]

Joe's next sync → outstanding: [{ type: "adjustment_request", adj… }]  (private)
Joe's agent: resolve_private_request { requestId, decision: "grant" }
  → { ok: false → NO — returns ok with staged: true }  … consent_required path:
  → result: "Grant staged. Joe must confirm on the page." + page shows confirm card
  → adjustment_grant_staged (owner-only revisioned event; no peer projection)
Joe (UI): taps Confirm → adjustment_resolved, requirement_relaxed (rev 33)
  → recompute → impasse_resolved; feeds: "Search adjusted. 3 new candidates."
  (owner and reason never published)
```

### 4.5 Agreement and arrival

```text
All participants: set_ready_state(ready); stances on prop_3 all accept/abstain
Organizer agent: confirm_agreement { proposalId: "prop_3" }
  → agreement_staged; page shows commit card to organizer (human)
Organizer (UI): Confirm → agreement_committed (rev 41) → phase: arrival
Each participant: plan_arrival { mode, pickup? } → arrival_plan_updated
Each participant: prepare_navigation → geo/google/apple links (one click)
```

## 5. Security binding

Beyond the per-protocol invariants:

1. **Identity**: the room-scoped invite secret arrives in the URL fragment and
   is exchanged for a participant token held in `sessionStorage` (tab-scoped —
   a session cookie would collide across tabs in one browser profile). Every
   tool call inherits it. Tool arguments contain no `actorId`,
   `participantId`-as-self, or role claims.
   WebSocket authentication also requires the loaded page's `clientBuildId`
   and `clientToolContractVersion`; either mismatch is rejected before the
   participant joins presence.
2. **Validation**: the browser does not enforce `inputSchema`; the server (and
   the page shim before dispatch) re-validates every argument against the
   closed vocabularies. Unknown enum values → `invalid_input`.
3. **Injection defenses**: all participant-authored and provider text returned
   through tools rides in structured JSON fields on tools marked
   `untrustedContentHint`, with length caps (`note` ≤200 chars). Feed
   projections are server-composed template strings, not raw user text, where
   redaction applies.
4. **Consequential actions have no agent tool route, and carry a confirmation
   nonce**: committing agreement and applying an over-bound grant are
   two-step — the negotiation tool (`confirm_agreement`,
   `resolve_private_request`) only *stages*, and the applying command
   (`CommitAgreement`, `ConfirmPrivateRequest`) is registered in
   `COMMAND_SCHEMAS` but bound to no WebMCP tool, so a personal agent — the
   threat model that matters here, a prompt-injected model acting through the
   tool surface — cannot reach it; only an in-page UI gesture dispatches it.

   That binding-layer control is backed by a server-side one. Staging mints a
   **confirmation nonce**: 24 random bytes, 120-second TTL, single-use, bound
   to room + participant + subject kind + subject ID. It is delivered *only*
   as a `confirmation` frame on that participant's realtime channel — never in
   the command result, so it never reaches the agent surface — and the
   applying command must carry it back or the server answers
   `consent_required`. A dropped socket loses that tab's copy, so the channel
   re-issues the existing live nonce for anything still staged on `welcome`;
   another tab authenticating does not revoke it. Only an actual restage
   replaces the credential. Nonces live in the server process, never on disk.

   **What this does and does not buy.** It closes the blind replay: a caller
   holding a participant's bearer token can no longer POST `CommitAgreement`
   from a script without ever touching the page. It is not proof that a human
   made a page gesture. The realtime channel authenticates with the same
   bearer token, so the same token holder can open a socket, be re-issued a
   nonce, and apply — they just have to speak the page's protocol and be
   connected inside the window. The honest claim is narrow: the applying
   commands are bound to a live page session, to one subject, and to a
   120-second single-use window. The residual case remains a participant
   acting as themselves, in their own room, on their own decisions. ChatGPT
   additionally runs its own per-invocation safety review; ours does not rely
   on it.
5. **Least exposure**: no `exposedTo` in v1 (no cross-origin consumers); the
   `tools` permissions policy stays default (`'self'`).
6. **Privacy testable at the wire**: the projection test suite asserts
   private fields never appear in any other participant's tool result, WS
   frame, or HTTP response body (NEGOTIATION-PROTOCOL invariant 1).

## 6. Versioning and evolution

- Manifest declares `negotiation: v1` and `domain: spatial-destination/v1`;
  they version independently.
- **Additive** changes (new optional fields, new enum values the server
  tolerates, new tools) do not bump versions.
- **Breaking** schema changes to a tool rename the tool (`_v2` suffix) —
  never a schema swap under a stable name.
- A future second domain (scheduling, purchasing…) reuses `negotiation/v1`
  unchanged: new domain string, new payload validators, new domain tool set.
  That boundary — everything in NEGOTIATION-PROTOCOL.md with zero spatial
  imports — is the future `negotiation-core` package seam. Extraction waits
  until after the vertical slice works (MVP-AND-RISKS.md).
- Correcting a capability that never had a callable implementation does not
  remove a tool or accepted result field. Pass 3 therefore withdraws the
  unsupported `meeting-points` advertisement while retaining tool contract v3.
- The contract hash derives runtime schemas from the exported response and
  realtime types; optional output fields cannot change without moving the
  committed manifest hash.

## 7. Resolved and open questions

Resolved in this design:

- Privacy tiers: all three fully, including screening loop and the four-level
  disclosure ladder (decision 2026-08-31).
- Agreement: all-accept + organizer-commit, staged with in-page confirmation
  (decision 2026-08-31).
- Static tool surface; imperative API only; plain-JSON results.
- Merged sketch tools: `connect_to_session`+`sync_session` → `sync_session`;
  `update_requirement` → `submit_requirement` upsert; `offer_relaxation` →
  owner edits own requirement or grants an adjustment;
  `request_user_approval` → server-initiated `outstanding` + in-page confirm;
  `compare_destinations` → `inspect_candidates[2..3]`;
  `set_search_area`/`set_planning_time` → `set_search_scope`;
  `calculate_meeting_point`/`preview_route` → `plan_arrival`.

Still open (do not block the vertical slice):

1. Whether commutative-rebase (§6.2 case 2 in NEGOTIATION-PROTOCOL) ships in
   v1 or everything non-current returns `sync_required` (simpler, safer
   default for the POC).
2. Exact `brief`/delta wording templates per event × projection level.
3. Whether `evaluate_candidates` needs a "re-screen changed candidates only"
   nudge in `outstanding` payloads (likely yes via `mapRevision`).
4. Scoring model after hard constraints pass (weighted soft-requirement
   satisfaction — details with implementation).
5. Minimal-conflict-set algorithm choice (greedy deletion is likely enough
   for POC-scale requirement counts).
