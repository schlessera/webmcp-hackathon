# Ideation Journal

This document preserves the exploration and unresolved questions behind the
current specification.

## Starting problem-space deconstruction

The hackathon permits action across several interacting systems:

- The human and their conversational context.
- ChatGPT or another external personal AI.
- WebMCP as the live page's semantic tool surface.
- The web application's visible interface and internal state.
- An application-side AI or deterministic reasoning system.
- External world-data providers and services.
- Other humans and their independently contextualized agents.

The initial design lens was:

- What is difficult for an external agent to comprehend by looking at a UI but
  easy for the application to expose from internal state?
- What is difficult for ChatGPT to reason about alone but easy for a human to
  judge visually?
- Where can a human, external agent, and application-side intelligence each do
  the part they are best suited for?

Interactive spatial decision-making emerged as a strong answer: the page owns
semantic map state, an internal council can combine structured evidence, an
external personal agent understands the user's conversational context, and a
human can rapidly judge spatial fit.

## Concepts explored

Three broad domains were sparked:

- Helping citizens navigate public online services and forms.
- Interactive support for online games.
- Interactive maps with personalized help, such as finding places compatible
  with special needs.

The public-service concept was discarded because a meaningful implementation
would require excessive access to public-service systems. The game concept was
appealing but would require mechanics, assets, demo content, and playtesting in
addition to the WebMCP work. The map concept won because it was both personally
useful and feasible as a standalone project.

An informal allocation was 40 percent interest in the game direction and 60
percent in personalized spatial discovery.

The project will remain standalone for the challenge. Its mechanisms may later
be reused in an open-source second-brain system, but that integration is not the
hackathon deliverable.

## Concept evolution

The spatial concept evolved through these stages:

1. **Invisible City** — reveal useful semantic information hidden behind a map.
2. **Needs Council** — evaluate several participants' needs rather than one
   user's search query.
3. **Veto and Reconvene** — treat a natural-language veto as structured input,
   recompute the candidate set, and redraw the map.
4. **Shared async room** — give every participant an identity, projection, map,
   feed, and optional personal ChatGPT.
5. **Private personal-agent negotiation** — let agents advocate under explicit
   privacy and delegation rules.
6. **Impasse resolution** — identify when agreement is impossible and privately
   negotiate grounded adjustments.
7. **Reusable protocols** — separate generic agent negotiation from spatial map
   interaction.

## What felt valuable

- A constant visual representation of the surroundings while exploring.
- Offloading research, organization, and comparison while continuing to state
  requirements conversationally.
- Encoding useful preferences for better future starting points.
- Asking higher-value logistical questions, including ordering goals and
  considering public transportation.
- Saving and sharing an outcome through existing map integrations.
- Incorporating weather, traffic, events, and other live information.
- Handing a veto to a neutral mediator rather than creating interpersonal
  tension.
- Obtaining aggregate information such as expected total cost.
- Handling dogs, accessibility, dietary needs, and other special requirements.

## Wishes and longer-term possibilities

- Direct Google Maps-quality data for near-realtime option discussion.
- A live-sharing mechanism for several phones, parallel requirements, and
  vetoes.
- Booking restaurants or activities after agreement.
- Realtime promotions, events, and availability.
- A credible startup business model rather than only a technical demonstration.
- Apple CarPlay or Android Auto integration for in-car discussion.
- Smartwatch navigation and lightweight approvals.
- AR-glasses interaction.
- A future in which every participant already has a personal AI tuned to their
  needs and the agents coordinate organizational work behind the scenes.

## Questions a first-time user may ask

- What can this do?
- Can I click on the map?
- How do I tell it what to optimize for?
- How do three people combine their preferences?
- How do I plan for the near future rather than right now?
- Does it work with a smartwatch?

The interface and demo should answer the first five visibly. Smartwatch support
can remain a future extension while navigation links remain mobile-friendly.

## Concerns raised

- The same application might be implemented without WebMCP.
- Agent interaction may be too slow to feel enjoyable.
- Suggestions may be poor because of insufficient or unreliable data.
- Google Maps API costs may be too high.
- Reviews may be unavailable except through generic web search.
- Commercial data might require expensive B2B access.
- Proxies or scraping might create legal problems.
- Provider terms of service may prevent desired use.
- Cached data conflicts with real-time claims.
- Temporary moods may accidentally become permanent personality traits.
- A judge may not appreciate the technical difficulty of reliable location data.
- The experience may require unacceptable setup such as a user's own GCP OAuth
  client.
- A shared result may inadvertently reveal a supposedly private requirement.

The current architecture addresses these through a prepared area, evidence and
freshness, provider adapters, session/durable-memory separation, guest access,
server-side projections, and a demo centered on WebMCP-specific agent
participation rather than merely map search.

## Early role-play: individual snack and dog walk

The user asked for a small snack while with a dog, then requested a park detour
so the dog could relieve itself. The selected kiosk was full, prompting a nearby
alternative. The user ate at Garden Cafe Window, liked it, and explicitly asked
to keep the visit in history only.

Debrief:

- The flow felt too basic and too close to ordinary Google Maps navigation.
- The application should have proactively offered one-click navigation.

## Second role-play: three-person meal

The group included:

- Sarah, who needed a vegetarian option.
- Joe, who needed lactose-intolerance compatibility.
- A flexible organizer who wanted to avoid Italian after eating it the previous
  day and wanted an affordable option.

Sarah rejected Cedar Table because she had visited the previous week. Joe would
arrive via Uber. Sarah asked the organizer to pick her up from the nearest
subway station and navigate there.

This scenario demonstrated that aggregation, vetoes, and logistics were useful,
but a single synchronous conversation poorly represented the participants. It
sparked the shared-room design:

- One person initiates and shares a link or QR code.
- Everyone joins with their own identity.
- Contributions can happen asynchronously.
- The shared feed contextualizes who said or vetoed what when public.
- Direct map actions and chat/agent actions are equivalent.
- Every client sees live updates.
- ChatGPT synchronizes on its next action rather than pretending to receive
  background pushes.
- Agreement transitions into meeting-point and arrival coordination.

## The central architectural insight

ChatGPT must not be the realtime bus. The platform owns the session and event
stream. Each participant's ChatGPT joins as an intelligent participant through
WebMCP.

The platform also cannot let one model be the source of truth for both reality
and compromise. Responsibilities separate into:

- World knowledge: what destinations and facts may exist.
- Shared council: what is collectively feasible and authorized.
- Personal agents: what is acceptable to their respective users.
- Human participants: what may be disclosed, delegated, relaxed, and finally
  accepted.

## Current working thesis

> Personal AI agents participate in shared web applications through WebMCP,
> advocate for their users, and reveal only the minimum information needed to
> reach a collective decision.

The map reference application proves that thesis through a domain where the
visual interface, internal semantic state, real-world evidence, conflicting
preferences, privacy, and post-decision logistics all matter.

