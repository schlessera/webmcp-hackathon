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
candidate IDs, circle scope, `walk | bike | car`, an optional pickup note, and
candidate navigation handoff. `timeWindow`, `transit`, computed routes,
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

The protocol design reserves time as a first-class scope dimension ("plan for
later, not now"), but time-window eligibility and transit routing are deferred.
The current implementation applies circle radius and walk/bike/car modes;
implemented neutral impasse expansion changes radius only.

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
that would take the room above `POOL_CAP` (400 candidate rows).

A search-scope centre change MUST top the pool up from the same deterministic
seed rule used at creation: 40 places per distance ring, ordered first by
distance and ref, then thinned on a 100 m grid with greedy farthest-point
selection. Existing candidates are never removed. A successful growth emits
`candidates_added` with the shared actor and count, followed by the ordinary
`candidates_updated` reconciliation when classifications changed. Pool growth
does not itself move or fit any participant's map.

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
cross rooms.

### 8.2 Graded evidence (amendment, 2026-09-02)

A fact is one of five things, and every fact carries the confidence of
whoever said it:

| status | reads as | who says it |
| --- | --- | --- |
| `verified_true` | yes | the record, the venue's own markup, a person who checked (≥ 0.7) |
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
