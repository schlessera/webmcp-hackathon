# Known limitations

Checked against `main` on 2026-09-07. Spokes is a working hackathon prototype;
these are the current limits of its product, data, and security boundaries.
The [WebMCP binding](protocols/INTERACTION-AND-BINDING.md) describes the
implemented agent interface. The dated
[security review](SECURITY-REVIEW-2026-09-07.md) is a supporting code review,
not a guarantee about a running deployment.

## Places, evidence, and travel

- **Prepared regions, not worldwide venue search.** The primary data is
  committed OpenStreetMap snapshots for Berlin and San Francisco. Refreshing
  those extracts is an offline operation. Runtime lookup and enrichment can
  supplement selected facts, but do not make the underlying venue inventory
  live or complete. Rooms can grow to 2,500 candidates; the current scope and
  plan step determine which places are relevant. Additional places may be
  visible through map exploration even when the room is at its cap. See the
  [area definitions](../packages/contracts/src/areas.ts) and
  [place loader](../apps/server/src/places.ts).
- **Evidence can be incomplete, stale, or wrong.** Facts have five states:
  verified true, likely true, likely false, verified false, and unknown.
  “Verified” reflects an accepted source or participant assertion, not an
  independent site visit by Spokes. Models can infer likely facts and can
  adjudicate an explicit venue or chain statement as verified. Provenance,
  confidence, and freshness help assess a claim; they do not guarantee it.
  Confirmations and attestations affect their originating room, not every
  room using that venue. The curated Berlin fallback includes a labelled
  demo overlay; those invented facts are not a claim about the primary city
  snapshots. See [evidence handling](../apps/server/src/enrich/adjudicate.ts)
  and [room attestations](../apps/server/src/attestations.ts).
- **Prices and travel times are estimates.** Price levels map to rough
  per-person bands, not a current menu quote. Walking, cycling, and driving
  estimates use great-circle distance and fixed speeds, without street
  routing, traffic, elevation, or accessibility checks. Transit-time needs
  remain unresolved. Navigation creates links for external apps; it does
  not calculate or validate a route, book transport, or make a reservation.
- **Opening-time checks use a limited schedule model.** Time-window
  eligibility operates in the area's timezone. It relies on a subset of
  weekly opening-hours syntax; public-holiday selectors and unsupported
  syntax are ignored. Missing or insufficient schedules can remain unknown,
  and exceptional closures may be missed. See the
  [hours parser](../packages/contracts/src/dossier.ts) and
  [eligibility rules](../apps/server/src/eligibility.ts).
- **A starting point is not necessarily a device location.** A newly created
  organizer receives a labelled fixture origin; new members join without an
  origin. Fixture positions use real place names but do not describe the
  person. Participants can set a stated or device position. Ongoing device
  tracking runs only with a device origin and live-sharing opt-in. Durable
  origins stay private to their owner in peer snapshots; opt-in coordinates
  are shared through realtime presence without the private origin label.
  The server retains the latest origin. Browser map tiles load directly
  from OpenFreeMap, while venue lookups/images use the application server.

## Decisions and room lifecycle

- **No leaving, removal, or room closing.** One-person invite links can add
  members after creation, but there is no participant leave/removal command,
  room-closing command, or automatic room-retention/deletion policy.
  Agreement checks every participant, including someone who disconnected:
  everyone must be ready and have accepted or abstained, with no veto.
  `conditionally_accept` has no condition-resolution workflow and blocks
  commitment until the participant changes stance. Normal rooms start in
  `gathering`; `setup` and `closed` are not reached by the normal flow.
- **An agreement does not certify feasibility.** Hard needs drive the
  evidence-based candidate classification. The group can still propose and
  commit a candidate labelled likely, uncertain, or excluded if the stance
  and readiness rules are satisfied. Soft/optional needs are recorded but
  do not yet affect ranking. Impasse suggestions use bounded heuristics,
  not an exhaustive search for the best compromise.
- **Organizer scope changes bypass member consent routing.** The organizer
  can directly change the shared search circle or transport scope. This
  does not ask affected members for consent, although ordinary private
  adjustment requests have delegated-bound and confirmation checks. Members
  cannot change the scope directly.
- **Plans are short and sequential.** Plans support at most three steps.
  Committing an intermediate choice settles that step and starts the next
  around the selected place; the final choice leads to arrival planning.
  There is no command to edit/reorder the plan or reopen a settled step.
  Protocol-level meeting-point negotiation remains deferred; choosing a
  park or other place as a step is supported.
- **Privacy escalation has no request workflow.** Agent-private candidate
  screening is implemented, but the manifest's disclosure levels L1–L3 do
  not correspond to a request/consent flow for progressively revealing a
  condition. Private adjustment requests grant or deny changes to needs or
  scope; they are not disclosure requests.

These behaviors are enforced by the [command engine](../apps/server/src/engine.ts),
[phase rules](../apps/server/src/phase.ts), and
[step advancement](../apps/server/src/steps.ts).

## Identity, private information, and agents

