import { BUDGETS, TOOLS, type ToolDefinition } from "@webmcp-hackathon/contracts";
import {
  spatialContext,
  spatialInspectRaw,
  spatialLookupRaw,
  spatialNavigationRaw,
  syncSessionRaw,
} from "./api.ts";
import { diagnostics } from "./diagnostics-store.ts";
import { runCommand, spatial } from "./spatial-store.ts";
import type {
  CandidateSummary,
  SpatialContext,
} from "./spatial-types.ts";

/**
 * Gate 1: register the full static tool catalog through
 * document.modelContext.registerTool() AT PAGE LOAD — never after
 * authentication completes; late registration races ChatGPT's discovery
 * snapshot. Until the invite-token exchange finishes, tools return a
 * structured not_authenticated result rather than being absent.
 * Feature-detected: the page is fully usable without WebMCP.
 */

interface ModelContextLike {
  /** Resolves undefined; rejects on invalid name/schema (WEBMCP-REFERENCE §6.1). */
  registerTool(tool: {
    name: string;
    description: string;
    inputSchema: unknown;
    annotations?: unknown;
    execute(args: unknown, options?: { signal?: AbortSignal }): Promise<unknown>;
  }): Promise<undefined> | unknown;
}

/**
 * Test-only shim (lane 3): with ?shim=webmcp, install a minimal
 * document.modelContext BEFORE registration so the real registration layer is
 * exercised and Playwright can dispatch tool callbacks. This proves
 * command-bus convergence only — never WebMCP compatibility (lane 4 uses
 * native Chrome and fails hard when document.modelContext is absent).
 */
function installTestShimIfRequested(): void {
  const params = new URLSearchParams(window.location.search);
  if (params.get("shim") !== "webmcp") return;
  const doc = document as unknown as { modelContext?: ModelContextLike };
  if (doc.modelContext) return; // never mask a native implementation
  const tools = new Map<
    string,
    { description: string; inputSchema: unknown; annotations?: unknown; execute(args: unknown): Promise<unknown> }
  >();
  doc.modelContext = {
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
  };
  (window as unknown as Record<string, unknown>).__webmcpTestShim = {
    getTools: () =>
      [...tools.entries()].map(([name, t]) => ({
        name,
        description: t.description,
        inputSchema: t.inputSchema,
        annotations: t.annotations,
      })),
    executeTool: (name: string, argsJson: string) => {
      const tool = tools.get(name);
      if (!tool) throw new Error(`unknown tool ${name}`);
      return tool.execute(argsJson);
    },
  };
  diagnostics.log("test shim installed (?shim=webmcp) — NOT WebMCP proof");
}

function modelContext(): ModelContextLike | null {
  // Current API is document.modelContext (navigator.modelContext is the
  // pre-rename surface and deliberately not used).
  const mc = (document as unknown as { modelContext?: ModelContextLike })
    .modelContext;
  return mc && typeof mc.registerTool === "function" ? mc : null;
}

interface OmittedCounts {
  arrayItems: number;
  objectFields: number;
  stringCharacters: number;
}

interface StructuralLimits {
  arrayItems: number;
  objectFields: number;
  stringCharacters: number;
  depth: number;
}

const ROOT_PRIORITY = [
  "ok", "error", "revision", "effect", "staged", "delta", "outstanding",
  "identity", "phase", "brief", "manifest", "feasibility", "candidates",
];
const ERROR_PRIORITY = ["code", "message", "recovery"];

function clipString(value: string, max: number, omitted: OmittedCounts): string {
  if (value.length <= max) return value;
  omitted.stringCharacters += value.length - Math.max(0, max - 1);
  return max <= 1 ? "…" : `${value.slice(0, max - 1)}…`;
}

function compactStructurally(
  value: unknown,
  limits: StructuralLimits,
  omitted: OmittedCounts,
  path = "$",
  depth = 0,
): unknown {
  if (typeof value === "string") {
    return clipString(value, limits.stringCharacters, omitted);
  }
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const kept = value.slice(0, limits.arrayItems);
    omitted.arrayItems += value.length - kept.length;
    return kept.map((item) =>
      compactStructurally(item, limits, omitted, `${path}[]`, depth + 1),
    );
  }
  const record = value as Record<string, unknown>;
  const entries = Object.entries(record);
  if (depth >= limits.depth) {
    omitted.objectFields += entries.length;
    return "[nested content omitted]";
  }
  const priority = path === "$" ? ROOT_PRIORITY : path === "$.error" ? ERROR_PRIORITY : [];
  const ordered = [...entries].sort(([a], [b]) => {
    const ai = priority.indexOf(a);
    const bi = priority.indexOf(b);
    return (ai < 0 ? priority.length : ai) - (bi < 0 ? priority.length : bi);
  });
  const required = path === "$.error" ? new Set(ERROR_PRIORITY) : new Set<string>();
  const kept = ordered.filter(([key], index) => index < limits.objectFields || required.has(key));
  omitted.objectFields += entries.length - kept.length;
  return Object.fromEntries(
    kept.map(([key, item]) => [
      key,
      compactStructurally(item, limits, omitted, `${path}.${key}`, depth + 1),
    ]),
  );
}

