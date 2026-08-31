# Project Design Documentation

This directory captures the concept developed for the WebMCP Challenge as of
August 31, 2026.

## Current direction

Build a concrete collaborative destination-planning application that also
serves as a proof of concept for a more general idea:

> Personal AI agents participate in shared web applications through WebMCP,
> advocate for their users, and reveal only the minimum information needed to
> reach a collective decision.

The visible product is a live, multi-participant map room. Each participant can
contribute requirements, preferences, vetoes, and approvals through the map,
the shared application, or their personal ChatGPT. A neutral coordinator finds
collectively viable destinations, detects impasses, and privately negotiates
bounded adjustments when necessary.

The map is the first reference application, not the limit of the underlying
mechanism.

## Documents

- [PRODUCT-CONCEPT.md](PRODUCT-CONCEPT.md) — product thesis, value proposition,
  actors, and intended experience.
- [SYSTEM-ARCHITECTURE.md](SYSTEM-ARCHITECTURE.md) — system boundaries, data
  flows, realtime behavior, privacy model, and relationship to ChatGPT.
- [PROTOCOLS.md](PROTOCOLS.md) — the original protocol boundary sketch
  (superseded by the detailed designs below).
- [protocols/NEGOTIATION-PROTOCOL.md](protocols/NEGOTIATION-PROTOCOL.md) —
  normative design of `negotiation/v1`: objects, events, privacy tiers,
  sync discipline, state machines, invariants.
- [protocols/SPATIAL-PROTOCOL.md](protocols/SPATIAL-PROTOCOL.md) — normative
  design of `spatial-destination/v1`: IDs, scope, dossiers, domain payloads,
  spatial commands, eligibility semantics.
- [protocols/INTERACTION-AND-BINDING.md](protocols/INTERACTION-AND-BINDING.md)
  — how the protocols compose, the 14-tool WebMCP surface, result envelope,
  error model, demo sequences, security binding, versioning.
- [EXPERIENCE-AND-DEMO.md](EXPERIENCE-AND-DEMO.md) — user flows, impasse
  resolution, three-participant demonstration, and narrative.
- [MVP-AND-RISKS.md](MVP-AND-RISKS.md) — POC scope, validation work, known risks,
  mitigations, and deferred opportunities.
- [VALIDATION-SPIKE-1-AUTOMATED-DEMO.md](VALIDATION-SPIKE-1-AUTOMATED-DEMO.md)
  — researched critical path and automation design for ChatGPT WebMCP discovery
  with three parallel participant contexts.
- [IDEATION-JOURNAL.md](IDEATION-JOURNAL.md) — the exploration that produced the
  current direction, including discarded concepts, role-play findings, likes,
  wishes, questions, and concerns.

## Existing reference documents

The repository-root files remain the source material for the challenge and the
WebMCP technology:

- [../HACKATHON-OVERVIEW.md](../HACKATHON-OVERVIEW.md)
- [../HACKATHON-RULES.md](../HACKATHON-RULES.md)
- [../HACKATHON-RESOURCES.md](../HACKATHON-RESOURCES.md)
- [../WEBMCP-REFERENCE.md](../WEBMCP-REFERENCE.md)

## Decisions already made

- Build a meaningful standalone product, not a feature inside an existing
  second-brain project.
- Keep the underlying negotiation mechanisms reusable and suitable for later
  open-source extraction.
- Use a map-based group destination decision as the reference domain.
- Make async multi-participant collaboration the central differentiator.
- Treat ChatGPT as a participant through WebMCP, not as the realtime event bus.
- Keep the application authoritative for state, identity, privacy, and consent.
- Separate world knowledge, neutral coordination, and personal advocacy.
- Separate the generic negotiation protocol from the map-domain protocol.
- Include a minimal impasse resolver in the POC.
- Use prepared geographic areas for demo reliability while keeping a path to
  pluggable live data providers.
- Implement all three privacy tiers fully in v1, including agent-private
  screening and the progressive disclosure ladder (2026-08-31).
- Agreement rule for v1: all active participants accept (or abstain), then
  the organizer commits with an in-page confirmation (2026-08-31).
- Register a static WebMCP tool surface at page load; express phase and state
  in tool results, not in dynamic tool registration (2026-08-31).
