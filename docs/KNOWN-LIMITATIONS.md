# Known limitations (POC scope)

Spokes is a hackathon proof of concept for privacy-preserving multi-party
negotiation over WebMCP. Two independent adversarial reviews (a GPT-5.6 code
review and a protocol-invariant audit) ran against the vertical slice; the
demonstrable correctness and privacy findings were fixed. The items below are
deliberately deferred — they do not affect the demonstrated flow and each has a
bounded, honest threat model. We list them rather than hide them.

## Deferred, with rationale

- **The confirmation nonce binds to a page session, not to a human gesture.**
  Committing an agreement and applying an over-bound grant are two-step: the
  WebMCP tool only *stages*, the applying command has no tool route, and (since
  this change) staging mints a 120-second single-use nonce delivered only on
  the participant's realtime channel, which the applying command must carry
  back. That closes the blind replay — a script holding a bearer token can no
  longer POST `CommitAgreement` without ever touching the page. It is not proof
  a human clicked: the realtime channel authenticates with the same bearer
  token, so the same token holder can open a socket, be re-issued a nonce, and
  apply. The residual case is a participant acting as themselves, in their own
  room, on their own decisions. See INTERACTION-AND-BINDING §5.4.
- **Phase machine narrows two ambiguous §7.1 transitions.** All six states
  (`setup`, `gathering`, `deliberation`, `agreed`, `arrival`, `closed`) exist
  with a per-command gating table; `impasse` is a flag on deliberation, as the
  spec describes it. `setup` and `closed` are unreachable in v1 — rooms are
  seeded with participants already joined, and no command closes a session. The
  reading of the two unlabelled transitions is recorded in
  NEGOTIATION-PROTOCOL §7.1.
- **Organizer scope changes apply without consent routing.** The organizer's
  `SetSearchScope` applies in one step; the spatial protocol's invariant 7
  (route through consent when another participant's bounded-negotiable
  requirement is affected) is not implemented for the organizer. Members are
  refused outright (a POC simplification).
- **No participant join/leave lifecycle.** The agreement rule quantifies over
  all seeded participant rows; `policy.expiresAt` is stored but not enforced;
  guest tokens do not expire or revoke. Fine for a time-boxed demo room.
- **Disclosure ladder L1–L3, commutative rebase, transit routing, meeting
  points, and time-window eligibility** were scoped out of this slice from the
  start (see the protocol docs' open-questions sections). The agent-private
  screening loop (L0) is implemented.
- **Realtime fan-out and presence remain single-process.** Ping/pong expiry
  prevents half-open sockets from leaving stale presence or viewing state on
  that process, but there is no LISTEN/NOTIFY, Redis, durable outbox, or
  cross-worker presence store in this POC.

## Reliability findings closed in pass 1

- Delta catch-up now pages forward with an opaque stored-event cursor, advances
  across viewer-omitted private events, and signals an oversized backlog as an
  explicit full resync instead of silently dropping history.
- Page-authored mutation revisions and consumed WebSocket projection revisions
  are separate. Event broadcasts are ordered per room, frames carry an
  additive continuity revision, and gaps trigger catch-up.
- Mutations use participant-scoped ten-minute idempotency keys, and WebMCP
  mutation completion waits for the visible spatial projection to reach the
  committed revision.
- The in-page agent acts against the snapshot revision it saw and receives
  `sync_required` as model input. Over-bound grant staging now advances the
  room revision through an owner-only event and replaces older confirmation
  nonces for the same subject.

## Reliability findings closed in pass 2

- Candidate fact revisions now version private screening verdicts. An
  attestation increments `mapRevision`, stale verdicts stop affecting
  eligibility, and each active private condition receives a fresh screening
  request without exposing its content.
- Candidate inspection no longer holds a room lock or database client while
  waiting on external sources. On-demand work has a shared concurrency bound
  and the request returns at its lookup deadline while bounded work may finish
  into the cache.
- Enrichment refreshes use an OSM-ref database lease across server processes.
  Website and Wikidata freshness and errors are independent, and a transient
  provider failure keeps its last good parsed facts while shortening only its
  own retry window.
- In-page agent turns now have one 60-second deadline, four rounds, valid
  structurally compacted tool JSON, and one mutation per model round. Every
  mutation outcome is persisted immediately; a later failure returns those
  completed actions as an additive partial result and leaves the original
  composer text available for retry instead of creating a fallback need.

## Reliability findings closed in pass 3

- Realtime sockets receive 30-second pings and expire after 45 seconds without
  a pong; client reconnect uses jittered exponential backoff.
- Every non-sync WebMCP result is structurally encoded as valid JSON within the
  declared 1,500-character budget, with omission counts and preserved error
  shapes. `sync_session` now has the additive 8K exception described below.
  Read cancellation reaches fetch; mutation cancellation remains coupled to
  the pass-1 idempotency key.
- WebSocket versions, viewing IDs, verdict cross-fields and uniqueness,
  attestation URIs, future sync revisions, and actionable enum errors are now
  enforced. Unexpected command and client transport failures use a shared
  retryable envelope instead of escaping or claiming an ID was not found.
- The capability manifest no longer advertises meeting points; the 20-tool
  documentation and deferred spatial sections match implementation. Contract
  hashing is generated from the live response/message types, including all
  optional fields.

## Reliability findings closed in protocol-fix pass

- `sync_session` has an additive 8K allowance. Its first-connection manifest is
  intact, while large deltas are reduced to cursor-backed forward pages before
  encoding; the encoder never deletes events after claiming their revision.
- Private screening carries the room and candidate fact revisions it actually
  judged. Missing or old verdict revisions stay stale, including in impasse
  detection, and concurrent lookup/attestation changes cause `sync_required`.
- Browser mutations use one logical idempotency key across attempts and
  `sync_required` recovery. Natural-language turns are idempotent as a whole;
  per-attempt correlation IDs remain diagnostic only.
- Enrichment takes a bounded, fair process slot before its database lease, so
  queued work cannot expire a lease it has not begun using. Excess waiters
  receive stale cached data instead of growing the queue without bound.
- Reconnecting tabs receive the existing live confirmation nonce; only a real
  restage revokes it. Forged future delta targets are clamped to the room head,
  and already-ahead cursors are rejected.
- Fact commits notify the ordered room queue synchronously through a cycle-free
  registry. WebSocket transport errors have an explicit listener, and the
  TypeScript compiler used to derive the contract hash is pinned exactly.

## Data honesty

The three Berlin Mitte starting positions (near Rosenthaler Platz,
Alexanderplatz and Hackescher Markt) and the three San Francisco SoMa starting
positions (near Yerba Buena Gardens, South Park and Mint Plaza) are demo
fiction. They use real place names, but do not describe any participant. Every
room initially assigns them in roster order, organizer first. A real client
reads the participant's current position from device geolocation and updates it
as the person moves.

The venue dataset is a real one-time OpenStreetMap extract of Berlin Mitte
(ODbL; see `packages/contracts/data/ATTRIBUTION.md`). A small curated overlay,
marked with `source: "curated:demo-2026-08"`, sets the handful of attribute
values (notably lactose-free availability, which OSM does not tag here) that
make the scripted impasse deterministic. Overlay values are demo fiction and are
labelled as such in the data; all other facts come from OSM tags with honest
`observedAt` timestamps and four-state verification.
