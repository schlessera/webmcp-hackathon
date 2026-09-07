# Spatial/Map Domain Protocol — `spatial-destination/v1`

Status: maintained implementation reference, checked 2026-09-07. This document
covers current spatial payloads and behavior, alongside the
[negotiation protocol](NEGOTIATION-PROTOCOL.md) and
[WebMCP binding](INTERACTION-AND-BINDING.md). The executable
[input schemas](../../packages/contracts/src/commands.ts),
[read schemas](../../packages/contracts/src/tools.ts), and
[response types](../../packages/contracts/src/envelope.ts) are the wire
contract; code comments or descriptions can lag their implementation.

## 1. Purpose and position

The spatial layer gives the page and personal agents stable references for
places, search scope, evidence, requirements, proposals, and navigation
handoff. A selected pin and a tool-selected candidate refer to the same place.
Participant identity, stances, delegated adjustments, and agreement use the
negotiation command bus.

Current support includes circle scopes, prepared venue/landmark data,
progressive evidence lookup, ordered plans, per-person starting points,
walk/bike/car arrival choices, and external navigation links. There are no
computed street routes, route IDs, negotiated meeting points, polygon/bounding-
box search scopes, or public-transit routing. A transit travel-time requirement
is accepted but remains uncertain without a travel-time source.

## 2. Identifier rules

| Reference | Meaning and lifetime |
|---|---|
| `candidateId` | Room candidate; also the map pin identity. Stable across reclassification/scope changes; settled steps keep their records outside the live pool |
| Place `ref` | Source reference from the page's explore/search data; input to `AddCandidates` |
| `scopeId` | Current scope snapshot; a new ID is allocated when scope changes |
| `landmarkId` | Named public-place reference from `find_landmarks` in this room's area |
| `stepId` | Ordered plan step; one is active while later ones remain pending |
| `criterionId` | Evidence question/key behind a need; may be vocabulary, `q:<sha1>`, or a generated value/time criterion |

These IDs are distinct. Do not pass a source ref as a candidate ID or infer
one from a place label. `find_landmarks` accepts a name query; place references
for `add_candidates` are currently discovered through page HTTP/explore
surfaces, not a registered general venue-search tool. Coordinates are values
for scope, origins, and point referents, not place identity.

A historical candidate can remain inspectable without being eligible for a
new proposal. `propose_destination` requires membership in the current live
pool. No callable `routeId` or `meetingPointId` exists.

## 3. Search scope

The shared scope is a circle with transport metadata and a place class:

```json
{
  "scopeId": "scope_2",
  "area": {
    "kind": "circle",
    "center": { "lat": 52.499, "lng": 13.425 },
    "radiusM": 800
  },
  "transport": ["walk", "bike", "car"],
  "category": "food"
}
```

`SetSearchScope` accepts `baseRevision` and at least one of `area` or
`transport`. The radius is an integer from 100 to 5,000 metres; transport is
a unique non-empty list of `walk`, `bike`, and/or `car`. It does not accept
`category`, `timeWindow`, a bounding box, polygon, or transit. Time constraints
are requirements (§5.1, §8.3). Transport selection does not request routing.

Only the organizer can change shared scope. That command emits proposed and
applied events in the same transaction; it **does not** request each affected
participant's consent. A member cannot directly propose a scope change through
this command. Council-generated radius adjustments have their separate staged
consent path. Expansion calculations currently test radius only, not later
times, route networks, or meeting points.

In a multi-step plan, committing an intermediate destination recenters the
next step's search on that destination and restores the area's narrow radius.
The new step's place class supplies the scope category. This is a shared plan
transition, not a local map pan. There is no step editing, reordering, or
reopening command.

## 4. Candidate dossier

The HTTP `InspectCandidates` response contains `{ok, revision, candidates}`.
Each dossier includes stable ID, name, location, category, price level, hours,
attributes, and `mapRevision`. Available source data can add address, phone,
links, description, self-published rating, awards, images, per-need verdicts,
and lookup state. Optional data is not a guarantee that every place has it.
For example, an attribute row can be:

