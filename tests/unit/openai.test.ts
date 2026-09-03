import { afterEach, describe, expect, it } from "vitest";
import {
  NlError,
  resetServiceTierSupportForTests,
  respond,
  setTransport,
} from "../../apps/server/src/nl/openai.ts";

/** T1: web search options and clickable URL citations survive the Responses transport. */
describe("OpenAI web-search transport", () => {
  afterEach(() => {
    setTransport(null);
    resetServiceTierSupportForTests();
  });

  it("constructs only default and flex service-tier requests", async () => {
    const sent: Record<string, unknown>[] = [];
    setTransport(async (body) => {
      sent.push(body);
      return { output: [] };
    });
    await respond({ model: "interactive-model", instructions: "test", input: [], intent: "interactive" });
    await respond({ model: "background-model", instructions: "test", input: [], intent: "background" });
    expect(sent.map((body) => body.service_tier)).toEqual(["default", "flex"]);
    for (const body of sent) {
      expect(body.service_tier).not.toBe("priority");
      expect(body.service_tier).not.toBe("fast");
    }
  });

  it("remembers a model's flex rejection and falls back to default only once", async () => {
    const tiers: unknown[] = [];
    setTransport(async (body) => {
      tiers.push(body.service_tier);
      if (body.service_tier === "flex") {
        throw new NlError("openai 400: unsupported service_tier flex", 400);
      }
      return { output: [] };
    });
    const call = { model: "no-flex-model", instructions: "test", input: [], intent: "background" as const };
    await respond(call);
    await respond(call);
    expect(tiers).toEqual(["flex", "default", "default"]);
  });

  it("passes search controls through and preserves calls, citations, and raw output", async () => {
    let sent: Record<string, unknown> | undefined;
    const search = { type: "web_search_call", id: "ws_1", action: { type: "search", query: "place access" } };
    setTransport(async (body) => {
      sent = body;
      return {
        output: [
          search,
          {
            type: "message",
            content: [{
              type: "output_text",
              text: "The place says access is step-free.",
              annotations: [{ type: "url_citation", url: "https://place.example/access", title: "Access", start_index: 0, end_index: 9 }],
            }],
          },
        ],
      };
    });
    const reply = await respond({
      model: "test",
      instructions: "ground the answer",
      input: [{ role: "user", content: "Is it step-free?" }],
      tools: [{ type: "web_search", filters: { allowed_domains: ["place.example"] }, search_context_size: "low" }],
      include: ["web_search_call.action.sources"],
    });
    expect(sent).toMatchObject({
      tools: [{ type: "web_search", filters: { allowed_domains: ["place.example"] }, search_context_size: "low" }],
      include: ["web_search_call.action.sources"],
    });
    expect(reply.citations).toEqual([{ url: "https://place.example/access", title: "Access", start: 0, end: 9 }]);
    expect(reply.webSearchCalls).toEqual([search]);
    expect(reply.outputItems[0]).toBe(search);
  });

  it("rebases citation offsets when Responses returns several text parts", async () => {
    setTransport(async () => ({
      output: [{
        type: "message",
        content: [
          { type: "output_text", text: "First", annotations: [] },
          { type: "output_text", text: "Second source", annotations: [{ type: "url_citation", url: "https://place.example/two", start_index: 0, end_index: 6 }] },
        ],
      }],
    }));
    const reply = await respond({ model: "test", instructions: "test", input: [] });
    expect(reply.text).toBe("First\nSecond source");
    expect(reply.citations).toEqual([{ url: "https://place.example/two", start: 6, end: 12 }]);
  });

  it("ignores non-array annotations without failing the response", async () => {
    setTransport(async () => ({
      output: [{
        type: "message",
        content: [{ type: "output_text", text: "still usable", annotations: { malformed: true } }],
      }],
    }));
    await expect(respond({
      model: "test",
      instructions: "reply",
      input: [{ role: "user", content: "hello" }],
    })).resolves.toMatchObject({ text: "still usable" });
  });
});
