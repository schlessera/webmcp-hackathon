# WebMCP — Complete Protocol Reference

Compiled 2026-08-27 from the W3C WebML CG spec draft, the Chrome for Developers docs, the OpenAI/ChatGPT guide, Cloudflare, Shopify, Angular, and the reference implementations. Every code block here is either verbatim from a primary source or built directly from the spec algorithms.

**Sources are listed in [§16](#16-sources).** The spec is a CG draft under active change — [§15](#15-known-instability-and-open-questions) tracks what is unstable.

---

## Table of contents

1. [What WebMCP is](#1-what-webmcp-is)
2. [Status and browser support](#2-status-and-browser-support)
3. [When to use it — and when not to](#3-when-to-use-it--and-when-not-to)
4. [WebMCP vs MCP vs actuation](#4-webmcp-vs-mcp-vs-actuation)
5. [Enabling and detecting WebMCP](#5-enabling-and-detecting-webmcp)
6. [Imperative API](#6-imperative-api)
7. [Declarative API](#7-declarative-api)
8. [Complete WebIDL](#8-complete-webidl)
9. [Origins, permissions, and iframes](#9-origins-permissions-and-iframes)
10. [Security](#10-security)
11. [Best practices](#11-best-practices)
12. [Testing, debugging, evals](#12-testing-debugging-evals)
13. [Frameworks and libraries](#13-frameworks-and-libraries)
14. [Platform integrations](#14-platform-integrations)
15. [Known instability and open questions](#15-known-instability-and-open-questions)
16. [Sources](#16-sources)

---

## 1. What WebMCP is

WebMCP lets a web page expose its own functionality — JavaScript functions or annotated HTML forms — as **tools** with natural-language descriptions and JSON Schema signatures. AI agents (browser built-in, iframe-hosted, or extension-hosted) discover those tools and call them with structured arguments, instead of guessing their way through the DOM.

The entry point is a single new object:

```js
document.modelContext
```

The mental model: **your page becomes an in-page MCP server**. Same vocabulary as Model Context Protocol (tools, descriptions, input schemas), but web-native — origins, permissions policy, DOM lifecycle, `AbortSignal`, secure contexts.

The core claim from the explainer, which is the thing worth internalising:

> WebMCP introduces a client-side alternative. It allows web developers to define tools directly in the browser page's script. This enables visually rich, cooperative interplay between a user, a web page, and an agent with shared context.

Three properties fall out of that:

- **The UI stays.** The agent acts *through* your page, not around it. User and agent see the same state.
- **No backend needed.** You reuse the client-side code you already have. No separate MCP server, no replicated auth, no replicated session state.
- **You control the contract.** You decide what an agent can do, at what granularity, with what schema.

### The flow

```
1. Registration  Page calls document.modelContext.registerTool(...)
2. Discovery     Agent queries the browser for the page's active tool list + schemas
3. Invocation    Agent sends structured args matching the tool's inputSchema
4. Execution     Browser mediates; your execute() callback runs in the page
5. Response      Your return value is JSON-serialized and handed back to the agent
```

---

## 2. Status and browser support

| Engine / product | Status |
|---|---|
| **Chrome** | Origin trial live in **Chrome 149**. Local dev via `chrome://flags/#enable-webmcp-testing`. Chrome 153 adds unregistration that does not cancel in-flight executions. |
| **Edge** | Origin trial live in **Edge 150**. Same platform support as Chrome. |
| **ChatGPT Desktop** | Supported out of the box in the in-app browser. Requires **GPT-5.6 Sol** or **GPT-5.6 Terra** — WebMCP is disabled on GPT-5.6 Luna. Not available in Enterprise or Edu workspaces. |
| **Brave** | Experimental support in Leo AI chat. |
| **Firefox** | Standards position open (mozilla/standards-positions#1412), Bugzilla #2018306. Not implemented. |
| **Safari** | Standards position open (WebKit/standards-positions#670). Not implemented. |

Spec: `Shortname: webmcp`, `Status: CG-DRAFT`, W3C Web Machine Learning Community Group. ChromeStatus feature 5117755740913664 still reads "Proposed".

**Practical consequence:** target Chrome 149+ with the flag or an OT token, and the ChatGPT desktop in-app browser. Everything else needs the `@mcp-b/webmcp-polyfill` / `@mcp-b/global` runtime, or graceful degradation.

---

## 3. When to use it — and when not to

### Good fits

WebMCP earns its keep when **the human and the agent both need to be looking at the same live page**:

- **Complex forms.** An agent maps conversation data onto fields correctly instead of guessing whether "name" means full name or first name. Multi-passenger, multi-city, multi-leg booking.
- **Human-first widgets an agent cannot drive.** Date-range pickers, map viewports, canvas editors, seat maps, sliders. Expose `date_pick` or `set_map_bounds` instead of making the agent click pixels.
- **Filtering and search over live client state.** The agent narrows a product grid, a template gallery, a dataset view — and the *user watches the UI update*.
- **Deep or hidden functionality.** A `run_diagnostics` tool on a settings page, buried five menus down. A `get_trybot_failure_snippet` on a code review tool.
- **Authenticated, session-bound work.** The user is already signed in. No credential replication, no OAuth dance for the agent.
- **Collaborative editing.** Agent proposes a batch of uncommitted changes; the user reviews and accepts in the UI.
- **Accessibility leverage.** Agents act as capable intermediaries for assistive-technology users. (Note: WebMCP is *not* an a11y API and does not read the a11y tree — see explainer Issue #91.)

### Poor fits

Explicit non-goals from the spec:

- **Headless / fully autonomous flows.** May technically work; not what it is designed for. There is meant to be a human in the loop.
- **Replacing backend MCP.** If the work is pure server-side API calls with no UI, write an MCP server.
- **Replacing the human UI.** The human interface stays primary; tools augment.

Stated limitations:

- **Overhead on complex sites.** If your app has messy state management, you will refactor before tools behave predictably.
- **Discoverability.** An agent only learns your tools exist by visiting the page. There is no crawlable registry (community projects like `webmcp.cool` are filling that gap informally).

### Decision heuristic

> Would a human *watching this happen* add value? If yes → WebMCP. If the answer is "no, just do it on the server" → MCP server.

---

## 4. WebMCP vs MCP vs actuation

| | **Actuation** | **Backend MCP** | **WebMCP** |
|---|---|---|---|
| Mechanism | Screenshots, DOM/a11y snapshots, simulated clicks | JSON-RPC to your server | `execute()` callback in the page |
| Auth | User's browser session | Replicated on the server | User's browser session |
| State | Inferred from pixels | Replicated on the server | Shared live with the page |
| UI visibility | Yes, but brittle | **None** — page bypassed entirely | Yes, and reliable |
| Reliability | Low; every step re-interpreted | High | High |
| Token cost | High (screenshots, DOM dumps) | Low | Low |
| Build cost | Zero for you | New server + auth + state sync | Reuse existing client code |

WebMCP does **not** conflict with actuation. If the agent can't accomplish something through your tools, it falls back to driving the UI. Tools are a fast path, not a cage.

WebMCP deliberately did **not** adopt MCP wholesale. From the explainer:

> MCP was built primarily for server-to-client and stdio/SSE process communication. It lacks native web concepts like origins, standard browser permissions, DOM integration, and tab-level lifecycle management.

---

## 5. Enabling and detecting WebMCP

### Chrome / Edge local development

1. Open `chrome://flags/#enable-webmcp-testing`
2. Set to **Enabled**
3. Relaunch

### Origin trial (real users)

Register at `https://developer.chrome.com/origintrials/#/register_trial/4163014905550602241` and ship the token as a `<meta http-equiv="origin-trial" content="TOKEN">` or `Origin-Trial` response header.

### Hard requirements

- **Secure context.** `[Exposed=Window, SecureContext]` — HTTPS or `localhost`. No plain `http://` on a public host.
- **Origin-isolated document.** If `document.domain` is enabled (e.g. via `Origin-Agent-Cluster: ?0`), WebMCP is **disabled** and every call rejects with `SecurityError`. `file:` scheme is exempted.
- **`tools` permissions policy.** Defaults to `'self'`. Cross-origin iframes need `allow="tools"`.

### Feature detection

Always feature-detect. Never assume the API exists.

```js
if (typeof document.modelContext?.registerTool === "function") {
  await document.modelContext.registerTool({ /* ... */ });
}
```

Older MCP-B–era demos use `navigator.modelContext`. That is **obsolete**; the spec and Chrome both use `document.modelContext`. Some polyfills still accept the old path as a fallback.

---

## 6. Imperative API

### 6.1 `registerTool()`

```js
Promise<undefined> registerTool(
  ModelContextTool tool,
  optional ModelContextRegisterToolOptions options = {}
)
```

Canonical example, verbatim from the explainer:

```js
const controller = new AbortController();

await document.modelContext.registerTool({
  name: "add-todo",
  description: "Add a new item to the user's active todo list",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "The text content of the todo item" }
    },
    required: ["text"]
  },
  async execute({ text }) {
    // Reuse existing client-side application logic and update UI.
    await addTodoItemToCollection(text);

    return {
      content: [
        {
          type: "text",
          text: `Added todo item: "${text}" successfully.`
        }
      ]
    };
  }
}, { signal: controller.signal });

// To unregister the tool later, abort the signal.
// controller.abort();
```

### 6.2 `ModelContextTool` fields

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | `DOMString` | **yes** | Unique within the document. **1–128 chars.** Only ASCII alphanumerics, `_`, `-`, `.`. Anything else → `InvalidStateError`. |
| `title` | `USVString` | no | Human-readable label for browser UI. Should be localized to the user's language. If absent the UA picks its own display string. |
| `description` | `DOMString` | **yes** | Natural-language description. Must be non-empty. This is what the model reads to decide whether to call you. |
| `inputSchema` | `object` | no | JSON Schema object. Stored internally as a **stringified** schema. |
| `execute` | `ToolExecuteCallback` | **yes** | `(inputObject, { signal }) => Promise<any>` |
| `annotations` | `ToolAnnotations` | no | `{ readOnlyHint, untrustedContentHint }`, both default `false`. |

### 6.3 `inputSchema`

Standard JSON Schema (2020-12 vocabulary in the spec references). Top level is an object schema.

```js
inputSchema: {
  type: 'object',
  properties: {
    layer:  { type: 'string', enum: ['sauce-layer', 'cheese-layer'] },
    action: { type: 'string', enum: ['add', 'remove', 'toggle'] },
  },
  required: ['layer'],
}
```

Richer form using `oneOf` with `const`/`title` pairs, which gives the model a label per value — verbatim from the Chrome imperative docs:

```js
inputSchema: {
  "type": "object",
  "properties": {
    "timeframe": { "type": "string", "oneOf": [
      { "type": "string", "const": "today",        "title": "Today" },
      { "type": "string", "const": "yesterday",    "title": "Yesterday" },
      { "type": "string", "const": "last_7_days",  "title": "Last 7 Days" },
      { "type": "string", "const": "last_30_days", "title": "Last 30 Days" },
      { "type": "string", "const": "last_6_months","title": "Last 6 Months" }],
      "enum": [ "today", "yesterday", "last_7_days", "last_30_days", "last_6_months" ],
      "description": "Timeframe for the order lookup." }
  },
  "required": [ "timeframe" ]
}
```

Rules that actually matter:

- The schema is serialized with `JSON.stringify()` at registration. A circular reference, or a `toJSON()` returning `undefined`, rejects the promise with the thrown `TypeError`.
- **Schema constraints are not enforced by the browser.** Validate in code. The spec has an open issue (#92) on input validation; today nothing checks the agent's arguments against your schema before `execute` runs.
- Add `additionalProperties: false` to tighten what the model may invent.
- Prefer `enum` over free strings wherever the value space is closed.
- Use natural-language values over IDs: `shipping: "Express"`, not `shipping_id: 1`.

### 6.4 `execute()` — the contract

```js
callback ToolExecuteCallback = Promise<any> (
  object inputObject,
  ToolExecuteCallbackOptions options   // { signal: AbortSignal }
);
```

**Input.** The agent's JSON arguments, already parsed into a plain object in your realm. If the JSON is malformed or does not parse to an Object, execution fails before your callback runs.

**Output.** Whatever you return is passed through `JSON.stringify()`. If serialization throws, the call is reported to the agent as a **failure**. Three shapes are in the wild:

```js
// 1. Plain string — what Chrome's own demos use. Simplest, works.
execute: ({ layer, action }) => {
  toggleLayer(layer, action);
  return `Performed ${action || 'toggle'} on layer: ${layer}`;
}

// 2. MCP content-block object — used in the explainer and by OpenAI.
execute: async ({ text }) => ({
  content: [{ type: "text", text: `Added todo item: "${text}" successfully.` }]
})

// 3. Arbitrary JSON — fine, it just gets stringified.
execute: async ({ size, color }) => {
  const response = await fetchDresses(size, color);
  return response.json();
}
```

Native Chrome does not interpret shape (2) specially — it stringifies like anything else. The `{content:[...]}` convention exists so MCP-shaped runtimes (`use-webmcp-tool`, `@mcp-b/global`) can normalize consistently. **Pick one and be consistent.** For a native-Chrome-first project, plain strings and plain JSON objects are the lower-friction choice.

**Errors.** A rejected promise or a thrown value is reported to the agent as failure, and the UA may log a console warning. There is currently no channel for structured error detail back to the agent — so put the recoverable information *in the returned value*:

```js
execute: async ({ city }) => {
  const rooms = await search(city);
  if (!rooms.length) {
    // Return, don't throw: gives the model something to act on.
    return `No rooms in ${city}. Available nearby: Lyon, Marseille. Try one of those.`;
  }
  return rooms;
}
```

**Cancellation.** The second argument carries an `AbortSignal`. Thread it everywhere:

```js
await document.modelContext.registerTool({
  name: 'fetch_tool',
  description: 'Fetch the text content of a URL and stream the response.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL to fetch' },
      priority: { type: 'string', enum: ['high', 'low', 'auto'] },
    },
    required: ['url'],
  },
  execute: async ({ url, priority }, { signal }) => {
    // Abort the fetch request when tool execution is aborted.
    const response = await fetch(url, { priority, signal });
    const stream = response.body.pipeThrough(new TextDecoderStream());
    for await (const chunk of stream) {
      document.querySelector('pre').textContent += chunk;
    }
    return 'Success';
  },
});
```

If the execution is cancelled before your promise settles, the pending-execution entry is removed and your eventual result is discarded silently. Do not rely on post-abort side effects.

### 6.5 Annotations

```js
annotations: {
  readOnlyHint: false,          // true = does not mutate state
  untrustedContentHint: true    // true = output contains UGC / external data
}
```

- `readOnlyHint` lets the agent skip user confirmation prompts for safe reads.
- `untrustedContentHint` labels the payload so the agent applies heightened scrutiny to anything embedded in it. **Set this on any tool that returns user-generated content, third-party content, or anything you did not author.** It is your main structural defence against output-injection through your own tools.

### 6.6 Unregistering

Only via `AbortSignal`. There is no `unregisterTool()`.

```js
const controller = new AbortController();
await document.modelContext.registerTool(addTodoTool, { signal: controller.signal });

// Unregister the tool later...
controller.abort();
```

Registering a signal that is *already* aborted rejects immediately with the signal's abort reason.

As of **Chrome 153**, unregistering no longer cancels in-flight executions of that tool — which is what you want when a component unmounts mid-call.

### 6.7 `getTools()`

```js
Promise<sequence<RegisteredTool>> getTools(
  optional ModelContextGetToolOptions options = {}   // { fromOrigins }
)
```

Returns an **alphabetically ordered** list of the tools the calling document is allowed to see. This is the API for **in-page agents** (your own chat widget, an iframe-hosted assistant). The browser's built-in agent uses a separate internal channel.

```js
const [tool] = await document.modelContext.getTools();
console.log(tool);

// {
//   annotations: { readOnlyHint: false, untrustedContentHint: true },
//   description: "Add a new item to the to-do list",
//   inputSchema: {"type":"object","properties":{…}},
//   name: "addTodo",
//   origin: "https://example.com",
//   title: ""
//   window: Window {window: Window, self: Window, …},
// }
```

Default scope is same-origin documents in the frame tree. Cross-origin requires **both** sides to opt in:

```js
// https://example.com

// Get same-origin tools only
const sameOriginTools = await document.modelContext.getTools();

// Get same-origin tools plus tools from specific cross-origin documents
const allTools = await document.modelContext.getTools({
  fromOrigins: ['https://partner.org']
});
```

A cross-origin tool appears only if **both** hold:
1. its origin is in your `fromOrigins`, **and**
2. it was registered with your origin in its `exposedTo`.

`fromOrigins` entries must be potentially-trustworthy origins, or the call rejects with `SecurityError`.

### 6.8 `executeTool()`

```js
Promise<DOMString> executeTool(
  RegisteredTool tool,
  optional object inputObject = {},
  optional ModelContextExecuteToolOptions options = {}   // { signal }
)
```

Resolves with the **stringified** result of the tool's execution.

```js
const result = await document.modelContext.executeTool(tool, '{"text": "Buy milk"}');
console.log(result);
// 'Added to-do: Buy milk'
```

The explainer passes an object instead of a JSON string:

```js
const result = await document.modelContext.executeTool(
  addTodoTool,
  { text: "Buy groceries" }
);
```

Both work — the IDL takes `object` and the spec stringifies it for you. The Chrome docs' string form is a pass-through of an already-serialized payload. Chrome's docs also note the result is `null` when the tool triggers a navigation.

Cancellation:

```js
const controller = new AbortController();
document.modelContext.executeTool(tool, '{"text": "Buy milk"}', {
  signal: controller.signal,
});

// Cancel tool execution later...
controller.abort();
```

This is also the hook the eval tooling uses to drive tools without a model in the loop.

### 6.9 The `toolchange` event

Fires on `document.modelContext` whenever the visible tool set changes — registration, unregistration, or a cross-origin tool becoming visible to you.

```js
document.modelContext.addEventListener("toolchange", async () => {
  const currentTools = await document.modelContext.getTools();
  updateAgentToolRegistry(currentTools);
});
```

Also available as `ontoolchange`.

**Ordering caveat, from the spec, verbatim:**

```js
document.modelContext.ontoolchange = e => console.log('Parent toolchange');
iframe.contentDocument.modelContext.ontoolchange = e => console.log('Child toolchange');

// Queues a task to fire `toolchange`, on the `webmcp task source`.
const p = document.modelContext.registerTool({
  name: "tool_name",
  description: "tool_desc",
  execute: async () => {}
});

p.then(() => console.log('Register promise resolved'));

// Queues a task on the `timer task source`.
setTimeout(() => console.log('Post-register task'));

// `Parent toolchange` will always log before `Child toolchange`, and
// `Register promise resolved` will always log after both.
// But `Post-register task` can log before, in between, or after all three.
```

The event runs on a dedicated `webmcp task source` in parallel with the browser agent's own queue. Do not depend on interleaving with timers.

### 6.10 Rejection reference

| Condition | Rejection |
|---|---|
| Document not fully active | `InvalidStateError` |
| Agent cluster not origin-keyed (and scheme ≠ `file`) | `SecurityError` |
| `tools` permissions policy denies | `NotAllowedError` |
| Tool name already registered | `InvalidStateError` |
| `name` or `description` empty | `InvalidStateError` |
| `name` >128 chars or illegal characters | `InvalidStateError` |
| `inputSchema` fails `JSON.stringify()` | the thrown `TypeError` / original exception |
| `signal` already aborted at registration | signal's abort reason |
| `exposedTo` / `fromOrigins` entry not potentially trustworthy | `SecurityError` |
| `executeTool` target origin is opaque or unparseable | `NotSupportedError` |
| Tool not found at execution time | reported as failure (spec issue: should become `NotFoundError`) |
| Input JSON unparseable / not an Object | reported as failure (spec issue: should become `DataError`) |

### 6.11 Race: unregister-then-reregister

The spec calls this out explicitly. Tool *existence* is protected; **schema identity is not**.

```js
// -- Tool owner document. --
const oldInputSchema = {...};
const newInputSchema = {...};
const ac = new AbortController();
document.modelContext.registerTool({..., inputSchema: oldInputSchema}, {signal: ac.signal});

// Unregister, and quickly re-register with an updated input schema.
ac.abort();
document.modelContext.registerTool({..., inputSchema: newInputSchema});


// -- Executing document. --
//
// This could target either the "old" tool, or the "new" one above,
// and the execution might encounter any requisite errors due to the mismatch.
const [tool] = await document.modelContext.getTools();
document.modelContext.executeTool(tool, {a: 10});
```

**Mitigation:** if a tool's schema changes meaningfully, change its `name` too. Version the name (`search_v2`) rather than swapping the schema under a stable name.

---

## 7. Declarative API

Turns an existing `<form>` into a tool with HTML attributes only. Zero JavaScript required for the basic case.

### 7.1 Attributes

**On `<form>`:**

| Attribute | Meaning |
|---|---|
| `toolname` | Tool identifier. Analogous to `ModelContextTool.name`. |
| `tooldescription` | Tool description. Analogous to `ModelContextTool.description`. |
| `toolautosubmit` | Boolean. Agent may submit the form itself after filling it. Without it, the browser focuses the submit button and the agent should ask the user to check and submit. |

**On form controls:**

| Attribute | Meaning |
|---|---|
| `name` | Becomes the JSON Schema property key. (Standard HTML attribute.) |
| `toolparamdescription` | Becomes the property's `description`. Falls back to the associated `<label>` text, then `aria-description`. |
| `required` | Feeds the schema's `required` array. |

Removing either `toolname` or `tooldescription` unregisters the tool.

### 7.2 Minimal registration

```html
<form toolname="createSupportRequest" tooldescription="Submits a request for customer support.">
</form>
```

### 7.3 Full example and its synthesized schema

```html
<form toolname="supportRequestTool"
      tooldescription="Submit a request for support."
      action="/submit">

  <label for="firstName">First Name</label>
  <input type=text name=firstName>

  <label for="lastName">Last Name</label>
  <input type=text name=lastName>

  <select name="select" required
          toolparamdescription="Determines what team this request is routed to.">
    <option value="Customer happiness team">Return my purchase.</option>
    <option value="Distribution team">Check where my package is.</option>
    <option value="Website support team">Get help on the website.</option>
  </select>

  <button type=submit>Submit</button>
</form>
```

The browser synthesizes:

```json
[
  {
    "name": "supportRequestTool",
    "description": "Submit a request for support.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "firstName": { "type": "string" },
        "lastName": { "type": "string" },
        "select": {
          "type": "string",
          "anyOf": [
            { "type": "string", "const": "Customer happiness team", "title": "Return my purchase." },
            { "type": "string", "const": "Distribution team",        "title": "Check where my package is." },
            { "type": "string", "const": "Website support team",     "title": "Get help on the website." }
          ],
          "enum": [
            "Customer happiness team",
            "Distribution team",
            "Website support team"
          ],
          "description": "Determines what team this request is routed to."
        }
      },
      "required": ["select"]
    }
  }
]
```

Note the `<select>` shape: `anyOf` carries `const` + `title` pairs (option value + option label), and a flat `enum` sits alongside. `<option>` **text** becomes the title, `<option value>` becomes the const. Write option text that reads as an intent, not as UI chrome.

### 7.4 Declarative ≡ imperative

From the declarative explainer, these two are equivalent:

```js
await document.modelContext.registerTool({
  name: "search-cars",
  description: "Perform a car make/model search",
  inputSchema: {
    type: "object",
    properties: {
      make: { type: "string", description: "The vehicle's make (e.g., BMW, Ford)" },
      model: { type: "string", description: "The vehicle's model (e.g., 330i, F-150)" },
    },
    required: ["make", "model"]
  },
  execute({make, model}, agent) { ... }
});
```

```html
<form toolname="search-cars" tooldescription="Perform a car make/model search" [...]>
 <input type=text name="make" toolparamdescription="The vehicle's make (i.e., BMW, Ford)" required>
 <input type=text name="model" toolparamdescription="The vehicle's model (i.e., 330i, F-150)" required>
 <button type=submit>Search</button>
</form>
```

### 7.5 Submission, `agentInvoked`, `respondWith()`

`SubmitEvent` gains two members:

```webidl
[Exposed=Window]
interface SubmitEvent : Event {
  // ...
  readonly attribute boolean agentInvoked;
  undefined respondWith(Promise<any> agentResponse);
};
```

- `agentInvoked` — `true` when an agent triggered the submission.
- `respondWith(promise)` — resolves to the value returned to the model as the tool's output. **You must call `preventDefault()` first**; this suppresses the form's normal `action` navigation.

```html
<form toolautosubmit toolname="search_tool"
      tooldescription="Search the web" action="/search">
  <input type=text name=query>
</form>
<script>
document.querySelector("form").addEventListener("submit", (e) => {
  e.preventDefault();
  if (!myFormIsValid()) {
    if (e.agentInvoked) { e.respondWith(myFormValidationErrorPromise) };
    return;
  }
  if (e.agentInvoked) { e.respondWith(Promise.resolve("Search is done!")); }
});
</script>
```

If the form *does* navigate, getting a response back to the agent is still under debate (Issue #135). The parked proposal was to read the first `<script type="application/ld+json">` on the destination page as the tool response, falling back to the whole page contents.

### 7.6 Events

```js
window.addEventListener('toolactivated', ({ toolName }) => {
  console.log(`the tool "${toolName}" execution was activated.`);
  // TODO: Update UI or validate form if needed.
});

window.addEventListener('toolcancel', ({ toolName }) => {
  console.log(`the tool "${toolName}" execution was cancelled.`);
  // TODO: Let the user know. Update UI.
});
```

- `toolactivated` fires once the agent has pre-filled the fields, **before** submission. Your hook to draw attention to the form.
- `toolcancel` fires when the agent cancels, or when `reset()` is called. Note it does **not** fire when the *site itself* cancels by removing the form or changing its name/description.
- Both are non-cancelable and carry `toolName`.

⚠️ The explainer names the second event `toolcanceled` and fires both at `ModelContext`; Chrome ships `toolcancel` on `window`. Chromium also appears to fire these for imperative calls. Treat naming and target as unstable — see [§15](#15-known-instability-and-open-questions).

### 7.7 Focus styling

Two pseudo-classes mark an agent-filled form awaiting human review:

- `:tool-form-active` — on the `<form>` whose declarative tool is running
- `:tool-submit-active` — on that form's submit button

Chrome's defaults:

```css
/* Chrome default declarative form styles. */
form:tool-form-active {
  outline: light-dark(blue, cyan) dashed 1px;
  outline-offset: -1px;
}

input:tool-submit-active {
  outline: light-dark(red, pink) dashed 1px;
  outline-offset: -1px;
}
```

A form counts as "running" from the moment agent output starts filling it until one of: the form is reset or removed; the `respondWith()` promise resolves; `toolname`/`tooldescription` change; or `toolautosubmit` triggers submission.

Resetting a form, or changing its tool declaration, **cancels any in-flight invocation** and notifies the agent.

### 7.8 Why both APIs exist

> The reason WebMCP is not limited to only declarative form tools is for the same reason that websites cannot be built exclusively out of declarative forms. Some of the web's functionality is only possible with JavaScript.

**Rule of thumb:** if it is already a form, annotate it. If it is application logic, register it.

---

## 8. Complete WebIDL

```webidl
partial interface Document {
  [SecureContext, SameObject] readonly attribute ModelContext modelContext;
};

[Exposed=Window, SecureContext]
interface ModelContext : EventTarget {
  Promise<undefined> registerTool(ModelContextTool tool, optional ModelContextRegisterToolOptions options = {});
  Promise<sequence<RegisteredTool>> getTools(optional ModelContextGetToolOptions options = {});
  Promise<DOMString> executeTool(RegisteredTool tool, optional object inputObject = {}, optional ModelContextExecuteToolOptions options = {});

  attribute EventHandler ontoolchange;
};

dictionary ModelContextTool {
  required DOMString name;
  // Because `title` is for display in possibly native UIs, this must be a `USVString`.
  USVString title;
  required DOMString description;
  object inputSchema;
  required ToolExecuteCallback execute;
  ToolAnnotations annotations;
};

dictionary ToolAnnotations {
  boolean readOnlyHint = false;
  boolean untrustedContentHint = false;
};

dictionary ToolExecuteCallbackOptions {
  required AbortSignal signal;
};

callback ToolExecuteCallback = Promise<any> (object inputObject, ToolExecuteCallbackOptions options);

dictionary ModelContextRegisterToolOptions {
  sequence<USVString> exposedTo;
  AbortSignal signal;
};

dictionary ModelContextGetToolOptions {
  sequence<USVString> fromOrigins;
};

dictionary ModelContextExecuteToolOptions {
  AbortSignal signal;
};

dictionary RegisteredTool {
  required DOMString name;
  DOMString title;
  required DOMString description;
  object inputSchema;
  required Window window;
  required USVString origin;
  ToolAnnotations annotations;
};

// Declarative additions
[Exposed=Window]
interface SubmitEvent : Event {
  // ...
  readonly attribute boolean agentInvoked;
  undefined respondWith(Promise<any> agentResponse);
};
```

**Events:** `toolchange` (on `ModelContext`), `toolactivated` / `toolcancel` (on `window`, per Chrome).

**Permissions policy:** feature name `tools`, default allowlist `'self'`.

---

## 9. Origins, permissions, and iframes

### 9.1 The `tools` permissions policy

Default allowlist `'self'`: tool registration works in the top-level document and same-origin frames, and is **off** in cross-origin iframes.

Grant it:

```html
<iframe src="https://chat-bot-provider.example/" allow="tools"></iframe>
```

Revoke it site-wide with a response header:

```
Permissions-Policy: tools=()
```

Denied calls reject with `NotAllowedError`. Declarative-tool behaviour when the policy is denied is TBD (Issue #182).

### 9.2 `exposedTo` — who may see your tool

By default a tool is visible only to its own document, same-origin documents in the tree, and the browser's built-in agent. To share with a cross-origin in-page agent:

```js
await document.modelContext.registerTool({
  name: "share-location",
  description: "Returns the user's office location.",
  execute() { return { office: "Building 4" }; }
}, { exposedTo: ["https://trusted-partner.example"] });
```

Any document in the tree whose origin matches (and which is allowed to use `tools`) will:

- receive `toolchange` when the tool is registered or unregistered
- be able to discover and run the tool

Real-world use, from Chrome's pizza demo — scoping tools to the dev host and the demo host:

```js
const toolOptions = { exposedTo: ["http://localhost:8080", "http://127.0.0.1:8080", "https://chrome.dev"] };
document.modelContext.registerTool({ /* ... */ }, toolOptions);
```

### 9.3 The two-sided handshake

Cross-origin access requires **both** directions:

```
Provider (partner.org):  registerTool(tool, { exposedTo: ['https://example.com'] })
Consumer (example.com):  getTools({ fromOrigins: ['https://partner.org'] })
```

Miss either half and the tool is invisible. Both lists accept **secure origins only**.

`executeTool()` re-checks that `exposedTo` and `fromOrigins` agree, and runs the tool in the **owner's** execution context, not the caller's.

---

## 10. Security

The threat model is real and the spec says so plainly:

> it's impossible to guarantee safety inside of a large language model (LLM). Models are probabilistic in nature.

### 10.1 The risk classes

The spec enumerates five:

1. **Prompt injection** — three attack surfaces:
   - *Metadata / description attacks (tool poisoning)*: malicious instructions inside a tool's `name` or `description`.
   - *Output injection*: malicious instructions in what a tool returns.
   - *Tool implementation as attack target*: the agent is steered into calling your tool in a way that harms the user.
2. **Misrepresentation of intent** — a tool that does more, or less, than its description claims. Malicious *or* accidental. The spec's worked example is "ambiguous finalization": the agent thinks it is previewing an order; the tool commits it.
3. **Privacy leakage through over-parameterization** — a schema with a `context` or `notes` free-text field invites the model to dump everything it knows about the user into your tool.
4. **Same-origin boundary violations.**
5. **Private browsing mode interactions.**

### 10.2 What you actually do about it

**Annotate honestly.**

```js
annotations: {
  readOnlyHint: true,           // only on genuinely non-mutating tools
  untrustedContentHint: true    // on anything returning UGC or third-party data
}
```

**Expose narrowly.** Only origins you trust:

```js
await document.modelContext.registerTool({
  name: 'my_shared_tool',
  description: 'Shared across origins',
  // ...
}, {
  exposedTo: ['https://trusted.com', 'https://example.com']
});
```

- A read-only tool like `getFavoriteProducts` reveals user data. Expose it only to sites you would hand that data to directly.
- A read-write tool acts on the user's behalf. `postComment` to `trustedExample.com`, never to `evilExample.com`.

**Keep schemas tight.** Every optional free-text parameter is a privacy hole. No `extra_context: { type: "string" }`. Ask for the fields you need, `additionalProperties: false`, done.

**Confirm consequential actions in your own UI.** Do not rely on the agent to ask. Purchases, deletions, messages, payments — put the confirmation in the page where the human can see it. This is also what ChatGPT's browser does on its side, but defence in depth is the point.

**Validate strictly in code.** The browser does not enforce your schema. Treat `inputObject` as untrusted input from a probabilistic source, because that is exactly what it is.

**Never let tool output become instructions.** If a tool returns UGC, set `untrustedContentHint` *and* keep the payload structured (JSON fields, not prose paragraphs the model will read as directions).

### 10.3 Character budgets

Chrome's recommended limits, to stay inside agent guardrails:

| Item | Limit |
|---|---|
| Tool description | 500 characters |
| Parameter description | 150 characters |
| Tool name and parameter name | 30 characters |
| Individual tool output | 1.5K characters |

Subject to change; may become normative in the spec. Note the 30-char practical limit is far below the spec's hard 128-char `name` maximum.

### 10.4 Extensions

Chrome extensions can query and execute WebMCP tools from content scripts. With `host_permission` they could already run arbitrary JS on your page, so WebMCP does not widen that particular hole — but it does make your capabilities *legible* to them.

### 10.5 Checklist

- [ ] `untrustedContentHint` on every tool returning UGC or external data
- [ ] `readOnlyHint` on every non-mutating tool
- [ ] `exposedTo` restricted to trusted secure origins (or omitted entirely)
- [ ] No free-text catch-all parameters
- [ ] Every argument validated in code, not just in schema
- [ ] Consequential actions confirmed in your own UI
- [ ] Descriptions and outputs inside the character budgets
- [ ] Tool descriptions describe what the tool *does*, exactly — no more, no less

---

## 11. Best practices

### Tool strategy

- **One function per tool.** Overlapping tools are the main cause of wrong-tool selection. Ask: can these two tasks be one function?
- **Register dynamically when page state warrants it.** Register when useful, unregister when not. But: **static registration is the right default for most apps.** Dynamic registration is a complexity budget you may not need.
- **There is no hard tool limit, but every tool costs context.** More tools = slower completion and more selection errors.
- **Trust the agent.** Don't write rigid step-by-step instructions in descriptions. Describe capability; let the model plan.

### Naming and descriptions

- **Distinguish execution from initiation.** `create-event` creates it now. `start-event-creation-process` navigates to a form. The verb is the contract.
- **Describe what it does, not what it doesn't.**

  > ❌ "Don't use this tool for weather."
  > ✅ "This tool can create a calendar event, scheduled for a specific date and time."

  Limitations should be implicit in a well-written positive description.

### Minimize cognitive computing

- **Accept raw user input.** If the user says "11:00 to 15:00", take that string. Don't make the model compute elapsed minutes.
- **Declare specific types.** `string`, `number`, `enum` — not bare objects.
- **Natural language over IDs.** `shipping="Express"`, not `shipping_id=1`. And explain *why* a choice exists, not just that it does.

### Reliability

- **Fail gracefully on rate limits.** Return a meaningful message, or tell the user to do it manually. Tools get called repeatedly (price comparison, batch edits) — allow for that.
- **Update UI state before returning success.** Agents read the interface to plan next steps. If your function completes before the DOM reflects it, the agent plans against stale state. Return only once the interface is consistent.
- **Validate strictly in code, loosely in schema.** Schema constraints are hints, not guarantees. Descriptive error strings let the model self-correct and retry with valid parameters.
- **Don't patch model-specific failures with narrow rules.** If a model keeps picking the wrong honorific, don't add a rule — make the field optional and have the agent ask the user.

### Compatibility

Keep the site fully usable without WebMCP. Feature-detect, register in an `if`, and never make a tool the only path to a capability.

### Common patterns

**State-gated registration.** Register a tool only while the page state makes it callable, so the agent never sees an option it cannot use.

```js
let checkoutController = null;

function onCartChanged(cart) {
  if (cart.items.length && !checkoutController) {
    checkoutController = new AbortController();
    document.modelContext.registerTool({
      name: 'proceed_to_checkout',
      description: 'Take the shopper to checkout with the current cart.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      execute: () => { goToCheckout(); return 'Navigating to checkout.'; },
    }, { signal: checkoutController.signal });
  } else if (!cart.items.length && checkoutController) {
    checkoutController.abort();
    checkoutController = null;
  }
}
```

**Read/act pairs.** Give the agent a `readOnlyHint` reader beside every mutator, so it can verify before and after instead of guessing.

```js
const read = {
  name: 'get_cart',
  description: 'List the items currently in the cart with quantities and total.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true },
  execute: () => cart.summary(),
};

const write = {
  name: 'update_cart',
  description: 'Add, remove, or change the quantity of an item in the cart.',
  inputSchema: {
    type: 'object',
    properties: {
      sku: { type: 'string', description: 'Product SKU from get_cart or search.' },
      quantity: { type: 'integer', minimum: 0, description: 'New quantity. 0 removes the item.' },
    },
    required: ['sku', 'quantity'],
    additionalProperties: false,
  },
  execute: ({ sku, quantity }) => {
    if (!catalog.has(sku)) return `Unknown SKU "${sku}". Call search_catalog first.`;
    cart.set(sku, quantity);
    renderCart();                       // UI updated before we return
    return cart.summary();
  },
};
```

**Human-in-the-loop confirmation.** For anything consequential, stage the action in your own UI and return without committing. The user commits.

```js
execute: async ({ amount, recipient }) => {
  showPendingTransfer({ amount, recipient });   // renders a confirm/cancel card
  return `Staged a transfer of ${amount} to ${recipient}. ` +
         `It is shown on screen and requires the user to press Confirm.`;
}
```

**Self-correcting errors.** Return the recovery path in the payload rather than throwing.

```js
execute: async ({ date }) => {
  const slots = await availability(date);
  if (!slots.length) {
    const next = await nextAvailableDates(date, 3);
    return `No availability on ${date}. Next open dates: ${next.join(', ')}.`;
  }
  return slots;
}
```

**Untrusted passthrough.** Any tool surfacing content you did not author gets the hint and a structured shape.

```js
{
  name: 'get_reviews',
  description: 'Return recent customer reviews for a product.',
  annotations: { readOnlyHint: true, untrustedContentHint: true },
  inputSchema: {
    type: 'object',
    properties: { sku: { type: 'string' } },
    required: ['sku'],
    additionalProperties: false,
  },
  execute: ({ sku }) => reviews(sku).map(r => ({ rating: r.stars, body: r.text.slice(0, 400) })),
}
```

**In-page agent over your own tools.** `getTools()` + `executeTool()` let you ship a chat widget that drives the same tools the browser agent uses — one implementation, two consumers.

```js
async function refreshToolRegistry() {
  const tools = await document.modelContext.getTools();
  myChatWidget.setTools(tools);
}

document.modelContext.addEventListener('toolchange', refreshToolRegistry);
await refreshToolRegistry();

// When the model picks one:
const result = await document.modelContext.executeTool(tool, args, { signal });
```

---

## 12. Testing, debugging, evals

### 12.1 Chrome DevTools

**Application panel → WebMCP.**

- **Available Tools** — names, descriptions, and an invocation counter per tool. Status icons in the counter are clickable and filter the log.
- **Invoked Tools** — chronological log with status (Completed, Canceled, In Progress, Error), the agent's input parameters, and the output or error.
- **Filter bar** — by name/description text, by status, or by tool type (declarative vs imperative).
- **Manual run** — click a tool in Available Tools, or the Play icon on a logged invocation, edit parameters, and **Run tool**. Replaying from history pre-populates the parameters; starting from the tool list gives you empty fields.

Use the invocation counter as a signal: a tool the agent never *considers* has a description problem, not an implementation problem.

### 12.2 Model Context Tool Inspector extension

Chrome Web Store extension (`beaufortfrancois/model-context-tool-inspector`). Gives you an agent chat against any page:

- see which tools are registered
- manually call tools
- verify the JSON Schema parses as intended
- inspect structured output and error strings as the agent sees them
- talk to the page in natural language and watch which tool gets picked

Prompts go to `gemini-3-flash-preview` by default. Separate from Gemini in Chrome.

### 12.3 Lighthouse

`agentic-browsing/registered-webmcp-tools` is an **informational** audit — it inventories the tools registered on a page (declarative and imperative). No pass/fail; an empty list means none were found. Useful as a smoke check that registration actually happened in production.

### 12.4 Evals

Unlike unit tests, agent behaviour is probabilistic — "one input could lead to thousands of answers with varying degrees of accuracy."

**Failure modes to test for:**

| Mode | Fix direction |
|---|---|
| Agent skips the right tool or calls the wrong one | Clarify descriptions, use intuitive names, remove schema overlap |
| Tools called in the wrong order | Reduce description overlap, verify state updates, test chains in isolation |
| Wrong arguments | Tighter `inputSchema`, mark `required`, map user input explicitly |
| Wrong/incomplete output | Fix logic with deterministic tests; format output for LLM clarity; cut verbosity |
| Runtime JS errors | Handle exceptions; report clearly; distinguish temporary from critical |

**Three test layers:**

1. **Deterministic** — plain unit tests on your `execute` logic, dependency calls, UI side effects, parameter handling. Mock the environment.
2. **Isolated tool-call accuracy** — drive `document.modelContext.executeTool(...)` directly, and score model tool-selection against `expectedCall` specs:

```json
{
  "messages": [{"role": "user", "content": "I'd like a small pizza."}],
  "expectedCall": [{
    "functionName": "set_pizza_size",
    "arguments": {"size": "Small"}
  }]
}
```

3. **End-to-end trajectories** — multi-step with mixed ordering constraints:

```json
{
  "messages": [{"role": "user", "content": "Buy black jacket and jeans..."}],
  "expectedCall": [
    {"functionName": "navigate_to_category", "arguments": {"category": "clothes"}},
    {"unordered": [
      {"ordered": [
        {"functionName": "search_clothes", "arguments": {"query": "black jacket"}},
        {"functionName": "get_product_details", "arguments": {"productId": "JACKET002"}}
      ]},
      {"ordered": [
        {"functionName": "search_clothes", "arguments": {"query": "jeans"}},
        {"functionName": "get_product_details", "arguments": {"productId": "JEANS001"}}
      ]}
    ]}
  ]
}
```

Include **ambiguous** prompts ("I want all meat on my pizza"), not just direct ones.

**Mid-chain failure testing:** manually execute a tool chain without the model to bring the app into the failure state you want, then test the failing tool in isolation.

### 12.5 `webmcp-evals` CLI

`GoogleChromeLabs/webmcp-tools/webmcp-evals` — experimental TypeScript framework + CLI.

```bash
# Static schema files, no browser
npx webmcp-evals local -t examples/pizza-maker/schema.json -e examples/pizza-maker/evals.json

# Live page via Puppeteer
npx webmcp-evals browser -u https://example.com/demo -e examples/pizza-maker/evals.json --open

# Concrete expected calls against a live page, no LLM and no API key
npx webmcp-evals smoke ...
```

Backends: `vercel` (default, Vercel AI SDK), `gemini` (`@google/genai`), `ollama`. Reporters: `console`, `json`, `html` → `.evals/`. Matching supports regex, numeric ranges, type checks, and `ordered`/`unordered` trajectory constraints. Default model `gemini-3.5-flash`; default Chrome channel `chrome-canary`.

Env: `GOOGLE_AI`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, optional `OLLAMA_HOST` and `*_BASE_URL` overrides.

### 12.6 Testing in ChatGPT

Open the deployed URL in the **ChatGPT desktop in-app browser**. Tools appear under **"Available site tools"** in the address bar; recent activity shows in the **Sources** panel. Requires **GPT-5.6 Sol or Terra** — Luna has WebMCP disabled. Users can turn site tools off in **Settings → Browser → Permissions**. Tools go away when the user navigates off the page.

---

## 13. Frameworks and libraries

### 13.1 TypeScript types

```bash
npm install --save-dev webmcp-types
```

```jsonc
// tsconfig.json
{
  "compilerOptions": {
    "types": ["webmcp-types"]
  }
}
```

Or inline, if your toolchain ignores `tsconfig.json`:

```ts
/// <reference types="webmcp-types" />
```

Maintained under `webmachinelearning/webmcp-types`; augments the ambient `dom` lib.

### 13.2 React — `use-webmcp-tool` (maintained by Chrome)

```bash
npm install use-webmcp-tool
```

React 18+ peer dep, ESM, zero runtime deps, feature-detects and no-ops where the API is absent.

```jsx
import { useWebMCP } from "use-webmcp-tool";

function TodoTools({ addTodo }) {
  const { supported, registered } = useWebMCP({
    name: "add-todo",
    description: "Add a new item to the user's active todo list",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The text content of the todo item" },
      },
      required: ["text"],
    },
    async execute({ text }) {
      addTodo(text);
      return `Added todo item: "${text}" successfully.`;
    },
  });

  if (!supported) return null;
  return <p>{registered ? "🤖 Agent tools ready" : "…"}</p>;
}
```

Full config:

```ts
const { supported, registered, error } = useWebMCP({
  name,           // string — tool identifier (required)
  description,    // string — natural-language description for the agent (required)
  inputSchema,    // JSON Schema object describing args (optional)
  annotations,    // ToolAnnotations object with readOnlyHint/untrustedContentHint (optional)
  execute,        // (args) => result | Promise<result> (required)
  enabled = true, // boolean — register only while true
  formatOutput,   // (result, args) => any — optional shaper before MCP normalization
  onError,        // (error) => void — optional side-effect when execute throws
});
```

Tool registers on mount, unregisters on unmount — **the agent's tool list stays in lockstep with what is on screen.** That property alone is worth adopting the hook for.

Return normalization:

| You return | Agent gets |
|---|---|
| string | `{ content: [{ type: "text", text }] }` |
| `undefined` / `null` | `{ content: [] }` (success, no payload) |
| already `{ content: [...] }` | passed through untouched |
| a thrown value (Error or not) | `{ content: [{ type: "text", text }], isError: true }`, after `onError` |
| a returned `Error` | same as a throw |
| anything else | JSON-serialized into a text block |

### 13.3 React — `usewebmcp` (MCP-B)

```bash
pnpm add usewebmcp react
```

Different package, different maintainer (MCP-B ecosystem). Adds `outputSchema`, execution state, and local re-invocation:

```tsx
import { initializeWebMCPPolyfill } from '@mcp-b/webmcp-polyfill';
import { useWebMCP } from 'usewebmcp';

initializeWebMCPPolyfill();

const INPUT_SCHEMA = {
  type: 'object',
  properties: { query: { type: 'string' } },
  required: ['query'],
} as const;

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: { total: { type: 'integer' } },
  required: ['total'],
} as const;

export function SearchTool() {
  const search = useWebMCP({
    name: 'search',
    description: 'Search indexed documents',
    inputSchema: INPUT_SCHEMA,
    outputSchema: OUTPUT_SCHEMA,
    execute: async ({ query }) => ({ total: await countMatches(query) }),
  });

  return (
    <button disabled={search.state.isExecuting} onClick={() => search.execute({ query: 'webmcp' })}>
      Run search ({search.state.executionCount})
    </button>
  );
}
```

`state` carries `isExecuting`, `lastResult`, `error`, `executionCount`. JSON Schema literals (and Zod 4.2+) infer `execute` input/output types. Re-registers when `name`, `description`, or a value in `deps` changes.

⚠️ `outputSchema` is **MCP-B metadata, not native WebMCP** — native Chrome does not advertise it.

### 13.4 Angular

Experimental first-party support.

```typescript
import {provideExperimentalWebMcpTools, declareExperimentalWebMcpTool, inject} from '@angular/core';
import {provideExperimentalWebMcpForms} from '@angular/forms/signals';
```

- **App-level tools:** `provideExperimentalWebMcpTools` in bootstrap config. `execute` runs inside the associated Injector's injection context, so `inject()` works directly.
- **Route-level tools:** register in a route's `providers`; pair with `withExperimentalAutoCleanupInjectors()` so tools unregister on navigation.
- **Dynamic/service-level:** `declareExperimentalWebMcpTool` registers within an injection context and unregisters when that context is destroyed. Use it in **root services** — component-level registration risks name collisions.
- **Signal Forms → tools:** `provideExperimentalWebMcpForms()`, then:

```typescript
readonly userForm = form(this.model, (f) => {...}, {
  experimentalWebMcpTool: {
    name: 'registerUser',
    description: 'Registers a new user.',
  },
  submission: {action: async (formValue) => {...}}
});
```

Angular derives the JSON Schema from the form model's initial values and validator config, and wires validation + submission into the tool. Angular does **not** validate tool inputs for you — do it yourself, and use `required` + `additionalProperties: false`.

### 13.5 Polyfill / MCP-B runtime

For browsers without native support, `@mcp-b/global` implements `document.modelContext` and bridges to MCP clients.

```html
<script src="https://unpkg.com/@mcp-b/global@latest/dist/index.iife.js"></script>
<script>
  void document.modelContext
    .registerTool({
      name: 'get-page-title',
      description: 'Get the current page title',
      inputSchema: { type: 'object', properties: {} },
      async execute() {
        return {
          content: [{ type: 'text', text: document.title }],
        };
      },
    })
    .catch(console.error);
</script>
```

Auto-detects and defers to the native implementation when present. IIFE is ~285KB self-contained; ESM is ~16KB unbundled.

Package split:
- `@mcp-b/webmcp-types` — types only
- `@mcp-b/webmcp-polyfill` — strict runtime polyfill only
- `@mcp-b/global` — polyfill plus MCP-B extras (bridge transport, prompts/resources, extension APIs)

### 13.6 Other

- **`latch`** (`latch.tools`) — one-line script that auto-detects existing search/cart/form handlers and registers them as tools. MIT.
- **`webmcpify`** — agent skill that inventories an app, proposes a tool manifest, integrates, and verifies each tool in a real browser.

---

## 14. Platform integrations

### 14.1 Shopify

**Live today, zero configuration.** Every Liquid storefront and Hydrogen storefront already exposes WebMCP tools, operating on the shopper's live session via the Storefront API.

| Category | Tools |
|---|---|
| Catalog | `search_catalog`, `browse_store`, `get_product`, `show_variant` |
| Cart | `get_cart`, `update_cart`, `cancel_cart` |
| Checkout / orders | `proceed_to_checkout`, `manage_orders` |
| Store info | `search_shop_policies_and_faqs` |

Agent support is currently limited to Chromium-based browsers.

### 14.2 Cloudflare

Dashboard toggle: **Agent Readiness → WebMCP**. Cloudflare injects a bridge script at the edge via HTMLRewriter — no origin code changes:

```html
<script type="module"
        src="/.webmcp/bridge.js"
        data-packs="c2pa,mcp-server-client"
        data-mcp-url="/mcp"></script>
```

The bridge composes the named packs into one tool list and no-ops if the browser lacks WebMCP. **Every tool runs entirely in the visitor's browser** — no round trip to Cloudflare at execution time.

Current packs:
- **Content Credentials (C2PA)** — scans images for provenance metadata
- **Site MCP Server** — proxies to your own MCP server, keeping the visitor's session

The proxy pattern is worth stealing generally — this is how you front an existing MCP server with WebMCP:

```javascript
document.modelContext.registerTool({
  name: tool.name,
  description: tool.description,
  inputSchema: tool.inputSchema,
  execute: async (args) => {
    const res = await fetch(mcpUrl, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: tool.name, arguments: args },
      }),
    });
    const { result } = await res.json();
    return result;
  },
});
```

Also works with Cloudflare Browser Run (remote browser).

### 14.3 OpenAI / ChatGPT

Registration guard OpenAI recommends, verbatim:

```javascript
if (typeof document.modelContext?.registerTool === "function") {
  await document.modelContext.registerTool({
    name: "get_page_title",
    description: "Read the title of the current page.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    execute: async () => ({ title: document.title }),
  });
}
```

OpenAI's own docs sites expose `search_openai_docs`, `lookup_page`, `navigate_to_page`, and `generate_custom_guide` (async) as a reference implementation.

Their design guidance: narrow, well-documented parameters; lean on the app's existing auth; return enough for the user to verify the result; annotate side effects; stay compatible with non-WebMCP browsers.

The browser treats **all** site tool definitions as untrusted content and runs a safety review before invoking — tool names do not guarantee behaviour.

---

## 15. Known instability and open questions

Things that will move. Do not build load-critical logic on these.

**Event naming and target.** Chrome ships `toolactivated`/`toolcancel` on `window`. The explainer says `toolactivated`/`toolcanceled` on `ModelContext`. Chromium appears to fire them for imperative calls too, which the explainer flags as an open question. Issue #126 debates `window` vs the `<form>` element.

**`requestUserInteraction()`.** Chrome's security doc says "the spec draft includes `requestUserInteraction()` to asynchronously request user input at tool execution." It is **not** in the current `index.bs` on `main`. Treat as proposed.

**Declarative schema synthesis is under-specified.** The explainer says outright: *"The exact algorithms reducing a form... is TBD."* How `<input>` attributes like `step`, `min`, `max` reduce to `anyOf`/`oneOf`/`maximum`/`minimum` is not pinned down. Chromium implements "a loose version." Expect drift.

**Cross-document tool responses.** If a form navigates, how the response reaches the agent is unresolved (Issue #135). The parked proposal reads the destination's first `<script type="application/ld+json">`.

**`outputSchema`.** Issue #9. Not in the spec. MCP-B ships it as metadata; native Chrome ignores it.

**Input/output schema validation.** Issue #92. Today the browser does not validate agent arguments against your schema.

**Granular errors.** Two spec issues acknowledge that `NotFoundError` (tool missing at execution) and `DataError` (unparseable input) should propagate to the caller but currently do not.

**Built-in agent exposure defaults.** A `native-agent` keyword for `exposedTo` is under discussion: top-level documents would expose to the built-in agent by default when `exposedTo` is absent; iframes would not.

**Also open:** multimodal tool I/O (Issues #41, #86, #81), streaming inputs/outputs, progress reporting for long tasks, Service Worker integration for background discovery, "skills" that coordinate related tools, and cross-party consent management.

**Declarative tools in `getTools()`.** Whether declarative tools appear in `getTools()`/`executeTool()` is TBD. The explainer says "almost certainly yes, but details are TBD."

---

## 16. Sources

**Specification**
- Spec draft — https://webmachinelearning.github.io/webmcp/
- Spec source (`index.bs`) — https://github.com/webmachinelearning/webmcp/blob/main/index.bs
- Explainer — https://github.com/webmachinelearning/webmcp/blob/main/README.md
- Declarative API explainer — https://github.com/webmachinelearning/webmcp/blob/main/declarative-api-explainer.md
- Implementation status — https://github.com/webmachinelearning/webmcp/blob/main/implementation-status.md
- Security & privacy questionnaire — https://github.com/webmachinelearning/webmcp/blob/main/security-privacy-questionnaire.md

**Chrome**
- WebMCP overview — https://developer.chrome.com/docs/ai/webmcp
- Imperative API — https://developer.chrome.com/docs/ai/webmcp/imperative-api
- Declarative API — https://developer.chrome.com/docs/ai/webmcp/declarative-api
- Best practices — https://developer.chrome.com/docs/ai/webmcp/best-practices
- Tool security — https://developer.chrome.com/docs/ai/webmcp/secure-tools
- Evals — https://developer.chrome.com/docs/ai/webmcp/evals
- WebMCP and AI agents — https://developer.chrome.com/docs/ai/agents
- DevTools debugging — https://developer.chrome.com/docs/devtools/application/webmcp
- Origin trial — https://developer.chrome.com/blog/ai-webmcp-origin-trial
- Lighthouse audit — https://developer.chrome.com/docs/lighthouse/agentic-browsing/registered-webmcp-tools

**OpenAI**
- WebMCP guide — https://learn.chatgpt.com/docs/webmcp
- Showcase — https://developers.openai.com/showcase?view=webmcp-apps

**Ecosystem**
- Demos + Awesome WebMCP — https://github.com/GoogleChromeLabs/webmcp-tools
- `webmcp-evals` — https://github.com/GoogleChromeLabs/webmcp-tools/tree/main/webmcp-evals
- Tool Inspector extension — https://github.com/beaufortfrancois/model-context-tool-inspector
- `webmcp-types` — https://www.npmjs.com/package/webmcp-types
- `use-webmcp-tool` — https://www.npmjs.com/package/use-webmcp-tool
- `usewebmcp` — https://www.npmjs.com/package/usewebmcp
- `@mcp-b/global` — https://www.npmjs.com/package/@mcp-b/global
- MCP-B — https://mcp-b.ai/
- Angular — https://angular.dev/ai/webmcp
- Cloudflare — https://blog.cloudflare.com/webmcp/
- Cloudflare Browser Run — https://developers.cloudflare.com/browser-run/features/webmcp/
- Shopify — https://shopify.dev/docs/api/web-mcp