```json
{
  "key": "outdoor-seating",
  "status": "likely_true",
  "source": "infer:model:venue_site",
  "observedAt": "2026-09-07T10:00:00Z",
  "confidence": 0.6,
  "note": "Evidence supporting this reading."
}
```

`status`, provenance, confidence, and observation time are separate fields.
The semantic status vocabulary has five values: `verified_true`,
`likely_true`, `likely_false`, `verified_false`, and `unknown`. Legacy
`unverified` data is read as a low-confidence likely value. A disputed fact
uses `unknown` with a `disputed:` source; it is not a sixth status. A verified
positive can exclude a negative expectation just as a verified negative can
exclude a positive expectation.

The manifest publishes thirteen attribute keys and their display labels:
vegetarian, vegan, gluten-free, halal, lactose-free, wheelchair access,
outdoor seating, dog friendly, wifi, takeaway, delivery, price-level, and
cuisine. Use the exact machine strings in the manifest. Dossiers can also
carry hours and authorized generated question/value criteria; not every
attribute key is accepted by every mutation schema.

`mapRevision` identifies the facts screened for this candidate. It is separate
from the room event revision. A private verdict stamped with another fact
revision is not current evidence for this place.

### 4.1 Projected candidate summary

HTTP spatial context supplies summary rows with `candidateId`, optional source
`ref`, name, location, category, eligibility, walking estimate, price level,
optional explanation/confidence, and image summary. Its eligibility classes
are `eligible`, `likely`, `uncertain`, `unlikely`, and `excluded`.
`why` is optional, viewer-specific, and capped at 60 characters; eligible rows
omit it. Unknown price is `null`, not a zero-cost price band.

The HTTP context also carries scope, feasibility, facets, own/shared needs,
private effects, roster, proposals, agreement, own arrival plan, pool progress,
and available plan/refinement metadata. `total` is the in-scope denominator;
out-of-scope candidates can remain in the array as excluded so the page can
fade them in place.

WebMCP is a smaller projection. `get_spatial_context` begins with at most eight
candidate rows sorted by eligibility and walking estimate, and omits
coordinates, detailed needs/facets, pool/refinement state, and plan fields.
`inspect_candidates` compacts attribute/need rows and drops hours, coordinates,
and image URLs. The structural encoder can omit further fields to fit its
budget. A full HTTP dossier or context is not an example of a full tool result;
see binding §2.4 and §3.

## 5. Domain payloads for negotiation objects

The following are payload objects nested in `SubmitRequirement`, whose
visibility, hardness, delegation, and revision fields belong to negotiation.

### 5.1 Requirement payloads

```jsonc
// Positive or negative attribute expectation; key comes from the manifest.
{ "kind": "attribute", "key": "vegetarian-options", "expect": "verified_true" }
{ "kind": "attribute", "key": "dog-friendly", "expect": "verified_false" }

// Distance from the need owner's starting point (default referent).
{ "kind": "scope", "dimension": "walk_min", "max": 15 }
{ "kind": "scope", "dimension": "radius_m", "max": 1000 }
{ "kind": "scope", "dimension": "travel_min", "max": 20, "mode": "bike" }

// Explicit distance referent; use an ID returned by find_landmarks.
{ "kind": "scope", "dimension": "walk_min", "max": 15,
  "referent": { "kind": "landmark", "landmarkId": "node/42" } }

// Estimated per-person budget, not a live menu quote.
{ "kind": "budget", "perPersonMax": { "amount": 18, "currency": "EUR" } }

// Absolute opening-hours interval, with an optional display phrase.
{ "kind": "time", "window": {
    "start": "2026-09-08T12:00:00+02:00", "end": "2026-09-08T14:00:00+02:00"
  }, "phrase": "tomorrow for lunch" }

// Cuisine set membership; values are bounded strings, not arbitrary fields.
{ "kind": "exclusion", "key": "cuisine", "values": ["italian"], "lifetime": "session" }
{ "kind": "inclusion", "key": "cuisine", "values": ["asian", "vietnamese"], "lifetime": "session" }

// Bounded free-text need; evidence may later answer its question criterion.
{ "kind": "text", "text": "A quiet place to talk" }
```

