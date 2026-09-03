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

Four jobs, two model tiers, one rule for choosing between them.

| Job | Where | Tier | Why this tier |
|---|---|---|---|
| Route a composer sentence: need / ask / act / unclear, and turn a need into typed payloads | `apps/server/src/nl/say.ts` | fast (`gpt-5.6-luna`) | bounded, schema-shaped, must feel like typing. A strict JSON schema is the whole output; every payload is re-validated by the server's Ajv pass like a hand-typed one. |
| Infer still-unknown place attributes from supplied evidence spans | `apps/server/src/enrich/infer.ts` | fast (`gpt-5.6-luna`) | bounded extraction over a closed key set. The server validates the quoted span, clamps confidence below verification and drops unsupported claims. |
| Adjudicate one likely evidence span in its nearby context | `apps/server/src/enrich/adjudicate.ts` | fast (`gpt-5.6-luna`) | focused strict-schema reread, about 1,500 input tokens and a two-second timeout. Server-side publisher and quote validation are the authority; every result uses the existing monotonic merge and room model bucket. |
| Refine uncertain active needs from site text and cited web search | `apps/server/src/refine/worker.ts`, `apps/server/src/pipeline/stages/*` | fast (`gpt-5.6-luna`) | fetch work is always admitted independently of place/criterion judge cells; the matrix batcher closes at 8 places × 5 criteria or 300 ms (0 ms for interactive work). The default split search uses one request per unresolved place plus one cited-snippet matrix; optional combined search returns one strictly validated row per place. |
| Act on the room or answer a question about it | `apps/server/src/nl/agent.ts` | smart (`gpt-5.6-sol`) | open-ended: read state, weigh, call tools, explain. A wrong move changes a shared room. |
| Screen places against an agent-private condition | `apps/server/src/nl/screening.ts` | smart | judging evidence against a person's private condition is where a wrong call costs most — a place wrongly ruled out never comes back. Told to prefer `needs_info` over a guess. |

**The rule.** The fast tier does anything that is bounded and latency-bound:
a sentence in, a schema out, no tools, no room state changed. The smart tier
does anything that acts through tools, judges private content against
evidence, or answers over the room's state. Cost is never the deciding axis;
the shape of the job is. Models are configurable (`NL_FAST_MODEL`,
`NL_SMART_MODEL`), the split is not.

## How it reaches the page

- `GET /api/meta` carries `nl: true` when `OPENAI_API_KEY` is set. Without it
  the composer keeps its label matching and no agent card ever appears; the
  app is fully usable.
- `POST /api/nl/say { text, scope }` — the composer, for Shared and Private.
  The page attaches one participant-scoped idempotency key to the whole turn;
  retries replay its completed response instead of re-running model actions.
  - `need` → `{ needs: [{ payload, topic?, gist }] }`. The **page** submits
    each through `SubmitRequirement`, so revision discipline, the `{ }`
    drawer and every server check are the same as for a typed need. The
    `topic` the fast tier read is returned but **not** attached as a
    `scopeHint.category`: disclosing a category is the owner's opt-in
    (FACETS.md §4), and the composer has no control for it yet.
  - `ask` / `act` → the smart tier runs as this participant and returns
    `{ reply, actions[], partial?, failureCategory? }`. Room changes arrive on
    the realtime channel like any commit; the reply lands as a **"Your agent"
    card** in the brief with a record row per move. Each mutation result is
    persisted as its own participant-private action row before the next model
    turn. If a later model/read step fails, completed actions still return,
    `partial: true` names the failure category, and the reply offers retry.
    There is no chat pane (SPOKES-UI §9).
  - `unclear` → a card saying what would help.
- `POST /api/nl/condition { text }` — the composer in **Agent only** scope.
  The condition is held in memory (`apps/server/src/nl/holder.ts`), never in
  a table or an event. The room receives a content-free agent-private
  declaration (no topic, for the same opt-in reason), and the
  agent screens whatever the council asks it to, batch after batch, on every
  commit in the room. A restart forgets held conditions; the declaration then
  stays pending (uncertain) until it is said again. Nothing is guessed.

## Time resolution in the fast tier

The router receives the room area's IANA timezone and the current local
date/time with that area's numeric UTC offset. The request clock is captured
when `say` runs; the area's `areaId` resolves through the area registry to its
timezone. The model therefore has an explicit civil-date anchor and does not
invent timestamps without time words from the person.

A date word selects a civil date: `today`, `tomorrow`, or the next occurrence
on or after today of a named weekday. It combines with these fixed windows:

| Words | Local window |
|---|---|
| `lunch` | 12:00–14:00 |
| `dinner` | 18:00–21:00 |
| `brunch` | 10:00–13:00 |
| `evening` | 18:00–21:00 |
| `tonight` | today, 18:00–23:00 |
| `at 7pm` | 18:00–20:00 (the stated time ±1 hour) |
| `open now` | the captured clock through two hours later |

A bare date or weekday spans local 00:00 through the next civil day's 00:00.
The strict result schema carries a concrete `{ start, end }` window plus the
person's actual phrase. Both endpoints must be parseable ISO-8601 date-times
with the area's numeric offset and `end > start`; the server drops a malformed
time need instead of turning it into free text.

The client does not parse natural-language dates, weekdays, meals, or clock
times. When the fast tier is unavailable, its one exact time fallback is
`open now`, which becomes the browser's current instant through two hours
later with the typed words preserved as `phrase`. Every other time sentence
uses the existing honest `text` fallback.

## What the smart tier can and cannot do

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
  site, image, adjudication and optional Parallel-fast search continuation
  through `facts` frames.
- One agent turn has a total deadline of about 60 seconds, including its
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
drawer (`agent routed "need" (gpt-5.6-luna 1200ms)`), and a held condition
logs that it is held. The reply cards in the brief carry none of that.

## Verification

- `tests/api/staging.test.ts` covers the readiness change that came with this
  session (accepting marks you ready) and the viewing presence frame.
- Scripted API tests cover stale revisions, partial action persistence, total
  deadline consumption and the one-mutation-per-round rule. Unit tests cover
  valid structural result compaction and retry disposition. The transport is
  swappable through `setTransport` in `nl/openai.ts`.