function withOmissionMarker(value: unknown, omitted: OmittedCounts): Record<string, unknown> {
  const object = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { value };
  return { ...object, truncated: true, omitted };
}

/**
 * R15/X1: every registered tool crosses this single declared-budget boundary.
 * It never slices serialized JSON. Generic results are structurally compacted;
 * protocol pages must arrive complete because their cursor describes content.
 */
export function encodeToolResult(
  value: unknown,
  maxChars: number = BUDGETS.resultMax,
): { content: Array<{ type: "text"; text: string }> } {
  const raw = JSON.stringify(value ?? null);
  if (raw.length <= maxChars) {
    return { content: [{ type: "text", text: raw }] };
  }
  const root = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
  if (root && ("delta" in root || "manifest" in root)) {
    // X1: these fields are protocol state, not optional presentation detail.
    // A valid server page is budgeted before it reaches this boundary. If a
    // malformed/legacy response still exceeds the allowance, fail explicitly
    // rather than claiming that deleted revisions or manifest fields arrived.
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          ok: false,
          error: {
            code: "temporarily_unavailable",
            message: "The protocol page exceeded this tool's result allowance.",
            recovery: "Call sync_session again from the last fully consumed revision.",
          },
        }),
      }],
    };
  }
  for (const limits of [
    { arrayItems: 8, objectFields: 20, stringCharacters: 240, depth: 7 },
    { arrayItems: 4, objectFields: 14, stringCharacters: 160, depth: 6 },
    { arrayItems: 2, objectFields: 10, stringCharacters: 96, depth: 5 },
    { arrayItems: 1, objectFields: 7, stringCharacters: 64, depth: 4 },
    { arrayItems: 0, objectFields: 4, stringCharacters: 40, depth: 3 },
  ]) {
    const omitted: OmittedCounts = { arrayItems: 0, objectFields: 0, stringCharacters: 0 };
    const compacted = compactStructurally(value, limits, omitted);
    const text = JSON.stringify(withOmissionMarker(compacted, omitted));
    if (text.length <= maxChars) return { content: [{ type: "text", text }] };
  }

  // The declared 1.5K budget always fits this last shape. Keep failures
  // actionable even if a pathological value defeated every richer pass.
  const source = value as { ok?: unknown; error?: Record<string, unknown> } | null;
  const omitted: OmittedCounts = {
    arrayItems: 0,
    objectFields: value && typeof value === "object" ? Object.keys(value).length : 0,
    stringCharacters: raw.length,
  };
  const fallback = source?.ok === false
    ? {
        ok: false,
        error: {
          code: String(source.error?.code ?? "temporarily_unavailable"),
          message: clipString(String(source.error?.message ?? "Request failed."), 120, omitted),
          recovery: clipString(String(source.error?.recovery ?? "Retry in a moment."), 120, omitted),
        },
        truncated: true,
        omitted,
      }
    : { ok: source?.ok === true, truncated: true, omitted };
  return { content: [{ type: "text", text: JSON.stringify(fallback) }] };
}

/** Tool name → server command type for the mutating negotiation/spatial tools. */
const MUTATION_COMMANDS: Record<string, string> = {
  submit_requirement: "SubmitRequirement",
  withdraw_requirement: "WithdrawRequirement",
  set_requirement_active: "SetRequirementActive",
  evaluate_candidates: "EvaluateCandidates",
  respond_to_proposal: "RespondToProposal",
  resolve_private_request: "ResolvePrivateRequest",
  set_ready_state: "SetReadyState",
  set_origin: "SetOrigin",
  confirm_agreement: "ConfirmAgreement",
  set_search_scope: "SetSearchScope",
  add_candidates: "AddCandidates",
  propose_destination: "ProposeDestination",
  plan_arrival: "PlanArrival",
  attest_attribute: "AttestAttribute",
  confirm_fact: "ConfirmFact",
  // Deliberately absent: ConfirmPrivateRequest and CommitAgreement are
  // page-confirmation commands with no tool route — the human confirms in
  // the UI, not the agent. Both also require a confirmation nonce the server
  // sends only over this page's realtime channel, so a route added here by
  // mistake still could not commit (INTERACTION-AND-BINDING.md §5.4).
};

