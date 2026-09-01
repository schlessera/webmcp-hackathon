# MVP, Validation, and Risks

## Hackathon constraints

Based on the repository's challenge documents, the entry must include:

- A WebMCP-powered web application representing a future open web where humans
  and agents interact, collaborate, or create.
- A working live URL accessible in ChatGPT's in-app browser or Chrome with
  WebMCP.
- A public source repository with a visible open-source license and setup
  instructions.
- A written submission description.
- A public YouTube video under three minutes with audio.
- Only authorized third-party SDK, API, and data usage.

The listed deadline is September 3, 2026 at 1:00 PM Pacific Time, corresponding
to 10:00 PM in Berlin.

## Focused POC scope

### Must demonstrate

- One prepared geographic area with a reliable candidate dataset.
- A room created through a shareable link and QR code.
- Three simultaneous guest identities in separate browser contexts.
- A live map and participant-specific activity feed.
- Shared and application-private requirements.
- Hard, soft, locked, and bounded-negotiable semantics.
- Three or more recomputed candidate options.
- Direct map selection and veto.
- At least one participant using ChatGPT through WebMCP.
- First-connection protocol instructions and capability discovery.
- Revision-aware catch-up after another participant acts.
- One controlled impasse and one private resolution request.
- Explicit group acceptance.
- Individual meeting/navigation handoffs.

### Quality bar

- The map reflects changes immediately.
- Agent calls use stable semantic IDs, not coordinates inferred from pixels.
- Unauthorized private data never reaches another client's network response.
- Explanations cite evidence status and do not leak private reasoning.
- The prepared demo works without developer credentials or OAuth setup.
- Common actions, especially navigation after acceptance, are one click.

## Data strategy

### POC approach

Ask for or select the geographic area before the demonstration, then fetch,
curate, prepopulate, and cache the bounded dataset needed for that area. Explain
this as an infrastructure and cost tradeoff for the POC, not a product
limitation inherent to the design.

Separate:

- **Base geography:** relatively stable places, coordinates, categories, and
  accessibility attributes.
- **Live overlays:** weather, traffic, temporary closures, promotions, events,
  availability, or current travel times.

Every fact should carry source, retrieval time, and confidence. Cached base
data and live overlays can coexist rather than treating all cached information
as current.

### Provider principles

- Avoid making Google Maps or Google Reviews a hard dependency.
- Prefer permissive, authorized, or curated sources for the POC.
- Put provider access behind adapters.
- Do not scrape through proxies or violate service terms.
- Avoid expensive B2B data contracts merely to start the demo.
- Degrade honestly when an attribute is unknown.

## Preference-memory policy

Session behavior must not silently become personality.

- Temporary moods remain session-scoped.
- Visit history can be stored without interpreting it as preference.
- Durable preferences require explicit promotion or confirmation.
- Users can inspect and delete durable preference records.
- The council distinguishes "history only" from "use in future ranking."

This prevents a recent mood, veto, or situational constraint from creating
long-term profile drift.

## Main risks and mitigations

### "This could be built without WebMCP"

**Risk:** judges perceive a normal shared SaaS map with AI text.

**Mitigation:** visibly demonstrate an independently contextualized personal
ChatGPT discovering live page semantics, catching up on session deltas, acting
under the participant's identity, and causing immediate UI changes. Emphasize
the reusable negotiation protocol rather than generic map search.

### Slow interaction flow

**Risk:** agent round trips make exploration unpleasant.

**Mitigation:** keep map interactions local and realtime; precompute and cache
the bounded candidate universe; use WebMCP for meaningful semantic operations;
return concise deltas; do not put ChatGPT in the realtime transport path.

### Weak or incorrect suggestions

**Risk:** insufficient venue data leads to untrustworthy recommendations.

**Mitigation:** use a prepared area, evidence-backed candidate dossiers,
confidence labels, deterministic hard checks, and an explicit `uncertain` state.

### Cost and provider lock-in

**Risk:** Google Maps or commercial data makes the POC expensive or impossible.

**Mitigation:** use provider adapters, bounded prepared data, permissive map and
routing alternatives where possible, and optional premium integrations later.

### Reviews and real-time data access

**Risk:** important signals are unavailable or legally constrained.

**Mitigation:** never imply access the application lacks. Demonstrate the
evidence/freshness model with authorized sources and treat promotions, reviews,
and live availability as adapters rather than foundational requirements.

### Terms-of-service and scraping concerns

**Risk:** the demo relies on proxies or unauthorized extraction.

**Mitigation:** exclude such mechanisms from the POC and document every source
and license.

### User setup friction

