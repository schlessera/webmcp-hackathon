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
  "walkMin": 6, "priceLevel": 2, "imageCount": 1,
  "image": {
    "url": "/api/places/node/42/images/0",
    "width": 960, "height": 640,
    "blurhash": "LGF=X50Dx@x]G^IaM|-nyCRnaLt5"
  }
}
```

`why` is optional and is omitted for `eligible` rows; when present it is at
most 60 characters. Consumers MUST fall back to the structured `eligibility`
state when it is absent. This is a backward-compatible payload reduction.
Ordinary HTTP context responses also use content negotiation for gzip and
Brotli; compression changes transport bytes, not the JSON contract.
`image` is optional and is the same-origin `idx = 0` image only. It is omitted
when the place has no image or that row has not received a blurhash yet;
`imageCount` remains authoritative in either case. Agent projections keep the
count and drop `image`.

## 5. Domain payloads for negotiation objects

These are the `payload` shapes the negotiation envelope carries when
`domain: "spatial-destination/v1"`.

### 5.1 Requirement payloads

```jsonc
// Attribute predicate (machine-checkable — also the L2 disclosure shape)
{ "kind": "attribute", "key": "vegetarian-options", "expect": "verified_true" }

// Scope predicate
{ "kind": "scope", "dimension": "walk_min", "max": 15, "referent": { "kind": "landmark", "landmarkId": "node/42" } }
{ "kind": "scope", "dimension": "walk_min", "max": 15 }
{ "kind": "scope", "dimension": "travel_min", "max": 20, "mode": "bike" }

// Budget
{ "kind": "budget", "perPersonMax": { "amount": 18, "currency": "EUR" } }
{ "kind": "budget", "perPersonMax": { "amount": 20, "currency": "USD" } }

// Absolute opening-hours window; both instants carry the area's UTC offset
{ "kind": "time", "window": { "start": "2026-09-04T12:00:00+02:00", "end": "2026-09-04T14:00:00+02:00" }, "phrase": "tomorrow for lunch" }

