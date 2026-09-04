# Plan: production onboarding, multi-step rooms, and invite links

Branch `wave4/onboarding`. Written and built 2026-09-04. This is the working
spec for the wave; when it and the code disagree, fix one of them in the same
commit.

**Status: built.** Everything in §3–§7b is implemented and covered by
`tests/api/steps.test.ts`, `tests/api/invites.test.ts`,
`tests/api/plans.test.ts`, `tests/e2e/onboarding.spec.ts` and the rewritten
goal tests in `tests/e2e/landing.spec.ts`. The one thing §4.2 left open —
whether to filter reads by step or retire rows — resolved to **P**: candidate
rows carry a `step_id`, and the rule for which are live is written once in
`apps/server/src/live-pool.ts`. Nothing is deleted when a step settles, so a
settled step keeps its place, its enrichment and its history.

Reads on top of: `docs/NL-AGENT.md` §"Reading a goal before the room exists"
(D1, the one-step half this wave completes), `CLAUDE.md` (UI invariants),
`apps/web/COPY.md`, `docs/protocols/NEGOTIATION-PROTOCOL.md` §7.1 (phases).

---

## 1. What the wave delivers

Today a room opens from one screen: pick an area, type a sentence, name up to
five people, get five invite links. The area comes first, the sentence becomes
**one** step, and everyone who will ever be in the room is named before it
exists.

After this wave:

1. **Onboarding is three screens**, in the order a product would ask:
   who you are and what you are trying to do → what that decomposes into →
   (hackathon-only) which of the two demo regions.
2. **A goal becomes one or more steps.** "Dinner then the new MCU film" is two.
   The room runs step 1, and when step 1 is agreed, step 2 activates with its
   own pool, anchored near the place step 1 settled on.
3. **Participants arrive after the room does.** The organizer opens alone, and
   a `+` beside their avatar mints a share link and a QR code. Links are
   single-use, bind to the device that claims them, and expire in an hour
   unused.
4. **A joiner sees what they are joining** before they enter: the goal, who
   started it, how many are in. Then they enter a name, as a guest.

Non-goals for this wave, stated so nobody has to guess:

- Accounts. The join screen shows a disabled "Log in" with a note saying the
  demo has none.
- Research steps as a distinct concept (D4). "Test and buy a new iPhone"
  becomes a shop step plus needs like "stocks the iPhone 17"; the existing
  lookup/attestation machinery resolves them per place. No new step kind.
- World-wide data. Two regions, and the dialog says so in the product's own
  voice.
- `room_demo` changes. It stays exactly as seeded.

---

## 2. Decisions taken (do not relitigate without asking)

- **D1 — full multi-step rooms.** Steps are real: their own pool, their own
  active needs, their own settled place. Not a cosmetic list.
- **D2 — planning is area-agnostic.** The plan screen names classes without
  counts. The area dialog then shows, per area, what those planned classes
  would find there — which is the information that makes the choice mean
  something. (In the real product this screen would assume the organizer's
  location; the dialog exists only because the demo is bounded to two
  extracts.)
- **D3 — invite links.**
  - Every `+` mints a new link; previously minted, still-unused links keep
    working.
  - An unused link expires **1 hour** after minting. Not configurable.
  - A claimed link keeps working **for the device that claimed it**, forever.
  - Opening a claimed link on another device is refused **without naming
    anyone**: "This link is already in use. Ask for a new one."
  - The organizer's `+` dialog lists the links minted for this room and
    whether each is unused, claimed, or expired.
- **D4 — research is needs, not a new step kind.** See §1 non-goals.

---

## 3. Screens

### 3.1 Start — "Who are you, and what are you trying to do?"

Replaces the top half of `apps/web/src/components/Start.tsx`. No area picker,
no member names.

- One name field (yours). Persisted to `localStorage` so a returning organizer
  is not asked twice.
- One goal field, multi-line, with the published examples as placeholder
  rotation — the same three strings that appear in the WebMCP tool description
  and in this document (§8).
- Continue is enabled when both are non-empty.

### 3.2 Plan — "Here is what that takes"

- Calls `POST /api/plans/preview` with `{ goal }` and no `areaId`.
- Renders one **step box** per returned step, in order, each showing:
  the step's title, the class of place ("a cinema"), the needs the sentence
  already stated as pending rows the organizer can drop, the time phrase if
  one was stated, and — for steps after the first — the relation to the step
  before it ("after dinner, near there").
- A step's class is changeable from the server's class table (a `<select>`,
  same control D1 shipped). A step can be removed. Steps can be reordered only
  by removing and re-adding — no drag.
