# Everyday evidence and compound requirements

Spokes now retains more useful survey facts and keeps the meaning of compound requests through its existing interpretation and question-evaluation paths. This is a small extension to place selection, without specialist assessments, accessibility scoring or route modelling.

## Behaviour

- The CLI and async backend share one discovery adapter. Dog-only records no longer require a wheelchair flag. Independent matching surveys coexist, conflicting evidence is marked, and original observation dates stay separate from fetch dates. A restricted or missing Wi-Fi qualifier is not a negative Wi-Fi claim; assistance dogs do not imply pet permission.
- Existing dog-friendly and Wi-Fi attributes are supplemented by quiet, step-free entrance, accessible toilet and assistance-dog access. Wheelchair access has its own accurate label. A stepped entrance does not establish that all entrances fail; a removable ramp remains qualified. Attached toilets and nearby toilets are distinct assessed objects.
- At most three separately sourced toilets within 300 m provide nearby context. These are straight-line distances; absence of a record is not proof of absence. Hours, public access, fees and an accessible route can still be unknown.
- Ordinary conjunctions become separate needs. Alternatives, conditional requirements and qualified facts remain one natural-language question. Examples include “dogs inside or on a covered terrace”, “quiet tonight”, “Wi-Fi fast enough for a call” and “entry without staff help”. A conservative mapper repair prevents a split OR from becoming multiple mandatory needs.
- Partial pre-parsing no longer removes a qualifier before the model sees its sentence. Stage B still resolves the returned quantities and civil times deterministically. A condition over 200 characters asks for shortening instead of truncating its meaning.
- Optional `evidenceKeys` on question payloads tell the existing lookup pipeline which reusable facts help answer them. Explicit lookups select relevant active criteria. Dossiers and the matrix evaluator retain recorded facts and scoped survey evidence with provenance. These hints are not an expression language, and they never substitute for the complete question.
- Literal attribute requirements still use the deterministic eligibility engine. Contextual model interpretations of survey/record material stay below verified confidence. The matrix instructions spell out AND/OR truth conditions and require complete supporting evidence. Source reports and likely negatives do not exclude places.
- HTTP and built-in agent inspections default to passive reads. The agent chooses missing keys on its shortlist and stops on pending work or unchanged unknowns. The private judge can make one budgeted lookup for public fact keys and rescreen changed records once. Its held wording remains in the tool-less private path. Decisive private verdicts must cite verified fact keys (or a literally named place); a code check downgrades unsupported claims to unknown. Required `needs_info` hints are generic; model omissions also receive valid unknown verdicts.
- Per-clause hard/soft choices now survive composer submission, clarification choices, room creation and later plan steps. Existing protection of access requirements remains enforced by the engine.

## Operational checks

The implementation was exercised with unit/API fixtures covering mixed schemas, dog-only data, assistance-only access, partial access, source conflicts, ambiguous branches, a same-named unrelated toilet, dated reports, and private missing-information verdicts. A browser test checks that a compound sentence submits one must-have and one preference.

Validation passed on Node 26.8.1: 839 unit tests, 281 API tests against an isolated PostgreSQL database, the compound-submission browser regression, workspace type checking and the production build. The build retains its existing large-chunk warning. An additional mapper regression verifies that an unresolved compound condition asks for clarification instead of submitting an incomplete meaning.

A bounded live check using the configured routing model returned the intended grouping for eight ordinary EN/DE examples. A separate live evaluator check covered nine place/question combinations: complete evidence supported AND/OR, a missing Wi-Fi fact left AND unknown while dogs alone supported OR, and explicit refusals supported negative answers. Old quietness reports left “quiet tonight” unknown in all three cases. All contextual conclusions remained likely. These are smoke checks, not general language-accuracy benchmarks.

A live accessibility.cloud check, written only to an isolated test database, returned DogMap permission for Monbijoupark and Zollpackhof and refusal for Berlin Dungeon. Monbijoupark and Berlin Dungeon also had nearby toilet context, kept separate from venue access. All three dog claims remained likely.

Source IDs and deployment instructions are in [PREPOPULATE.md](../PREPOPULATE.md). Production prepopulation remains stopped. The catalogue still contains regional and specialist sources that are deliberately outside this first selection.
