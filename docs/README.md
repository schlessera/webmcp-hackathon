# Spokes documentation

The maintained references below describe the current application. They are
checked against the implementation as it changes; dated reviews, research,
and implementation plans remain records of their original scope.

Start with [Project status](PROJECT-STATUS.md) for what exists and how to
validate it, or [Known limitations](KNOWN-LIMITATIONS.md) for current product,
data, privacy, and operational boundaries.

## Current references

| Document | Purpose |
|---|---|
| [PROJECT-STATUS.md](PROJECT-STATUS.md) | Current product and repository state, validation entry points, and remaining work |
| [KNOWN-LIMITATIONS.md](KNOWN-LIMITATIONS.md) | Limits that still apply; no closed-issue history |
| [SYSTEM-ARCHITECTURE.md](SYSTEM-ARCHITECTURE.md) | Components, command/read paths, storage, realtime coordination, and trust boundaries |
| [protocols/INTERACTION-AND-BINDING.md](protocols/INTERACTION-AND-BINDING.md) | The 24-tool WebMCP catalog, actual output shapes/budgets, revisions, identity, consent, and agent boundaries |
| [protocols/NEGOTIATION-PROTOCOL.md](protocols/NEGOTIATION-PROTOCOL.md) | Current negotiation objects, commands, events, phases, and privacy projections |
| [protocols/SPATIAL-PROTOCOL.md](protocols/SPATIAL-PROTOCOL.md) | Current spatial payloads, candidate pools, evidence, eligibility, and destination/arrival behavior |
| [NL-AGENT.md](NL-AGENT.md) | Goal/composer interpretation, built-in agent review, and private screening |
| [DATA-QUALITY.md](DATA-QUALITY.md) | Prepared regions, data freshness, coverage, and evidence limits |
| [ENRICHMENT-SOURCES.md](ENRICHMENT-SOURCES.md) | Implemented provider paths, caches, and source handling |
| [PREPOPULATE.md](PREPOPULATE.md) | Warm a serving database's regional provider caches without creating a room |
| [DEMO-RUNBOOK.md](DEMO-RUNBOOK.md) | Repeatable local demonstration and validation workflow |
| [DEPLOY.md](DEPLOY.md) | Caddy/Hetzner deployment, checks, secrets, rollback, and fixture reset |
| [DEPLOY-COOLIFY.md](DEPLOY-COOLIFY.md) | Production Compose environment reference and optional, unverified Coolify setup |
| [Repository README](../README.md) and [PRODUCT.md](../PRODUCT.md) | Setup, product behavior, and brand principles |
| [COPY.md](../apps/web/COPY.md) and [SPOKES-UI.md](../apps/web/SPOKES-UI.md) | Current interface copy, interaction rules, and known wording gaps |
| [FACETS.md](../apps/server/FACETS.md) | Implemented classification, evidence, and progress contracts |
| [Data attribution](../packages/contracts/data/ATTRIBUTION.md) | Snapshot licenses, runtime sources, and cache handling |

The landing page links directly to the WebMCP binding and Known limitations.
Executable contracts in [packages/contracts](../packages/contracts/src) and
the server/browser implementation are the authority for exact wire fields.
A checked-in document does not certify the build currently served by a host.

## Design background and historical snapshots

These explain intent, decisions, or findings at a particular point. They are
not current implementation checklists or promises about deployed behavior.

| Material | Role |
|---|---|
| [PRODUCT-CONCEPT.md](PRODUCT-CONCEPT.md) | Original product thesis and intended experience |
| [EXPERIENCE-AND-DEMO.md](EXPERIENCE-AND-DEMO.md) | Proposed user journeys, role-play scenario, and demonstration narrative |
| [MVP-AND-RISKS.md](MVP-AND-RISKS.md) | Time-boxed MVP scope and planning record |
| [PROTOCOLS.md](PROTOCOLS.md) | Superseded protocol boundary sketch; use the current `protocols/` references |
| [PLAN-LIVE-DATA-AND-ONBOARDING.md](PLAN-LIVE-DATA-AND-ONBOARDING.md) | Live-data/onboarding implementation-wave plan |
| [PLAN-ONBOARDING-AND-MULTISTEP.md](PLAN-ONBOARDING-AND-MULTISTEP.md) | Multi-step and invite implementation-wave specification |
| [REDESIGN-HANDOFF.md](REDESIGN-HANDOFF.md) and [design/HANDOFF.md](design/HANDOFF.md) | Redesign handoffs and mockup context |
| [design/SYNC.md](design/SYNC.md) | Design-tool synchronization record |
| [IDEATION-JOURNAL.md](IDEATION-JOURNAL.md) | Exploration and discarded directions |
| [SUBMISSION.md](SUBMISSION.md) | Submission preparation draft |
| [VALIDATION-SPIKE-1-AUTOMATED-DEMO.md](VALIDATION-SPIKE-1-AUTOMATED-DEMO.md) | Dated automation/discovery investigation and results |
| [SECURITY-REVIEW-2026-09-07.md](SECURITY-REVIEW-2026-09-07.md) | Security findings and validation for the reviewed revision |
| [research/](research/) | Dated provider benchmarks, crawl results, and measurement artifacts |

Other dated security reports and local submission artifacts retain their own
scope. Use current references for present behavior and those records for
historical evidence; do not read old pass counts as a fresh test result.

## Challenge and technology reference material

The root [hackathon overview](../HACKATHON-OVERVIEW.md),
[rules](../HACKATHON-RULES.md), [resources](../HACKATHON-RESOURCES.md), and
[WebMCP reference](../WEBMCP-REFERENCE.md) are background source material.
For the browser API's present availability, follow the official Chrome links
in the [binding](protocols/INTERACTION-AND-BINDING.md#21-registration-model-static-surface).