- **Clarifying questions** arrive as `clarify` on the preview: a question and
  choices. Choices are now **multi-select** (`Clarification.mode`), rendered as
  a checkbox set with a free-text fallback, and answering re-previews with the
  chosen needs retained. This is the AskUserQuestion-shaped tool surface the
  planner uses when a goal is under-determined.
- Confirm opens §3.3.

### 3.3 Region — the hackathon dialog

A modal that does not pretend to be product. Its precedent is the `{ }` wire
drawer (`apps/web/src/components/Drawer.tsx`): deliberately plainer than the
app around it, so it reads as an instrument rather than a feature.

- One paragraph, in the product's voice, saying that world-wide venue data is
  a cost and licensing problem this demo does not solve, so it is bounded to
  two prepared extracts.
- Two cards, Berlin Mitte and San Francisco SoMa. Each shows, for **the classes
  this plan actually needs**, how many places are on record, plus the area's
  measured fact coverage and the as-of date — all from `GET /api/areas`,
  never typed into the component.
- Picking one creates the room and enters it.

### 3.4 Room — organizer alone, plus `+`

`apps/web/src/components/Header.tsx`. The avatar row shows only the organizer.
Beside it, a `+` button (44px tap target, drawn smaller — CLAUDE.md §13).

### 3.5 Invite dialog

- The link, in full, selectable.
- Copy, and `navigator.share` where the browser has it (guarded; it is absent
  on most desktops and throws outside a user gesture).
- A QR of the same link, rendered as inline SVG from `qrcode-generator`
  (zero transitive dependencies), sized to stay scannable at the dialog's
  width and legible in both themes.
- The list of links minted for this room with their state.
- `+ new link` mints another.

### 3.6 Join

Reached at `#join=<secret>`, before any identity exists.

- What the room is for (the goal), who started it, how many are in, which
  area.
- "Log in" — disabled, with the note that the demo has no accounts.
- "Join as guest" — a name field, then in.

---

## 4. Server: multi-step rooms

### 4.1 Shape

`packages/contracts/src/steps.ts`:

```ts
export interface RoomStep {
  stepId: string;                       // "s1", "s2", "s3"
  title: string;                        // server-composed, never a client string
  placeClass: { key: string; label: string };
  /** Where this step sits in the sequence. */
  relation: { kind: "first" } | { kind: "then"; afterStepId: string };
  when: { start: string; end: string; phrase: string } | null;
  status: "pending" | "active" | "settled";
  /** Filled when the room commits an agreement on this step. */
  settled: { candidateId: string; name: string; lat: number; lng: number } | null;
  /** Needs the goal already stated, applied as the organizer's when the step
   * activates. Empty once applied. */
  pendingNeeds: Array<{ payload: Record<string, unknown> }>;
}
```

Stored on `rooms.steps jsonb not null default '[]'`, with
`rooms.active_step_id text`. A room with an empty `steps` array behaves exactly
as rooms do today — this is what keeps `room_demo` and every existing test
untouched.

### 4.2 Pool per step

