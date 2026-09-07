# The natural-language surface

Implementation reference, checked against `main` on 2026-09-07. The built-in
agent helps one participant interpret needs, inspect the room, and propose
changes. External agents use the [WebMCP binding](protocols/INTERACTION-AND-BINDING.md);
they do not depend on this language-model service. Page wording follows
[the copy guide](../apps/web/COPY.md).

## What it is

Language interpretation, evidence evaluation, and participant actions are
separate jobs. The server remains responsible for typed payloads, identity,
visibility, revisions, and consent. The built-in tool-calling model proposes
mutations for owner review; it cannot execute them directly.

| Job | Implementation | Boundary |
|---|---|---|
| Read a composer sentence | [say.ts](../apps/server/src/nl/say.ts) | EN/DE pre-parser, structured interpretation, deterministic mapping and payload validation |
| Read an outing before room creation | [plan.ts](../apps/server/src/nl/plan.ts) | Up to three ordered steps, with needs and clarification choices |
| Answer questions or propose a room action | [agent.ts](../apps/server/src/nl/agent.ts) | Participant-visible reads; mutations produce an owner-only review card |
| Screen an agent-private condition | [screening.ts](../apps/server/src/nl/screening.ts) | Tool-less evaluation; only candidate verdicts enter the room |
| Evaluate or adjudicate place evidence | [enrichment](ENRICHMENT-SOURCES.md) | Source/span, criterion, confidence and publisher checks before claims are stored |

## Model configuration

The defaults below describe [config.ts](../apps/server/src/config.ts), not a
claim that every listed provider account supports the configured model.

| Setting | Meaning |
|---|---|
| `LLM_PROVIDER` | `openrouter` or `openai`; when unset, selects OpenRouter if its key exists and OpenAI otherwise |
| `OPENROUTER_API_KEY`, `OPENAI_API_KEY` | Credentials for the selected backend; `GET /api/meta` reports `nl` from its configured key |
| `LLM_MODEL` | Deployment default, currently `openai/gpt-5.6-luna` |
| `LLM_MODEL_ROUTE`, `LLM_MODEL_JUDGE`, `LLM_MODEL_AGENT`, `LLM_MODEL_VISION` | Per-job overrides, each falling back to `LLM_MODEL` |
| `LLM_REASONING_EFFORT` | Shared reasoning setting; defaults to `high` |
| `OPENROUTER_PROVIDERS` | Optional ordered provider slugs; pinning disables fallback to other endpoints |

The [transport](../apps/server/src/nl/llm.ts) uses Responses requests with
`store: false`. Interactive calls use the default service tier. Background
calls can request `flex`, with fallback to default when unsupported; `priority`
and `fast` service tiers are rejected. These service tiers are distinct from
reasoning effort and the search provider's processor setting.

`respondPrivate()` additionally requests OpenRouter no-collection and
zero-retention routing. It is used for the participant-agent loop and private
screening. Ordinary sentence interpretation uses `respond()`, including the
interpretation performed when an agent-private condition is first submitted.
A request setting is not an independently verified provider-retention guarantee.

Without a selected model key, the composer keeps its deterministic/local
controls and plan preview returns an offline fallback. A configured key does
not guarantee provider availability: failed model requests can still return an
unavailable response.

## Routing a sentence

1. The shared [EN/DE pre-parser](../packages/contracts/src/understand/preparse.ts)
   extracts quantities, units, bounds, travel modes, referents, and civil-time
   concepts. A fully understood sentence needs no model call.
2. Remaining words go to the route model with the pre-parsed concepts. The
   returned schema describes an interpretation, not an authorized command.
3. [Server mapping](../apps/server/src/nl/understand/map.ts) resolves concepts
   against the room's facets and named referents, checks ranges, composes labels,
   and validates requirement payloads. Metres and minutes remain different
   dimensions. Cuisine/venue kinds retain their specificity.
4. Ready needs return to the page. Concrete ambiguities return bounded choices
   with attached payloads; choosing one does not require another model call.
   Unclear input can return suggestions derived from the room.

Questions can also carry needs: an `ask` about vegan options can return both a
reply and a vegan requirement. Room moves such as proposing, accepting,
withdrawing, or vetoing route as `act`. The server distinguishes a question
from a stated need; punctuation alone is insufficient.

### How it reaches the page

`POST /api/nl/say` accepts a sentence of 1–300 characters and its visibility
scope. The page attaches a participant-scoped idempotency key to this routed
turn; stored responses can be replayed within the server's ten-minute window.
This is separate from the subsequent command requests and approval action.

| Result | Page behavior |
|---|---|
| `need` | Submits each typed need through `SubmitRequirement` |
| `ask` / `act` | Shows the participant agent's reply and, when present, its exact proposed action for review; returned needs still use the ordinary command path |
| `clarify` | Submits resolved needs and presents the unresolved choice |
| `unclear` | Shows available room-derived alternatives |

The interpreted `topic` is not automatically attached as a shared category
hint. A failed or partial agent result preserves the original composer text
for retry; it is not converted into a guessed new need. Replies appear in the
brief, with request/model diagnostics in the developer drawer.

## Reading a goal before the room exists

`POST /api/plans/preview` interprets the goal into one to three steps. A step
contains its place class, title, optional time window, needs, and a sequential
`then` relation where applicable. [Step classes](../packages/contracts/src/step-classes.ts)
group snapshot classes into food, cafés, drinks, cinema, theatre, parks,
museums/galleries, coworking, sport, and books.

