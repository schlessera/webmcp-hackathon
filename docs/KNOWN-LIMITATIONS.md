# Known limitations (POC scope)

Spokes is a hackathon proof of concept for privacy-preserving multi-party
negotiation over WebMCP. Two independent adversarial reviews (a GPT-5.6 code
review and a protocol-invariant audit) ran against the vertical slice; the
demonstrable correctness and privacy findings were fixed. The items below are
deliberately deferred — they do not affect the demonstrated flow and each has a
bounded, honest threat model. We list them rather than hide them.

## Deferred, with rationale

- **No short-lived confirmation nonce on the applying commands.** Committing an
  agreement and applying an over-bound grant are two-step: the WebMCP tool only
  *stages*, and the applying command has no tool route, so a personal agent
  (the prompt-injection threat model) cannot reach it. A participant using their
  own bearer token directly, outside the agent surface, still can — they can act
  only as themselves, in their own room, on their own decisions. A UI-minted
  nonce would close this; see INTERACTION-AND-BINDING §5.4.
- **Partial phase machine.** Only `gathering` and `arrival` are enforced; the
  `deliberation`/`agreed`/`closed` states from the negotiation protocol §7.1 are
  not distinct, and most commands are accepted regardless of phase (the
  committed-destination and stage/commit paths ARE now guarded). Full
  per-command phase gating is future work.
- **Organizer scope changes apply without consent routing.** The organizer's
  `SetSearchScope` applies in one step; the spatial protocol's invariant 7
  (route through consent when another participant's bounded-negotiable
  requirement is affected) is not implemented for the organizer. Members are
  refused outright (a POC simplification).
- **`mapRevision` is static.** Candidate dossiers carry a `mapRevision` but no
  fact-change path bumps it; re-screening is driven by missing/`needs_info`
  verdicts instead. Adequate for a prepared, static dataset.
- **No participant join/leave lifecycle.** The agreement rule quantifies over
  all seeded participant rows; `policy.expiresAt` is stored but not enforced;
  guest tokens do not expire or revoke. Fine for a time-boxed demo room.
- **Disclosure ladder L1–L3, commutative rebase, transit routing, meeting
  points, and time-window eligibility** were scoped out of this slice from the
  start (see the protocol docs' open-questions sections). The agent-private
  screening loop (L0) is implemented.

## Data honesty

The venue dataset is a real one-time OpenStreetMap extract of Berlin Mitte
(ODbL; see `packages/contracts/data/ATTRIBUTION.md`). A small curated overlay,
marked with `source: "curated:demo-2026-08"`, sets the handful of attribute
values (notably lactose-free availability, which OSM does not tag here) that
make the scripted impasse deterministic. Overlay values are demo fiction and are
labelled as such in the data; all other facts come from OSM tags with honest
`observedAt` timestamps and four-state verification.
