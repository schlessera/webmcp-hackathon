# Spokes redesign — session handoff

Written 2026-09-01, at the end of the session that landed the mapview
redesign. Read this before continuing that work. Companion docs: root
`CLAUDE.md` (invariants), `apps/web/SPOKES-UI.md`, `apps/web/COPY.md`,
`apps/server/FACETS.md`, `docs/design/HANDOFF.md`, `docs/PROJECT-STATUS.md`.

## What landed (four commits on main)

| Commit | What |
|---|---|
| `2b8657e` | Self-hosted fonts: Bricolage Grotesque + IBM Plex Mono variable woff2 subsets + OFL licenses in `apps/web/public/fonts/` |
| `52a6c9b` | Server: the full FACETS.md contract — `facets`, `activeNeeds` (ruledOut / wouldReturn / unknown), `privateEffects`, participant roster, per-person public stances, `SetRequirementActive` + `requirements.active` (migration 005), `text` predicate, `excludeRequirementId` preview on `/api/spatial/context`, live-recomputed `walkMin`, `TOOL_CONTRACT_VERSION` 1→2 |
| `47a4943` | Fixes from an independent gpt-5.6-sol review: impasse council reads the classifier's snapshot; toggling a need aside expires its open relaxation offers (and grants against inactive needs are refused); `candidates.price_level` nullable (migration 006) |
| `1bbd65a` | Client rebuilt to the redesign: new shell (header/map band/brief/composer), sticker map with 420ms settle and no re-centring, data-driven brief with toggle + press-and-hold preview, composer with facet pills, place details, consent rungs, `{ }` drawer, flow states. Old tabs/sheet/panels deleted. |

State: `pnpm typecheck` clean, `pnpm test:unit` 71/71, `pnpm test:api` 67/67,
`vite build` ok. **The four e2e specs in `tests/e2e/` are stale by design**
(they bind to the deleted DOM) — rewriting them is the next phase.

## Locked decisions (user-approved; do not relitigate)

- **D1 — privacy relaxation.** The server now discloses a participant roster
  and per-person PUBLIC stances. Private need *content* (predicate, values,
  notes, affected place ids) still never reaches peers on any path; a private
  stance reads `"none"`, identical to silence; `vetoStands` stays aggregate.
  `privateEffects` carries owner id + ruledOut count + opt-in `topic` from
  `scope_hint.category` — sanctioned by CLAUDE.md invariant 5 / FACETS.md §4.
- **D2 — trim to spec.** Commit celebration, map legend, hover scaling,
  proposal pulse, scope tween, veto reason picker, success toasts, in-chrome
  phase/feasibility chips: deleted, do not resurrect. Ready toggle kept
  (restyled) because the phase machine needs it.
- **D3 — commit per phase on main**, only when that phase's tests pass.
- Commit trailer policy: `Claude-Session` link yes, no co-author lines.

## Orchestrator rulings that bind future work

- Map band rules are 1.5px (mockups drew 1px; CLAUDE.md wins).
- Allowed animations: `spoke-pop`, the 420ms settle, `spoke-breathe`.
  Reduced motion zeroes all three.
- Colour literals may exist ONLY in `tokens.css` and `apps/web/src/map-theme.ts`
  (GL paint can't read CSS vars; every literal there is comment-paired to its
  token). The favicon data-URI in `index.html` is the third documented spot.
- Facet keys stay kebab-case `ATTRIBUTE_VOCABULARY` keys; `label` humanizes.
  Key→label table: `ATTRIBUTE_LABELS` in `packages/contracts/src/manifest.ts`.
- Composer free text: facet-label match → attribute need; "€N" → budget;
  "N min" → walk scope; anything else → `text` predicate (pending for every
  place, rules out nothing). No other client-side parsing.
- Verdict strip wording: "Clears every need the room has stated".
- `total` = in-scope count (the "of N"); `matching` = eligible count;
  candidates array still carries every place so leavers fade in place.

## Key wire facts (client relies on these)

- `matching === feasibility.eligible`; never compute a second count.
- `total ≠ candidates.length`; count against `total`, draw everything.
- `walkMin` moves with the scope centre — never cache across scope changes.
- `priceLevel: number|null`; summaries carry the 1–4 band, UI maps it through
  `PRICE_LEVEL_EUR`. Null renders as unknown.