`travel_min` requires `mode: walk | bike | car | transit`. Walk, bike, and car
use straight-line distance divided by fixed speed assumptions; they do not
account for streets, barriers, traffic, or transfers. Transit remains pending.
Plain walking summaries use the same estimate, rounded to at least one minute.

Budget currency is `EUR` or `USD`. Comparison is against the area's currency;
a mismatch remains uncertain. The published price bands estimate upper
per-person EUR amounts of 10, 15, 25, and 40 for levels 1–4. Missing price
remains uncertain. Cuisine values allow one to eight entries of up to 60
characters. `lifetime: "durable"` is accepted but does not promote a preference
into a user profile or another room. Text and time phrases are capped at
200 characters. Text needs are never assumed satisfied just because they
were accepted by the input schema.

### 5.2 Delegation bounds

A requirement's optional bound is `{dimension, max}` where dimension is
`radius_m`, `per_person_eur`, or `walk_min`. These describe delegated authority,
not a universal optimizer. Current council generators propose radius expansion,
next-band EUR budgets, or cuisine inclusion/exclusion removal. Of these,
budget grants can satisfy a matching `negotiable` per-person bound; scope and
cuisine changes need their addressee's page confirmation when staged.
No generator currently uses every accepted bound dimension.

### 5.3 Stance reasons

A stance reason is optional `{kind: "history" | "domain", note?: string}`,
with a 200-character note cap. Agent-private stances omit it. There is no
spatial conditions payload on `conditionally_accept`; that disposition blocks
agreement until the participant replaces it with accept or abstain and meets
the readiness requirement. Text in a reason is not an executable condition.

### 5.4 Adjustment change payloads

Current generated examples include:

```jsonc
{ "dimension": "radius_m", "from": 800, "to": 1400 }
{ "dimension": "per_person_eur", "from": 15, "to": 25 }
{ "dimension": "exclusion", "from": ["italian"], "to": [] }
{ "dimension": "inclusion", "from": ["vietnamese"], "to": [] }
```

The council tests wider radii in 200-metre increments up to 2,000 metres and
uses the next published price band for budget relaxation. It reports the
recomputed eligible count as projected gain. These examples are server-authored
request data; `resolve_private_request` takes only request ID and grant/deny,
not an arbitrary replacement `change`. No time-start adjustment is generated.

### 5.5 Pool growth and plan steps

The **active step's** pool is shared and additive. Scope changes can add
places but do not delete existing candidates. A snapshot-backed room starts
with up to 60 spread-out places from the selected class within its narrow
circle. Background fill adds matching snapshot venues within the current
circle in bounded batches, up to `POOL_CAP = 2500` live candidate rows.
The prepared extract still bounds what can be discovered.

The page's explore layer displays source places before they join the pool.
Any participant can submit `AddCandidates {baseRevision, refs}` with one to
40 distinct refs during gathering/deliberation. The server resolves them
against the room's area, ignores those already in the live pool, and enforces
the pool ceiling. Adding places does not move another participant's viewport.

Fill progress sends presentation-only `facts` frames with `reason: "pool"`;
the completed fill emits a shared `candidates_added` event. HTTP context's
`pool` has `size`, `cap`, `explorable`, `filling`, and `target`; `target` accounts
for the current pool and bounded circle plan. Fill planning is process-local,
with persisted candidate refs supporting resumption.

Committing an intermediate step keeps its candidate and requirement records
but takes them out of the active decision. The next step gets its own seeded
pool and scope, centered on the previous settlement. Its pending goal-derived
needs are submitted through the ordinary command path. Candidate IDs continue
uniquely within the room; they are not recycled between steps. Past records
are history, not members of the next step's live pool.

### 5.6 Optional hint taxonomy

`scopeHint` on an agent-private declaration can contain
`affects: "candidate-eligibility"` and one optional category:
`dietary`, `accessibility`, `budget`, `distance`, `time`, `personal-history`,
`atmosphere`, or `other`. A hint is deliberate coarse disclosure and may be
shown with the private need's owner/effect. It is not inferred secretly from
the private condition. The manifest's disclosure ladder has no implemented
escalation request workflow.