// Exclusion (temporary preference: "not Italian today")
{ "kind": "exclusion", "key": "cuisine", "values": ["italian"], "lifetime": "session" }
{ "kind": "inclusion", "key": "cuisine", "values": ["asian", "vietnamese"], "lifetime": "session" }
```

`travel_min` requires `mode` (`walk`, `bike`, `car`, or `transit`). Walk,
bike and car use the shared straight-line speed conventions; transit remains
pending until a travel-time source exists. Budgets are compared only in the
area's currency, so a currency mismatch is pending rather than exclusion.

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

### 5.7 Candidate image payload measurement

Measured 2026-09-03 from a serialized, completed 343-place Berlin context
(compact JSON, no whitespace). The existing valid image cache supplied 76
first images, or 22.16% coverage. A serialized `image` object was 110–115
bytes (112.79 bytes mean); including its property name and separator added
121.79 bytes per carrying candidate on average.

| Coverage | Images | Uncompressed delta | Gzip delta |
|---|---:|---:|---:|
| Measured | 76 / 343 (22.16%) | 9,256 B | 2,881 B |
| Every place | 343 / 343 | 41,813 B | 10,725 B |

The measured coverage is below the +25 KB uncompressed target. The every-place
case is not: it exceeds the target by 16,213 bytes (using 25 × 1,024 bytes).
The worst-case row was measured by serializing the same real context with a
same-origin route and a distinct valid 4 × 3 blurhash on every candidate, not
by multiplying an average row size.

## 6. Spatial commands

Transport-agnostic, like the negotiation command set. Mutations carry
`baseRevision` and follow the same sync discipline.

| Command | Kind | Effect |
|---|---|---|
| `GetSpatialContext` | read | scope, feasibility counts, candidate summaries, current proposal, selection state |
| `InspectCandidates { candidateIds[1..3] }` | read | full dossiers (side-by-side when >1 — this is "compare") |
| `FindLandmarks { query }` | read | ranked named landmarks in the room's area for resolving a distance referent |
| `SetSearchScope { area?, transport? }` | mutate | **organizer only**; applies circle scope and walk/bike/car modes, emits `scope_change_proposed` + `_applied` |
| `SetOrigin { position, label?, source }` | mutate | updates the acting participant's application-private starting position |
| `SetOriginSharing { shared }` | mutate | changes the acting participant's live-position opt-in without rewriting the origin |
| `AddCandidates { refs[1..40] }` | mutate | brings snapshot places from the explore layer into the shared room pool, additively and subject to the pool ceiling |
| `LookUpPlaces { candidateIds[], keys? }` | read | starts bounded provider lookup for current places |
| `ProposeDestination { candidateId }` | mutate | emits negotiation `proposal_created` with `domainRef` |
| `FocusDestination { candidateId }` | local | pans/highlights the caller's own map view; **no shared state change** |
| `PlanArrival { mode, pickupNote? }` | mutate | per-participant walk/bike/car mode and note; emits `arrival_plan_updated` |
| `AttestAttribute { candidateId, key, status, confidence, note, sourceUrl? }` | mutate | records shared participant-supplied evidence |
| `ConfirmFact { candidateId, criterionId, lean, note?, sourceUrl? }` | mutate | permanently records person-verified evidence for every room holding the place |
| `UnconfirmFact { candidateId, criterionId }` | mutate | confirmer/organizer withdrawal of a permanent fact |
| `PrepareNavigation { candidateId?, from? }` | read | one-click handoff links for that candidate or the committed destination (§9) |

Negotiation-meaningful map actions do **not** get spatial commands: vetoing a
pin is `RespondToProposal { proposalId, disposition: "reject", reason: {…} }`.
The map resolves pin → candidate → proposal and dispatches the negotiation
command. One command model, two entry surfaces.

### 6.3 Origins

An origin is where one participant starts from:
`{ lat, lng, label, source: fixture | device | stated, updatedAt }`. A real
client reads and refreshes it from device geolocation; fixtures and stated
positions make the same model usable when that is unavailable. `SetOrigin`
has no target participant: identity comes from the authenticated session and a
participant can update only their own origin. It has the same phase gate as
`SetReadyState`.

The durable origin and its label are application-private. The server and owner
get the full value; every peer summary omits `origin` entirely and an
`origin_updated` event projects to peers at existence level only. Its effect
on eligibility counts remains visible. The event payload omits coordinates so
the append-only event log cannot become location history. A scope need is measured from its
owner's origin, falling back to the shared scope centre when that owner has no
origin. Candidate `walkMin` and the walk facet are measured from the viewer's
origin with the same fallback. The implicit shared search-circle constraint
always remains centred on the room scope.

Sharing is independently opt-in and off by default. `SetOriginSharing`
changes it with the same owner-only identity and phase gate. An
`origin_sharing_changed` event projects at existence level: peers learn only
that Sarah is showing where they are, or stopped. While sharing is on and the
participant has an open socket, the presence frame carries `{ participantId,
lat, lng, updatedAt }`; it never carries the label. Switching off or closing
the last socket removes the row in the next frame. The position is overwritten
in `participants.origin`: there is no positions table and no location history.

### 6.4 Referents

A scope requirement may say what its distance is measured from with an
optional `referent`: `self`, `scopeCenter`, `candidate`, `participant`,
`point`, or `landmark`. An absent referent is `self`, preserving every scope
need written before this addition. Candidate, participant and landmark
references use stable IDs; a bare point carries latitude/longitude and an
optional reader-facing label.

Resolution is per read. `self` uses the need owner's origin and falls back to
the shared scope centre. `scopeCenter` uses that centre; `candidate` uses the
candidate's current location; `point` uses its coordinates; and `landmark`
uses the area's in-process landmark snapshot. A deleted candidate, unknown
landmark, missing participant, or otherwise unresolved reference is pending:
it never rules a place out. Several scope requirements remain independent
hard requirements, so a place must lie within all of them.

A participant referent is measurable only by that participant or while that
participant has opted to share their position. For every other reader it is
pending, and its label says only “where someone starts from”: neither a name
used as a location nor coordinates cross the privacy boundary. The need's
public effect remains visible. Consequently two readers can honestly see
different eligible/uncertain counts for the same room when only one is
entitled to a participant referent. This is an intentional privacy consequence,
not a synchronization error.

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
| Starting-point control → drag or device location | `SetOrigin` | `origin_updated` |
| "Show where you are" switch | `SetOriginSharing` | `origin_sharing_changed` |
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

#### Confirmed facts (amendment, 2026-09-03)

`ConfirmFact { baseRevision, candidateId, criterionId, lean, note?, sourceUrl? }`
records what a person verified themselves. It uses the attestation merge path
but is keyed globally by `(osm_ref, criterion_id)`, has no TTL, and applies to
every room holding that OpenStreetMap ref. Its read-time fact is
`verified_true` / `verified_false` at confidence **0.95**, source
`person:confirmed`. `UnconfirmFact` removes it and is available only to the
recorded confirmer or the current room's organizer.

The precedence order is record (`osm:*` / `curated:*`), looked-up facts,
inference over published material, kind-of-place guesses, room attestations,
then confirmed facts. A confirmed fact therefore replaces every looked-up,
inferred, guessed or room-attested answer. It does not silently replace a
contradictory verified OSM/curated record: that combination reads as
`unknown`, source `disputed:<record-source>|person:confirmed`, and the ledger
shows both the record and the named confirmer.

Only a vocabulary key or `q:<40 lowercase hex>` is storable. An `open:*`
absolute window is rejected because it becomes meaningless later; synthetic
value criteria and raw question sentences are rejected too. For a private
question, the permanent row stores only the `q:` hash, lean, confirmer name/id,
origin room and timestamp; `note` and `source_url` are forced to null, so they
cannot be used to smuggle the sentence into shared storage. The owner may see
the answer alongside the label recovered from their requirement. A peer or a
participant in another room receives neither that label nor the opaque `q:`
row. Its shared event says only “a question”. A shared question may put its
authorized requirement label in the event.

### 8.2 Graded evidence (amendment, 2026-09-02)

A fact is one of five things, and every fact carries the confidence of
whoever said it:

| status | reads as | who says it |
| --- | --- | --- |
| `verified_true` | yes | the record, the venue's own markup or explicit own-site prose, a person who checked (≥ 0.7) |
| `likely_true` | likely | a Google business listing (`listing:google`, 0.65), a word on the menu (0.6), the kind of place (0.4–0.9), a partial value ("limited", 0.5), a reading of a menu photo, a person less sure (< 0.7) |
| `likely_false` | unlikely | the same, leaning the other way; an unavailable Google listing attribute is 0.65 rather than unknown |
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

`likely` and `unlikely` are drawn (dashed mark) and explained ("vegan
options likely") apart from eligible and excluded. `matching`, the impasse
arithmetic and the relaxation deltas count `eligible` only: a guess never
makes a room feasible and never rules a place out. The candidate's
`confidence` travels on the wire.

Display differs from the wire, deliberately. The client's big number is
`matching + likely` — a guess with a reason is an option the room can act on
— and the subline breaks it down ("of 34 · 4 likely · 3 unsure").
The sum is computed in the client; no field on the wire carries it, and
`matching` keeps its eligible-only meaning for every other consumer.

Precedence of sources when a dossier is read: the record (`osm:*`,
`curated:*`), then looked-up facts (`web:*`, `wikidata:*`) into open slots,
then structured Google listing evidence (`listing:google`) below an explicit
venue statement and always below the verified floor,
then guesses (`guess:*`) into slots still unknown, then attestations
(`agent:*`), which may dispute any of the above, then permanent confirmed
facts (`person:confirmed`) under the dispute rule in §8.1.

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

#### Adjudication

A likely inference with a validated evidence span receives one focused second
read on the fast model. This is not another place × criterion sweep: each cell
carries only its evidence, a bounded nearby context window, page title and URL,
publisher identity hints, and the place name/category. The model returns
`yes | no | unclear`, whether the wording is explicit, a publisher class, and
one verbatim quote. The server validates the quote and publisher independently.

An explicit `yes` or `no` from a validated `venue` or `chain` becomes
`verified_true` or `verified_false` at **0.75**, with source
`adjudicated:<host>` and the quote as the displayed note. A third-party answer
remains likely at **0.69**. `unclear`, an unsupported quote, or an unproved
first-party label leaves the fact unchanged. All writes pass through the same
monotonic resolver: adjudication may flip a likely claim, but never an existing
verified fact.

First-party publishing is established by either a registrable-domain match
between the evidence URL and the OSM `website`, or a captured
`og:site_name`/schema.org `name` matching the place or its brand. Thus a chain
page can be recognized even when its host differs from the OSM website; a model
label without either server-checked signal is reduced to `unknown`.

The original matrix stores no whole page. It retains at most **1,200
characters** with the claim: the evidence span (itself at most 400) plus up to
400 normalized characters on each side, a 160-character title, and up to six
120-character publisher names. A fresh in-memory page/proxy cache is preferred
when available; the stored window is the no-refetch fallback.

Opening a place and **Look again** adjudicate all of that place's likely active
criterion rows in one call and wait no more than three seconds while the normal
busy ring is shown. Proactively, when in-scope `matching + likely <= 20`, the
refinement worker adjudicates the viable set nearest-first, with at most eight
places per call, and wakes again on need changes. A 30-day cache on
`(place, criterion, sha256(normalized evidence))`, plus an in-flight guard,
prevents paying for the same read twice.

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
provider API call is required at handoff time. When `from` is supplied, the
Google and Apple directions links start there; otherwise the server uses the
caller's saved origin when one exists.

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