- Press-and-hold: `POST /api/spatial/context {excludeRequirementId}`;
  `preview.matching − live.matching === wouldReturn` exactly (test-pinned).
  Peer/unknown ids both fail with identical `not_found` (existence oracle).
- Agent tool results (`trimContext` in `apps/web/src/webmcp.ts`) deliberately
  exclude facets/activeNeeds/roster (1.5K result budget).
- Demo counterfactual numbers are pinned in `tests/unit/facets.test.ts` and
  the "Demo numbers" table of the (session-local) P1 report; at 800 m the demo
  set gives total 21, matching 0, Joe's lactose need ruledOut 2 / wouldReturn
  11, peers see `privateEffects: [{owner: p_joe, ruledOut: 2}]`.

## Known gaps / deferred (next session's menu)

1. **e2e rewrite (P4, first).** Full old/new/gone `data-testid` inventory and
   Playwright pitfalls (sticker overlap vs actionability; press-and-hold needs
   one-script `mouse.down/up`) are in `apps/web` P2 notes below. Worth
   asserting: preview arithmetic, Space-hold parity, marker transform
   unchanged across need submit/toggle (invariant 8), peer-brief privacy
   canary, reduced-motion zeroing, no domain word in chrome.
2. **Client not yet adversarially reviewed.** The server wave got a
   gpt-5.6-sol review (findings fixed in `47a4943`); commit `1bbd65a` has NOT
   had its independent review or a systematic visual pass against the mockup
   frames (`docs/design/Spokes - Mapview Redesign.dc.html`, frames 4a, 7a–7d,
   8a–8f, 9b). Run both before the demo video.
3. **Presence cursors + 7a invite card** — need wire support (who's looking /
   who arrived). Roster has `readyState` only.
4. **Digest actor chips (7d)** — `projection.ts` strips `actorName` from full
   payloads; digest rows are colourless until events carry a non-identifying
   `actorId`.
5. **Consent rung 2 numeric bound** — `OutstandingAdjustment` carries
   `withinDelegatedBound` boolean, not the number; copy says "beyond what you
   delegated" instead of the mockup's "beyond the 1.2 km you delegated".
6. **Late-join digest** keys off per-tab `sessionStorage`; exposing
   `participants.last_synced_revision` on `/api/sync` would make it exact.
7. **Agreed/arrival flow (7c) not browser-verified** — commands carried over
   verbatim and api-tested, but nobody has clicked through a full three-user
   propose→stance→stage→commit in the new UI.
8. **Dense-cluster tap targets**: at default zoom ~⅓ of markers have no
   exposed 44px hit point (overlaps); zoom resolves. If it matters for the
   demo: tighter initial fit or clustering — design decision first.
9. **Peer rows draw no toggle** (server is owner-only) — deviation from
   mockup 8e, deliberate.
10. **Composer maps the enum facet by `key === "cuisine"`**
    (`Composer.tsx`); branching on `facet.type === "enum"` instead would be
    cleaner protocol hygiene. Cosmetic.
11. **`docs/DEMO-RUNBOOK.md` and `docs/SUBMISSION.md` predate the redesign** —
    demo beats reference the old tab UI; re-walk before recording.
12. **ChatGPT WebMCP gate unchanged** (public deploy + origin-trial token +
    real ChatGPT run) — see PROJECT-STATUS "Planned next waves".

## Session-local artifacts (die with the session)

Full research + implementation reports lived in the session scratchpad
(`explore-web.md`, `explore-server.md`, `explore-mockup.md` — a 64KB
frame-by-frame extraction of the mockup HTML — `p1-server-report.md`,
`p2-client-report.md`, plus browser screenshots of every reached state). The
durable substance is distilled above; the mockup extraction is regenerable
from `docs/design/Spokes - Mapview Redesign.dc.html` with an Explore agent.

## How to verify what ships

```sh
pnpm typecheck && pnpm test:unit
docker compose up -d --wait db && pnpm test:api   # migrations 005/006 needed: make update for image-based stacks
sudo -n make update                                # full demo stack on 4173 after a pull
node scripts/open-participants.mjs                 # three isolated participant windows
```

Contract bookkeeping if you touch result shapes: update `RESULT_CONTRACT` in
`packages/contracts/src/hash.ts`, run
`pnpm --filter @webmcp-hackathon/contracts generate:manifest`, and know that a
`TOOL_CONTRACT_VERSION` bump force-reloads every open page.
