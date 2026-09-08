import { BUDGETS, TOOLS, validReadInput, type ToolDefinition, type SpatialContextResult, type InspectCandidatesResponse } from "@webmcp-hackathon/contracts";
import {
  createRoom,
  fetchAreas,
  previewPlan,
  spatialContext,
  spatialInspectRaw,
  landmarksRaw,
  spatialLookupRaw,
  spatialNavigationRaw,
  syncSessionRaw,
} from "./api.ts";
import { diagnostics } from "./diagnostics-store.ts";
import { exchangeInvite, currentToken } from "./session.ts";
import { ContextPager, inspectResult, resultTooLarge, type ContextInput, type InspectInput } from "@webmcp-hackathon/contracts";
import { mintInvite } from "./invite-api.ts";
import { runCommand, spatial } from "./spatial-store.ts";
import { trim, utf8Bytes, wire } from "./wire-store.ts";
import type {
  SpatialContext,
} from "./spatial-types.ts";

/**
 * Start the full static catalog registration through document.modelContext
 * at page load. Registration proceeds asynchronously alongside mounting and
 * authentication. Room tools can report not_authenticated until exchange
 * finishes; phase/identity state does not change the catalog.
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

/** Complete output or an explicit failure. Never delete operational fields from
 * a successful result after its counts/cursors have been calculated. */
export function encodeToolResult(
  value: unknown,
  maxChars: number = BUDGETS.resultMax,
  recovery = "Request fewer candidates or specific keys/details. Use sync_session for outstanding work.",
): { content: Array<{ type: "text"; text: string }>; truncated: boolean } {
  const raw = JSON.stringify(value ?? null);
  if (raw.length <= maxChars) return { content: [{ type: "text", text: raw }], truncated: false };
  const source = value as { ok?: boolean; revision?: number; error?: { code?: string } } | null;
  const failure = resultTooLarge(recovery, source?.ok === true ? source.revision : undefined);
  if (source?.ok === false && source.error?.code) {
    // Keep the original failure category, but never clip a cursor or recovery instruction.
    failure.error.code = source.error.code as typeof failure.error.code;
    if (source.error.code === "sync_required") {
      failure.error.recovery = "Call sync_session with your last fully consumed event revision; consume every delta cursor before reconsidering the mutation.";
    } else if (source.error.code === "invalid_input") {
      failure.error.recovery = "Use the tool's published input schema.";
    } else if (source.error.code === "upgrade_required") {
      failure.error.recovery = "Reload the page and acquire tools for the new document, then call sync_session.";
    }
  }
  return { content: [{ type: "text", text: JSON.stringify(failure) }], truncated: true };
}

const contextPager = new ContextPager();

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

/**
 * The regions this demo can open a room in.
 *
 * The limitation is stated in the answer, not only in the tool description,
 * because an agent that reads one may not have kept the other.
 */
async function describeRegions(): Promise<unknown> {
  const areas = await fetchAreas().catch(() => null);
  if (!areas) {
    return {
      ok: false,
      error: {
        code: "temporarily_unavailable",
        message: "The region list could not be read.",
        recovery: "Retry in a moment.",
      },
    };
  }
  return {
    ok: true,
    note:
      "Spokes is built to work anywhere. World-wide venue data is out of scope " +
      "for this hackathon demo, so it runs on these prepared extracts.",
    regions: areas
      .filter((area) => area.available)
      .map((area) => ({
        regionId: area.id,
        label: area.label,
        city: area.city,
        source: area.source,
        dataAsOf: area.dataAsOf,
        placesOnRecord: (area.classes ?? []).map((item) => ({
          kind: item.label,
          places: item.count,
        })),
        ...(area.coverage?.pool
          ? {
              factsOnRecord: area.coverage.pool.decisive,
              factsPossible: area.coverage.pool.slots,
            }
          : {}),
      })),
  };
}

function cancelled(): unknown {
  return {
    ok: false,
    error: {
      code: "temporarily_unavailable",
      message: "The request was cancelled before the room was opened.",
      recovery: "Call open_room again when you want the room.",
    },
  };
}

