# The natural-language surface — "your agent" inside the page

Status: built 2026-09-02. Companion to `docs/protocols/INTERACTION-AND-BINDING.md`
(the WebMCP binding, which this does not replace) and `apps/web/COPY.md`
(agent phrasing).

## What it is

Until now the only agent Spokes knew was the one on the other side of WebMCP
(ChatGPT's in-app browser). The page itself could not read a sentence. This
adds a second agent that lives with the serving process and speaks for one
participant at a time, through the **same** tool surface and the **same**
command bus. Nothing about the protocols changed; the page gained a way to
turn words into commands.

Every job uses OpenRouter's Responses API and `z-ai/glm-5.3-flash` by default.
The old tier names remain configuration seams, but they resolve to the same
deployment model today.

| Job | Where | Model use |
|---|---|---|
| Route a composer sentence and turn a need into typed payloads | `apps/server/src/nl/say.ts` | Strict schema; every payload is re-validated by the server's Ajv pass like a hand-typed one. |
| Infer still-unknown place attributes from supplied evidence spans | `apps/server/src/enrich/infer.ts` | Strict schema over a closed key set; quoted spans and confidence are checked by server code. |
| Adjudicate one likely evidence span in nearby context | `apps/server/src/enrich/adjudicate.ts` | Focused strict-schema reread; publisher and quote validation remain authoritative. |
| Refine uncertain active needs from site text and cited web search | `apps/server/src/refine/worker.ts` | Split search only: Parallel supplies bounded snippets, then the matrix judge evaluates them without a search tool. |
| Act on the room or answer a question about it | `apps/server/src/nl/agent.ts` | Function-tool loop over participant-visible room state. |
| Screen places against an agent-private condition | `apps/server/src/nl/screening.ts` | Strict schema with no-collection and zero-retention provider routing. |

`LLM_MODEL` chooses the deployment default and defaults to
`z-ai/glm-5.3-flash`. `LLM_MODEL_ROUTE`, `LLM_MODEL_JUDGE`,
`LLM_MODEL_AGENT`, and `LLM_MODEL_VISION` can override one job family; each
inherits `LLM_MODEL` when unset, preserving the single-model default.
`LLM_PROVIDER` selects `openrouter` or `openai`; absent an explicit value it
uses OpenRouter when `OPENROUTER_API_KEY` exists and OpenAI otherwise.

This never means a paid priority processing tier. Every foreground request
sets `service_tier: "default"`; `apps/server/src/nl/llm.ts` rejects
`priority` and `fast` before transport. A named `flex` hook is reserved for
later background work.

## Routing a sentence

Routing runs in the same order on every turn, whether or not an in-page agent
is available:

1. The shared EN+DE pre-parser in `packages/contracts` extracts quantities,
   units, bounds, travel modes and referents. If it consumes the whole
   sentence, code maps the concepts and no model request is made.
2. If words remain, the deployment model at low effort reads only that
   remainder. The pre-parsed concepts are supplied as already understood and
   must not be repeated. Its strict result is an interpretation, not a command.
3. Server code maps every concept through the closed requirement-payload
   union, resolves named referents in process, checks numeric ranges, composes
   labels, and re-validates every payload with Ajv. Metres and minutes are
   never converted into one another.
4. Ready needs return immediately. If one concrete ambiguity remains, the
   result is `clarify` with two or three consequence-labelled choices; choosing
   one submits its attached needs through `SubmitRequirement` and makes no
   second model request. Only empty or off-topic input becomes `unclear`, with
   suggestions composed from the room's facets.

### What the sentence-reading step is told (2026-09-03)

Two families of sentence used to be read wrong by every model tried, which
made it a prompt problem rather than a model problem. The instructions in
`apps/server/src/nl/say.ts` now spell both out, in English and in German.

- **A question keeps its concepts.** Intent is about what the sentence does,
  not about whether anything was stated. "Is there anything vegan?" is an
  `ask` **and** returns the vegan concept, so the reply can answer the
  question while the need still counts. A room move — put forward, accept,
  veto, withdraw — is `act`. Server code still demotes `ask` to `need` when
  the words are not interrogative, so a stated noun phrase can never hide
  behind a question mark.
- **A kind of place is a kind, not a quality.** Any word for what sort of
  place or food is wanted — a cuisine, a dish, a class of venue — is a `kind`
  concept with its values lowercase, singular and in English. Alternatives are
  one concept with several values, and a value is never widened: sushi stays
  sushi.

Two mapping rules in `apps/server/src/nl/understand/map.ts` back this up.
Only distance, travel time and money may ask what unit a bare number meant, so
a stray quantity on an attribute no longer hijacks the sentence into "0 what?".
And a kind value counts as actionable when the room's own cuisine facet can
reach it through T3.6's sourced taxonomy, so "anything but pizza" becomes an
exclusion in a room that records Italian places, while "avoid sushi" still
asks when nothing on record is Japanese.

Measured over the 44 model-only rows of `tests/fixtures/nl-corpus.jsonl`,
three passes each on `z-ai/glm-5.3-flash` and one on `gpt-5.6-luna`:

| Model | Before | After |
|---|---|---|
| `z-ai/glm-5.3-flash` | 88 / 132 (66.7 %) | 125 / 132 (94.7 %) |
| `gpt-5.6-luna` | 37 / 44 (84.1 %) | 43 / 44 (97.7 %) |

An included kind the room's cuisines cannot reach becomes a text need phrased
for any class of place ("is this a … kind of place?"), so a cinema and a
cuisine read the same way; the judge answers it from the place's own pages.

## How it reaches the page

- `GET /api/meta` carries `nl: true` when the selected provider's key is set. Without it
  the composer keeps its label matching and no agent card ever appears; the
  app is fully usable.
- `POST /api/nl/say { text, scope }` — the composer, for Shared and Private.
  The page attaches one participant-scoped idempotency key to the whole turn;
  retries replay its completed response instead of re-running model actions.
  - `need` → `{ needs: [{ payload, label, topic?, gist, assumed? }] }`. The **page** submits
    each through `SubmitRequirement`, so revision discipline, the `{ }`
    drawer and every server check are the same as for a typed need. The
    `topic` the model read is returned but **not** attached as a
    `scopeHint.category`: disclosing a category is the owner's opt-in
    (FACETS.md §4), and the composer has no control for it yet.
  - `ask` / `act` → the participant agent runs as this participant and returns
    `{ reply, actions[], partial?, failureCategory? }`. Room changes arrive on
    the realtime channel like any commit; the reply lands as a **"Your agent"
    card** in the brief with a record row per move. Each mutation result is
    persisted as its own participant-private action row before the next model
    turn. If a later model/read step fails, completed actions still return,
    `partial: true` names the failure category, and the reply offers retry.
    There is no chat pane (SPOKES-UI §9).
  - `clarify` → `{ needs, clarify: { question, choices, allowFreeText, said } }`.
    The page submits `needs` immediately and asks only about the unresolved
    part. Choice payloads use the ordinary command path and never call a model.
  - `unclear` → a card saying what was heard, with three room-derived choices.
- `POST /api/nl/condition { text }` — the composer in **Agent only** scope.
  The condition is held in memory (`apps/server/src/nl/holder.ts`), never in
  a table or an event. The room receives a content-free agent-private
  declaration (no topic, for the same opt-in reason), and the
  agent screens whatever the council asks it to, batch after batch, on every
  commit in the room. A restart forgets held conditions; the declaration then
  stays pending (uncertain) until it is said again. Nothing is guessed.

## Deterministic time resolution

The shared EN/DE pre-parser and Stage A produce only civil-time fields: a day
reference, a day part, and/or a clock. Stage A never does relative-date or
offset arithmetic; raw model windows remain only as a compatibility fallback
for explicit calendar dates such as “on the 12th”. Stage B resolves the fields
from the request instant in the room area's IANA timezone, including DST.

A weekday means its next occurrence, including today while its window has not
ended. A clock already past today moves to tomorrow. The shared resolver owns
these windows (and generates the matching Stage A prompt text):

| Words | Local window |
|---|---|
| `lunch` | 12:00–14:00 |
| `dinner` | 18:00–21:00 |
| `brunch` | 10:00–13:00 |
| `evening` | 18:00–21:00 |
| `tonight` | today, 18:00–23:00 |
| `morning` | 08:00–11:00 |
| `afternoon` | 14:00–17:00 |
| `night` | 20:00–24:00 |
| `late` | 22:00–02:00 next day |
| `at 7pm` | 18:00–20:00 (the stated time ±1 hour) |
| `open now` | the captured clock through two hours later |

A bare day spans 09:00–23:00. Both server and offline composer call the same
resolver and preserve the person's words as `phrase`; the client derives the
timezone from the room area's shared registry entry, never the browser zone.

## What the participant agent can and cannot do

- Runs as the participant's own actor: every read is their view, so peers'
  private content never reaches it (it gets counts, like the page).
- Tool catalog: the registered WebMCP tools minus `sync_session` (it gets a
  room snapshot up front) and `focus_destination` (page-local). `baseRevision`
  is the revision of the snapshot/read the model actually saw. A
  `sync_required` result returns to the next model round; the runtime never
  silently retries old arguments at the live room revision. Only one mutation
  executes per model round.
- Cannot commit or confirm: `CommitAgreement` and `ConfirmPrivateRequest`
  have no tool route here either. The human's page gesture stays the only
  path (INTERACTION-AND-BINDING.md §5.4).
- `inspect_candidates` has an optional `intent: "open"`. With it, the tool
  returns the cached dossier immediately and streams the bounded priority-zero
  site, image, adjudication and optional Parallel-turbo search continuation
  through `facts` frames.
- One agent turn has a total deadline of about 90 seconds, including its
  initial snapshot, requested reads and every model call. Each call receives
  only the remaining budget. The loop is capped at four model rounds and at
  most one mutating call executes per round; later mutations in the same
  batch return a structured refusal for the next round to reconsider.
- Tool results are compacted as data before serialization. They always remain
  valid JSON within the model-input budget and carry
  `{ "truncated": true, "omitted": { … } }` when fields or rows were left
  out. Replies remain capped at 320 characters and follow COPY.md (second
  person, no exclamation marks, no tool names).
- Private screening submits the dossier's room revision and each candidate's
  `mapRevision`. If facts land while the model is judging, its write receives
  `sync_required`; the runtime does not query a fresh revision and bless the
  old verdict.
- A failed or partial `ask`/`act` is never reinterpreted by the composer as a
  new need. The original text stays in the input and the page offers retry,
  because an earlier action from that same turn may already be committed.

## What the drawer shows

Every routed sentence logs its intent, model and milliseconds to the `{ }`
drawer (`agent routed "need" (z-ai/glm-5.3-flash 1200ms)`), and a held condition
logs that it is held. The reply cards in the brief carry none of that.

## Verification

- `tests/api/staging.test.ts` covers the readiness change that came with this
  session (accepting marks you ready) and the viewing presence frame.
- Scripted API tests cover stale revisions, partial action persistence, total
  deadline consumption and the one-mutation-per-round rule. Unit tests cover
  valid structural result compaction and retry disposition. The transport is
  swappable through `setTransport` in `nl/llm.ts`; `nl/openai.ts` is a thin
  compatibility re-export.
