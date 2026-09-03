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

## Data honesty

The venue dataset is a real one-time OpenStreetMap extract of Berlin Mitte
(ODbL; see `packages/contracts/data/ATTRIBUTION.md`). A small curated overlay,
marked with `source: "curated:demo-2026-08"`, sets the handful of attribute
values (notably lactose-free availability, which OSM does not tag here) that
make the scripted impasse deterministic. Overlay values are demo fiction and are
labelled as such in the data; all other facts come from OSM tags with honest
`observedAt` timestamps and four-state verification.
