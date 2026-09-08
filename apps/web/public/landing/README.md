# Landing page images

These are browser captures of the current application, refreshed on 2026-09-07.
The built-in agent review capture was added on 2026-09-08.
The plan review and place-details captures were refreshed on 2026-09-08 after
styling secondary onboarding actions and limiting confirmation actions to
likely/unlikely results.
The original seven files are hot-linked outside the app: preserve their exact
paths and WebP format when replacing them.

| File | Dimensions | Scene / suggested alt description |
|---|---|---|
| `hero-desktop.webp` | 1440 × 900 | Three people compare places on a Berlin map; four still work, and The Barn's details show how it fits shared needs and a private condition. |
| `hero-mobile.webp` | 430 × 932 | Four places still work on a mobile map, with shared needs and the effect of a private condition below. |
| `planning-mobile.webp` | 430 × 932 | An editable two-step plan: outdoor dinner, then a film, with quiet ink removal controls and a rounded paper button to change the goal. |
| `scopes-mobile.webp` | 430 × 932 | The composer offers Shared, Private and Agent only, explaining what each scope reveals. |
| `pending-mobile.webp` | 430 × 932 | An outdoor-seating need appears immediately with a saying-it indicator while its request is in transit. |
| `impasse-mobile.webp` | 430 × 932 | No confirmed match in the current area; a private proposal offers the organizer four more places by widening the search. |
| `details-mobile.webp` | 430 × 932 | A data-improvement demo: The Barn has a likely outdoor-seating result with Confirm / Rule out actions beside definitive results. |
| `agreement-mobile.webp` | 430 × 932 | The group has settled on The Barn; the arrival screen offers travel choices and directions. |
| `drawer-mobile.webp` | 430 × 932 | The under-the-hood drawer shows the capture session's actual protocol traffic and connection state. |
| `roster-mobile.webp` | 430 × 932 | Three people are present; the organizer's location-sharing controls and a private-condition effect are visible. |
| `explore-mobile.webp` | 430 × 932 | A panned map offers a place from the Berlin snapshot to bring into the room. |
| `agent-review.webp` | 430 × 932 | A clip of the actual desktop room at 980 × 932: the built-in agent's proposal for The Barn awaits Approve change or Dismiss, alongside a strip of the map. |

The landing page presents supporting captures through CSS crop windows and
labels them as screenshot details. Each links to the complete original with a
visible **View full screen** action. The original WebPs and their provenance
remain intact; no UI content is retouched. Crop bounds in `Landing.tsx` select
the plan review, visibility menu, widening offer, arrival controls, place
verdicts, and agent review card. The hero remains a full screenshot.

## Reproduce

Use Node 24+, the workspace's installed dependencies, Playwright Chromium, and
Python 3 with Pillow. Start the current application against an **isolated**,
migrated PostgreSQL database. Disable external enrichment, background pool
filling, and model credentials; enable the local three-person invite fixture:

```sh
rtk proxy env DATABASE_URL=postgres://webmcp:webmcp@127.0.0.1:55433/webmcp \
  PORT=4183 ENRICH_NETWORK=0 POOL_FILL=0 ALLOW_LEGACY_MEMBER_INVITES=1 \
  OPENAI_API_KEY= OPENROUTER_API_KEY= node apps/server/src/server.ts
```

In another shell, from the repository root:

```sh
rtk proxy env DATABASE_URL=postgres://webmcp:webmcp@127.0.0.1:55433/webmcp \
  LANDING_BASE_URL=http://127.0.0.1:4183 node scripts/capture-landing.ts
```

The base URL and database must describe the same server. The capture script
creates fresh rooms through the existing test helper, uses the actual UI and
API, and deletes only those rooms in `finally`. It never truncates shared tables
or removes other rooms. OpenFreeMap tiles must be reachable for the map to load.
The plan fixture starts a temporary second server and shuts it down afterwards.
Set `LANDING_CAPTURE_ONLY=planning`, `LANDING_CAPTURE_ONLY=explore`, or
`LANDING_CAPTURE_ONLY=details` to replace only that scene. The details capture
uses its own room and deliberately tentative outdoor-seating evidence. It
asserts that the likely result offers Confirm / Rule out while definitive rows
do not. After capturing the choice, it clicks Confirm through the real API and
checks the resulting yes, attribution and undo. The sidecar records this
verification. New Confirm / Rule out actions belong only to likely/unlikely
results; human-confirmed facts retain their provenance and undo action.