### 5.7 Image payloads and budgets

Images are optional venue evidence, not required candidate identity. HTTP
context may include an `imageCount` and the first stored image's same-origin
route, dimensions, and blurhash; the thumbnail is absent until its placeholder
is available. Dossiers can carry more images and source/credit metadata.
These protected image routes require participant authentication; the page
fetches blobs rather than exposing a third-party image URL in its map rows.

WebMCP projections retain only the count. Image URLs and detailed photo metadata
do not fit the ordinary tool result's purpose or budget. HTTP compression
reduces transport bytes without changing the underlying JSON fields. Image
coverage varies by extract, source availability, and completed lookup work;
there is no fixed coverage percentage in the protocol.

## 6. Spatial commands

### 6.1 Reads and lookup initiation

| Read/tool role | Input besides authentication | Result or effect |
|---|---|---|
| `GetSpatialContext` | Empty tool input | Scope, candidates, feasibility, proposals; HTTP has additional page data |
| `InspectCandidates` | `candidateIds[1..3]`, optional `intent`, `force` | Current dossiers; `intent: "open"` can start fact work, `"read"` is passive |
| `FindLandmarks` | `query` (1–100 characters) | Ranked landmark IDs, names, kinds, locations |
| `LookUpPlaces` | `candidateIds[1..3]`, optional `keys[1..6]`, `force` | Starts bounded lookup and returns records after a bounded wait; work may continue |
| `PrepareNavigation` | Optional `candidateId`, `from: {lat,lng}` | External navigation handoff links |
| `FocusDestination` | `candidateId` | Pan/highlight caller's map; mounted page publishes viewing presence and can start enrichment |

`LookUpPlaces` can perform paid I/O and cache writes and has no read-only
annotation. `InspectCandidates` retains a read-only hint despite the optional
interactive-open behavior. Passing multiple IDs reads records for comparison;
it does not itself open a comparison panel. `force` means a requested refresh,
not a promise of new facts or cancellation of source caches.

HTTP context additionally accepts `excludeRequirementId` for a temporary
counterfactual preview of an owned/shared need. This is not a registered
`get_spatial_context` argument. Sources and budgets can leave a lookup partial,
unknown, or unchanged without making the overall read fail.

### 6.2 Mutating commands

Every command in this table also requires `baseRevision` and obeys negotiation
revision/phase rules.

| Command | Other input | Authority/effect |
|---|---|---|
| `SetSearchScope` | `area?`, `transport?` | Organizer directly applies shared scope |
| `SetOrigin` | `position`, `label?`, `source: "device" | "stated"` | Set own application-private origin |
| `SetOriginSharing` | `shared` | Page-only own live-location opt-in |
| `AddCandidates` | `refs[1..40]` | Add discovered places to the shared live pool |
| `ProposeDestination` | `candidateId` | Create proposal on current pool candidate |
| `PlanArrival` | `mode`, `pickupNote?` | Own walk/bike/car plan after agreement |
| `AttestAttribute` | `candidateId`, `key`, `status`, `confidence`, `note`, `sourceUrl?` | Shared, named participant evidence |
| `ConfirmFact` | `candidateId`, `criterionId`, `lean`, `note?`, `sourceUrl?` | Room-scoped person confirmation |
| `UnconfirmFact` | `candidateId`, `criterionId` | Page-only withdrawal by confirmer or organizer |

`PlanArrival` accepts a pickup **note**, not a meeting-point ID or transport
reservation. Only the caller's full arrival plan is returned in their spatial
context; the shared event announces arrival mode. Veto/accept actions are
negotiation `RespondToProposal`, not independent spatial mutations.

### 6.3 Origins

The stored origin is `{lat, lng, label, source, updatedAt}`. Source can also be
`fixture` for seeded data; external updates accept only `device` or `stated`.
There is no target participant argument: authentication determines ownership.
Origin/sharing changes use the same live-phase gates as readiness.

