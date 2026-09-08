---
version: 1
slug: "apps-web-src-components-landing-tsx"
primary_target: "apps/web/src/components/Landing.tsx"
related_targets: ["apps/web/src/landing.css", "apps/web/src/components/BrowserSupportCheck.tsx"]
---

# Landing page refresh

Mode: Persuade. Scope: `/`, its copy, screenshots, and responsive presentation.
Audience: small groups deciding where to go; secondary readers building with WebMCP.
Action: start a room through goal-first onboarding. Evidence: real current app captures with scripted scenarios.

## Direction contract

THESIS: Follow an outing from intent to agreement, with current screens proving each decision.
OWN-WORLD: Keep the Field Notebook: cream, ink-green, Bricolage, semantic marks, printed shadows, and the dark protocol section.
STORY: Review a plan, choose visibility, resolve the collision, agree and continue. Evidence and privacy explanations earn trust.
FIRST VIEWPORT: Two-line brand headline beside plain-language offer and primary action; a full-width real map below. Mobile stacks the offer above a portrait capture.
FORM: Extend the existing screenshot-led narrative; four ordered decisions replace repeated feature beats. No visual-world replacement or concept seed applies.
FINISH: Finish review, its scoped verdict, this completed surface record, and provenance for every shipping raster. Existing DESIGN.md remains the design-system authority.

## Constraints

Keep the seven hotlinked image paths, global tokens, brand identity, and room behavior. No invented adoption, performance, or privacy guarantees. Screenshot scenarios are documented in asset provenance. Browser requirements link to official WebMCP documentation. The design system remains unchanged; record only the landing surface at handoff.

## Shipped surface

Completed 2026-09-07; refined 2026-09-08. [DESIGN.md](../../../../DESIGN.md) remains authoritative;
this is an ordinary landing extension of its Field Notebook identity. The
implementation is [Landing.tsx](../../src/components/Landing.tsx) and
[landing.css](../../src/landing.css). No global product, token, or design-system
scope changes are part of this refresh.

- **Story:** the map-led hero leads into four ordered decisions: review a plan
  of up to three stops and invite each person; choose Shared, Private, or Agent
  only; preview changes and resolve an impasse; agree, continue to the next stop,
  and open arrival directions. Evidence follows the journey. A compact dark
  technical section, practical FAQ, and final start action complete the page.
- **Composition:** content is capped at 1120px with fluid 16–40px gutters. The
  desktop headline and offer sit side by side above a full-width screenshot.
  Journey copy and focused screenshot details alternate columns; evidence uses
  the same two-column relationship. Supporting figures are capped at 430px and
  crop to the relevant controls in CSS. Screenshots sit in token-based rounded plates with
  printed shadows. Definitions and technical points use rules, without adding
  a competing card system.
- **Responsive behavior:** below 960px the hero introduction stacks; below
  720px the journey, evidence, agent example, and FAQ become single columns,
  with copy before each capture. Supporting figures fill the available width
  up to 430px. Below 600px the hero selects its dedicated portrait capture. On small
  screens the header keeps the wordmark, accessible `{ }` link, and start button.
- **Visual hierarchy:** existing cream and ink-green tokens carry the page;
  semantic marks retain their product meanings. Bricolage carries headings and
  actions, the body face explains, and mono identifies the technical section.
  The existing hero, heading, reading, and detail scales remain in use. Local
  ink-section text mixes preserve contrast without introducing global tokens.
- **Interaction:** all start actions call the existing goal-first onboarding
  path. A sticky header keeps that action reachable and adopts the technical
  section's ink ground while it passes underneath. In-page links have scroll
  clearance; the skip link and focus outlines support keyboard navigation.
  The privacy anchor opens its native disclosure and focuses its summary,
  including on direct load. The first FAQ is open initially. Smooth scrolling
  respects reduced motion. Journey and evidence images open their originals
  in a new tab, with that behavior in the accessible link name and a visible
  View full screen action. Captions identify screenshot details.
- **Browser check:** the account/agent FAQ pairs its official browser-requirements
  link with a compact status panel. A drawn browser icon, semantic green/amber
  colors, and explicit text distinguish registered tools, a missing API, failed
  registration, and the opt-in test shim. Pending registration uses the action
  color. The panel observes the app's existing registration result, updates a
  polite live region, and never registers probe tools or infers support from the
  browser's name. The shim cannot earn a positive result. Successful registration
  still explains that a compatible agent is needed and opens this FAQ by default,
  alongside the first FAQ. This also works when registration completes after page
  load. Visitors can close it, and ordinary page rerenders preserve that choice.
- **Truthful copy:** private text is omitted from other participants' views,
  while observable effects may reveal information. Agent-only text stays out of
  the room record; the FAQ explicitly explains the built-in agent's server
  memory and configured AI provider processing. The page distinguishes this
  from an external agent holding the condition. Invite expiry and browser
  ownership, demo regions, prepared place data, AI availability, evidence
  uncertainty, and on-page confirmation requirements are stated plainly. The
  hero puts the Berlin Mitte / San Francisco SoMa demo boundary and optional
  external agent beside the first start action. The technical section shows a
  real built-in agent suggestion for The Barn awaiting review, and distinguishes
  that review from an external agent using the participant's authority directly.

## Assets and reproduction

All twelve WebPs are captures of current UI using documented scenarios. The
seven canonical names remain: `hero-desktop`, `scopes-mobile`, `pending-mobile`,
`impasse-mobile`, `drawer-mobile`, `roster-mobile`, and `explore-mobile`. Four
captures were added: `hero-mobile`, `planning-mobile`, `agreement-mobile`, and
`details-mobile`. The additional `agent-review` image is a 430 × 932 browser
clip of a real 980 × 932 desktop room, documenting the built-in owner-review
flow. Every file remains under `/landing/`; retained external
images need not all appear in the landing narrative.

