# Spokes redesign — session handoff

Written 2026-09-01, updated 2026-09-02 at the end of the session that closed
the redesign's open menu. Read this before continuing that work. Companion
docs: root `CLAUDE.md` (invariants), `apps/web/SPOKES-UI.md`, `apps/web/COPY.md`,
`apps/server/FACETS.md`, `docs/design/HANDOFF.md`, `docs/PROJECT-STATUS.md`,
`docs/DEMO-RUNBOOK.md` (re-walked to the new UI).

## What landed

### Session 1 (2026-09-01) — the redesign

| Commit | What |
|---|---|
| `2b8657e` | Self-hosted fonts: Bricolage Grotesque + IBM Plex Mono variable woff2 subsets + OFL licenses in `apps/web/public/fonts/` |
| `52a6c9b` | Server: the full FACETS.md contract — `facets`, `activeNeeds` (ruledOut / wouldReturn / unknown), `privateEffects`, participant roster, per-person public stances, `SetRequirementActive` + `requirements.active` (migration 005), `text` predicate, `excludeRequirementId` preview on `/api/spatial/context`, live-recomputed `walkMin`, `TOOL_CONTRACT_VERSION` 1→2 |
| `47a4943` | Fixes from an independent gpt-5.6-sol review: impasse council reads the classifier's snapshot; toggling a need aside expires its open relaxation offers (and grants against inactive needs are refused); `candidates.price_level` nullable (migration 006) |
| `1bbd65a` | Client rebuilt to the redesign: new shell (header/map band/brief/composer), sticker map with 420ms settle and no re-centring, data-driven brief with toggle + press-and-hold preview, composer with facet pills, place details, consent rungs, `{ }` drawer, flow states. Old tabs/sheet/panels deleted. |

### Session 2 (2026-09-01/02) — the open menu, all items except 12

| Commit | What |
|---|---|
| `5d9f709` | Six client review findings (gpt-5.6-sol, then gpt-5.5 on the same commit): staged ≠ settled; zero-with-unknowns is `pending`, not impasse; scope-centre change refits (§8 exception); `.need-row` touch-action pan-y; PlanArrival keeps the pickup note; away digest bounded above |
| `794184f` | Wire: roster `arrived` + `present`, `presence` realtime message, `ProjectedEvent.actorId` at full level only, `OutstandingAdjustmentRequest.delegatedBound`, `SyncSessionResult.lastSyncedRevision`; migration 007 `participants.arrived_at`. Client: idle avatars until arrival, presence mark, 7a "haven't arrived" card, digest author chips, consent copy names the bound, composer branches on facet type |
| `0e1dcdb` | Dense clusters: a name card never buries a neighbour's dot; a tap resolves to the nearest dot unless it landed on a drawn card |
| `a3110c0`, `2dff3c4` | The four e2e specs rewritten against the new DOM (gpt-5.6-sol, hardened against an Opus review), 7 passing |
| `0d1602b` | The away state ends with the user's first own move |
| `55586e4` | `docs/DEMO-RUNBOOK.md` and `docs/SUBMISSION.md` re-walked to the new UI; counts recomputed from the engine |
| `7478a36` | Visual-pass findings (gpt-5.6-sol computer-use against the mockup frames + a three-user click-through): late-join digest for a tab that first saw revision 0; outstanding list refreshes on council/consent events; stale widening drafts expire on regeneration; declared impasse wins over `pending`; new cards scroll the brief to the top; no wire vocabulary in the record; settled record leads the brief; set-aside row contrast; arrival link tap targets; pills on one line |

State: `pnpm typecheck` clean, `pnpm test:unit` 72/72, `pnpm test:api` 73/73,
`pnpm test:e2e` 7/7, `vite build` ok. `TOOL_CONTRACT_VERSION` is still 2 —
every wire change this session was additive; the manifest hash was regenerated.

## Locked decisions (user-approved; do not relitigate)

- **D1 — privacy relaxation.** The server discloses a participant roster and
  per-person PUBLIC stances. Private need *content* (predicate, values, notes,
  affected place ids) never reaches peers on any path; a private stance reads
  `"none"`, identical to silence; `vetoStands` stays aggregate. `privateEffects`
  carries owner id + ruledOut count + opt-in `topic` from `scope_hint.category`.
  `ProjectedEvent.actorId` follows the same line: present only on `full`-level
  rows, never on the existence/aggregate rows peers get for a private move.
- **D2 — trim to spec.** Commit celebration, map legend, hover scaling,
  proposal pulse, scope tween, veto reason picker, success toasts, in-chrome
  phase/feasibility chips: deleted, do not resurrect. Ready toggle kept
  (restyled) because the phase machine needs it.
