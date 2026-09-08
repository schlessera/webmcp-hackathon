# Wire diagnostics

Wire answers three questions: what happened, what caused it, and where the
time went. It stays inside the `{ }` drawer. Expand opens space for the event
list and inspector together; compact and mobile layouts drill into one event
at a time.

## Reading Wire

- **Activity:** chronological events with a causal graph, source shapes, outcomes, decoded
  body sizes and duration. Turns preview the person's words and reply; socket
  frames name the contained events. Search also matches conversation text,
  projected event descriptions and tool outcomes. Summary buttons select attention, running and slow HTTP
  events. Hover or keyboard focus highlights the connected chain. Counts summarize the retained recording; the result line states how
  many pass the current filters.
  The graph and type filters share PATHS order: Page, Agent, Tool, HTTP,
  Socket. Solid edges represent a recorded parent or shared request ID;
  dashed edges represent a revision match; dotted edges represent another
  attempt with the same operation key. Adjacency never implies causation.
  The activity view scrolls through the full retained history without a tab selector. Only visible rows
  and clipped connectors are drawn. Links continue to offscreen endpoints,
  with above/below navigation; open ends and a Show control reveal filtered
  endpoints. Coincident offscreen paths are bundled, without losing records.
- **Inspector:** select a row or graph node, follow a connection, or focus the
  whole connected set. Conversation, interpreted requirements, clarification
  choices, tool calls and viewer-projected event descriptions appear first,
  without expanding raw metadata. Tool calls include round, duration and a
  safe count/status summary. Approval proposals are recorded as awaiting
  approval, never as applied changes. A child request shows the conversation
  that started it. Older recordings explicitly identify missing content.
  The chain summary reports elapsed time (without adding
  overlapping durations), attention, retries, model usage and the longest HTTP
  request. Connection lists page through 20 links at a time. Timings distinguish server time, the unaccounted
  remainder, reading the body and parsing JSON. An invalid JSON response
  retains its HTTP status and size. All recorded metadata is expandable.

The clock is wall time, while completed client durations use a monotonic
clock. The difference between time to headers and the server measurement
includes transit and browser scheduling, and is not labelled pure network
latency. HTTP sizes are decoded body bytes; tool result budgets are
characters. Neither is an estimate of compressed transfer bytes.

## Collection and boundaries

The browser ring retains up to 5,000 events and at most 100 keepalives, within
a 12 MiB serialized recording budget (not a measurement of JS heap usage).
Completed leaves leave first, preserving parents and HTTP requests while
their explicitly linked children remain. Other completed events leave before
open work; hard limits still apply and eviction is counted. Notifications are
batched per microtask. Pause freezes a snapshot and unsubscribes the view;
capture continues. Export serializes the displayed subset as versioned JSON
and omits conversation content, event descriptions and free-form detail
fields. Exports keep tool names, rounds, timings and statuses. Clear resets this page's history.

Own shared/application-private conversation text and server-projected socket
descriptions stay in this page's memory. Each text is capped at 4,096
characters; lists at 32 items, with omissions or shortening shown. The store
copies explicit fields only. It never retains raw socket payloads, tool
arguments/results, approval IDs, model prompts or held agent-private text.
These additions do not create durable conversation logs. Tool metadata sent
back to the participant includes only tool names, rounds, timings, statuses
and allowlisted result counts. The existing response already carries the
person's reply and approval card; Wire keeps only its display title.

Instrumented POST requests and authenticated place/landmark reads opt in with `x-wire-trace: 1`. A request-scoped
recorder follows the existing async work context, including enqueued work.
The response returns at most 32 spans in a header capped at 6,000 characters.
It records model attempts (including retries and reported usage), outbound
attempts through body completion, and metadata/matrix cache hits. A span still
running when response headers are sent is explicit. The snapshot is then
sealed; it does not claim to contain later background work. Socket pipeline
and facts frames retain stage/progress counters for that later work.

These spans contain timings, counters, model identifiers and provider-purpose
labels. They contain no URLs, search queries, prompts, authorization headers
or response bodies. The request log adds correlation ID, route template,
status and duration. There is no new global diagnostics endpoint or durable
trace archive. The existing global outbound endpoint stays authenticated and
development-only; its UI shows a refreshable snapshot and distinguishes
unavailable access from an empty process history.

The request hook starts after parsing, following the context considerations
in the [Fastify request-context documentation](https://github.com/fastify/fastify-request-context).
No tracing or charting dependency was added.

## Performance and validation

The drawer is a separate lazy-loaded chunk. Closed raw sections do not
serialize their payloads, the stream mounts only visible rows plus overscan,
and identical offscreen connections share SVG paths. Existing drawer colours and typography
tokens provide the visual language; SVG/CSS supply shapes, patterns and
diagrams. No new animation runs per event.

Unit and API regressions cover request isolation, queued context propagation,
header limits, late work, malformed responses, chronology, rollover, metadata
boundaries, local-content limits/export exclusions, approval-call recording
and correlation versus inference. The browser regression covers
selection, graph navigation, related filtering, pause/resume, JSON export,
keyboard navigation, the bounded DOM with 5,000 events and a large fan-out, offscreen/filtered
connections, connection paging, and the mobile inspector.
