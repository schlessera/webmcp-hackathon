# Wire diagnostics

Wire answers three questions: what happened, what caused it, and where the
time went. It stays inside the `{ }` drawer. Expand opens space for the event
list and inspector together; compact and mobile layouts drill into one event
at a time.

## Reading the views

- **Activity:** chronological events with a causal graph, source shapes, outcomes, decoded
  body sizes and duration. Search matches routes, outcomes, request IDs and
  recorded metadata. Summary buttons select attention, running and slow HTTP
  events. Hover or keyboard focus highlights the connected chain. Counts summarize the retained recording; the result line states how
  many pass the current filters.
- **Timing:** all displayed events share a linear scale. Overlapping bars
  show concurrent work; causal connectors stay visible alongside the bars.
  No log scale or guessed sequential stage placement.
- **Flow:** a sequence diagram with columns for page, HTTP, socket, tools and
  agent work. Solid edges represent a recorded parent or shared request ID;
  dashed edges represent a revision match; dotted edges represent another
  attempt with the same operation key. Adjacency never implies causation.
  All views can scroll through the full retained history. Only visible rows
  and clipped connectors are drawn. Links continue to offscreen endpoints,
  with above/below navigation; open ends and a Show control reveal filtered
  endpoints. Coincident offscreen paths are bundled, without losing records.
- **Inspector:** select a row or graph node, follow a connection, or focus the
  whole connected set. The chain summary reports elapsed time (without adding
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
a 12 MiB serialized metadata budget (not a measurement of JS heap usage).
Completed leaves leave first, preserving parents and HTTP requests while
their explicitly linked children remain. Other completed events leave before
open work; hard limits still apply and eviction is counted. Notifications are
batched per microtask. Pause freezes a snapshot and unsubscribes the view;
capture continues. Export serializes the displayed subset as versioned JSON
and omits free-form detail fields. Clear resets this page's history.

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
boundaries and correlation versus inference. The browser regression covers
selection, graph navigation, related filtering, pause/resume, JSON export,
keyboard navigation, the bounded DOM with 5,000 events and a large fan-out, offscreen/filtered
connections, connection paging, and the mobile inspector.