The hero loads eagerly with high fetch priority; supporting images load lazily.
Explicit dimensions reserve space, alt text describes each state, and the hero
caption describes the shared needs. Each WebP has embedded EXIF capture
provenance and a matching JSON sidecar. No generated or retouched UI is used;
CSS crops preserve the original files. The agent image has its own isolated
capture script, `scripts/capture-agent-landing.ts`, with model-transport fixtures
and assertions that the pending suggestion has not yet changed the room.
The plan-review and place-details captures were refreshed on 2026-09-08. The
former shows the app's paper secondary buttons and quiet ink removal controls;
the latter demonstrates improving a likely outdoor-seating result with Confirm
and Rule out, beside definitive results without those actions. Its caption
identifies a demo scenario; its isolated capture fixture makes that one result
tentative without changing the shipped venue dataset. The capture verifies the
real ConfirmFact transition to yes, attribution and undo after photographing
the choice. Its CSS crop ends after the private-condition row. Only likely/unlikely
results offer new confirmation actions in the live app; existing human
confirmation provenance and undo remain available.

[The asset README](../../public/landing/README.md) owns the scene inventory,
fixture limitations, external consumers, and reproduction instructions.
[capture-landing.ts](../../../../scripts/capture-landing.ts) exercises real UI
and API paths against an isolated database, uses the documented plan transport
fixture and browser shim where needed, and cleans up only its own rooms. The
final complete capture run and provenance scan passed; isolated database cleanup
left zero rooms.

## Completion evidence

- **2026-09-08 screenshot and onboarding corrections:** replaced only
  `planning-mobile.webp` and `details-mobile.webp`, with matching EXIF and JSON
  provenance. Both are real browser captures against isolated fixture databases,
  without image retouching. The scoped details capture asserts visible Confirm /
  Rule out buttons on the likely row and none on definitive rows, then confirms
  the likely fact through the real application and verifies yes, attribution and
  undo. Three focused place-details tests pass,
  including all five verdict states and the confirmation/undo presentation.
  The web build, web typecheck, and all 14 landing tests pass. Browser inspection
  at 1180, 390, and 330px covered the onboarding ask, plan, region, and clarification
  phases, plus both replaced images in the landing. Secondary controls have
  44px targets, at least 6.26:1 text contrast, working hover/focus/disabled states,
  and no horizontal overflow. Evidence: `/tmp/spokes-onboarding-buttons/`.
  The final data-improvement scene was verified again against the current main
  branch, including the real likely → Confirm → yes transition; its final
  desktop/mobile landing crops are at `/tmp/spokes-tentative-details/`.
- **2026-09-08 browser support check:** web build and typecheck pass. All 14
  landing end-to-end tests pass against an isolated database, including six
  new cases for missing/current/legacy APIs, registration failure, the test
  shim, and asynchronous registration. A batched visual check exercised all
  five panel states at 1440, 390, and 330px: no horizontal overflow or console
  errors, 44px requirements-link targets, keyboard focus, and a minimum text
  contrast of 6.04:1. Desktop/mobile screenshots and computed measurements are
  retained at `/tmp/spokes-browser-support/`. Simulated APIs verify the panel's
  behavior; they are not evidence of native browser/agent interoperability.
  The automatic-open refinement also passed all 14 landing tests and the build
  and typecheck; both FAQs were inspected open at 1440 and 390px. The local
  preview was restarted to serve the rebuilt asset routes.
- **2026-09-08 critique refinements:** all three priority issues from
  `2026-09-07T20-55-18Z__apps-web-src-components-landing-tsx.md` are addressed.
  The web build, web typecheck, and all eight existing landing end-to-end tests
  pass. Tests used an isolated database, removed afterwards. Browser checks at
  1440, 768, 390, and 330px passed enlargement, privacy disclosure, Start/Back,
  and keyboard skip navigation, with no horizontal overflow or console errors.
  At 390px, the four-step journey is 3351px tall (previously 5009px), and the
  complete page is 7938px (previously 9660px). Original screenshot paths remain
  intact. Evidence is retained at `/tmp/spokes-landing-changes/`, including
  `browser-checks.json` and desktop/mobile screenshots. The new agent capture
  verified one pending owner action, zero applied proposals, and an unchanged
  room revision; its owned databases, browser, and server were cleaned up.
- **2026-09-07 original refresh:**
- Eight landing end-to-end tests passed, covering start and plan review,
  fallback and clarification, browser history, invite entry, width, anchors,
  and privacy disclosure. Typecheck and the web build passed.
- Browser inspection at 1440, 1280, 768, 390, and 330px found no horizontal
  overflow, JavaScript errors, or visible interactive targets below 44px.
  Recorded text contrast is at least 6.02:1 on the light surface; technical
  body and secondary text measure 8.94:1 and 6.39:1 respectively.
- Local review evidence lives in `.impeccable/review/` at the repository root:
  `desktop.png`, `mobile.png`, the five `*-viewport.png` captures, per-section
  desktop/mobile captures, and `browser-checks.json`.
- Finish review required one FAQ browser-requirements link-spacing fix. The
  corrected spacing was confirmed resolved with a **ship** disposition scoped
  to that fix.

Landing-specific navigation, alternating composition, image widths, and local
ink text mixes are recorded only for this surface. They do not establish new
room rules, reusable tokens, or a replacement visual world.