The durable origin and label are application-private. Peer roster rows omit
`origin`; `origin_updated` records an existence change without storing a
coordinate history in the event log. The server overwrites the participant's
current origin. It can affect eligibility even while live sharing is off.
A need with no explicit referent uses its owner's origin, with scope-center
fallback. Candidate `walkMin` uses the viewer's own origin with that fallback.
The shared circle constraint always uses the room's scope center.

Live sharing is separately opt-in and off by default. While opted in with an
open socket, presence carries participant ID, coordinates, and update time,
without the label. Disabling sharing or closing the last socket removes that
live row. It does not erase the durable private origin. No origin-history
table or route/location tracking service is implemented. Physical location
can still be inferred from revealed ranges and changing outcomes; the
[limitations document](../KNOWN-LIMITATIONS.md) describes that boundary.

### 6.4 Referents

A scope requirement's optional `referent` accepts `self`, `scopeCenter`,
`candidate`, `participant`, `point`, or `landmark`. Candidate, participant,
and landmark variants carry their stable ID; point carries latitude/longitude
and an optional label. Omission is `self`.

Resolution occurs on read. A candidate referent must resolve in the live pool;
unknown places, candidates outside that pool, missing landmarks, or absent origins can
leave a need pending rather than excluding a place. A participant referent is
resolvable to the referenced participant or while that participant has opted
into sharing.
Unauthorized viewers get a private/unresolved referent without coordinates
or a location-revealing label. Spatial readers can consequently see different
eligible/uncertain counts. Server-internal evaluation without a viewer uses
the requirement owner's entitlement.

The schema also accepts optional `stepId` on referents, but the current
resolver does not use it. Do not rely on it to anchor a need to a different
step's chosen place. The implemented cross-step behavior is the automatic
recentering on agreement described in §3 and §5.5.

## 7. Gesture ↔ command ↔ event mapping

The exact presentation controls can change without changing these meanings:

| Page action | Protocol operation | Shared transition |
|---|---|---|
| Focus a place | Local selection plus viewing presence | Peers can see viewing activity; enrichment may start |
| Inspect or compare places | Inspect dossiers | Optional asynchronous evidence work |
| Change shared area | `SetSearchScope` | Scope proposed and applied by organizer |
| Bring an explored place into the room | `AddCandidates` | `candidates_added` |
| Propose a place | `ProposeDestination` | `proposal_created` |
| Accept or veto a proposal | `RespondToProposal` | `stance_submitted`; accept may also change readiness |
| Set a need aside/restore it | `SetRequirementActive` | `requirement_toggled` |
| Change readiness | `SetReadyState` | `ready_state_changed` |
| Set own starting point/sharing | `SetOrigin` / `SetOriginSharing` | Origin/sharing event plus allowed presence projection |
| Attest/confirm a fact | `AttestAttribute` / `ConfirmFact` | `attribute_attested` and possible screening work |
| Record arrival mode/note | `PlanArrival` | `arrival_plan_updated` |
| Open directions | `PrepareNavigation` | None; external handoff |

Both page and agent commands use the same server authorization and domain
semantics. After a successful WebMCP room mutation, the adapter awaits a
projection refresh targeting its returned revision. This is best effort:
failed reads can retain the previous view, and the callback does not await
a React paint. Local focus and onboarding have their own completion behavior.
See binding §3.2 rather than assuming an unconditional UI-before-return rule.

## 8. Eligibility semantics

Classification uses the live pool and currently active hard needs. The shared
circle is an implicit hard distance constraint. Inactive and prior-step needs
are not in force. **Soft needs do not currently rank candidates.**

| Evidence against a hard need | Consequence |
|---|---|
| Verified contradiction or deterministic bound failure | `excluded` |
| Likely evidence against it | `unlikely` |
| Unknown evidence, missing referent, or absent/stale private screen | `uncertain` |
| Likely evidence satisfying it | `likely` |
| Every applicable check satisfied without unresolved/likely evidence | `eligible` |

Precedence is `excluded > unlikely > uncertain > likely > eligible`. A
negative expectation reverses which evidence agrees with the need. Current
private `unacceptable` verdicts exclude; `acceptable` passes the private
screen; `needs_info` remains uncertain. No disclosure-granted L2 predicate
path exists.

