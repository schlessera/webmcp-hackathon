import { afterEach, describe, expect, it } from "vitest";
import { respond, setTransport } from "../../apps/server/src/nl/openai.ts";

/** T1: web search options and clickable URL citations survive the Responses transport. */
describe("OpenAI web-search transport", () => {
  afterEach(() => setTransport(null));

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