**Chosen: `candidates.step_id`, with the rule written once.** A row with a
NULL `step_id` belongs to the room — every room that predates plans,
`room_demo` included — and a row with a step is live only while that step is
active. `apps/server/src/live-pool.ts` holds the two SQL fragments; they are
self-contained (they read the room's active step themselves) so they paste
into a query without disturbing its parameter numbering, and a query that
enumerates a pool without mentioning one of them is visibly a query that has
forgotten steps exist.

Ten sites enumerate a pool and carry the rule: `eligibility.ts` (the pool read
everything else derives from), `engine.ts` ×2, `outstanding.ts`,
`nl/holder.ts`, `pool-fill.ts` ×3, `enrich/listings.ts`, `server.ts`.

Lookups by a specific candidate id are mostly NOT filtered: if you hold the
id you hold the candidate, which is what keeps a settled step's committed
place readable in the header and its proposal row intact. Two exceptions,
both deliberate:

- **`ProposeDestination` IS filtered.** A page holding ids from a settled
  step must not be able to propose one, because committing it would settle
  the current step with the previous step's place and centre everything
  after it on the wrong point.
- **`EvaluateCandidates` is NOT.** An agent may be answering for a place that
  settled while it was screening, and refusing that verdict would turn a race
  into an error. Recording it is harmless: eligibility only reads the live
  pool.

New rows never carry a step from their caller. `insertCandidateSeeds` reads
it from the room, so a background fill or a participant addition cannot write
a step-less row — which would be live for *every* step — into a room that has
one.

The invariant: **the room's live pool is the active step's pool, and a settled
step keeps its chosen place, not its losers.** Nothing is deleted; there are no
foreign keys onto `candidates.id`, so a step's rows simply stop being live.

### 4.3 Advancing

`CommitAgreement` on the active step:

1. writes the existing `agreement_committed` event (unchanged),
2. records the committed place on the step (`status: "settled"`),
3. if a later step exists, emits a new `step_advanced` event, which:
   - sets `active_step_id` to it,
   - re-centres `rooms.scope` on the settled place with the area's narrow
     radius and the new step's class, bumping `scope_seq`,
   - builds that step's pool from the snapshot around the settled place,
   - deactivates the previous step's requirements (`requirements.active`),
   - applies the step's `pendingNeeds` as the organizer's shared needs through
     the ordinary `SubmitRequirement` path.

Phase machine gains one transition: `agreed --step_advanced--> gathering`.
A room with no next step stays `agreed` and behaves as today.

Re-centring the map here is legal under CLAUDE.md §8: committing an agreement
is an explicit user action, and it is the second exception's spirit — the
viewport follows the user's decision, not a filter.

### 4.4 Wire

`SpatialContextResult` gains `steps: RoomStepView[]` and `activeStepId`, both
optional so an older client keeps working. A `RoomStepView` is `RoomStep`
without `pendingNeeds`.

New event types in the projection and the feed: `step_advanced`
("Step 2: a cinema, near Trattoria Sole") and, on creation, the steps ride on
`session_created`.

---

## 5. Server: the multi-step planner

`apps/server/src/nl/plan.ts`. Stage A's schema gains a `steps` array (max 3)
in place of the single `placeClass`, each entry carrying its class and the
concepts that belong to it; stage B (`mapInterpretation`) runs per step,
unchanged.

- **Ordering and relation** come from the sentence: "then", "after",
  "afterwards" put a step second; "near", "close to" bind it to the previous
  step's place. Absent any cue, one step.
- **Area-agnostic facets.** Cuisine and class routing read the union of both
  areas' snapshots rather than one area's, so a preview is not silently a
  Berlin preview. Counts are not returned.
- **Clarification** gains `mode: "one" | "many"` so the plan screen can render
  a multi-select. The existing single-choice path keeps `"one"`.
- Offline (`no model configured`): one `food` step, no needs, `offline: true`.
  Creation still works. Unchanged from D1.

`POST /api/plans/preview` no longer requires `areaId`; it accepts one and
ignores it for facets, kept only so existing tests and the WebMCP tool do not
break.

---

## 6. Server: invites

### 6.1 Model

New table (migration `024-room-invites.sql`):

```sql
CREATE TABLE room_invites (
  id            text PRIMARY KEY,
  room_id       text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  secret_hash   text NOT NULL UNIQUE,
  created_by    text NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  claimed_at    timestamptz,
  participant_id text REFERENCES participants(id) ON DELETE SET NULL,
  device_hash   text
);
```

`invite_secrets` is untouched: `room_demo` and organizer-created rooms keep
minting per-participant secrets exactly as they do now, so nothing existing
regresses. `room_invites` is the new, participant-less kind.

### 6.2 Endpoints

- `POST /api/invites` — bearer, any participant in the room. Mints a link
  (16 random bytes, sha256 stored), `expires_at = now() + 1 hour`. Returns the
  raw secret once.
- `GET /api/invites` — bearer. The room's links with `state`:
  `"unused" | "claimed" | "expired"`, the claimed one's display name (the
  organizer may see who took which link; a stranger may not — see below), and
  `expiresAt`.
- `GET /api/invites/:secret/context` — **unauthenticated**, gated by knowing
  the secret. Returns `{ goal, steps: [{title, placeClass.label}], organizer:
  {displayName}, participantCount, area: {label} }` and nothing else. No
  participant list, no candidate data, no room id that is useful without a
  token.
- `POST /api/invites/:secret/claim` — unauthenticated. Body
  `{ displayName, deviceId }`.
  - unclaimed and unexpired → create participant (role `member`), bind
    `device_hash = sha256(deviceId)`, emit `participant_joined`, mint a token.
  - claimed and `sha256(deviceId)` matches → mint a fresh token for the same
    participant (this is the "reload on the same device" path).
  - claimed and it does not match → `409 { error: "invite_in_use" }`. The
    client copy names nobody.
  - expired and unclaimed → `410 { error: "invite_expired" }`.
- Both unauthenticated routes are rate-limited per IP, like
  `/api/session/exchange`.

`deviceId` is a random id the client generates once and keeps in
`localStorage` (not `sessionStorage`: it must survive a tab close). It is
never an identity — it only rebinds a link to the browser that took it. The
server stores its hash.

### 6.3 Phase

`participant_joined` already transitions `setup → gathering`. Organizer-created
rooms open in `gathering` today and stay there; joining does not move a room
that is past `setup`.