/**
 * A goal, in ordinary words, becomes a room this page is now inside.
 *
 * The agent states the goal; the preview decides what it takes. That split is
 * the point: an agent choosing step classes would be a second implementation
 * of the planner, and the two would drift.
 */
async function openRoomFromGoal(
  args: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const input = (args ?? {}) as {
    goal?: unknown;
    organizerName?: unknown;
    regionId?: unknown;
  };
  const goal = typeof input.goal === "string" ? input.goal.trim() : "";
  const organizerName =
    typeof input.organizerName === "string" ? input.organizerName.trim() : "";
  const regionId = typeof input.regionId === "string" ? input.regionId : "";
  if (!goal || !organizerName || !regionId) {
    return {
      ok: false,
      error: {
        code: "invalid_input",
        message: "goal, organizerName and regionId are all required.",
        recovery: "Call describe_regions for the region ids, then retry.",
      },
    };
  }

  let timezone: string | undefined;
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    timezone = undefined;
  }
  if (signal?.aborted) return cancelled();
  const preview = await previewPlan({ goal, ...(timezone ? { timezone } : {}) });
  // The last point before anything is written. An agent that walked away
  // while the goal was being read should not come back to a room.
  if (signal?.aborted) return cancelled();
  const steps = preview?.steps?.length
    ? preview.steps.map((step) => ({
        placeClass: step.placeClass.key,
        title: step.title,
        needs: step.needs,
        when: step.when,
      }))
    : [{ placeClass: "food" }];

  const created = await createRoom({ areaId: regionId, organizerName, goal, steps });
  if (!created.ok) {
    return {
      ok: false,
      error: {
        code: "invalid_input",
        message: created.error,
        recovery: "Call describe_regions and use one of the region ids it lists.",
      },
    };
  }
  const organizer = created.room.invites.find((invite) => invite.role === "organizer");
  if (!organizer) {
    return {
      ok: false,
      error: {
        code: "temporarily_unavailable",
        message: "The room opened without a way in.",
        recovery: "Retry.",
      },
    };
  }

  // Become the organizer here and now, so a link to hand out can be minted
  // before the page moves. The navigation below reloads into the room with
  // this same identity already stored.
  await exchangeInvite(organizer.inviteSecret);
  const invite = await mintInvite();

  // Schedule navigation into the room; this callback does not await its mount.
  window.setTimeout(() => {
    window.location.assign(`/#invite=${organizer.inviteSecret}`);
    window.location.reload();
  }, 0);

  return {
    ok: true,
    effect: `Room open: ${created.room.goal}`,
    region: created.room.areaId,
    steps: created.room.steps.map((step) => ({
      position: step.index,
      about: step.title,
      kindOfPlace: step.placeClass.label,
      ...(step.relation.kind === "then" ? { after: step.relation.afterStepId } : {}),
    })),
    ...(invite
      ? {
          inviteOthers: `${window.location.origin}/#join=${invite.inviteSecret}`,
          inviteNote: "One person per link, and unused links expire in an hour.",
        }
      : {}),
    next: "After the page enters the room, call sync_session, then get_spatial_context.",
  };
}

