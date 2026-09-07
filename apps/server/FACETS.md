# Facets, needs, and progress contracts

Implementation reference, checked against `main` on 2026-09-07. The server
supplies the facets, need summaries, private effects, and provenance that drive
the page's controls. This capability is implemented in [facets.ts](src/facets.ts)
and projected through [spatial.ts](src/spatial.ts).

The authoritative response types are in
[envelope.ts](../../packages/contracts/src/envelope.ts); realtime types are in
[realtime.ts](../../packages/contracts/src/realtime.ts). Examples below are
illustrative excerpts with synthetic IDs/counts, not complete API responses or
claims about actual places.

## Why

The server describes what is askable about the current places. The client
renders supplied labels and the appropriate control type rather than inventing
a separate set of food, park, cinema, or museum filters. Place-class and
criterion vocabularies remain server data. This does not imply unlimited
attribute support: the current mapper and evidence sources determine which
facts can be answered.

## 1. Facets alongside candidates

The authenticated `POST /api/spatial/context` response contains `facets`,
`activeNeeds`, `privateEffects`, and the current classification. Counts are
computed over the current step's **in-scope** candidates. The context can also
return excluded out-of-scope candidates so the map can keep their positions;
they do not inflate the facet/count denominator. Compact WebMCP results omit
some of these page fields; see the
[binding reference](../../docs/protocols/INTERACTION-AND-BINDING.md#24-what-an-agent-actually-receives).

```json
{
  "total": 34,
  "facets": [
    {
      "key": "wheelchair-accessible",
      "label": "step-free access",
      "type": "boolean",
      "counts": { "yes": 11, "no": 6, "unknown": 17 }
    },
    {
      "key": "dog-friendly",
      "label": "dogs welcome",
      "type": "boolean",
      "counts": { "yes": 9, "likely": 2, "no": 18, "unknown": 5 }
    },
    {
      "key": "cuisine",
      "label": "cuisine",
      "type": "enum",
      "values": [
        { "value": "italian", "label": "Italian", "count": 8 },
        { "value": "thai", "label": "Thai", "count": 2 }
      ],
      "counts": { "yes": 10, "no": 0, "unknown": 24 }
    },
    {
      "key": "walk-minutes",
      "label": "walking time",
      "type": "numeric",
      "unit": "min",
      "range": { "min": 3, "max": 34 },
      "histogram": [4, 9, 7, 3, 11],
      "counts": { "unknown": 0 }
    }
  ]
}
```

### Field rules

- `key` is the stable machine identifier; `label` is the server-authored text
  rendered to the participant. Vocabulary keys come from the
  [manifest](../../packages/contracts/src/manifest.ts).
- `type` is `boolean`, `enum`, `numeric`, `temporal`, or `text`. Current output
  supplies vocabulary booleans, a cuisine enum when available, numeric walking
  and price facets, and temporal facets for authorized active time needs.
  Free-text questions have need rows rather than reusable text facets.
- `counts.unknown` is required. The other count fields are optional;
  `likely`/`unlikely` being absent means zero. Boolean/enum/temporal buckets
  describe disjoint evidence outcomes, not an intersection with every other
  active requirement. A numeric facet instead has a range and five histogram
  buckets, plus its missing-value count.
- `values[].count` for cuisine counts verified exact matches and sufficiently
  strong sourced implications for **that inclusion predicate alone**. It does
  not promise the same count after all the room's other needs are applied.
  The implication floor is `CUISINE_IMPLICATION_SATISFACTION_FLOOR`, currently
  0.7. Likely values and weaker implications can remain available with count
  zero so the sentence parser can still resolve them.
- Facet array order is render order. The current server sorts booleans by
  `yes + likely`, then appends cuisine and numeric facets, followed by temporal
  facets. `salience` is an optional contract field; its absence does not tell
  the client to resort the entire array.
- `walk-minutes` uses this viewer's private origin, falling back to the room
  centre; it is absent if neither is available. It is a straight-line walking
  estimate, not route-provider time. Other participants' coordinates are not
  included in the facet.
- `price-level` exposes approximate per-person bands with `unit: "EUR"` or
  `"USD"` from the area. It is not a live menu quote or currency conversion.

### What the client does with it

| Surface | Current use |
|---|---|
| Composer pills | First three unstated boolean facets with positive `yes + likely`; displays that combined count |
| Brief | Server-authored `activeNeeds` labels, state, uncertainty, and deltas |
| Place panel | Per-place facts and `needs` verdicts, with provenance |
| Counterfactual preview | Server classification with one authorized requirement omitted |
| Main count | `matching + likely` as places that still work; remaining states separately reported |

The [composer](../web/src/components/Composer.tsx) consumes the returned order.
No `category` or `domain` field is part of the `Facet` contract.

## 2. Counterfactual deltas

`activeNeeds` contains shared needs and the viewer's own needs. Despite its
name, it also retains set-aside rows with `active: false`. Peer-private
requirements are represented separately (§4).

```json
{
  "matching": 6,
  "likely": 2,
  "activeNeeds": [
    {
      "id": "req_example_1",
      "criterionId": "wheelchair-accessible",
      "label": "step-free access",
      "ruledOut": 3,
      "wouldReturn": 2,
      "unknown": 4,
      "likely": 1,
      "unlikely": 0,
      "active": true,
      "visibility": "shared",
      "hardness": "hard",
      "ownerId": "p_example"
    }
  ]
}
```

`ruledOut` counts what that need alone decisively rules out within scope.
`unknown`, `likely`, and `unlikely` likewise describe that need alone.
`wouldReturn` is the change in the eligible count if the active need were
omitted while the other active needs remain. An inactive row has zero
`wouldReturn`. These deltas use eligible counts; the main display also counts
likely candidates. The response normalizes non-soft hardness to `hard` for
this display row; full delegation still belongs to the requirement contract.

A scope need can carry a `referent` label and authorized location, plus a
`range` circle with centre/radius and optional participant ID. A private or
unavailable measuring point does not become a coordinate in a peer response.

Press-and-hold uses `excludeRequirementId` on the context read to compute the
actual counterfactual classification without changing the requirement. Only a
shared need or one owned by the viewer can be omitted. Unknown and foreign
private IDs fail the same way. The displayed delta is not permission to relax
a need; mutation ownership and consent rules still apply.

### Question needs

A free-text question has a stable `criterionId` of `q:<sha1>` and the same
need counts as other criteria. It does not add a new reusable facet whose
label would expose the question. Source evaluation, private screening where
applicable, or participant evidence can change the place verdicts.

Refinement starts with room activity/creation and can continue for the default
ten-minute grace period after the room empties. Missing evidence remains
unknown; a failed model/source request is not a negative answer. The optional
context `refine` view reports activity, queued active-need places, the
`tier1Queued` alias, checked-today count, pause reason, and remaining model/search
budgets. See [continuous refinement](../../docs/ENRICHMENT-SOURCES.md#continuous-refinement).

### Temporal needs

Each distinct authorized active time window can produce a `temporal` facet
keyed by `open:<start>-<end>`. The server supplies a readable label in the
area's timezone. Identical window keys share a facet; different windows do
not. Peers do not receive a temporal facet for someone else's private window.

The five outcome buckets reflect verified schedule coverage, likely website
schedule coverage, or unknown hours. Evaluation is deterministic and does not
send `open:*` predicates to a model. It uses a limited weekly-hours parser;
public holidays and unsupported syntax are not a complete calendar model.
See [time, price, and distance](../../docs/DATA-QUALITY.md#time-price-and-distance).

## 3. Provenance

A dossier's `attributes` is an **array**, with numeric confidence and explicit
status/source/observation fields:

```json
{
  "candidateId": "pl_example_001",
  "name": "Example place",
  "mapRevision": 4,
  "attributes": [
    {
      "key": "wheelchair-accessible",
      "status": "verified_true",
      "source": "osm:wheelchair",
      "observedAt": "2026-08-31T20:21:20Z",
      "confidence": 0.8
    },
    {
      "key": "price-level",
      "status": "unknown",
      "source": "osm:price",
      "observedAt": "2026-08-31T20:21:20Z",
      "confidence": 0.6
    }
  ]
}
```

`status` carries the five-state evidence classification. Missing `value` does
not mean false, and confidence alone does not replace the status/source rules.
The contract's numeric confidence is translated into words by the page.
Optional fields include a reader label for non-vocabulary facts, `note`,
`sourceUrl`, an attester, and confirmation attribution/time.

Verified labels describe accepted records or assertions, not independent
inspection. Participant confirmations and attestations affect their originating
room. Model evaluation can accept an explicit venue statement as verified;
ordinary likely evidence retains its weaker standing. See
[evidence and precedence](../../docs/ENRICHMENT-SOURCES.md#evidence-and-precedence).
Candidate `mapRevision` changes invalidate screening against earlier facts.

## 4. Privacy boundary

Application-private predicates are stored and evaluated by the server but
omitted from peer need rows. The effect projection can still identify the
owner and an optional owner-supplied topic:

```json
{
  "privateEffects": [
    { "owner": "p_example", "ruledOut": 4, "topic": "distance" }
  ]
}
```

`topic` is omitted without a supplied category hint. The projection contains
neither predicate values nor an explicit list of removed place IDs. It is a
row per active peer-private requirement, so its owner and count are observable;
it does not guarantee anonymity or prevent inference in a small group.

A dossier uses a more aggregated representation. Its `needs` includes full
rows for shared requirements and the viewer's own requirements, plus at most
one peer-private row for that place:

```json
{
  "needs": [
    { "private": true, "verdict": "unknown" }
  ]
}
```

That aggregate contains no requirement ID, label, or explanation. It takes the
worst peer-private verdict: `no`, then `unlikely`, `unknown`, `likely`, `yes`.
Its presence and effects are public; private predicates are not.

Question inference entries in the shared OSM-ref cache use the hashed
criterion ID and do not store the original question or display label. The hash
is guessable, not encryption. Dossier reads filter question attributes to
shared needs and needs owned by the viewer, recovering their labels only from
those authorized requirements.

Application-private criteria can reach a separate tool-less model evaluation
call over source text already held by the server. Outbound search queries use
only shared active-need words or the closed server vocabulary for background
criteria without active needs. A private criterion cannot itself supply search
terms. Agent-private content is not used by refinement: an external agent can
hold it outside the application; the built-in agent sends it through server
interpretation and separate screening and keeps it in process memory. See
[agent-private conditions](../../docs/NL-AGENT.md#agent-private-conditions) and
[Known limitations](../../docs/KNOWN-LIMITATIONS.md).

## 5. Reading and updating these views

The full context endpoint supplies counts, facets, need rows, room plan, and
other participant-visible state. `POST /api/spatial/inspect` supplies dossiers
for one to three candidate IDs. Page controls mutate the underlying needs or
facts through the ordinary command path, then refresh their projections.
Neither a facet selection nor a progress frame is a new source of authority.

When extending these views, update the live TypeScript contracts and the
server projection together. Reuse server labels, preserve unknown/likely
states and private-field omission, and check both owner and peer views. The
WebMCP adapter deliberately compacts results; adding a page field does not
make it appear automatically in the tool response.

## 6. Pipeline realtime frames

The server emits process-local presentation frames alongside revisioned room
activity. These frames describe work and trigger rereads; they are not commands
or a replacement for room revision checks.

```json
{
  "type": "pipeline",
  "outstanding": { "fetch": 7, "process": 4 },
  "inFlight": { "fetch": 3, "process": 2 },
  "done": 12,
  "total": 28,
  "etaMs": 9400,
  "paused": null,
  "stalled": [],
  "stages": [{ "candidateId": "pl_example_001", "stage": "fetching" }],
  "reset": false,
  "reason": { "kind": "refine" }
}
```

Volume includes priority-zero and priority-one work. `total` is deduplicated
by place; fetch/process work can overlap, so it is not a sum of arbitrary
stage counters or the entire pool size. `etaMs` is diagnostic and is not drawn
as a promised arrival/completion time. `paused` may be `budget`, `idle`, or
null; absent fields are allowed by the contract.

`stages` is a delta unless `reset: true` makes it a full snapshot. A null stage
removes that candidate from the stage map. `stalled` names candidates with a
remembered dispatch timeout; later admission/completion can clear it. Updates
are coalesced on a 250-ms cadence, with an immediate update for a quiet room
and clearing updates as work ends. The process holding the sockets supplies
these counts; there is no cross-process progress store.

The current client also accepts `lookups` snapshots:

```json
{
  "type": "lookups",
  "pending": ["pl_example_001", "pl_example_002"],
  "stages": [
    { "candidateId": "pl_example_001", "stage": "fetching" },
    { "candidateId": "pl_example_002", "stage": "processing" }
  ]
}
```

Lookup stages are `queued`, `fetching`, or `processing`; an entry in `pending`
without a stage is treated as fetching. An empty snapshot clears its lookup
state. A `reason` label may name only shared need content. Private question
text does not belong in progress frames.

### Previewing and opening a place

A client can send `{"type":"previewing","candidateId":"pl_example_001"}`
or the same object with `candidateId: null` to clear it. These hints are
validated against the room and remain transient. They start bounded
cache/site/judge prefetch, at most two places concurrently, with a five-second
open window. Prefetch has no search, image decode, or vision path.

`viewing` uses the same candidate-ID/null shape and starts the bounded
interactive open plan. `inspect_candidates` with `intent: "open"` returns the
cached dossier immediately and can start that plan too. `intent: "read"`
starts no work; omitted intent retains a compatibility lookup with a bounded
three-second wait. A successful open is reused within the same needs epoch;
elapsed time alone does not admit another completed open. Changed needs or
`force` can allow another pass, subject to the ordinary budgets.

Interactive work publishes `facts` frames using a different stage vocabulary:

```json
{
  "type": "facts",
  "candidateIds": ["pl_example_001"],
  "reason": "interactive",
  "stage": "site"
}
```

The stages are `queued`, `site`, `needs`, `photos`, and `web`. A terminal
frame uses `done` and a completion reason:

```json
{
  "type": "facts",
  "candidateIds": ["pl_example_001"],
  "reason": "interactive",
  "done": true,
  "steps": [
    { "stage": "queued", "ms": 20 },
    { "stage": "site", "ms": 1200 },
    { "stage": "needs", "ms": 800 }
  ],
  "costUsd": 0.001,
  "completionReason": "complete"
}
```

Completion reasons are `complete`, `floor`, `budget`, `aborted`, or `error`.
`steps` and `costUsd` are optional diagnostics for the developer drawer;
`costUsd` in the example is synthetic. `deadlineExceeded` is not part of this
contract. The page rereads affected dossiers/context so actual evidence and
classification determine what it displays.

## Verification

Relevant suites cover [facets](../../tests/api/facets.test.ts),
[facet computation](../../tests/unit/facets.test.ts),
[question lookup](../../tests/api/question-lookup.test.ts),
[origins](../../tests/api/origin.test.ts),
[projection](../../tests/unit/projection.test.ts), and
[pipeline behavior](../../tests/unit/pipeline.test.ts). Provider quality and
production concurrency remain separate from contract correctness.