- **Browser possession is the identity boundary.** An unclaimed member link
  expires after one hour. Its first claim binds it to a secret held in that
  browser; this does not verify the intended person's identity. Participant
  bearer tokens expire after 24 hours, and organizer recovery links after
  seven days. Claimed member links can recover the same identity in the
  bound browser without a final lifetime or self-service revocation. Losing
  that browser secret can lose access; copying credentials can transfer
  authority. See [invites](../apps/server/src/invites.ts) and
  [authentication](../apps/server/src/auth.ts).
- **Private content is protected by access controls, not end-to-end
  encryption or anonymity.** Application-private conditions reach the
  server and durable storage. Peers do not receive their predicate/text,
  but can receive owner IDs, optional hints, counts, and aggregate per-place
  effects. Small groups can infer information from those effects. Private
  stances are hidden from peers while a veto can still block agreement.
- **“Agent-private” depends on which agent holds the condition.** An
  external agent can retain the text and send only declarations and verdicts.
  The built-in agent sends condition text to the application server, keeps
  it in process memory, and supplies it to tool-less models for
  interpretation and screening. It is omitted from requirement/event storage and from the
  tool-calling model's context. A restart loses the held text; re-enter it
  to resume fresh screening. No-storage/provider-routing request settings
  are not independent guarantees about provider handling. See the
  [condition holder](../apps/server/src/nl/holder.ts) and
  [screening path](../apps/server/src/nl/screening.ts).
- **Built-in screening can stall on missing evidence.** Its adapter emits
  `needs_info` without the command schema's required `infoNeeded` field.
  A batch containing that verdict is rejected, leaving the candidate screens
  pending. This also affects a batch where the model omitted a candidate and
  the adapter filled in `needs_info`. External agents can supply valid verdicts
  through `evaluate_candidates`.
- **Confirmation does not prove a human gesture.** Agreement commitment and
  over-bound grants need a 120-second, single-use nonce delivered only on
  the participant's authenticated realtime channel. Their applying commands
  have no WebMCP tool route. A holder of the participant's bearer token can
  open that channel and receive the nonce, so this binds the action to
  participant authority, not to proof that a person clicked. Details are in
  [binding §5.4](protocols/INTERACTION-AND-BINDING.md#54-page-confirmation-authority-not-proof-of-a-human-gesture).
- **Model review reduces authority, not interpretation errors.** The built-in
  tool-calling agent's mutations become owner-only approval cards, bound to
  exact stored arguments and the original revision. Approval is single-use
  and expires after five minutes; normal ownership and consent rules still
  apply. Malicious or misleading source text can still influence answers,
  ordinary need interpretation, private screening, or a suggestion someone
  approves. External WebMCP agents use their participant's authority and do
  not pass through this built-in review wrapper. See
  [action approvals](../apps/server/src/nl/approvals.ts).

## WebMCP and reliability

- **Native availability depends on the browser and agent host.** Spokes
  feature-detects `document.modelContext` and remains usable without it.
  The test shim exercises callbacks but does not prove native discovery,
  input validation, or compatibility with every host.
- **The tool view is bounded.** The catalog has 24 tools. Context includes
  the plan and visible need IDs, and pages candidates through five-minute
  document-local snapshots. Inspection offers explicit evidence/hour/link
  detail selection; image URLs and coordinates are omitted. Results that
  cannot fit intact fail explicitly rather than silently losing fields. See the
  [binding reference](protocols/INTERACTION-AND-BINDING.md) for the fields and
  budgets available to agents.
- **Stale writes require catch-up; retries need care.** All stale mutations
  are rejected; commutative rebasing is not implemented. Server idempotency
  lasts ten minutes and binds the entire request, including its revision.
  Exact ambiguous retries reuse a key while held in the document's bounded
  retry cache; a known stale rejection gets a new key after catch-up. Reload
  and cache expiry lose retry identity. Cancellation does not undo a server
  commit. Re-sync and inspect current state before retrying after reload.
- **Agent runtime state belongs to the host.** A missing REPL variable or a
  required-documentation gate cannot be repaired by the page. See the
  [recovery recipe](WEBMCP-AGENT-RECOVERY.md). Native browser regression tests
  verify discovery, execution, reload and retries, not Codex's REPL lifecycle
  or the host's approval decisions.
- **Completion and failures are not fully normalized.** Mutations await a
  projection refresh, but failed refreshes can leave old page state and
  there is no guaranteed paint before a tool resolves. Opening a room
  schedules navigation. Some callbacks can reject unexpectedly or return
  errors without recovery text; callback schema checks are not uniform.
  These limits are detailed in binding §§2–3.
- **The deployment assumes one application process for live coordination.**
  Realtime fan-out/presence, confirmation nonces, held private conditions,
  and resource quotas are process-local. PostgreSQL persists room state and
  events, but there is no shared presence/fan-out service or durable quota
  store. Restarts reset transient state and quotas; multiple replicas need
  coordination. Provider outages or budgets can pause fact enrichment and
  leave cached or unknown results.

The [security review's remaining work](SECURITY-REVIEW-2026-09-07.md) includes
separating the runtime database role from migration/admin privileges, durable
abuse ceilings and provider spending controls, controlled egress when using
a forward proxy, and operational backup/restore/monitoring verification.
Direct outbound fetches validate DNS at connection time; a proxy's own
resolver remains outside that application check. These are deployment
responsibilities, not evidence that a particular live host has been checked.
