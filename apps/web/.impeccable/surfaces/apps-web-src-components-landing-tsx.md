---
version: 1
slug: "apps-web-src-components-landing-tsx"
primary_target: "apps/web/src/components/Landing.tsx"
related_targets: ["apps/web/src/landing.css"]
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

Completed 2026-09-07. [DESIGN.md](../../../../DESIGN.md) remains authoritative;
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
  Journey copy and portrait captures alternate columns; evidence uses the same
  two-column relationship. Screenshots sit in token-based rounded plates with
  printed shadows. Definitions and technical points use rules, without adding
  a competing card system.
- **Responsive behavior:** below 960px the hero introduction stacks; below
  720px the journey, evidence, technical points, and FAQ become single columns,
  with copy before each capture. Portrait figures grow from a 280px cap to
  340px. Below 600px the hero selects its dedicated portrait capture. On small
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
  in a new tab, with that behavior in the accessible link name.
- **Truthful copy:** private text is omitted from other participants' views,
  while observable effects may reveal information. Agent-only text stays out of
  the room record; the FAQ explicitly explains the built-in agent's server
  memory and configured AI provider processing. The page distinguishes this
  from an external agent holding the condition. Invite expiry and browser
  ownership, demo regions, prepared place data, AI availability, evidence
  uncertainty, and on-page confirmation requirements are stated plainly.

## Assets and reproduction

All eleven WebPs are captures of current UI using documented scenarios. The
seven canonical names remain: `hero-desktop`, `scopes-mobile`, `pending-mobile`,
`impasse-mobile`, `drawer-mobile`, `roster-mobile`, and `explore-mobile`. Four
captures were added: `hero-mobile`, `planning-mobile`, `agreement-mobile`, and
`details-mobile`. Every file remains under `/landing/`; retained external
images need not all appear in the landing narrative.

The hero loads eagerly with high fetch priority; supporting images load lazily.
Explicit dimensions reserve space, alt text describes each state, and the hero
caption describes the shared needs. Each WebP has embedded EXIF capture
provenance and a matching JSON sidecar. No generated or retouched UI is used.

[The asset README](../../public/landing/README.md) owns the scene inventory,
fixture limitations, external consumers, and reproduction instructions.
[capture-landing.ts](../../../../scripts/capture-landing.ts) exercises real UI
and API paths against an isolated database, uses the documented plan transport
fixture and browser shim where needed, and cleans up only its own rooms. The
final complete capture run and provenance scan passed; isolated database cleanup
left zero rooms.

## Completion evidence

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
