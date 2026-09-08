# More useful data for choosing places together

Recommendation: add DogMap first, retain more everyday facts from existing surveys, and make lookup respond to the group's unresolved requirements. Keep detailed accessibility assessments and transport routing outside the initial scope.

## What was reviewed

All **168 accessibility.cloud catalogue entries**, their descriptions and licence metadata, plus **434 representative records from 151 sources**. Each source received a bounded sample attempt, generally three records; this was a capability review, not a completeness or accessibility audit. Seventeen sources yielded no sample: some returned empty place/equipment collections, the OSM mirror timed out, and the disruption endpoint returned HTTP 404. This does not establish that their upstream data is empty.

The [complete catalogue spreadsheet](accessibility-cloud-catalogue-2026-09-08.csv) gives every source a use, priority, observed field families, and caveats. A [JSON version](accessibility-cloud-catalogue-2026-09-08.json) preserves the same review. Regional counts in those files are observations from earlier probes, not coverage guarantees; missing counts mean unestablished coverage. Global sample fields may not occur in Berlin or SF.

## What is worth using

| Dataset family | Spokes use | Recommendation |
| --- | --- | --- |
| **DogMap, Pfotenpiloten** | “Somewhere I can bring my dog.” | First addition. DogMap has 236 records in the Berlin area; 117 explicitly describe pet policy. Eight distinct source locations match nine snapshot entries, seven allowing pets and one refusing them. All nine entries lack an OSM `dog` tag; other enrichment may already contain evidence. |
| **Travelable Mapathon, Ginto, independent city/Wheelmap surveys** | Basic entrance/access facts, toilets, Wi-Fi, atmosphere | Expand existing adapters. Samples contained Wi-Fi-related fields in seven sources, quietness in one, entrance fields in thirty, and toilet detail in twenty-four. Field presence is not proof of availability, positive values, freshness or regional coverage. |
| **City toilet and parking datasets** | “A park with a toilet nearby”; “somewhere near designated parking.” | Treat these as nearby facilities or explicitly attached amenities. They generally will not match venue names, which is why our earlier enrichment-only coverage figure understated their potential. |
| **Clean your Cup** | A discreet toilet with a wash basin inside | Useful for a specific condition; no default filter. Samples explicitly describe the basin's location. A toilet named after a café must not establish the café's overall access. |
| **Regional destination guides, outdoor locations, benches** | More outing choices and practical nearby facilities when those regions open | Keep in the catalogue; activate by region. Do not infer seating from a source title: the sampled Norwegian bench records are categorized as parks and do not describe seats. |
| **Cinema support datasets** | Find cinemas worth checking for audio-described/subtitled screenings | Later, region-specific leads. A cinema's general capability does not establish a particular film, language or showtime. Some sampled flags were strings, not booleans. |
| **Station/lift feeds** | A targeted arrival check when someone needs it | Later. Keep equipment tied to its station and observation time. Sampled top-level working states coexisted with historical outage fields; blindly merging them would create contradictions. No full route-accessibility engine. |
| **Clinical/specialist, demo, obsolete and empty feeds** | Little immediate benefit for ordinary shared outings | Defer specialist fields; skip test/obsolete feeds. Retain catalogue entries so a future stated need can justify revisiting them. |

The blanket `wheelmap` name exclusion is too broad. The **OSM mirror** and OSM-derived French cinema data share OSM lineage; independent Wheelmap surveys are separate candidates for review. Establish lineage per dataset/record rather than excluding an entire publisher.

Two current selections need attention before activation: SF parking describes a **September 2011** snapshot; Berlin parking's source description requires attribution while its linked licence is labelled Zero. Refresh the former and resolve the latter's attribution metadata. Re-downloading data does not make an old observation current.

## A small attribute mapping

The existing [attribute vocabulary](../../packages/contracts/src/manifest.ts) is small and useful. Extend it selectively; use the existing free-text question criteria for less common conditions.

| Observed input | Mapping | Interpretation boundary |
| --- | --- | --- |
| `animalPolicy.allowsDogs`; legacy `allowsDogs` | Existing **dog-friendly** | Explicit pet permission/refusal only. |
| `allowsAssistanceDogs`, `allowsGuideDogs` | New **assistance-dog access** fact, retaining the stated subtype | Assistance-dog-only access does not imply pets allowed. |
| `hasFreeWifi`, `wifi.isOpenToEveryone` | Existing **wifi**, with free/public qualifiers in evidence | Free Wi-Fi implies Wi-Fi; “not free” does not imply no Wi-Fi. No promise of speed, sockets or suitability for a work call. |
| `isQuiet` | New **quiet** | A subjective, dated report. It cannot establish quietness at tonight's requested time by itself. |
| `accessibleWith.wheelchair`, partial-access flags | Existing **wheelchair-accessible** | Preserve partial/unknown states. This general assessment is not interchangeable with a step-free entrance. |
| Entrance `isLevel`, fixed/removable ramp facts | New **step-free entrance**, retaining entrance and assistance qualifiers | Describe the entrance actually assessed. One inaccessible entrance does not prove there is no alternative. |
| An attached restroom's `isAccessibleWithWheelchair` | New **accessible toilet** | Only an identified facility belonging to that place; no whole-venue inference. |
| Toilet/parking record near a place | Supporting amenity + a question-based requirement | Keep “nearby” separate from “on site”; distance, public access, time and fees may still need checking. |

