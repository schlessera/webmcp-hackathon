# Spatial/Map Domain Protocol — `spatial-destination/v1`

Status: initial design, 2026-08-31. This document defines the domain payloads
and spatial commands carried by [NEGOTIATION-PROTOCOL.md](NEGOTIATION-PROTOCOL.md)
and bound to WebMCP in [INTERACTION-AND-BINDING.md](INTERACTION-AND-BINDING.md).

## 1. Purpose and position

The spatial protocol gives the map UI, human gestures, the world-knowledge
service, and personal agents **the same referents** for one spatial situation:
candidates, pins, search scope, routes, and meeting points. It exposes
semantic state an agent cannot reliably recover from pixels.

It owns spatial facts and interaction semantics. It does **not** own identity,
privacy, consent, or agreement — any spatial action with negotiation meaning
(veto a pin, propose a destination) compiles down to a negotiation command.

**Implementation boundary (tool contract v3).** The live wire supports stable
candidate IDs, circle scope, `walk | bike | car`, an optional pickup note,
candidate navigation handoff, and absolute time requirement predicates.
The search scope's `timeWindow`, `transit`, computed routes,
`routeId`, meeting points, and `meetingPointId` are explicitly deferred. Any
examples below that mention them reserve future protocol design; they are not
advertised capabilities or accepted tool arguments today.

## 2. Identifier rules

All references are stable, opaque IDs — never labels, coordinates, or screen
positions:

| ID | Meaning | Stability |
|---|---|---|
| `candidateId` (`place_42`) | A destination. The map pin for a candidate **is** the candidate — there is no separate pin ID. | Stable for the session; survives re-ranking and scope changes. |
| `scopeId` (`scope_2`) | A search-scope snapshot (area + time + transport). | New ID per applied change; previous scopes remain referencable in history. |
| `routeId` (`route_p_joe_1`) | A computed route for one participant. | **Deferred; not on the v3 wire.** |
| `meetingPointId` (`meet_1`) | A proposed meeting/pickup point. | **Deferred; not on the v3 wire.** |

Implemented tool schemas accept and return candidate/scope IDs. The deferred
route and meeting-point rows have no accepted tool arguments yet. Free-text
place names appear only in human-readable fields, never as command arguments.

## 3. Search scope

The shared spatial question being asked. Owned by the session (shared
visibility); changes flow through negotiation as `scope_change_proposed` /
`scope_change_applied`.

```jsonc
{
  "scopeId": "scope_2",
  "area": { "kind": "circle", "center": { "lat": 52.499, "lng": 13.425 }, "radiusM": 800 },
  // also: { "kind": "bbox", ... } — polygon deferred
  "timeWindow": { "start": "2026-09-01T18:30:00+02:00", "end": "2026-09-01T22:00:00+02:00" }, // deferred
  "transport": ["walk", "transit", "car"], // transit deferred; live enum is walk | bike | car
  "category": "food"                     // room goal category
}
```