`matching` counts eligible only; `likely` is separate. The page can combine
matching and likely in its headline while showing their breakdown. Feasibility
and adjustment gains use verified eligible counts. Confidence is a product of
relevant likely facts, not a calibrated success probability or soft-preference
score. A likely claim does not become verified by multiplying confidences.

Explanations are viewer-specific: an owner can see their private reason,
while peers receive shared explanations or aggregate private effects.
The per-place `needs` projection combines all peer-private needs into one
worst-verdict row with `private: true`, without their IDs or labels. The
separate `privateEffects` array can identify an owner and count. This provides
content redaction, not anonymous participation or protection from inference.

### 8.1 Attestations and confirmed facts

`AttestAttribute` accepts a boolean manifest key (excluding `price-level` and
`cuisine`) or `q:<40 lowercase hex>`, `status: verified_true | verified_false`,
confidence from zero to one, a required 1–200-character note, and optional
source URL. It records shared, named evidence per room/place/key/participant.
The source record is not rewritten; attestations merge at read time.

An agreeing attestation leaves a verified record intact. A contradiction with
verified record data, or disagreeing attesters without a decisive record,
produces `unknown` with a `disputed:` source. Otherwise the latest agreeing
participant evidence takes its stated lean, verified at confidence at least
0.7 and likely below that. Supplied notes are shared evidence: the external
agent must not put a private condition into an attestation note.

`ConfirmFact` accepts manifest vocabulary or a question hash, boolean `lean`,
and optional note/source URL. It requires a candidate backed by a permanent
source ref. The row is keyed by `(room_id, osm_ref, criterion_id)`, has no TTL,
and influences **only that room**. Its merged source is `person:confirmed`,
verified at confidence 0.95. It supersedes lookup/inference/guess/ordinary
attestation; a contradiction with verified OSM/curated record remains a
visible dispute. Confirmations are participant assertions, not proof of an
independent verification process.

Only the recorded confirmer or room organizer can `UnconfirmFact`; that
command has no registered WebMCP tool. Confirmation rejects raw question text,
`open:*` time windows, and synthetic value criterion IDs. For an owned private
question, optional confirmation note/source URL are forced to null. Question
labels and dossier rows remain viewer-authorized. Cross-room private question
rows are not published as a global facts feed.

### 8.2 Graded evidence and fact revisions

Evidence can come from prepared OSM/curated records, venue sites and menus,
Wikidata, configured structured listing providers, model interpretation,
category guesses, attestations, and confirmations. Availability depends on
configured sources, extract coverage, budgets, and completed work. A stored
fact's source and timestamp remain meaningful even when the source is old.

A model inference is normally likely, but validated explicit venue statements
can become verified. Matrix evidence must cite a real span and meet its
source/host checks; a focused adjudication can verify explicit venue/chain
answers after separately checking the quote and publisher. Third-party claims
remain graded evidence. A model saying it is certain is insufficient. The
current exact gates and confidence bands live in
[evaluate.ts](../../apps/server/src/enrich/evaluate.ts),
[adjudicate.ts](../../apps/server/src/enrich/adjudicate.ts), and
[the evidence cache](../../apps/server/src/enrich/cache.ts).

Cached claims use a source-aware merge: absent/abstaining new evidence does
not by itself erase a claim, stronger same-lean evidence may replace it, and
opposite evidence must pass the conflict rules. A conflicting reread can
retain a fact with a disagreement note. Consequently “Look again” does not
promise a new answer, a correction, or a verified fact. Participant evidence
merges after automatic evidence according to §8.1.

A free-text need becomes a question criterion keyed by `q:<sha1>` of its
normalized text. Equivalent normalized wording can reuse evidence. The hash
is an identifier, not encryption: a short question can be guessed. A question
row/label is returned only when the need is shared or owned by the viewer;
the cross-room evidence cache does not store the normalized private sentence
as its label. Value-specific cuisine criteria distinguish requested value
sets; time criteria distinguish absolute windows.

