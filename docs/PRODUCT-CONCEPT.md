# Product Concept

## One-sentence pitch

A shared map where people and their personal AI agents privately negotiate
requirements, resolve conflicts, and agree on a destination together.

## Broader thesis

Traditional web applications assume one user manipulating one interface. Many
real decisions instead involve several people, hidden personal context,
conflicting constraints, incomplete information, and an eventual need for
explicit agreement.

WebMCP creates an opportunity for a personal agent to participate inside the
live application rather than infer everything from screenshots or operate a
separate SaaS workflow. The personal agent can understand its user, advocate
for that user through a structured tool contract, and disclose only the
decision-relevant information the user authorizes.

The project is therefore both:

1. A polished group destination-planning application.
2. A proof of concept for reusable WebMCP-mediated personal-agent negotiation.

## The concrete problem

Groups routinely struggle to choose somewhere to go because their needs are
distributed across people and communicated piecemeal:

- Dietary restrictions, accessibility needs, dogs, children, and budgets.
- Temporary preferences such as avoiding a cuisine eaten yesterday.
- Different starting positions and transportation modes.
- Personal information someone may not want to explain publicly.
- Vetoes that arrive late and force the group to start over.
- Logistics after the destination has been chosen.

A search result list can optimize for one query, but it does not mediate a
multi-party decision. A group chat can collect messages, but it does not
maintain a structured constraint model or a live spatial representation.

## Intended experience

One participant creates a planning room and shares a link through an existing
channel such as WhatsApp, or shows a QR code to people nearby. Participants
join as guests and see different authorized projections of one shared session.

Each person can:

- State requirements conversationally.
- Mark a requirement as shared or private.
- Distinguish locked, approval-required, bounded-negotiable, and soft needs.
- Click, inspect, shortlist, veto, or approve options directly on the map.
- Use their personal ChatGPT to advocate and act through WebMCP.
- Contribute asynchronously and catch up later.

The system:

- Maintains a constant visual representation as options change.
- Performs the work of research, organization, comparison, and aggregation.
- Combines several participants' needs without publicly exposing private
  details.
- Shows why candidates are useful without revealing protected reasons.
- Detects when no known option satisfies the current requirements.
- Suggests quantified ways to recover from an impasse.
- Requires consent before relaxing constraints.
- Coordinates meeting points, routes, and one-click navigation after agreement.

## Product identity

This is not primarily "AI search on a map." It is a:

> Shared asynchronous negotiation space for groups and their agents.

Google Maps or another navigation application is a downstream handoff. This
application owns the collective decision: gathering intent, protecting private
context, comparing tradeoffs, recording vetoes, reaching agreement, and
coordinating arrival.

## Actors and responsibilities

### Human participant

Owns preferences, privacy choices, delegations, and final authority. A human
can interact through chat-like input or direct map controls.

### Personal AI agent

Advocates for one participant through WebMCP. It may use private knowledge of
its user, but can only act within the user's declared or confirmed authority.
It responds with structured stances such as accept, veto, conditional accept,
request information, offer a relaxation, or request approval.

### Shared council/coordinator

Acts as the neutral mediator. It owns the authoritative session, event order,
privacy projections, deterministic eligibility checks, impasse detection,
consent, and final agreement.

### World-knowledge backend

Discovers possible destinations and provides factual candidate dossiers:
location, attributes, hours, cost, routes, evidence, freshness, and confidence.
It proposes what may be possible; it does not decide whose needs should yield.

### Map application

Renders the live shared state and gives human gestures and agent commands the
same semantic referents: candidate IDs, pins, search areas, routes, meeting
points, and selections.

## Why WebMCP matters

The page already understands state that is difficult for an external agent to
recover visually:

- What every pin represents.
- Which candidates were filtered out and why.
- Which option is currently selected or vetoed.
- The active search bounds, time, transport mode, and route.
- Source provenance and data freshness.
- The current participant's identity and authorized private projection.
- Changes that occurred since the agent last participated.

WebMCP exposes that semantic state as narrow, contextual tools. It lets the
personal agent act inside the same live session the human sees. Direct map
actions and agent actions use the same underlying commands, and the interface
reflects either immediately.

The target ChatGPT experience keeps the live application open in ChatGPT's
built-in browser while the conversation remains available alongside it. A user
can discuss tradeoffs in chat, watch the map change as tools execute, and also
click the map directly without switching to a disconnected copy of the state.
Embedding the complete product inside the transcript is not required; semantic
tool access to the live in-app browser page is the essential integration.

A conventional SaaS could implement a shared map and forms. The distinctive
WebMCP contribution is that each person's independently contextualized agent
can join the application's structured negotiation without the user recreating
their entire personal context inside the SaaS.

## Privacy promise

The initial promise is intentionally bounded:

> Private information is protected from other participants and their agents.
> The coordinator receives only what is required by the selected visibility
> level.

The POC must not imply cryptographic secrecy from the application operator.
Perfect inference prevention is also impossible in a small group whose members
observe outcomes changing. The practical goal is confidential inputs with
inference-minimizing outputs: no raw private data in other clients, no public
per-person private scores, and no explanations precise enough to disclose the
reason or owner.

## Progressive disclosure modes

1. **Shared:** the requirement and its owner may be visible to the room.
2. **Application-private:** the coordinator can evaluate it, while peers and
   their agents see only its aggregate effect.
3. **Agent-private:** the personal agent evaluates proposals and returns a
   stance without revealing the underlying reason.

Agent-private evaluation minimizes disclosure but makes discovery less
efficient because the application may need to propose candidates before it
knows whether they are acceptable. The system can progressively request a
narrower, safe hint or explicit disclosure if an impasse cannot otherwise be
resolved.

## Generalization beyond maps

The negotiation lifecycle can support other shared decisions by replacing the
domain adapter:

- Scheduling across private calendars.
- Selecting group accommodation or travel plans.
- Collaborative purchasing and vendor selection.
- Allocating shared resources.
- Planning an event.
- Any domain where several personal agents need to reach a shared outcome
  without exporting their users' complete profiles.

The hackathon entry should demonstrate one domain deeply rather than dilute the
demo across several shallow examples.

## Deliberate non-goals for the first version

- Replacing general-purpose navigation providers.
- Global, exhaustive destination coverage.
- Autonomous relaxation of medical, safety, allergy, or accessibility needs.
- Claiming cryptographic privacy or anonymity.
- Fully autonomous background ChatGPT agents.
- Restaurant booking, live GPS tracking, car integration, or AR.
- Automatically learning durable personality traits from session behavior.
- Proving every possible domain for the generic negotiation protocol.
