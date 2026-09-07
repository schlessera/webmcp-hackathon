# Project status — Spokes

**Last reviewed:** 2026-09-07 against the repository implementation.
**Tool contract:** version 3, 24 tools.
This document describes the current product and its operating boundaries.
Deployment health and test results require a run against the build being assessed.

## Product

Spokes is a shared map for a group and their personal agents to decide where to
go. Participants contribute needs, inspect evidence, resolve impasses, propose
places, and record their responses. The organizer confirms each decision on the
page. A plan can contain up to three sequential stops; after the final choice,
participants choose a travel mode and open navigation in an external map app.

The web application works without an external agent. WebMCP exposes the same
room through narrow tools scoped to the authenticated participant.
[KNOWN-LIMITATIONS.md](KNOWN-LIMITATIONS.md) records the current product,
privacy, data, and reliability limits.

## Implemented experience

### Start and invitations

The root route opens the landing page. **Start a room** asks for a name and
goal, then shows the interpreted plan. The organizer can change a step's place
class, remove steps or needs, and answer clarification questions before choosing
Berlin Mitte or San Francisco SoMa as the demo region. When language
interpretation is unavailable, the organizer can still choose a place class
and open a room.

A new room starts with its organizer. The room's invite control creates a
separate link and QR code for each new participant; the first claim binds a
member link to a secret stored in that browser. Unclaimed links expire after
one hour, participant bearer tokens after 24 hours, and organizer recovery
links after seven days. Claimed member links can recover the same identity in
the bound browser. These are possession-based guest identities, not verified
accounts. There is no participant leave/removal command, room-closing command,
or automatic room deletion policy.

Sources: [onboarding](../apps/web/src/components/Onboarding.tsx),
[room creation](../apps/server/src/rooms.ts),
[invites](../apps/server/src/invites.ts), and
[authentication](../apps/server/src/auth.ts).

### Needs, evidence, and negotiation

The room combines a MapLibre map, a brief, a composer, place details, and the
`{ }` diagnostic drawer. Facet labels and counts come from the server.
Changing the candidate set preserves the map's position; a participant can
pan, search, inspect places, and bring additional candidates into the room.
Holding an owned need previews the set without it and restores the view on
release, with a keyboard equivalent. The optional **Buildings in 3D** layer
tilts the map and raises place heads on thin needles pointing to their map
locations. Labels keep the same anchors; turning it off retracts the pins,
and reduced-motion settings make the change immediate.

Needs have Shared, Private, and Agent only visibility. Time-window requirements
are supported using the area's timezone and the available opening-hours data.
Hard needs drive deterministic classification: eligible, likely, uncertain,
unlikely, or excluded. The page's headline count includes eligible and likely
places; wire `matching` counts and impasse gains use confirmed eligibility.
Soft/optional needs are stored but do not affect ranking.

Place details expose evidence, uncertainty, and source information.
Participants can attest to an attribute or confirm a fact for their room;
these contributions do not establish facts in every other room. Models can
infer likely facts and can adjudicate explicit statements as verified, so a
verified label describes the accepted evidence rather than an independent
site visit.

Impasse handling offers quantified changes to needs or scope. Requirement
changes observe ownership, delegation, and confirmation checks. The organizer
can also change shared search scope directly without routing consent to every
member. Agent-private screening is implemented; disclosure levels L1–L3 have
no progressive disclosure request workflow.

Sources: [eligibility](../apps/server/src/eligibility.ts),
[impasse suggestions](../apps/server/src/impasse.ts),
[attestations](../apps/server/src/attestations.ts), and
[command engine](../apps/server/src/engine.ts).

### Agreement and arrival

Anyone can propose a place. Commitment requires every participant to be ready
and to have accepted or abstained, with no veto; disconnected participants
still count. A conditional acceptance must be replaced before commitment.
These response rules do not require the candidate to be classified eligible.

The organizer stages and then commits the agreement. An intermediate commit
settles that step and opens the next search around the chosen place; the final
commit leads to arrival planning. Readiness carries forward between steps, but
each new proposal needs fresh participant stances. There is no command to
edit/reorder the remaining plan or reopen a settled step after creation.

Participants can choose walking, cycling, or driving and open Google Maps,
Apple Maps, or a `geo:` link. Starting points can be stated, device-derived,
or labelled fixtures; device tracking requires live-sharing opt-in. Travel
estimates use distance and fixed speeds, not street routing or live traffic.
Transit eligibility, negotiated meeting points, and route planning remain
outside the implemented flow.

Sources: [step advancement](../apps/server/src/steps.ts),
[phase rules](../apps/server/src/phase.ts), and
[arrival controls](../apps/web/src/components/ArrivalBar.tsx).

## Agent and privacy boundaries

The catalog exports **24 tools: 2 onboarding, 10 negotiation, and 12 spatial**.
It is registered at page load when `document.modelContext` is available.
The two application protocols are negotiation v1 and spatial-destination v1.
Tool results are abbreviated to explicit budgets; agents synchronize revisions
and receive participant-specific projections. See the
[implemented binding](protocols/INTERACTION-AND-BINDING.md) for the tool table,
result limits, and retry behavior.

The built-in tool-calling agent acts for one participant. Its proposed room
mutations require an owner-only approval card, bound to the stored arguments
and original revision, with a five-minute lifetime. Ordinary ownership,
phase, and consent checks still apply. External WebMCP agents act under their
participant's authority without this built-in review wrapper.

