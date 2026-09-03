# FACETS — the data contract behind every control

The redesign has **no predefined filter UI**. Every chip, suggestion and
attribute row is generated from what the server returns for the current
candidate set. That requires a capability the server does not have yet.
This document specifies it.

Until it exists, the composer's suggestion pills and the details panel's
attribute groups cannot be built correctly — they would have to be hardcoded,
which is precisely the thing the redesign removes.

---

## Why

The old UI shipped food-domain filter buttons. That works for one domain and
breaks for every other. The app must serve "a park where the dog can run",
"a museum with the Hilma af Klint show", "a cinema showing it in Japanese",
"a coworking space with a quiet room" — with the same screens.

The only way that holds is if the **server describes what is askable** about
the current results, and the client renders whatever it gets.

---

## 1. Facets alongside candidates

Extend the candidate-set response with a `facets` array describing the
attributes present across the current results.

```jsonc
{
  "candidates": [ /* … as today … */ ],
  "total": 34,
  "facets": [
    {
      "key": "dog_offleash",           // stable id, never shown
      "label": "off-leash area",       // the ONLY string the UI shows
      "type": "boolean",
      "counts": { "yes": 9, "no": 18, "unknown": 7 },
      "salience": 0.82
    },
    {
      "key": "wheelchair",
      "label": "step-free access",
      "type": "boolean",
      "counts": { "yes": 11, "no": 6, "unknown": 17 }
    },
    {
      "key": "opening_hours",
      "label": "open Sunday morning",
      "type": "temporal",
      "counts": { "yes": 21, "no": 9, "unknown": 4 }
    },
    {
      "key": "language",
      "label": "screening language",
      "type": "enum",
      "values": [
        { "value": "de", "label": "German",   "count": 12 },
        { "value": "en", "label": "English",  "count": 5  },
        { "value": "ja", "label": "Japanese", "count": 1  }
      ],
      "counts": { "unknown": 3 }
    },
    {
      "key": "walk_minutes",
      "label": "walking time",
      "type": "numeric",
      "unit": "min",
      "range": { "min": 3, "max": 34 },
      "histogram": [ 4, 9, 7, 3, 1 ],
      "counts": { "unknown": 0 }
    }
  ]
}
```

### Field rules

- `key` — stable, machine-readable, **never rendered**.
- `label` — human, lowercase, domain-natural. The client renders this
  verbatim. It is the server's job to make it read well.
- `type` — one of `boolean` | `enum` | `numeric` | `temporal` | `text`.
  The client has one renderer per type and no domain branches.
- `counts.unknown` — **mandatory**. Unverified is a first-class state in this
  UI; a facet without an unknown count cannot render its `?` badge.
- `counts.likely` / `counts.unlikely` — graded facts (SPATIAL-PROTOCOL §8.2):
  places where the answer is a guess with a confidence. Absent means zero.
  Pills count `yes + likely`; the brief row shows "n likely" beside
  "n unknown"; the count block shows "· n likely" apart from the big number.
- `salience` — optional 0–1 hint for ordering. Absent → order by
  `counts.yes` descending.

### What the client does with it

| Where | Rendering |
|---|---|
| Composer suggestion pills | top 2–3 facets not already a stated need, as `label` + `counts.yes` |
| Brief row "n unknown" badge | `counts.unknown` for that need's facet |
| Details attribute groups | one row per facet the place has a value for |
| Impasse "ways out" | facets whose relaxation changes the count (see §2) |

**Do not** add a `category` or `domain` field. The client must never branch on
domain — that reintroduces exactly what we removed.

---

## 2. Counterfactual deltas

The map's `+3 if "step-free" went optional` chip, and the impasse screen's
quantified ways out, need to know **what the set would be without a need**.

Computing this client-side means re-running the whole predicate set per need
on every change. Better on the server, which already has the index.

```jsonc
{
  "activeNeeds": [
    { "id": "n1", "label": "dogs can be off-leash", "ruledOut": 19, "wouldReturn": 0 },
    { "id": "n2", "label": "step-free paths in",    "ruledOut": 3,  "wouldReturn": 3 },
    { "id": "n3", "label": "water on site",         "ruledOut": 0,  "unknown": 3, "wouldReturn": 2 }
  ],
  "matching": 6
}
```

- `ruledOut` — how many this need alone eliminates → the `−19` in the row.
- `wouldReturn` — how many come back if it were dropped → the `+3` chip and
  the impasse cards.
- At impasse (`matching: 0`) the client sorts by `wouldReturn` and offers the
  top two as ways out.

Press-and-hold preview can use `wouldReturn` for the count immediately, then
reconcile with the real set when it arrives.

### Question needs

A free-text question is a real active need even though it cannot produce a
reusable facet. Its `ActiveNeed` row carries the stable `criterionId`
(`q:<sha1>`), plus the same live `ruledOut`, `wouldReturn`, `unknown`, `likely`
and `unlikely` counts as any other need. The `facets` array deliberately has no
row for that id: the sentence remains need content, not a new hardcoded control.

---

## 3. Provenance

Unverified is a state the UI draws, so every attribute value needs a source.

```jsonc
{
  "id": "place_nordbahnhof",
  "name": "Park am Nordbahnhof",
  "attributes": {
    "dog_offleash":  { "value": true,  "source": "osm",      "confidence": "high" },
    "wheelchair":    { "value": true,  "source": "osm",      "confidence": "medium" },
    "water_on_site": { "value": null,  "source": null,       "confidence": null }
  }
}
```

- `value: null` → renders hollow / `?` / "unknown". **Never** rendered as a
  failure, never silently excluded.
- `source` → shown in the details panel ("from OpenStreetMap", "the venue says").
- `confidence: "low"` → renders as unsure even when a value exists.

---

## 4. Privacy boundary

A private need is evaluated **without its content reaching the room**. The
shared response therefore carries the effect only:

```jsonc
{
  "privateEffects": [
    { "owner": "sarah", "ruledOut": 4, "topic": "distance" }
  ]
}
```

- `topic` is a coarse, opt-in category — enough for "one condition about
  distance exists", never enough to reconstruct the condition.
- Omit `topic` entirely when the owner hasn't consented to that much.
- Never include the predicate, the value, or the place ids it removed.

The owner's own client receives the full need; peers receive only this.

The same boundary governs a place dossier's `needs[]`. The viewer's own needs
and every shared need are full rows, each naming its requirement. Every
**peer-private** need collapses into a single row — `{ private: true, verdict }`
— with no `requirementId`, no label and no why, carrying the worst verdict any
of them reaches (`no` > `unlikely` > `unknown` > `likely` > `yes`). One row
however many such needs exist: a per-need verdict would let a reader pair a
condition with the places it removes, and a row count would leak how many
conditions a peer is holding.

---

## 5. What to build first

1. `facets` on the candidate response (§1) — unblocks every data-driven control.
2. `activeNeeds` deltas (§2) — unblocks the count chip and the impasse screen.
3. `source` / `confidence` on attributes (§3) — unblocks the unsure state.
4. `privateEffects` (§4) — unblocks the late-joiner digest and history rows.

1 and 2 are the blocking pair. Without them the UI can be built but not
honestly populated, and the temptation to hardcode domain chips returns.
