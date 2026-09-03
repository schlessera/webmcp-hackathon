# Protocol Boundaries

> **Superseded by the detailed protocol design (2026-08-31).** This file is
> the original sketch. The normative design now lives in:
> [protocols/NEGOTIATION-PROTOCOL.md](protocols/NEGOTIATION-PROTOCOL.md),
> [protocols/SPATIAL-PROTOCOL.md](protocols/SPATIAL-PROTOCOL.md), and
> [protocols/INTERACTION-AND-BINDING.md](protocols/INTERACTION-AND-BINDING.md).
> Where they differ (tool names were consolidated; privacy and agreement
> semantics were finalized), the protocols/ documents win.

There are two application protocols running over the WebMCP substrate:

```text
WebMCP tool discovery and invocation
  |
  +-- Agent Negotiation Protocol
        |
        +-- Spatial/Map Domain Protocol
```

WebMCP is the browser-agent capability mechanism. It does not itself define
multi-party negotiation, privacy semantics, or spatial interaction.

## Protocol 1: Agent Negotiation Protocol

### Purpose

Define how a personal agent represents its user in a shared decision without
revealing more information than necessary.

### Scope

- Session identity, authentication context, and capabilities.
- Revision synchronization and reconnect behavior.
- Privacy and visibility classifications.
- Delegated authority and consent.
- Requirements, preferences, and proposal lifecycles.
- Stances, vetoes, conditional acceptance, and counteroffers.
- Impasse notification and bounded relaxation.
- Explicit agreement and audit history.
- Participant-specific projections of shared events.

### Out of scope

- Coordinates, maps, destinations, routes, or venue attributes.
- World-data acquisition.
- Visual rendering.
- Domain-specific definitions of feasibility.

### Core concepts

#### Intent

The collective outcome the room is trying to reach.

#### Requirement

A participant-owned condition with hardness, visibility, scope, and delegation.

#### Proposal

A candidate shared outcome identified by a stable domain reference.

#### Stance

One of:

```text
accept
reject
abstain
conditionally_accept
request_information
offer_relaxation
require_user_approval
```

#### Counteroffer

A bounded adjustment that would make a proposal or new search acceptable.

#### Impasse

A verified inability to produce a satisfying proposal from the current known
candidate universe and authorized constraints.

#### Agreement

An explicitly confirmed shared result. A high rank is not agreement.

#### Session delta

The participant-authorized changes since a specified revision.

### Illustrative WebMCP tools

These names are provisional and should remain few, narrow, and well described:

```text
connect_to_session
sync_session
submit_requirement
update_requirement
respond_to_proposal
offer_relaxation
request_user_approval
set_ready_state
confirm_agreement
```

Mutation inputs should carry `baseRevision`; successful results return the new
revision, the participant's resulting projection, and outstanding decisions.

### Generic envelope

The stable negotiation contract can wrap a typed domain payload:

```json
{
  "protocolVersion": "negotiation/v1",
  "sessionId": "room_123",
  "baseRevision": 17,
  "actorId": "participant_joe",
  "messageType": "requirement_submitted",
  "visibility": "application-private",
  "authority": "locked",
  "domain": "spatial-destination/v1",
  "payload": {}
}
```

The server derives actor identity from the authenticated page context; callers
must not be able to impersonate a different `actorId` through tool arguments.

## Protocol 2: Spatial/Map Domain Protocol

### Purpose

Allow the map, human gestures, world-knowledge service, and personal agent to
refer to and manipulate the same spatial situation.

This protocol exposes semantic state that an agent cannot reliably infer from
pixels alone.

### Scope

- Search area, time horizon, and transportation modes.
- Stable references for destinations, map pins, routes, and meeting points.
- Candidate dossiers, claims, sources, freshness, and confidence.
- Current viewport, selection, shortlist, exclusions, and active route.
- Inspecting, focusing, comparing, and proposing destinations.
- Vetoes and conditions whose subject is a spatial candidate.
- Route, detour, and meeting-point calculations.
- Navigation handoff.
- Translation between map gestures and semantic session events.
- Translation between agent commands and visible map changes.

### Out of scope

- Participant authentication and privacy authorization.
- Generic agreement semantics.
- Who should compromise.
- Permission to disclose or relax private requirements.

### Illustrative WebMCP tools

```text
get_spatial_context
set_search_area
set_planning_time
inspect_destination
compare_destinations
focus_destination
propose_destination
calculate_meeting_point
preview_route
prepare_navigation
```

Tools that express a negotiation stance should delegate to the negotiation
engine rather than duplicate it. For example, vetoing a selected pin produces
the generic `respond_to_proposal` command with a map-specific candidate ID and
reason payload.

### Candidate dossier sketch

```json
{
  "candidateId": "place_42",
  "name": "Garden Cafe Window",
  "location": { "lat": 0, "lng": 0 },
  "attributes": [
    {
      "claim": "dog-friendly outdoor seating",
      "status": "verified",
      "source": "provider-or-curated-record",
      "observedAt": "2026-08-31T10:00:00Z",
      "confidence": 0.9
    }
  ],
  "mapRevision": 8
}
```

The POC must distinguish an absent attribute, an unverified attribute, and a
verified negative attribute.

## Composition examples

| Negotiation event | Spatial/map payload |
|---|---|
| `requirement_submitted` | Wheelchair-accessible destination required |
| `proposal_created` | Destination `place_42` |
| `stance_submitted` | Conditional acceptance of `place_42` |
| `scope_change_proposed` | Expand radius from 800 m to 1.5 km |
| `impasse_detected` | No verified destination satisfies the current set |
| `agreement_confirmed` | Destination and arrival plan (meeting points deferred) |

## First-connection capability manifest

The first sync should teach the personal agent both contracts:

```json
{
  "negotiationProtocol": "v1",
  "domain": {
    "type": "spatial-destination",
    "protocol": "v1",
    "capabilities": [
      "destination-search",
      "map-selection",
      "navigation-handoff"
    ]
  },
  "privacy": {
    "allowedVisibilities": [
      "shared",
      "application-private",
      "agent-private"
    ]
  },
  "revision": 17
}
```

The negotiation protocol teaches the agent how to participate. The domain
manifest teaches it what the current application can do.

## Boundary rules

- The negotiation protocol owns identity, privacy, consent, and agreement.
- The map protocol owns spatial facts, referents, and interaction semantics.
- The map cannot bypass negotiation permissions.
- The negotiation engine cannot manipulate map state without domain commands.
- The world backend never receives a participant's private explanation when an
  attribute-only query is sufficient.
- Tool schemas should use stable IDs rather than labels or screen positions.
- Direct manipulation and agent invocation must converge on the same commands.
- Negotiation and domain protocol versions evolve independently.

## Candidate package structure

The reusable open-source result could eventually be organized as:

```text
negotiation-core
  event envelopes, projections, consent, revision sync, WebMCP helpers

spatial-domain
  destination payloads, map state, routes, interaction commands

world-provider-adapters
  curated/prepared data plus optional external providers

map-reference-app
  the complete hackathon experience
```

For the POC, extraction should follow the working vertical slice rather than
precede it.