Each WebP carries the capture intent and fixture provenance in its EXIF image
description and a matching `.webp.json` sidecar. The sidecars are compatible with
the Impeccable `embed-prompt.mjs --read/--scan` tool. The sidecar records source
commit, capture time and viewport. Images are encoded at WebP quality 88 without
resizing, retouching, inserted UI or generated content.

### Built-in agent review

The additional agent capture has its own reproducible command. It needs a
PostgreSQL account with permission to create a temporary database:

```sh
rtk proxy env CAPTURE_DATABASE_ADMIN_URL=postgres://webmcp:webmcp@127.0.0.1:55433/postgres \
  node scripts/capture-agent-landing.ts
```

The script creates and migrates a uniquely named database, starts the current
application on its own port, and submits a request through the real composer.
Only the model transport is scripted. It verifies that the review card names
The Barn, one owner action is pending, no proposal has been applied, and the
room revision has not changed. It stops its server and browser and drops only
its own database on completion or failure. `CAPTURE_CHROMIUM_PATH` can select
an existing compatible Chromium installation.

The full desktop review card does not fit the mobile brief's height cap, so
this asset is a direct 430 × 932 browser screenshot clip of the 980 × 932
desktop viewport. The JSON sidecar records the viewport, clip, card bounds,
verification, and fixture limitations; the EXIF description repeats the scene
and provenance. This demonstrates the real review flow, not autonomous model
reasoning or an external WebMCP agent connection.

## What is fixture data

- Alex, Sarah and Joe, their requirements, presence and decisions are test
  scenarios. Their private and shared views use the actual server projections.
- Room places come from `packages/contracts/data/berlin-mitte-venues.json`.
  Names and coordinates are the shipped venue data; dietary, price and other
  evidence include the repository's curated demo facts. These screenshots are
  not fresh verification of a business's menu, prices, opening hours or access.
- The details scene overrides only the owned capture room's outdoor-seating
  evidence to `likely_true` at 0.6 confidence. The page labels the screenshot a
  demo scenario. This is an example of improving evidence, not a new assessment
  of The Barn; the shipped dataset is unchanged. All commands, classification,
  confirmation, attribution and undo controls use the real application.
- The impasse, +4 widening proposal, four matching results and final agreement
  are calculated by the real application. Widening is accepted and confirmed by
  the organizer; all three participants accept the destination before it is
  staged and confirmed.
- The pending screenshot delays one real `SubmitRequirement` request just long
  enough to capture the actual optimistic state, then releases it. It does not
  fabricate lookup results or a provider response.
- Exploration uses the real room places endpoint and the shipped Berlin area
  snapshot, with a normal map pan and a click on a visible map dot. The script
  checks that the whole action card fits in the captured viewport.
- Planning uses `tests/api/fixtures/plans-server.ts` to script only the model
  transport. The real plan API validates and interprets that answer, then the
  current onboarding UI renders its two steps. The fixture's film wording is a
  sample preference, not a claim about current listings. No room is opened for
  this pre-creation screenshot.
- The drawer uses the repository's WebMCP browser test shim. Its traffic is real
  for that local session; it is not evidence of a native browser agent connection.

## Consumers outside the app

`docs/DEVPOST.md` embeds six canonical images at
`https://spokes.alainschlesser.com/landing/<file>`: hero-desktop, scopes-mobile,
pending-mobile, impasse-mobile, drawer-mobile and roster-mobile. Devpost stores
those URLs, so renaming a file would break the submission. Preserve
`explore-mobile.webp` as well, even when it is not featured on the landing page.

Adding images is fine. Keep this table and any referring component's alt text
accurate when a scenario changes.