Private need text reaches the application and durable storage but is omitted
from peers' projections. Observable counts, owner metadata, hints, and effects
can still support inference. For Agent only, an external agent can hold the
condition outside Spokes and return verdicts. The built-in agent receives it
on the server, holds it in process memory, and sends it to tool-less interpretation and screening
models; the condition is omitted from requirement/event storage and the
tool-calling model's context. Restarting the process loses the held text.

Agreement commitment and over-bound grants require a 120-second, single-use
nonce delivered through the participant's authenticated realtime channel.
The applying commands have no WebMCP tool binding. A bearer-token holder can
receive the nonce, so confirmation establishes participant authority without
proving a human gesture.

Sources: [tool catalog](../packages/contracts/src/tools.ts),
[action approvals](../apps/server/src/nl/approvals.ts),
[condition holder](../apps/server/src/nl/holder.ts), and
[confirmation](../apps/server/src/confirmation.ts).

## Data and architecture

TypeScript contracts are shared by the React/Vite client and Fastify server.
PostgreSQL stores room state, events, evidence, and caches. The command engine
validates mutations, checks ownership and phase, enforces optimistic revision
checks, and projects results per viewer. Realtime fan-out, presence, confirmation
nonces, held conditions, and resource quotas assume one application process.

Committed OpenStreetMap snapshots provide Berlin and San Francisco venues.
The offline snapshot builder updates that inventory; runtime enrichment can
supplement facts from venue sites, Wikidata/Commons, listings, search, and
images. Rooms have a 2,500-candidate cap. Neither snapshots nor enrichment
guarantee current prices, availability, opening hours, or accessibility.

The enrichment scheduler coordinates interactive and background work through
bounded pools, per-room scheduling, cancellation, batching, and caches.
Outbound requests use the central network layer and configured provider
adapters. Provider availability and budgets determine which enrichment paths
can run. Direct map tiles come from OpenFreeMap.

The configured default model is `openai/gpt-5.6-luna`, with provider and
per-role overrides. Model-dependent behavior follows the configured credentials;
the room's direct controls and label-matching fallback remain available without
them.

Implementation references:
[SYSTEM-ARCHITECTURE.md](SYSTEM-ARCHITECTURE.md),
[ENRICHMENT-SOURCES.md](ENRICHMENT-SOURCES.md),
[DATA-QUALITY.md](DATA-QUALITY.md), and [NL-AGENT.md](NL-AGENT.md).

## Run and validate

Use Node 24 or newer and the workspace dependencies. The
[deployment guide](DEPLOY.md) covers the Docker Compose stack behind Caddy;
the repository review here does not certify the live host or its deployed
revision. [DEPLOY-COOLIFY.md](DEPLOY-COOLIFY.md) remains a maintained reference
for production configuration and its optional, unvalidated Coolify path.

```sh
make demo
node scripts/open-participants.mjs
make dev
make update
```

`make demo` starts the local stack and idempotently seeds `room_demo`.
Its three pre-created identities are development fixtures. On a local demo
database, `make demo-reset` clears only that room before reseeding. Production
uses the browser-bound member invitation flow; see the
[demo runbook](DEMO-RUNBOOK.md).

Validation commands are defined in [package.json](../package.json):

| Check | Command |
|---|---|
| Types | `pnpm typecheck` |
| Unit tests | `pnpm test:unit` |
| API tests | `pnpm exec vitest run tests/api --maxWorkers=4` |
| Default browser lane | `pnpm test:e2e` |
| Additional onboarding/security browser specs | `pnpm exec playwright test tests/e2e/onboarding.spec.ts tests/e2e/security.spec.ts` |
| Native WebMCP lane | `pnpm test:native` |
| Build | `pnpm build` |

Use a migrated, isolated database for API/browser lanes and recordings.
Some tests mutate shared cache tables; do not run them concurrently against
the same database. Limit API workers to stay within database connection
capacity. The default browser command names four spec files explicitly and
does not include every file under `tests/e2e/`; the Compose `e2e` service
runs only `three-user.spec.ts`. Native tool discovery requires the configured
real browser and a separate host check.

This review checked source contracts and documentation. It does not report a
fresh complete test run, native-agent session, or production health check.
Record those results with the tested revision, database setup, and command.

## Document roles

Current implementation and operating references include this file, the
[documentation index](README.md), architecture, data/enrichment, natural
language, protocol binding, deployment, limitations, and demo runbook documents.
Root product/design rules and app-specific interface rules retain their
respective scope.

The following preserve planning or submission context; their proposals and
historical counts are not the current implementation contract:

- [PRODUCT-CONCEPT.md](PRODUCT-CONCEPT.md): original product vision and intended
  scope, including broader opportunities.
- [EXPERIENCE-AND-DEMO.md](EXPERIENCE-AND-DEMO.md): proposed experience, role-play
  findings, and an early demonstration outline.
- [MVP-AND-RISKS.md](MVP-AND-RISKS.md): hackathon scope and validation planning,
  with status explicitly recorded as of 2026-09-01.
- [SUBMISSION.md](SUBMISSION.md): pre-deployment submission preparation draft.
- Dated audits, validation reports, design handoffs, and research snapshots:
  evidence and decisions at their recorded time. Use current references for
  behavior, and the dated documents when reviewing their historical findings.