const trimWhy = (why: string) => (why.length > 64 ? `${why.slice(0, 61)}…` : why);

/**
 * get_spatial_context result, trimmed to the ~1.5K tool-result budget:
 * ≤8 candidate summary rows (eligible first, then uncertain), counts for the
 * remainder, no coordinates (agents act on stable IDs, the map shows humans
 * the geometry).
 */
function trimContext(context: SpatialContext) {
  const order = { eligible: 0, likely: 1, uncertain: 2, unlikely: 3, excluded: 4 } as const;
  const sorted = [...context.candidates].sort(
    (a, b) => order[a.eligibility] - order[b.eligibility] || a.walkMin - b.walkMin,
  );
  const shown = sorted.slice(0, 8);
  const rest = sorted.slice(8);
  const restEligible = rest.filter((c) => c.eligibility === "eligible").length;
  const row = (c: CandidateSummary) => ({
    candidateId: c.candidateId,
    name: c.name,
    eligibility: c.eligibility,
    why: c.why ? trimWhy(c.why) : undefined,
    walkMin: c.walkMin,
    priceLevel: c.priceLevel,
  });
  return {
    ok: true,
    revision: context.revision,
    phase: context.phase,
    scope: {
      scopeId: context.scope.scopeId,
      radiusM: context.scope.area.radiusM,
      transport: context.scope.transport,
      category: context.scope.category,
    },
    feasibility: context.feasibility,
    impasse: context.impasse,
    candidates: shown.map(row),
    moreCandidates: rest.length
      ? `${rest.length} more not shown (${restEligible} eligible). Use inspect_candidates by ID for detail.`
      : undefined,
    // Named stances are a presence affordance for the page; the agent needs
    // the tally and whether a veto stands, not the roster.
    proposals: context.proposals.map((p) => ({
      proposalId: p.proposalId,
      candidateId: p.candidateId,
      status: p.status,
      accepts: p.stances.filter((s) => s.stance === "accept").length,
      vetoStands: p.vetoStands,
      ownStance: p.ownStance,
    })),
    agreement: context.agreement,
    outstanding: spatial.state.outstanding,
  };
}

/**
 * Compact dossier rows so 3 dossiers fit the ~1.5K result budget. The server
 * returns the dossier array as `candidates` (InspectCandidatesResult).
 */
function trimInspect(result: unknown): unknown {
  const r = result as {
    ok?: boolean;
    candidates?: Array<Record<string, unknown> & {
      attributes?: Array<{ key: string; value?: unknown; status: string; source: string }>;
      needs?: Array<{ label?: string; private?: true; verdict: string }>;
      images?: unknown[];
    }>;
  };
  if (!r?.ok || !Array.isArray(r.candidates)) return result;
  return {
    ...r,
    candidates: r.candidates.map((d) => ({
      ...d,
      // Hours and coordinates cost more budget than an agent's decision needs;
      // attribute rows compress to "key=status(value) [provenance]"; need
      // rows to "label=verdict" (a peer's private need stays "private").
      hours: undefined,
      location: undefined,
      // Photos are for the reader, not the model: an agent learns that a place
      // has pictures and never receives a route to their bytes.
      images: undefined,
      imageCount: d.images?.length ?? 0,
      attributes: d.attributes?.map(
        (a) =>
          `${a.key}=${a.status}${a.value !== undefined ? `(${String(a.value)})` : ""} [${a.source.split(":")[0]}]`,
      ),
      needs: d.needs?.map((n) => `${n.private ? "private" : n.label ?? "?"}=${n.verdict}`),
    })),
  };
}