---

## 7. Client work

| Area | Files |
|---|---|
| Onboarding | `components/Start.tsx` split into `Start.tsx` (name+goal), `PlanSteps.tsx`, `RegionDialog.tsx` |
| Invite | `components/InviteDialog.tsx`, `ui/qr.tsx`, `Header.tsx` (`+`) |
| Join | `components/Join.tsx`, `session.ts` (`#join=`, deviceId) |
| Step-aware room | `Header.tsx` (step line), `Brief.tsx` (settled steps), `spatial-store.ts`, `spatial-types.ts` |
| Copy | `ui/copy.ts`, `COPY.md` |
| Styles | `styles.css` on `tokens.css` — no raw hex (CLAUDE.md §3) |

Invariants that bite here, called out so nobody has to rediscover them:

- The region dialog and the invite dialog name no domain (§1) and use only
  token colours (§3).
- `--spoke-act` is authorship, never identity: the `+` and the invite dialog
  are an action, so `--spoke-act` is right for the staged/mint affordance and
  wrong for the avatar itself (§2).
- Counts absolute, deltas signed (§10). The region cards say "214 places on
  record", never "63%".
- The map does not re-centre on a filter change; it does re-centre on a step
  advance, which is a decision (§8).

---

## 7b. Onboarding is agent-reachable end to end

Added 2026-09-04 at the user's request. The landing page already advertises
the tool surface to an agent that finds it. That surface must now be able to
carry an external agent all the way from a sentence to the map view, without
a person touching the three screens.

The division of labour is the point: **the agent states a high-level goal and
the tooling does the distillation.** An external agent should not be picking
step classes, composing needs, or knowing that steps exist. It says what the
group wants; the same planner the Plan screen calls decides what that takes.

Tools, on the pre-room surface:

- `describe_regions` — the two demo regions with their measured coverage, so
  an agent can choose one for a reason rather than at random. It also carries
  the hackathon limitation in its description, because that is where an agent
  reads it.
- `open_room` — `{ goal, organizerName, regionId }` → runs the preview, opens
  the room with the resulting steps, and **navigates the page into the room**.
  Returns what it built (the steps, the area, the room's own invite link) so
  the agent can say what it did and hand the link on.

The invariant: an agent calling `open_room` and a person walking the three
screens reach the same room, through the same server calls. The screens are
not a separate path — they are `open_room` with a human in the middle.

Once in the room the existing 14 spatial and negotiation tools take over
unchanged, which is what makes this worth doing: the onboarding was the one
part of the product an agent could not reach.

## 8. Published examples

The same three strings appear in the goal field's placeholder, the WebMCP tool
description, and here. Change them in all three or none.

- "Dinner tonight somewhere we can all walk to"
- "Coffee and a quiet table, then a bookshop nearby"
- "A dog-friendly park this afternoon"

---

## 9. Tests

- `tests/api/plans.test.ts` — multi-step preview: a "then" sentence returns two
  steps in order with `relation.kind: "then"`; a plain sentence returns one; a
  preview without `areaId` succeeds; clarify returns `mode`.
- `tests/api/steps.test.ts` (new) — a two-step room: creation seeds step 1's
  pool and needs; committing an agreement settles step 1, emits
  `step_advanced`, re-centres scope, builds step 2's pool from the settled
  place, deactivates step 1's requirements, applies step 2's pending needs;
  a one-step room stays `agreed`.
- `tests/api/invites.test.ts` (new) — mint, list, context, claim; second device
  gets 409 and no name; same device gets a token; expiry gives 410; unused
  links survive a later mint; rate limits.
- `tests/e2e/onboarding.spec.ts` (new) — the whole flow in a browser: name and
  goal, two step boxes, region dialog, room with one avatar, `+`, copy the
  link, second context claims it as a guest, two avatars in both browsers.
- Existing suites stay green, `room_demo` untouched.

Two things the review pass added, because both are silent when broken:

- `tests/api/steps.test.ts` asserts that **no candidate row is left without a
  step** in a planned room, that a settled step's place cannot be proposed,
  that its needs cannot be switched back on, and that the commit reports the
  revision the caller must actually build on.
- Both new API files call `keepEnrichmentsClean` (`tests/api/helpers.ts`).
  Enrichment is keyed by place, not by room, so a file that opens Berlin
  rooms silently changes what a neighbour asserting on `enrichments` sees.
  Snapshot before, delete what appeared.

Lanes take the shared `flock /tmp/claude-1000/spokes-lane.lock` and their own
database (`docs/` test notes; api runs twice because of the global cache
tables — `pipeline.test.ts` fails on a cold cache and passes on the second
pass, which it also does on `main`).
