import { describe, expect, it } from "vitest";
import { WireStore, WIRE_BYTE_BUDGET } from "../../apps/web/src/wire-store.ts";
import { wirePresentation, WIRE_CONTENT_ITEM_LIMIT, WIRE_CONTENT_TEXT_LIMIT, type WireContent } from "../../apps/web/src/wire-content.ts";
import { eventMatches, wireExport, wireRelations } from "../../apps/web/src/wire-insights.ts";

describe("Wire content", () => {
  it("retains the conversation across response patches, makes it searchable and excludes it from exports", () => {
    const store = new WireStore();
    const input = "Can you explain which place fits our requirements and why the others are still uncertain? Please check the dog policy too.";
    const conversation: NonNullable<WireContent["conversation"]> = { scope: "application-private", input };
    const id = store.begin({ lane: "agent", label: "say", content: { conversation } });
    store.patch(id, { content: { conversation: { ...conversation, reply: "The garden allows dogs outdoors.",
      calls: [{ tool: "look_up_places", round: 1, ms: 20, ok: true, state: "completed", summary: "2 places returned" }] } } });
    store.end(id, { outcome: "error", note: "partial · model", detail: { retry: "text preserved" } });
    const event = store.state.events[0];
    expect(event.content?.conversation?.input).toBe(input);
    expect(event.content?.conversation?.reply).toBe("The garden allows dogs outdoors.");
    expect(wirePresentation(event).title).toContain(input);
    expect(wirePresentation(event).preview).toContain("garden");
    expect(eventMatches(event, "dogs outdoors")).toBe(true);
    expect(eventMatches(event, "look_up_places completed")).toBe(true);
    const exported = JSON.stringify(wireExport(store.state));
    expect(exported).not.toMatch(/garden|dogs|requirements|application-private|content/);
    expect(exported).toContain("partial · model");
    expect(JSON.parse(exported).events[0].calls).toEqual([{ tool: "look_up_places", round: 1, ok: true, ms: 20, state: "completed" }]);
    expect(exported).not.toContain("2 places returned");
  });

  it("reveals projected event names and descriptions while preserving correlation and omitting raw payloads", () => {
    const store = new WireStore();
    store.mark({ lane: "http", label: "POST commands", correlationId: "request", id: "http" });
    store.mark({ lane: "ws", dir: "in", label: "event ×2", correlationId: "request", id: "ws", content: {
      events: [
        { type: "requirement_submitted", text: "You added a quiet place.", revision: 2, level: "full", payload: { approvalId: "private-token" } },
        { type: "candidates_updated", text: "Three places still work.", revision: 3, level: "aggregate", actorId: "private-actor" },
      ] as WireContent["events"],
    } });
    const event = store.state.events[1];
    expect(wirePresentation(event)).toEqual({ title: "requirement_submitted · candidates_updated", preview: "You added a quiet place. · Three places still work." });
    expect(eventMatches(event, "quiet")).toBe(true);
    expect(wireRelations(store.state.events)).toContainEqual({ source: "http", target: "ws", kind: "correlation" });
    expect(JSON.stringify(event)).not.toMatch(/private-token|private-actor|payload|actorId/);
    expect(JSON.stringify(wireExport(store.state))).not.toMatch(/quiet|Three places/);
  });

  it("caps content, reports omissions, copies only known fields and includes content in the byte budget", () => {
    const store = new WireStore();
    const secret = "approval-material-not-for-wire";
    const content = { conversation: { scope: "shared", input: "x".repeat(5000), reply: "y".repeat(5000),
      pendingAction: { id: secret },
      calls: Array.from({ length: 40 }, () => ({ tool: "inspect_candidates", round: 1, ms: 1, ok: true, arguments: secret, result: secret })),
    }, events: Array.from({ length: 40 }, () => ({ type: "changed", revision: 1, level: "full", text: "z".repeat(5000), payload: secret })) } as WireContent;
    const id = store.mark({ lane: "agent", label: "say", content });
    store.patch(id, { note: "done" }); // Rebounding must not double-count omissions.
    const recorded = store.state.events[0].content!;
    expect(recorded.conversation!.input).toHaveLength(WIRE_CONTENT_TEXT_LIMIT);
    expect(recorded.events).toHaveLength(WIRE_CONTENT_ITEM_LIMIT);
    expect(recorded.omittedCalls).toBe(8);
    expect(recorded.omittedEvents).toBe(8);
    expect(recorded.shortened).toBe(true);
    expect(JSON.stringify(recorded)).not.toContain(secret);
    for (let i = 0; i < 110; i++) store.mark({ lane: "agent", label: "say", content });
    expect(store.state.dropped).toBeGreaterThan(0);
    expect(store.state.retainedBytes).toBeLessThanOrEqual(WIRE_BYTE_BUDGET);
  });

  it("never retains held private content, including later patches and an invalid conversation scope", () => {
    const store = new WireStore();
    const content: WireContent = { conversation: { scope: "shared", input: "held private words", reply: "private interpretation" } };
    const id = store.begin({ lane: "agent", label: "condition", detail: { scope: "agent-private" }, content });
    store.patch(id, { content, detail: { retry: "text preserved" } });
    store.mark({ lane: "agent", label: "say", content: { conversation: { ...content.conversation!, scope: "agent-private" as "shared" } } });
    expect(JSON.stringify(store.state)).not.toMatch(/held private words|private interpretation/);
  });

  it("supports older frames and excerpts without pretending missing descriptions were recorded", () => {
    const store = new WireStore();
    store.mark({ lane: "ws", label: "event ×2", detail: { types: "ready_state_changed candidates_updated" } });
    store.mark({ lane: "agent", label: "say", detail: { said: "older excerpt" } });
    expect(wirePresentation(store.state.events[0]).title).toBe("ready_state_changed · candidates_updated");
    expect(wirePresentation(store.state.events[1]).title).toBe("say · older excerpt");
    expect(store.state.events[0].content).toBeUndefined();
  });
});