Fact-changing paths bump candidate `mapRevision` and make older private
verdicts stale. Fresh screening must return the dossier's revision in
`screenedMapRevision`, plus the separate room `baseRevision`. Missing/older
candidate revisions remain non-authoritative and ahead revisions are invalid.
Photo/progress-only updates need not change eligibility or its fact revision.
The built-in holder may screen changed candidates while it retains a condition;
a personal external agent resumes work when it next synchronizes.

### 8.3 Absolute time windows

A time need stores absolute ISO-8601 `start` and `end`, with `end` after
`start`. Relative words are resolved before submission; the optional phrase
is presentation, not the stored clock. The area's IANA timezone determines
which local opening-hours rows the interval touches, including midnight and
offset changes.

Verified OSM opening hours covering the entire half-open interval satisfy the
need; a gap contradicts it. Structured venue-site hours produce likely or
unlikely rather than verified time answers. Missing/unparseable hours remain
unknown. Unsupported opening-hours syntax, holidays, or live exceptions can
limit the answer. The protocol checks available hours; it does not confirm
availability, reservations, event admission, or current opening status with
the venue. Absolute `open:*` windows cannot be permanently confirmed through
`ConfirmFact` because their meaning expires.

## 9. Navigation handoff

`PrepareNavigation {candidateId?, from?}` returns `{ok:true, target, links}`.
`target` contains candidate ID, name, and location; `links` has `geo`,
`googleMaps`, and `appleMaps`. An explicit candidate can be used before
agreement; omitting it requires a committed destination. An explicit `from`
overrides the caller's saved origin when building directions links.

The links are constructed from coordinates already held by the application,
with no provider request at handoff time. Opening one transfers the coordinates
to the chosen map provider/application. It does not book transport, confirm
arrival, calculate a route in Spokes, or turn a pickup note into a meeting
point. `PlanArrival` records only the caller's selected mode and note.

## 10. World-knowledge boundary

Prepared area extracts define the place/landmark discovery boundary. Lookup
can improve their evidence from configured external sources but does not make
venue discovery worldwide or guarantee complete/current facts. See
[ENRICHMENT-SOURCES.md](../ENRICHMENT-SOURCES.md) and
[Known limitations](../KNOWN-LIMITATIONS.md) for operational scope.

Shared and application-private criteria can be evaluated by a tool-less model
over server-held material. Application-private wording must not enter an
outbound search query or a prompt that enables search tools. Search admission
uses active shared criteria, or independent server vocabulary where no active
private need makes that criterion private. A query can contain place name,
city, and admitted criterion wording; it is not limited to anonymous generic
attribute names. No search is made for a place with no admitted criterion.

External agent-private conditions stay with the agent. In built-in mode the
server interprets the text with a tool-less model and holds it in memory for
a separate tool-less screener, so this mode
has a different server/provider exposure boundary. Neither no-storage request
settings nor encrypted transport prove provider retention behavior. The room's
evidence service does not acquire authority to change someone's stance,
relax a requirement, or commit agreement.

## 11. Invariants and limits

Current guarantees are stable place references, owner-derived mutation
authority, explicit five-state evidence, independent map viewports, common negotiation
semantics for map actions, and privacy-aware projections. Candidate fact
revisions bind private screening to the evidence read. Tests cover
[eligibility](../../tests/unit/eligibility.test.ts),
[attestation merging](../../tests/unit/attestations.test.ts),
[room confirmations](../../tests/api/confirmed-facts.test.ts), and
[multi-step behavior](../../tests/api/steps.test.ts).

Do not extend those guarantees into unsupported claims:

1. An organizer scope change is directly authorized; it is not affected-member
   scope consensus.
2. Content-private needs can expose owners, counts, and aggregate candidate
   effects, and location-dependent effects can support inference.
3. A likely/unknown candidate is not a verified match; a verified fact is only
   as sound and fresh as the admitted evidence behind it.
4. A local tool result is compact and its visible completion best effort,
   rather than a complete dossier or guaranteed rendered frame.
5. Transit routing, meeting-point negotiation, cross-step referent resolution,
   soft ranking, and durable preference reuse are not implemented merely
   because related design vocabulary exists.