**Risk:** judges must create OAuth clients, API projects, or accounts.

**Mitigation:** provide guest links and prepared data by default. Keep provider
credentials on the hosted application where allowed.

### Private-data leakage

**Risk:** hidden requirements appear in another browser's state, explanation,
or score changes.

**Mitigation:** server-side projections, aggregate explanations, access-control
tests, stable privacy labels, and explicit acknowledgment that small-group
outcome inference cannot be eliminated entirely.

### Overbuilding a generic framework

**Risk:** protocol abstraction consumes the remaining hackathon time.

**Mitigation:** implement a complete spatial vertical slice first. Extract only
the envelope, revision, projection, and consent primitives proven by the demo.

## Immediate validation spikes

Status as of 2026-09-01 (see `PROJECT-STATUS.md`). DONE = verified;
IMPLEMENTED = built + covered by automated tests but not yet human/ChatGPT
signed-off; OPEN = not started.

1. [DONE] Verify WebMCP tool discovery and first-connection instructions in
   ChatGPT's current built-in browser. (Spike-1 Gate 0/1, real ChatGPT,
   2026-08-31 — `sync_session` only; the 14 new slice tools are IMPLEMENTED but
   NOT yet ChatGPT-verified.)
2. [DONE] Verify a tool callback can read current WebSocket-backed page state and
   return a revision delta after inactivity.
3. [DONE] Implement a minimal revisioned event log and optimistic concurrency
   check.
4. [DONE] Prove three separate guest identities receive different server
   projections.
5. [DONE] Verify private fields never appear in another participant's network
   payload. (Asserted at the wire in lanes 2–3; hardened after the adversarial
   audit closed two derived-fact leaks.)
6. [IMPLEMENTED+RECORDED] Validate one direct map action and one WebMCP action
   through the same command. (One command bus for gestures + tools; e2e covers
   it, and the recorded three-window run shows an agent-surface proposal landing
   on every map. Not yet demonstrated in real ChatGPT — that half stays open
   with the lane-5 gate.)
7. [DONE] Build one deterministic infeasible constraint set and calculate a
   grounded scope-expansion counterfactual. (Berlin demo set → impasse →
   800→1200 m widening; `tests/api/impasse.test.ts` + recorded run.)
8. [IMPLEMENTED+RECORDED] Verify one-click navigation handoff from the accepted
   destination. (`prepare_navigation` → geo/Google/Apple links; e2e checks the
   href and the recorded run captures it. Not yet clicked through on a real
   device.)
9. [DONE] Confirm the selected data and map providers permit the intended usage.
   (Research pass: OpenFreeMap keyless + commercial OK, OSM/ODbL, FOSSGIS OSRM,
   Google Maps URLs — all ToS-cleared and cited; `docs/DEPLOY-COOLIFY.md` +
   `ATTRIBUTION.md`.)
10. [IN PROGRESS] Rehearse the complete three-window narrative within the video
    limit. (An automated paced recording of the full arc exists —
    `test-results/demo-recording/`, ~55 s — well inside the 3-minute limit;
    the human run-through and narration are still owed.)

## Open implementation decisions

These have not yet been selected and should not be treated as settled merely
because the conceptual architecture is clear:

- Frontend, backend, database, and deployment stack.
- WebSockets versus Server-Sent Events for browser projections.
- Map renderer, routing provider, and prepared-area data source.
- Guest token format, room expiry, and account-upgrade path.
- Exact group acceptance rule: unanimity, organizer commit, or configurable.
- Whether the POC implements agent-private evaluation or only shared and
  application-private requirements.
- The scoring/utility model used after all hard constraints pass.
- The algorithm used to find a useful minimal conflicting set.
- Whether internal generative interpretation runs locally or through a hosted
  model.
- The prepared demonstration area and exact venue scenarios.
- Project name and visual identity.
- The smallest useful boundary for extracting `negotiation-core` as a package.

## Deferred product opportunities

- Direct Google Maps or comparable near-realtime data integration.
- Multiple participants' personal AI agents operating with richer learned
  profiles.
- Live shared location and arrival tracking.
- WhatsApp or other messaging APIs rather than link sharing alone.
- Restaurant or activity booking and behind-the-scenes organization.
- Promotions, events, and availability feeds.
- Apple CarPlay, Android Auto, and smartwatch experiences.
- AR-glasses presentation and spatial interaction.
- Global-scale geographic ingestion.
- Durable accounts and cross-session preference learning.
- A business model based on booking commissions, premium coordination, or a
  reusable agent-negotiation platform.

These are valuable narrative extensions but should not displace the focused
POC.