Do not add a generic “family-friendly”, “work-friendly” or “fully accessible” flag. Those hide different requirements. Baby changing, ordinary seating, smoking and reliable Wi-Fi are useful questions, but this sample did not establish dependable current-region data for them. Adult changing facilities are not baby-changing evidence. Venue websites, existing listing providers or participant confirmation may remain the better sources.

Keep a compact fact record: **place/facility, property, value, qualifiers, source, observation time, fetched time and evidence status**. A registry can describe which source supplies which facts. This does not require a general ontology or a new expression language.

## How the agent should use it

Example: **“A café where I can bring my dog, talk without shouting, and get in without stairs.”**

1. Preserve the three conditions, the user's must/preference choices, time and visibility. Map dogs directly; interpret the other phrases as quietness and an entrance question. Preserve alternatives such as “inside or outside”—do not flatten them into two mandatory needs.
2. Read existing evidence for the current shortlist. The result might be “dog policy known; quietness is an old report; entrance unknown.”
3. Choose the next useful lookup: DogMap for pet policy, a survey/venue access page for the entrance, or current venue information for atmosphere. Fetch the missing facts that could change the shortlist, using existing provider quotas and agent time/round limits.
4. Evaluate literal booleans deterministically. Use the tool-less model for contextual language, with scoped evidence and citations. Return satisfied, failed, likely or unknown consistently with Spokes' existing evidence rules. A model's certainty must not turn a report into verification.
5. Explain the remaining uncertainty in plain language: “Dogs are reported welcome; the side entrance has a ramp; quietness tonight is unconfirmed.” Ask a narrow clarification or suggest another place when that would help. Do not automatically relax a must-have or commit the group's choice.

For “a toilet nearby”, query amenity proximity instead of searching for matching venue names. Existing straight-line distance estimates can shortlist facilities; they cannot prove walking time, opening hours or an accessible route. For private conditions, fetch public place facts without sending the private wording to search providers; evaluate that wording only through the authorized private path. Keep missing-information details owner-only where they could reveal the condition.

## The smallest implementation sequence

1. **Generalize the shared discovery adapter:** accept supported facts without requiring a wheelchair boolean; add DogMap; map Wi-Fi/quietness/toilet/entrance facts; retain multiple source observations for the same resolved entity. Keep branch ambiguity checks and source-aware conflict handling. Reuse this for both CLI and async backend.
2. **Make the existing agent loop ask for useful missing evidence:** expose source, scope, freshness and missing fact keys in dossiers. Fix the existing private-screening mismatch first: `needs_info` requires `infoNeeded` in the command contract, but the screener currently omits it. It also flattens evidence into strings and loses provenance/time. A private missing-information hint must not become a shared disclosure.
3. **Add nearby toilet context**, then evaluate whether parking or station status materially improves real group choices. Prepopulate reusable regional facts; perform time-sensitive checks on demand. Stop when there is enough evidence to choose, or report the remaining unknowns and budget limit.

Validate with a small set of ordinary outings: café with a dog; a quiet catch-up; laptop work with Wi-Fi; a park with a nearby toilet; step-free entry. Include assistance-dog-only access, partial access, a nearby-but-unrelated facility, stale observations, conflicting sources, duplicate venue records and private `needs_info`. Measure additional useful facts and better decisions per lookup, not imported row counts.

This review changes no production settings or runtime behavior. The prepopulation CLI remains stopped. Detailed measurements, clinical suitability, general accessibility scoring and full transport routing are outside this proposal.

## Sources and implementation references

- [Official accessibility.cloud API](https://github.com/sozialhelden/accessibility-cloud/blob/main/app/docs/json-api.md): source selection, bounded queries, related metadata, authentication.
- [A11yJSON model](https://sozialhelden.github.io/a11yjson/describing-objects/0-model/) and [object-focused modelling guidance](https://sozialhelden.github.io/a11yjson/best-practices/describe-objects-not-people/): vocabulary/semantics; schema support does not establish live data availability.
- [DogMap's explanation](https://map.pfotenpiloten.org/up/): pets versus assistance-dog access.
- Spokes [natural-language flow](../NL-AGENT.md), [facets](../../apps/server/FACETS.md), [discovery adapter](../../apps/server/src/enrich/discovery.ts), [screening adapter](../../apps/server/src/nl/screening.ts) and [verdict contract](../../packages/contracts/src/commands.ts).

Dataset-specific conclusions come from the authenticated catalogue and bounded live samples collected on 2026-09-08. Credentials and raw sample records are excluded from the committed review.