The protocol design reserves time as a first-class **scope** dimension ("plan
for later, not now"), but that scope field and transit routing are deferred.
An absolute window is implemented as a requirement payload (§5.1) and is
evaluated against opening hours (§8.3). The current scope implementation
applies circle radius and walk/bike/car modes; implemented neutral impasse
expansion changes radius only.

## 4. Candidate dossier

The unit of world knowledge. Produced by the world-knowledge service,
consumed by the council and (projected) by participants and agents.

```jsonc
{
  "candidateId": "place_42",
  "name": "Garden Cafe Window",
  "location": { "lat": 52.4981, "lng": 13.4262 },
  "category": "cafe",
  "priceLevel": 2,                        // 1–4, provider-normalized
  "hours": [ { "day": "mon", "open": "09:00", "close": "22:00" } ],
  "attributes": [
    {
      "key": "dog-friendly-outdoor-seating",
      "status": "verified_true",          // verified_true | verified_false | unverified | unknown
      "source": "curated:berlin-kreuzberg-2026-08",
      "observedAt": "2026-08-31T10:00:00Z",
      "confidence": 0.9
    }
  ],
  "mapRevision": 8                        // bumps when facts change; drives re-screening
}
```

**Attribute honesty is normative.** Four distinct states — an absent attribute
(`unknown`), an unverified claim, a verified positive, and a verified negative
— and eligibility logic must treat them differently: only `verified_false`
hard-excludes against a hard requirement; `unknown`/`unverified` yields
`uncertain`, which triggers evidence requests rather than silent exclusion.

Attribute `key`s come from a session-scoped controlled vocabulary published in
the capability manifest (e.g. `vegetarian-options`, `lactose-free-options`,
`wheelchair-accessible`, `outdoor-seating`, `dog-friendly`, `price-level`,
`cuisine`). Predicates in requirement payloads and L2 disclosures reference
these keys, which is what makes them machine-checkable.

### 4.1 Projected candidate summary

Full dossiers are too large for tool-result budgets. The standard projection
in sync results and spatial context is a summary row:

```jsonc
{
  "candidateId": "place_42", "name": "Garden Cafe Window",
  "eligibility": "eligible" | "uncertain" | "excluded",
  "why": "meets all shared requirements; 1 private screen pending", // redacted per §7
  "walkMin": 6, "priceLevel": 2
}
```

`why` is optional and is omitted for `eligible` rows; when present it is at
most 60 characters. Consumers MUST fall back to the structured `eligibility`
state when it is absent. This is a backward-compatible payload reduction.
Ordinary HTTP context responses also use content negotiation for gzip and
Brotli; compression changes transport bytes, not the JSON contract.

## 5. Domain payloads for negotiation objects

These are the `payload` shapes the negotiation envelope carries when
`domain: "spatial-destination/v1"`.

### 5.1 Requirement payloads

```jsonc
// Attribute predicate (machine-checkable — also the L2 disclosure shape)
{ "kind": "attribute", "key": "vegetarian-options", "expect": "verified_true" }

// Scope predicate
{ "kind": "scope", "dimension": "walk_min", "max": 15, "origin": { "lat": 52.5, "lng": 13.42 } }

// Budget
{ "kind": "budget", "perPersonMax": { "amount": 18, "currency": "EUR" } }

// Absolute opening-hours window; both instants carry the area's UTC offset
{ "kind": "time", "window": { "start": "2026-09-04T12:00:00+02:00", "end": "2026-09-04T14:00:00+02:00" }, "phrase": "tomorrow for lunch" }

// Exclusion (temporary preference: "not Italian today")
{ "kind": "exclusion", "key": "cuisine", "values": ["italian"], "lifetime": "session" }
{ "kind": "inclusion", "key": "cuisine", "values": ["asian", "vietnamese"], "lifetime": "session" }
```

### 5.2 Delegation bounds

```jsonc
{ "dimension": "radius_m", "max": 1500 }          // scope requirement, negotiable up to
{ "dimension": "per_person_eur", "max": 20 }      // budget, negotiable up to
```

### 5.3 Stance condition / reason payloads

```jsonc
// future condition on conditionally_accept (deferred; current tool has no condition argument)
{ "kind": "attribute", "key": "outdoor-seating", "expect": "verified_true" }

// veto reason (optional, from the map's reason menu)
{ "kind": "history", "note": "visited too recently" }
```

### 5.4 Adjustment change payloads

```jsonc
{ "dimension": "radius_m", "from": 800, "to": 1400 }
{ "dimension": "time_start", "from": "18:30", "to": "19:00" }
{ "dimension": "per_person_eur", "from": 15, "to": 18 }
```

### 5.5 Pool growth

The room pool is shared, additive state. The explore layer is not part of the
pool and has no negotiation effect until a participant dispatches
`AddCandidates {refs}`. Any participant may do that during gathering or
deliberation. The server MUST resolve every ref against the room area's loaded
snapshot, ignore refs already represented by an `osm_ref`, and reject a change
that would take the room above `POOL_CAP` (2,500 candidate rows).

A snapshot-backed room synchronously starts with 60 venues from its narrow
scope circle. The source order is distance then stable ref; the existing 100 m
grid thinning and deterministic greedy farthest-point selection spread that
first batch across the circle. After creation, the server MUST add every
remaining snapshot venue inside the current scope circle nearest-first in
stable batches, without blocking room creation. A radius or centre change
recomputes missing refs for the new circle. Existing candidates are never
removed, jobs resume from persisted candidate refs after a restart, and every
write is bounded by `POOL_CAP`.

Interim batches emit only a presentation-only `facts` realtime frame with
`reason: "pool"` and the inserted candidate IDs. It carries no room revision.
When the fill run completes, the server emits one shared `candidates_added`
event with `actor_id = null` and payload `{ "source": "pool", "count": N }`
for the whole run. It projects at existence level for every viewer as "N more
places on the map." The fill plan is cached in memory per room and `scopeId`;
a changed scope replaces it. Snapshot planning and candidate-ref reads happen
without the room write lock. Only the final headroom check and insert hold it.

The spatial context's `pool` object has additive fields `filling` and `target`:
`filling` is true while the current circle still has missing snapshot venues
and the cap has not been reached; `target` is the total snapshot venue count in
that circle clamped to the cap. `size`, `cap`, and `explorable` retain their
existing meanings. Pool growth never moves, fits, or recentres a participant's
map.

### 5.6 Hint taxonomy (L1 disclosure)

The categorical hints an agent-private owner may reveal, one enum value, no
free text: `dietary`, `accessibility`, `budget`, `distance`, `time`,
`personal-history`, `atmosphere`, `other`.

## 6. Spatial commands

Transport-agnostic, like the negotiation command set. Mutations carry
`baseRevision` and follow the same sync discipline.

| Command | Kind | Effect |
|---|---|---|
| `GetSpatialContext` | read | scope, feasibility counts, candidate summaries, current proposal, selection state |
| `InspectCandidates { candidateIds[1..3] }` | read | full dossiers (side-by-side when >1 — this is "compare") |
| `SetSearchScope { area?, transport? }` | mutate | **organizer only**; applies circle scope and walk/bike/car modes, emits `scope_change_proposed` + `_applied` |
| `AddCandidates { refs[1..40] }` | mutate | brings snapshot places from the explore layer into the shared room pool, additively and subject to the pool ceiling |
| `LookUpPlaces { candidateIds[], keys? }` | read | starts bounded provider lookup for current places |
| `ProposeDestination { candidateId }` | mutate | emits negotiation `proposal_created` with `domainRef` |
| `FocusDestination { candidateId }` | local | pans/highlights the caller's own map view; **no shared state change** |
| `PlanArrival { mode, pickupNote? }` | mutate | per-participant walk/bike/car mode and note; emits `arrival_plan_updated` |
| `AttestAttribute { candidateId, key, status, confidence, note, sourceUrl? }` | mutate | records shared participant-supplied evidence |
| `PrepareNavigation { candidateId? }` | read | one-click handoff links for that candidate or the committed destination (§9) |

Negotiation-meaningful map actions do **not** get spatial commands: vetoing a
pin is `RespondToProposal { proposalId, disposition: "reject", reason: {…} }`.
The map resolves pin → candidate → proposal and dispatches the negotiation
command. One command model, two entry surfaces.

## 7. Gesture ↔ command ↔ event mapping

| Human gesture on the map | Command dispatched | Resulting event(s) |
|---|---|---|
| Tap a pin | `FocusDestination` (local) | none (local UI) |
| Open a pin's card, tap "Details" | `InspectCandidates` | none (read) |
| Long-press two pins, "Compare" | `InspectCandidates[2]` | none (read) |
| Drag the search-radius handle | `SetSearchScope` | `scope_change_proposed` (+ `_applied`) |
| Pin card → "Propose this" | `ProposeDestination` | `proposal_created` |
| Pin card → "Veto…" + reason menu | `RespondToProposal(reject)` | `stance_submitted` |
| Pin card → "Works for me" | `RespondToProposal(accept)` | `stance_submitted` |
| "I'm done adding" toggle | `SetReadyState` | `ready_state_changed` |
| Arrival panel → mode + pickup note | `PlanArrival` | `arrival_plan_updated` |
| "Navigate" button | `PrepareNavigation` | none (read) |

An agent invoking the equivalent tool produces the identical command, so both
surfaces update every projection identically and immediately. **Tool results
return only after the local UI reflects the change** (agents plan against
what they can see). Concretely, a mutation waits for a projection read at least
as new as its returned room revision; joining an older in-flight read queues
and awaits a successor rather than resolving against stale map state.

## 8. Eligibility semantics

The council's deterministic check per candidate, per current requirement set:

```text
for each hard requirement:
    shared / application-private → evaluate predicate against dossier
        verified_false vs expectation      → excluded (cite requirement class only)
        unknown / unverified               → uncertain (evidence request)
        satisfied                          → pass
    agent-private (L0/L1)                  → consult recorded screening verdict
        unacceptable → excluded            (never cite owner or reason)
        no verdict yet → uncertain         (screening request outstanding)
    agent-private (L2 predicate granted)   → evaluate server-side like application-private
soft requirements & preferences            → scoring only, never exclusion
```

Public explanation strings for exclusions cite **evidence status and shared
requirements only** ("no verified vegetarian options") or aggregates
("excluded by a private requirement") — never a private owner or reason.

### 8.1 Attestations (amendment, 2026-09-02)

Where the record is silent, a participant may say what they found out:
`AttestAttribute { candidateId, key, status: verified_true | verified_false,
confidence, note, sourceUrl? }` (tool `attest_attribute`). Attestations are
**shared** evidence, stored per room and per (place, fact, participant), and
merged into the dossier **at read time** — the source record is never
rewritten. Precedence:

```text
source fact verified (osm:* / curated:*)
    attestation agrees                     → unchanged
    attestation contradicts                → unverified, source "disputed:…", both sides shown
source fact unknown / unverified
    one attester, or all agree             → attested status, source "agent:<participantId>"
    attesters disagree                     → unverified, source "disputed:…"
```

"Disputed" is a source prefix on an `unknown` fact with both sides on
record. An attestation at confidence ≥ 0.7 is a verified fact for
eligibility exactly like a record fact; below that it is a likely fact
(§8.2). The ledger names the attester and their note. Attestations never
cross rooms. The attestable-key union includes both the closed attribute
vocabulary and question criterion keys matching `q:<40 lowercase hex>`; a
person may therefore confirm or contradict a free-text need without placing
its sentence in the shared attestation record.

### 8.2 Graded evidence (amendment, 2026-09-02)

A fact is one of five things, and every fact carries the confidence of
whoever said it:

| status | reads as | who says it |
| --- | --- | --- |
| `verified_true` | yes | the record, the venue's own markup or explicit own-site prose, a person who checked (≥ 0.7) |
| `likely_true` | likely | a word on the menu (0.6), the kind of place (0.4–0.9), a partial value ("limited", 0.5), a reading of a menu photo, a person less sure (< 0.7) |
| `likely_false` | unlikely | the same, leaning the other way |
| `verified_false` | no | as for yes |
| `unknown` | — | nobody said anything; also a disputed fact |

`unverified` is retired: old data carrying it is read as `likely_true` at
no more than 0.5.

Only the two verified statuses rule a place in or out. A likely fact yields
two further classifications:

```text
per candidate, over every active hard need:
    a verified fact contradicting a need   → excluded
    a likely fact leaning against a need   → unlikely   (confidence = product of such facts)
    an unknown fact                        → uncertain
    a likely fact leaning with a need      → likely     (confidence = product of such facts)
    everything verified and satisfied      → eligible
precedence: excluded > unlikely > uncertain > likely > eligible
```

`likely` and `unlikely` are drawn (dashed mark), counted ("6 still work ·
4 likely · 3 unsure") and explained ("vegan options likely") apart from
eligible and excluded, never folded in. `matching` and the impasse
arithmetic count `eligible` only: a guess never makes a room feasible and
never rules a place out. The candidate's `confidence` travels on the wire.

Precedence of sources when a dossier is read: the record (`osm:*`,
`curated:*`), then looked-up facts (`web:*`, `wikidata:*`) into open slots,
then guesses (`guess:*`) into slots still unknown, then attestations
(`agent:*`), which may dispute any of the above.

`mapRevision` is the candidate fact-version boundary. Every path that changes
the merged facts MUST increment it in the same transaction. A private
screening verdict records the `mapRevision` it evaluated and is authoritative
only while that value still matches. After any bump, older verdicts are ignored,
the affected place returns to uncertain, an owner-only `evaluation_requested`
is re-issued for each active agent-private owner, and a page-held condition is
woken to screen the changed place again. This applies equally to attestations
and provider-fact refreshes; fact-producing handlers do not choose whether
private screening becomes stale.
The screening command carries this value back as additive
`screenedMapRevision`. The verdict writer never substitutes a newer database
read: missing or older values remain non-authoritative, and values ahead of the
candidate are invalid. The in-page screening loop also submits the room
revision of its dossier read, so a lookup or attestation between inspection and
write produces `sync_required` rather than rebasing the old judgment.

#### Criteria and questions (amendment, 2026-09-03)

A **criterion** is the independently answerable unit of evidence for one
place. A vocabulary need uses
`{ id, kind: "key", key, label }`; a free-text need uses
`{ id, kind: "question", text, label }`. The text is trimmed, whitespace is
collapsed, case is folded and one trailing question mark or full stop is
removed. Its dossier/cache key is `q:<sha1(normalized text)>`, so equivalent
wording shares evidence without putting the sentence into a machine field.
The hash is an identity commitment, not a secret: a short question may be
guessable. The cross-room enrichment cache therefore stores the `q:` key and
its evidence fields but never the normalized sentence or its label. A dossier
renders a question row only when the viewer owns the corresponding need or the
need is shared, and takes its label from that viewer-authorized requirement,
never from the cache. An unauthorized `q:` row is omitted completely.

Shared and application-private needs may reach the server-side matrix evaluator.
That matrix is a plain model call over text already held by the server and has
no tools. Application-private permits this evaluation but does not permit its
sentence to enter an outbound search query, any prompt on a call with
`web_search` enabled, shared storage, or a peer's dossier. A search query
contains the place name, the city, and criterion words admitted by one of two
rules: a criterion behind an active need travels only when that need is shared,
and a criterion behind no active need travels only when its label is server
vocabulary from `ATTRIBUTE_LABELS`. The second rule is what lets the background
sweep keep improving the whole pool: it runs over every place regardless of
what anyone wants, so its query is evidence of nobody's need. A question
criterion carries a person's own sentence and so travels only as an active
shared need. A place with no admitted criterion causes no search. Combined search excludes private criteria
from its tool-enabled call entirely. Agent-private needs are evaluated in the
owner's agent context and never enter server-side criterion harvesting.

A matrix claim is record-grade only when all of these hold: the model marks it
`explicit: true`, its evidence is a validated span from a `web` or `menu`
venue-site text bucket, its cited URL has the same hostname as the place's OSM
`website` tag. Host matching is exact after lowercasing and stripping one leading `www.`;
sibling subdomains and merely registrable-domain matches do not count. Such a
claim is graded at **0.72**, receives source `web:<host>`, and may become
`verified_true` or `verified_false`, giving an explicit prose statement the
same record standing as facts parsed from the venue's own schema.org markup.

Every claim that fails any part of that gate remains graded evidence on the
ordinary ladder: venue-site inference at no more than 0.60, domain-scoped
search at 0.55, open-web evidence at 0.50, and name/category evidence at 0.45.
A participant attestation may also verify a `q:` question key. No evidence
keeps the place `unknown`; abstention is not a negative answer.

#### Evidence never regresses on re-read

Evidence cached for one `(place, criterion)` merges monotonically. An abstain,
an omitted model cell, or a search pass that finds nothing cannot replace an
existing claim. It may create an omission marker only when that cell has no
claim. If a fresh claim has the same lean, it replaces the stored claim only
when its confidence is higher **or** its source bucket is higher. A fresh
opposite lean replaces the stored claim only when it is explicit and its
bucket is equal or higher. Every other opposite lean retains the claim and its
status, and sets its displayed note to exactly `another read leaned the other
way`.

The comparison order, highest first, is:

| rank | bucket | stored source shape |
|---:|---|---|
| 5 | record | `web:<host>` (validated record-grade own-site statement) |
| 4 | own-site explicit | `infer:<model>:venue_site` or `:menu`, `explicit: true` |
| 3 | own-site inferred | `infer:<model>:venue_site` or `:menu`, not explicit |
| 2 | domain search | `infer:<model>:domain_search` |
| 1 | open web | `infer:<model>:open_web_search` |
| 0 | name/category | `infer:<model>:name_category` and legacy unbucketed inference |

Name/category is last because it is generic contextual inference without a
quoted external source; even an open-web span has a stronger evidence basis.
A previously validated span disappearing from newly fetched text is absence,
not disproof: the claim and its original `observedAt` remain unchanged.
Consequently **Look again** may add a fact, strengthen one, or record a
contradiction, but it cannot silently remove one. The panel's changed-fact
count uses those durable fact differences, including confidence
strengthenings and the disagreement note. Attestations still merge after all
cached inference and therefore retain their existing decisive/disputing
precedence.

Cuisine uses a value-specific key criterion carrying `values` and a literal
question such as “Does this place serve Italian food?”. Its id is derived from
the normalized wanted-value set, so a stored Italian answer never suppresses a
later Japanese question. The resulting criterion fact is consumed directly by
eligibility. The sourced implication taxonomy remains the fallback: an
implication may add a place to an inclusion set (for example, `pizza` can
support Italian), but it never rules a place out of an exclusion set. An
implied exclusion remains `unlikely`, not `excluded`.

### 8.3 Absolute time windows

A time need has the payload `{ kind: "time", window: { start, end }, phrase? }`.
`start` and `end` are absolute ISO-8601 instants carrying a UTC offset, with
`end` later than `start`. Relative words are resolved before submission; the
predicate never stores "tomorrow" as its clock. The area's IANA timezone
decides which weekday and wall-clock opening-hours rows those instants touch,
including midnight crossings.

Verified OpenStreetMap hours covering every minute of the half-open window
produce `yes`; verified hours with any gap produce `no`. Structured hours
published only by the place's own site produce `likely` or `unlikely`, never a
verified answer. A place with no parseable hours is `unknown` and is never
ruled out for the time need. Reader-facing evidence uses a weekday and wall
clock span; the absolute timestamps stay on the protocol surface.

## 9. Navigation handoff

`PrepareNavigation` returns provider-agnostic links; the room stays the
coordination surface, the installed map app is the execution surface:

```jsonc
{
  "target": { "candidateId": "place_42", "name": "Garden Cafe Window" },
  "links": {
    "geo": "geo:52.4981,13.4262?q=Garden+Cafe+Window",
    "googleMaps": "https://www.google.com/maps/dir/?api=1&destination=52.4981,13.4262",
    "appleMaps": "https://maps.apple.com/?daddr=52.4981,13.4262"
  }
}
```

Links are constructed from coordinates the session already holds — no
provider API call is required at handoff time.

## 10. World-knowledge boundary

- The world service receives **scope + attribute queries only** — no
  participant identity, no requirement ownership, no free-text explanations.
  The council over-fetches (broader attribute set) and filters sensitively
  itself, so the provider never sees a user-linked query.
- Provider access sits behind adapters; the POC uses a prepared, curated area
  (`source: "curated:…"`) with honest `observedAt` timestamps. Base geography
  and live overlays are separate layers with separate freshness.
- The world service proposes possibilities; it never negotiates, ranks whose
  needs yield, or sees stances.

## 11. Invariants (testable)

1. Every implemented spatial command argument that references a place uses a
   stable candidate ID from §2 — never coordinates-as-identity or labels.
2. A dossier attribute is one of exactly four states; eligibility treats
   `unknown` ≠ `verified_false`.
3. `FocusDestination` never mutates shared session state.
4. Any spatial action with negotiation meaning produces the corresponding
   negotiation event — there is no spatial side channel to stances, scope
   consensus, or agreement.
5. Exclusion explanations never contain private owner identity or reason.
6. `mapRevision` changes on any fact change, and screening requests are
   re-issued for affected candidates.
7. Scope mutations outside the caller's authority always route through
   `scope_change_proposed` and consent — including the organizer's, when a
   bounded-negotiable requirement of another participant is affected.