async function executeTool(
  name: string,
  args: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  if (["get_spatial_context", "inspect_candidates", "sync_session"].includes(name) && !validReadInput(name, args === undefined ? {} : args)) {
    return { ok: false, error: { code: "invalid_input", message: `Invalid arguments for ${name}.`, recovery: "Use the tool's published input schema." } };
  }
  switch (name) {
    // Opening a room: the only two tools that answer before a participant
    // exists. They run the same server calls the three onboarding screens
    // run, so an agent-opened room and a person-opened one are the same room.
    case "describe_regions":
      return describeRegions();

    case "open_room":
      return openRoomFromGoal(args, signal);

    case "sync_session":
      // Thread the agent's AbortSignal into the fetch (WEBMCP-REFERENCE §6.4).
      return syncSessionRaw(
        args && typeof args === "object" && !Array.isArray(args) ? { ...args, passive: true } : args ?? { passive: true }, signal,
      );

    case "get_spatial_context": {
      const input = (args ?? {}) as ContextInput;
      const token = currentToken();
      if (!token) {
        contextPager.clear();
        return { ok: false, error: { code: "not_authenticated", message: "The page has no participant session.", recovery: "Wait for page authentication, then call sync_session." } };
      }
      if (input.cursor) return contextPager.read(token, input);
      // R15: this read owns its request, so cancellation cannot abort a UI
      // refetch that happened to share the store's coalesced promise.
      const fresh = await spatialContext(signal) as SpatialContext | { ok: false };
      if (!fresh.ok) return fresh;
      if (currentToken() !== token) {
        contextPager.clear();
        return { ok: false, error: { code: "not_authenticated", message: "The participant session changed during this read.", recovery: "Call sync_session for the current participant, then read a new candidate snapshot." } };
      }
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
      return contextPager.read(token, input, context as unknown as SpatialContextResult);
    }

    case "inspect_candidates": {
      const input = args as InspectInput;
      return inspectResult(await spatialInspectRaw({ candidateIds: input.candidateIds, intent: "read" }, signal) as InspectCandidatesResponse, input);
    }

    case "find_landmarks":
      return landmarksRaw(args ?? {}, signal);

    case "look_up_places": {
      const input = args as InspectInput;
      return inspectResult(await spatialLookupRaw(input, signal) as InspectCandidatesResponse, input);
    }

    case "prepare_navigation":
      return spatialNavigationRaw(args ?? {}, signal);

    case "focus_destination": {
      // Selects on this viewer's map without a negotiation command. The
      // mounted page reports viewing presence, which can start enrichment.
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
      // The command API retains a key for exact retries after an ambiguous
      // response. A reload loses that memory, so recovery then needs a sync.
      const result = await runCommand(commandType, input, signal);
      if (result.ok) {
        // Refresh the page store before returning when the read succeeds;
        // this does not await a React paint or guarantee a successful refetch.
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
  const registration = wire.begin({ lane: "tool", label: "register tools" });
  void (async () => {
    let registered = 0;
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
            // One span per call; the requests it makes hang under it through
            // the signal they are handed (argument names only, never values).
            const span = wire.begin({
              lane: "tool",
              label: tool.name,
              detail: {
                args: parsed && typeof parsed === "object" && !Array.isArray(parsed)
                  ? Object.keys(parsed as object).join(", ") || undefined
                  : undefined,
              },
            });
            const child = wire.child(span, options?.signal);
            let budget: number =
              tool.name === "sync_session" ? BUDGETS.syncResultMax :
              tool.name === "get_spatial_context" ? BUDGETS.contextResultMax :
              tool.name === "inspect_candidates" || tool.name === "look_up_places" ? BUDGETS.inspectResultMax :
              MUTATION_COMMANDS[tool.name] ? BUDGETS.mutationResultMax : BUDGETS.resultMax;
            try {
              const result = await executeTool(tool.name, parsed, child.signal);
              if (result !== null && typeof result === "object" && "delta" in result) {
                budget = BUDGETS.syncResultMax;
              }
              const encoded = encodeToolResult(result, budget);
              const text = encoded.content[0]?.text ?? "";
              const outcome = JSON.parse(text) as { ok?: boolean; effect?: string; error?: { code?: string } } | null;
              const ok = outcome?.ok === true;
              wire.end(span, {
                outcome: ok ? "ok" : "error",
                note: ok ? trim(outcome?.effect, 48) ?? "ok" : String(outcome?.error?.code ?? "error"),
                bytes: utf8Bytes(text),
                budget,
                truncated: encoded.truncated,
              });
              return encoded;
            } catch (err) {
              // A throw anywhere above (the tool, or encoding its result)
              // still closes the span.
              wire.end(span, { outcome: "error", note: "threw", budget, detail: { error: trim(err, 120) } });
              throw err;
            } finally {
              child.off();
            }
          },
        });
        registered += 1;
      }
      diagnostics.update({ registration: "registered", registrationError: null });
      wire.end(registration, { outcome: "ok", note: `${registered} tools` });
    } catch (err) {
      diagnostics.update({
        registration: "failed",
        registrationError: String(err),
      });
      wire.end(registration, { outcome: "error", note: trim(err, 80), detail: { registered } });
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