- **D3 — commit per phase on main**, only when that phase's tests pass.
- **D4 — presence = arrived + looking, no cursors.** `arrived` is durable
  (first sync on any surface, `participants.arrived_at`); `present` is an open
  realtime socket (in-memory `presence.ts`, single-process). The 4a/8c map
  cursor with a name tab is NOT built; the header avatar carries a small ink
  mark while a person is looking. *Extended 2026-09-02:* the presence frame
  also carries `viewing` (who has which place open, from the page's `viewing`
  socket message), drawn as initials peeking from behind that place's sticker.
- **D5 — dense clusters: every dot stays tappable; no re-fit, no clustering.**
- **D6 — consent bound is exposed only where one exists** (`delegatedBound`
  on the outstanding request, from the targeted need's own `delegation.bound`).
  Scope changes carry none: organizer scope authority has no delegated bound,
  so radius cards keep "beyond what you delegated".
- Commit trailer policy: `Claude-Session` link yes, no co-author lines.

## Orchestrator rulings that bind future work

- Map band rules are 1.5px (mockups drew 1px; CLAUDE.md wins).
- Allowed animations: `spoke-pop`, the 420ms settle, `spoke-breathe`.
  Reduced motion zeroes all three (e2e-pinned with a positive control).
- Colour literals may exist ONLY in `tokens.css` and `apps/web/src/map-theme.ts`
  (GL paint can't read CSS vars; every literal there is comment-paired to its
  token). The favicon data-URI in `index.html` is the third documented spot.
- Facet keys stay kebab-case `ATTRIBUTE_VOCABULARY` keys; `label` humanizes.
  Key→label table: `ATTRIBUTE_LABELS` in `packages/contracts/src/manifest.ts`.
- Composer free text: facet-label match → attribute need (only for facets the
  server typed boolean); "€N" → budget; "N min" → walk scope; anything else →
  `text` predicate (pending for every place, rules out nothing). A pill for a
  facet typed `enum` becomes an exclusion on that facet's key. No other
  client-side parsing.
- Verdict strip wording: "Clears every need the room has stated".
- `total` = in-scope count (the "of N"); `matching` = eligible count;
  candidates array still carries every place so leavers fade in place.
- Count block states: `pre` (nothing stated), `works`, `pending` (matching 0
  with unknowns and no declared impasse), `impasse` (declared by the council,
  or matching 0 with nothing unsure), `settled`. In the impasse state the
  subline still counts the unknowns: "of 21 · 6 unsure · two needs collide".
- "Settled" means a COMMITTED agreement. A staged one keeps the composer and
  shows the "X is staged" card; the header stays on the wordmark.
- The record (digest and history) never shows wire vocabulary: readiness,
  bookkeeping and screening events are filtered (`DIGEST_NOISE`), and
  settle/stage/impasse rows are phrased in `recordText()`.
- The away span: `since` = max(tab floor, server `lastSyncedRevision`), `until`
  = revision on this load's first sync; `lastSyncedRevision` is `null` for a
  first arrival and 0 is a real floor. The span ends with the user's first
  own command.

## Key wire facts (client relies on these)

- `matching === feasibility.eligible`; never compute a second count.
- `total ≠ candidates.length`; count against `total`, draw everything.
- `walkMin` moves with the scope centre — never cache across scope changes.
- `priceLevel: number|null`; summaries carry the 1–4 band, UI maps it through
  `PRICE_LEVEL_EUR`. Null renders as unknown.
- Press-and-hold: `POST /api/spatial/context {excludeRequirementId}`;
  `preview.matching − live.matching === wouldReturn` exactly (pinned at unit
  level and now end to end against the real server, by pointer and by Space,
  on own and on peer rows). Peer/unknown ids both fail with identical
  `not_found` (existence oracle).
- Roster (`participants[]` on both read paths): `participantId, displayName,
  role, readyState, arrived, present` — exactly these six keys (api-pinned).
  Organizer first, then id order. The `presence` frame `{type, present: ids[]}`
  reaches a socket on auth and the room when the set changes; the client
  answers it with a context refetch (the roster is server truth).
- The outstanding list travels only on sync and command results. The client
  catches up on any event in `OUTSTANDING_EVENTS` (App.tsx) so a peer's or the
  council's move can put a card on this page live.
- Council drafts: on regeneration under a standing impasse, open (`proposed`)
  adjustments the fresh pass no longer produces expire; staged grants are left
  alone; denied keys stay suppressed.
- Agent tool results (`trimContext` in `apps/web/src/webmcp.ts`) deliberately
  exclude facets/activeNeeds/roster (1.5K result budget).
- Demo counterfactual numbers are pinned in `tests/unit/facets.test.ts`; at
  800 m the demo set gives total 21, matching 0, Joe's lactose need ruledOut 2
  / wouldReturn 11, peers see `privateEffects: [{owner: p_joe, ruledOut: 2}]`.
  Price bands in scope: 8 places at €10, 12 at €15, 1 at €40 (a €9 budget is
  infeasible alone and relaxes to €10 — `tests/api/delegated-bound.test.ts`).

## Known gaps / deferred (next session's menu)

1. **Desktop layout (mockup 8c) is a thin adaptation**, not the frame: a
   319px rail and a wide map, count block still on the map, no pushed details
   panel, no chat column. Nobody has decided what desktop is for. Design
   decision first.
2. **Agreed map (7c) draws no route and no origin marker** and does not focus
   the destination; the candidate map simply stays. Needs a route source (the
   navigation links are provider deep links, no geometry).
3. **Place details (8a)** has no photo band and no "works for all N" pill.
   *2026-09-02:* the panel was redrawn — "Does it fit" ledger with the map's
   dot marks, "Also on record" as pills with unknowns counted, one sources
   line, peers' private effects as rows, "looking now" on stance rows.
4. **`{ }` drawer (8b)** is a full-screen takeover without the Wire / Tools /
   Session tabs; the raw candidates dump is long. Deliberately small and
   unstyled per CLAUDE.md §6, but the mockup's slide-over at 232px with the
   dimmed map behind is the better shape.
5. **Exclusion needs are unreachable from the page without an agent.** Pills
   render boolean facets only, so the enum (`cuisine`) pill never appears and
   the composer's enum branch is dead. *2026-09-02:* with `OPENAI_API_KEY`
   set, the in-page agent (`docs/NL-AGENT.md`) turns "no Italian" into an
   exclusion; without it, free text still becomes a `text` predicate. The
   contract still pins `exclusion.key` to the literal `"cuisine"`
   (`packages/contracts/src/commands.ts`) — a domain word on the wire; FACETS.md
   should decide whether exclusions generalise to any enum facet.
6. **Person colours reuse the semantic hexes** (`--spoke-person-1..5` =
   works/unsure/scope/act/…); `--spoke-person-4` is woad, which puts
   `--spoke-act`'s colour on a fourth participant's avatar (invariant 2).
   Rooms so far have three people. Pick a fifth-family hue or reorder before a
   4+ person room ships.
7. **Attribution links are 7px and have no 44px target** — invariant 11 says
   attribution never grows; invariant 13 says targets are 44px. Unresolved
   contradiction; left as is.
8. **Peer rows draw no toggle** (server is owner-only) — deviation from
   mockup 8e, deliberate.
9. **Idle grey does double duty** in the mockup (not arrived in the header;
   "hasn't said" in the details stance list). Live uses it only for not
   arrived.
10. **Presence is single-process** (`presence.ts` is an in-memory map). A
    multi-instance deploy needs a shared store or sticky sessions.
11. **"Send the link" (7a) is not built**: invite secrets are minted per person
    and never come back to the page. Needs an organizer-only endpoint that
    mints a fresh secret if the button should exist.
12. **ChatGPT WebMCP gate unchanged** (public deploy + origin-trial token +
    real ChatGPT run) — see PROJECT-STATUS "Planned next waves".

## Session-local artifacts (die with the session)

Research and reports lived in the session scratchpad: `explore-e2e.md` (DOM
inventory used for the e2e rewrite), `explore-wire.md`, `explore-mockup.md` (a
29KB frame-by-frame extraction of the mockup HTML), the two client review
reports, the Opus e2e review (22 findings, all addressed), the docs re-walk
report, and the codex visual pass (`codex-visual/report.md` with 40+ mockup
vs live comparison screenshots). The durable substance is distilled above; the
mockup extraction is regenerable from
`docs/design/Spokes - Mapview Redesign.dc.html` with an Explore agent.

Operational note: `codex exec -s workspace-write` cannot bind ports here, so
anything that must run the e2e or api lanes needs `-s danger-full-access`.

## How to verify what ships

```sh
pnpm typecheck && pnpm test:unit
docker compose up -d --wait db && pnpm test:api   # migrations 005–007 needed: make update for image-based stacks
pnpm test:e2e                                      # 7 tests, ~30 s, spawns its own servers on 43173/43174/5190
sudo -n make update                                # full demo stack on 4173 after a pull
node scripts/open-participants.mjs                 # three isolated participant windows
node scripts/record-demo.mjs                       # three paced recordings + beats.log (rewritten for the new UI)
```

Contract bookkeeping if you touch result shapes: update `RESULT_CONTRACT` in
`packages/contracts/src/hash.ts`, run
`pnpm --filter @webmcp-hackathon/contracts generate:manifest`, and know that a
`TOOL_CONTRACT_VERSION` bump force-reloads every open page.
