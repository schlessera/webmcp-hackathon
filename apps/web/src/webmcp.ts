import { TOOLS, type ToolDefinition } from "@webmcp-hackathon/contracts";
import { syncSessionRaw } from "./api.ts";
import { diagnostics } from "./diagnostics-store.ts";

/**
 * Gate 1: register the full (one-tool) catalog through
 * document.modelContext.registerTool() AT PAGE LOAD — never after
 * authentication completes; late registration races ChatGPT's discovery
 * snapshot. Until the invite-token exchange finishes, sync_session returns a
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

/** Tool results resolve (never reject) as one JSON text content block. */
function asToolResult(value: unknown): unknown {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
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
    default:
      return {
        ok: false,
        error: {
          code: "not_found",
          message: `Unknown tool "${name}".`,
          recovery: "Call sync_session for the current capability manifest.",
        },
      };
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
            return asToolResult(result);
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
