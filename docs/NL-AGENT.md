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
  - `need` → `{ needs: [{ payload, topic?, gist }] }`. The **page** submits
    each through `SubmitRequirement`, so revision discipline, the `{ }`
    drawer and every server check are the same as for a typed need. The
    `topic` the fast tier read is returned but **not** attached as a
    `scopeHint.category`: disclosing a category is the owner's opt-in
    (FACETS.md §4), and the composer has no control for it yet.
  - `ask` / `act` → the smart tier runs as this participant and returns
    `{ reply, actions[] }`. Room changes arrive on the realtime channel like
    any commit; the reply lands as a **"Your agent" card** in the brief with
    a record row per move. There is no chat pane (SPOKES-UI §9).
  - `unclear` → a card saying what would help.
- `POST /api/nl/condition { text }` — the composer in **Agent only** scope.
  The condition is held in memory (`apps/server/src/nl/holder.ts`), never in
  a table or an event. The room receives a content-free agent-private
  declaration (no topic, for the same opt-in reason), and the
  agent screens whatever the council asks it to, batch after batch, on every
  commit in the room. A restart forgets held conditions; the declaration then
  stays pending (uncertain) until it is said again. Nothing is guessed.

## What the smart tier can and cannot do

- Runs as the participant's own actor: every read is their view, so peers'
  private content never reaches it (it gets counts, like the page).
- Tool catalog: the registered WebMCP tools minus `sync_session` (it gets a
  room snapshot up front) and `focus_destination` (page-local). `baseRevision`
  is injected server-side from the live room; one `sync_required` is retried.
- Cannot commit or confirm: `CommitAgreement` and `ConfirmPrivateRequest`
  have no tool route here either. The human's page gesture stays the only
  path (INTERACTION-AND-BINDING.md §5.4).
- Eight tool rounds, 45 s per turn, reply capped at 320 characters, phrased
  by COPY.md rules (second person, no exclamation marks, no tool names).

## What the drawer shows

Every routed sentence logs its intent, model and milliseconds to the `{ }`
drawer (`agent routed "need" (gpt-5.6-luna 1200ms)`), and a held condition
logs that it is held. The reply cards in the brief carry none of that.

## Verification

- `tests/api/staging.test.ts` covers the readiness change that came with this
  session (accepting marks you ready) and the viewing presence frame.
- The NL routes are exercised live (`OPENAI_API_KEY` in the environment,
  `make demo`), not in the test lanes: the transport is swappable
  (`setTransport` in `nl/openai.ts`) for anyone who wants scripted tests.