The ordinary onboarding path previews the goal before choosing an area.
Without `areaId`, mapping uses the combined area snapshots and the supplied
browser timezone; class counts are empty. Passing an area selects that area's
facets, counts, and timezone. The page lets the organizer review the plan
before creating a room. The `open_room` WebMCP tool uses the same endpoints but
does not stop for that page review.

Each model concept identifies its step. Out-of-range step numbers fall back
to step 1, as do pre-parsed concepts. A film, exhibition, band, or product
subject becomes a text question for its step. A participant referent that
cannot be resolved before people join falls back to self with an assumption
label; named landmarks can resolve or raise clarification. Preview asks the
first clarification it finds rather than conducting an unbounded conversation.

`POST /api/rooms` stores the goal and plan. The first step's needs become the
organizer's shared requirements through `SubmitRequirement`; later steps keep
pending needs until they open. Invalid seed payloads can be skipped while the
room remains created. With no model, preview supplies one food step without
inferred needs; the ordinary creation path still works.

Agreement on an intermediate step records its place, deactivates that step's
needs, and opens the next around that location. The final agreement proceeds
to arrival planning. See [step advancement](../apps/server/src/steps.ts) and
[Known limitations](KNOWN-LIMITATIONS.md) for the lack of plan editing/reopening.

## Deterministic time resolution

The pre-parser and model normally return civil-time concepts: a day reference,
a day part, and/or a clock. The shared [resolver](../packages/contracts/src/understand/time.ts)
turns those into absolute windows using the captured request instant and the
room area's timezone. Model-provided windows remain a compatibility fallback
for explicit calendar dates.

A weekday means its next occurrence, including today while its window has not
ended. A clock already past today moves to tomorrow. The code owns the default
windows and corresponding prompt wording:

| Words | Local window |
|---|---|
| lunch | 12:00–14:00 |
| dinner / evening | 18:00–21:00 |
| brunch | 10:00–13:00 |
| tonight | today, 18:00–23:00 |
| morning | 08:00–11:00 |
| afternoon | 14:00–17:00 |
| night | 20:00–24:00 |
| late | 22:00–02:00 next day |
| at 7pm | 18:00–20:00, the stated time ±1 hour |
| open now | captured clock through two hours later |
| a bare day | 09:00–23:00 |

The offline composer shares this resolver. Resolving the requested time is
separate from proving a venue is open: [weekly-hours evaluation](../packages/contracts/src/hours.ts)
uses the recorded schedule, with the parser limits described in
[Data quality](DATA-QUALITY.md#time-price-and-distance).

## What the participant agent can and cannot do

The loop begins with this participant's authorized room snapshot. Reads use
that identity and do not receive other participants' private predicates. The
held agent-private condition is also omitted from this tool-calling model's
context; screening is a separate path.

The model's first valid mutating tool call stages one exact command in
`nl_pending_actions` and returns a review card. It does not change the room's
revision. The [approval handler](../apps/server/src/nl/approvals.ts) accepts only
the authenticated owner's opaque approval ID, consumes it once within five
minutes, and submits the stored arguments at their original revision. Client
supplied replacement arguments are ignored. Dismissing removes the pending
action. A newer proposal replaces the same participant's older one.

Approvals remain subject to normal authorization, stale-revision checks, and
additional consent. `CommitAgreement` and `ConfirmPrivateRequest` have no tool
route; approving a staging suggestion does not perform the separate final
confirmation. External WebMCP agents are not wrapped in this built-in review
step. Neither review nor a confirmation nonce cryptographically proves human
intent; see [binding §5](protocols/INTERACTION-AND-BINDING.md#5-security-binding).

The participant-agent loop has a 90-second deadline and at most four model
rounds. Sentence routing happens before that loop and has its own timeout.
Read results are compacted as valid JSON, with omission metadata when needed.
The final reply is capped at 320 characters. A failed turn can expose structured
partial/failure information; a lookup already started may still populate caches.
The complete external tool catalog is not a promise that every browser-only
operation has a meaningful server-side agent implementation.

## Agent-private conditions

`POST /api/nl/condition` receives the actual text at the application server,
interprets it through the ordinary sentence reader, and holds it in a
process-local map. It submits or updates a content-free hard agent-private
declaration with approval-required delegation. No topic is automatically
published. The condition text is omitted from requirement and event storage.

The tool-less screening model receives that text and candidate facts in batches
of at most ten. It returns `acceptable`, `unacceptable`, or `needs_info`;
missing answers become `needs_info`. The resulting `EvaluateCandidates` command
uses the room revision and each candidate's fact revision that were actually
read. Concurrent fact changes can reject the write as stale.

There is a current adapter/schema mismatch: the screening adapter does not
include `infoNeeded`, which the command schema requires for `needs_info`.
Any batch containing that verdict is rejected, including missing answers
filled in by the adapter, so screening can remain pending. External agents
can supply a valid `needs_info` verdict through the WebMCP command.

Commits wake held conditions for further screening. Restating replaces the
held text and clears prior verdicts; withdrawing its declaration releases it.
Restarting loses the text, so fresh screening requires the participant to
state it again. This differs from an external agent retaining the text outside
the application and sending only declarations/verdicts. Both paths expose
eligibility effects; neither promises anonymity or protection against inference.

## Verification

Relevant regression suites are [security](../tests/api/security.test.ts),
[natural-language revisions](../tests/api/nl-agent-revision.test.ts),
[turn idempotency](../tests/api/nl-idempotency.test.ts),
[clarification](../tests/api/nl-clarify.test.ts), [plans](../tests/api/plans.test.ts),
[steps](../tests/api/steps.test.ts), and [time resolution](../tests/unit/time.test.ts).
Scripted model tests check application behavior; they are not a benchmark of
current provider/model interpretation quality.