async function executeTool(
  name: string,
  args: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  switch (name) {
    case "sync_session":
      // Thread the agent's AbortSignal into the fetch (WEBMCP-REFERENCE §6.4).
      return syncSessionRaw(args ?? {}, signal);

    case "get_spatial_context": {
      // R15: this read owns its request, so cancellation cannot abort a UI
      // refetch that happened to share the store's coalesced promise.
      const fresh = await spatialContext(signal) as SpatialContext | { ok: false };
      if (!fresh.ok) return fresh;
      const context = fresh as SpatialContext;
      if (!spatial.state.context || context.revision >= spatial.state.context.revision) {
        spatial.update({ context });
      }
      if (!context.scope?.area) {
        return {
          ok: false,
          error: {
            code: "phase_unavailable",
            message: "This room has no spatial scope configured.",
            recovery: "Use sync_session for the room's negotiation state.",
          },
        };
      }
      return trimContext(context);
    }

    case "inspect_candidates":
      return trimInspect(await spatialInspectRaw(args ?? {}, signal));

    case "look_up_places":
      return trimInspect(await spatialLookupRaw(args ?? {}, signal));

    case "prepare_navigation":
      return spatialNavigationRaw(args ?? {}, signal);

    case "focus_destination": {
      // Page-local presentation only: pans/highlights this viewer's map.
      // No server call, no shared state (SPATIAL-PROTOCOL invariant 3).
      const candidateId = (args as { candidateId?: unknown })?.candidateId;
      if (typeof candidateId !== "string") {
        return {
          ok: false,
          error: {
            code: "invalid_input",
            message: "focus_destination needs a candidateId string.",
            recovery: "Pass a candidateId from get_spatial_context.",
          },
        };
      }
      const known = spatial.state.context?.candidates.find(
        (c) => c.candidateId === candidateId,
      );
      if (!known) {
        return {
          ok: false,
          error: {
            code: "not_found",
            message: `Unknown candidate "${candidateId}".`,
            recovery: "Refresh IDs with get_spatial_context.",
          },
        };
      }
      spatial.focus(candidateId);
      return { ok: true, effect: `Focused ${known.name} on this participant's map.` };
    }

    default: {
      const commandType = MUTATION_COMMANDS[name];
      if (!commandType) {
        return {
          ok: false,
          error: {
            code: "not_found",
            message: `Unknown tool "${name}".`,
            recovery: "Call sync_session for the current capability manifest.",
          },
        };
      }
      // Same command bus as UI gestures. The agent's own baseRevision (from
      // its last sync) is forwarded verbatim so revision discipline stays
      // honest — a stale agent gets sync_required with a delta, which is the
      // designed catch-up path, not something to paper over client-side.
      const input =
        args && typeof args === "object" ? (args as Record<string, unknown>) : {};
      // R15: aborting a mutation request cannot prove it did not commit. It is
      // safe to expose cancellation only because pass 1 attaches the same
      // invocation's idempotency key to the command transport.
      const result = await runCommand(commandType, input, signal);
      if (result.ok) {
        // UI-before-return: the visible map/panels reflect the change before
        // the agent's tool call resolves (agents plan against what they see).
        // A grant beyond the delegated bound also lands here as ok:true — the
        // refreshed outstanding list carries staged:true, which is what makes
        // the in-page confirm card visible; no error branch is involved.
        // R8: await the committed revision, not merely whichever projection
        // request happened to be in flight before this mutation.
        await spatial.refetch(result.revision);
      }
      return result;
    }
  }
}

export function registerWebMcpTools(): void {
  installTestShimIfRequested();
  const mc = modelContext();
  diagnostics.update({ modelContextPresent: mc !== null });
  if (!mc) {
    diagnostics.update({ registration: "unsupported" });
    diagnostics.log(
      "document.modelContext absent — WebMCP unavailable on this surface",
    );
    return;
  }
  // registerTool is async and can reject (bad name chars, schema
  // serialization): await every registration so failures land visibly in the
  // diagnostics panel instead of as unhandled rejections.
  void (async () => {
    try {
      for (const tool of TOOLS as ToolDefinition[]) {
        await mc.registerTool({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: tool.annotations,
          async execute(args: unknown, options?: { signal?: AbortSignal }) {
            // Native Chrome hands the parsed input object; the test shim may
            // pass the raw JSON string form.
            const parsed = typeof args === "string" ? safeParse(args) : args;
            const result = await executeTool(tool.name, parsed, options?.signal);
            return encodeToolResult(
              result,
              tool.name === "sync_session" ||
                (result !== null && typeof result === "object" && "delta" in result)
                ? BUDGETS.syncResultMax
                : BUDGETS.resultMax,
            );
          },
        });
        diagnostics.log(`registered tool ${tool.name}`);
      }
      diagnostics.update({ registration: "registered", registrationError: null });
    } catch (err) {
      diagnostics.update({
        registration: "failed",
        registrationError: String(err),
      });
      diagnostics.log(`registerTool FAILED: ${String(err)}`);
    }
  })();
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    // Forward the unparseable raw string: the server's schema rejects
    // non-objects, which is the correct outcome for malformed args.
    return raw;
  }
}
