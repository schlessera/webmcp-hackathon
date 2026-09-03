import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NlError,
  resetServiceTierSupportForTests,
  respond,
  respondPrivate,
  setTransport,
} from "../../apps/server/src/nl/openai.ts";

describe("LLM Responses transport", () => {
  beforeEach(() => {
    vi.stubEnv("LLM_PROVIDER", "openrouter");
  });

  afterEach(() => {
    setTransport(null);
    resetServiceTierSupportForTests();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.useRealTimers();
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
        throw new NlError("openrouter 400: unsupported service_tier flex", 400);
      }
      return { output: [] };
    });
    const call = { model: "no-flex-model", instructions: "test", input: [], intent: "background" as const };
    await respond(call);
    await respond(call);
    expect(tiers).toEqual(["flex", "default", "default"]);
  });

  it("rewrites search controls, drops include, and parses OpenRouter calls and citations without offsets", async () => {
    let sent: Record<string, unknown> | undefined;
    const search = {
      type: "openrouter:web_search",
      id: "ws_1",
      action: { type: "search", query: "place access" },
    };
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
              annotations: [{
                type: "url_citation",
                url: "https://place.example/access",
                title: "Access",
                content: "A permanent step-free entrance is available.",
                start_index: 0,
                end_index: 0,
              }],
            }],
          },
        ],
        usage: { server_tool_use_details: { web_search_requests: 1 } },
      };
    });
    const reply = await respond({
      model: "test",
      instructions: "ground the answer",
      input: [{ role: "user", content: "Is it step-free?" }],
      tools: [{
        type: "web_search",
        filters: { allowed_domains: ["place.example"] },
        search_context_size: "low",
      }],
      include: ["web_search_call.action.sources"],
    });
    expect(sent).toMatchObject({
      store: false,
      service_tier: "default",
      reasoning: { effort: "high" },
      tools: [{
        type: "openrouter:web_search",
        parameters: {
          allowed_domains: ["place.example"],
          search_context_size: "low",
        },
      }],
    });
    expect(sent).not.toHaveProperty("include");
    expect(reply.citations).toEqual([{
      url: "https://place.example/access",
      title: "Access",
      content: "A permanent step-free entrance is available.",
    }]);
    expect(reply.webSearchCalls).toEqual([search]);
    expect(reply.outputItems[0]).toBe(search);
  });

  it.each(["none", "minimal"] as const)(
    "maps reasoning %s to low effort with excluded reasoning",
    async (reasoning) => {
      let sent: Record<string, unknown> | undefined;
      setTransport(async (body) => {
        sent = body;
        return { status: "completed", output: [] };
      });
      await respond({ model: "test", instructions: "test", input: [], reasoning });
      expect(sent?.reasoning).toEqual({ effort: "low", exclude: true });
    },
  );

  it("never omits reasoning and requires parameter support for strict schemas", async () => {
    let sent: Record<string, unknown> | undefined;
    setTransport(async (body) => {
      sent = body;
      return { status: "completed", output: [] };
    });
    await respond({
      model: "test",
      instructions: "test",
      input: [],
      schema: {
        name: "strict_test",
        schema: { type: "object", additionalProperties: false, properties: {} },
      },
    });
    expect(sent).toMatchObject({
      reasoning: { effort: "high" },
      provider: { require_parameters: true },
      store: false,
    });
  });

  it("adds Cloudflare PDF parsing and private no-collection routing", async () => {
    let sent: Record<string, unknown> | undefined;
    setTransport(async (body) => {
      sent = body;
      return { status: "completed", output: [] };
    });
    await respondPrivate({
      model: "test",
      instructions: "read privately",
      input: [{
        role: "user",
        content: [{
          type: "input_file",
          filename: "menu.pdf",
          file_data: "data:application/pdf;base64,AA==",
        }],
      }],
      schema: {
        name: "private_pdf",
        schema: { type: "object", additionalProperties: false, properties: {} },
      },
    });
    expect(sent).toMatchObject({
      store: false,
      provider: {
        require_parameters: true,
        data_collection: "deny",
        zdr: true,
      },
      plugins: [{ id: "file-parser", pdf: { engine: "cloudflare-ai" } }],
    });
  });

  it("retries one incomplete response with a higher cap and accounts for both real costs", async () => {
    const sent: Array<Record<string, unknown>> = [];
    setTransport(async (body) => {
      sent.push(structuredClone(body));
      if (sent.length === 1) {
        return {
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          output: [],
          usage: { input_tokens: 10, output_tokens: 1, cost: 0.001 },
        };
      }
      return {
        status: "completed",
        output: [{
          type: "message",
          content: [{ type: "output_text", text: "{}" }],
        }],
        usage: { input_tokens: 10, output_tokens: 2, cost: 0.002 },
      };
    });
    const reply = await respond({
      model: "test",
      instructions: "test",
      input: [],
      maxOutputTokens: 1_200,
    });
    expect(sent.map((body) => body.max_output_tokens)).toEqual([1_200, 2_400]);
    expect(reply.usage).toEqual({ inputTokens: 20, outputTokens: 3, costUsd: 0.003 });
  });

  it("forces store false even if an untyped caller supplies store true", async () => {
    let sent: Record<string, unknown> | undefined;
    setTransport(async (body) => {
      sent = body;
      return { status: "completed", output: [] };
    });
    await respond({
      model: "test",
      instructions: "test",
      input: [],
      store: true,
    } as never);
    expect(sent?.store).toBe(false);
  });

  it.each(["priority", "fast"])(
    "refuses the paid %s service tier before transport",
    async (serviceTier) => {
      let calls = 0;
      setTransport(async () => {
        calls += 1;
        return { output: [] };
      });
      await expect(respond({
        model: "test",
        instructions: "test",
        input: [],
        serviceTier,
      } as never)).rejects.toThrow(`service tier ${serviceTier} is not allowed`);
      expect(calls).toBe(0);
    },
  );

  it.each([429, 500])("retries status %s three times with jitter", async (status) => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    let calls = 0;
    setTransport(async () => {
      calls += 1;
      if (calls < 4) throw new NlError("retry", status);
      return { status: "completed", output: [] };
    });
    const pending = respond({
      model: "test",
      instructions: "test",
      input: [],
      timeoutMs: 10_000,
    });
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toMatchObject({ text: null });
    expect(calls).toBe(4);
  });

  it("keeps the OpenAI request shape unchanged when that backend is selected", async () => {
    vi.stubEnv("LLM_PROVIDER", "openai");
    let sent: Record<string, unknown> | undefined;
    setTransport(async (body) => {
      sent = body;
      return {
        output: [{
          type: "message",
          content: [
            { type: "output_text", text: "First", annotations: [] },
            {
              type: "output_text",
              text: "Second source",
              annotations: [{
                type: "url_citation",
                url: "https://place.example/two",
                start_index: 0,
                end_index: 6,
              }],
            },
          ],
        }],
      };
    });
    const reply = await respond({
      model: "test",
      instructions: "test",
      input: [],
      tools: [{ type: "web_search", search_context_size: "low" }],
      include: ["web_search_call.action.sources"],
      reasoning: "none",
    });
    expect(sent).toMatchObject({
      tools: [{ type: "web_search", search_context_size: "low" }],
      include: ["web_search_call.action.sources"],
      reasoning: { effort: "none" },
    });
    expect(reply.citations).toEqual([{
      url: "https://place.example/two",
      start: 6,
      end: 12,
    }]);
  });

  it("ignores non-array annotations without failing the response", async () => {
    setTransport(async () => ({
      output: [{
        type: "message",
        content: [{
          type: "output_text",
          text: "still usable",
          annotations: { malformed: true },
        }],
      }],
    }));
    await expect(respond({
      model: "test",
      instructions: "reply",
      input: [{ role: "user", content: "hello" }],
    })).resolves.toMatchObject({ text: "still usable" });
  });
});


describe("OpenRouter provider pinning and attribution", () => {
  it("emits the pinned provider order with fallbacks off, and reads the serving provider", async () => {
    const previous = process.env.OPENROUTER_PROVIDERS;
    process.env.OPENROUTER_PROVIDERS = "together, fireworks";
    let sent: Record<string, unknown> | null = null;
    setTransport(async (body) => {
      sent = body;
      return {
        provider: "Together",
        output: [{ type: "message", content: [{ type: "output_text", text: "{}", annotations: [] }] }],
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    });
    try {
      const reply = await respond({
        model: "z-ai/glm-5.3-flash",
        instructions: "test",
        input: [{ role: "user", content: "hi" }],
        schema: { name: "t", schema: { type: "object", properties: {}, additionalProperties: false } },
      });
      const provider = (sent as unknown as { provider?: Record<string, unknown> })?.provider;
      expect(provider?.order).toEqual(["together", "fireworks"]);
      expect(provider?.allow_fallbacks).toBe(false);
      expect(provider?.require_parameters).toBe(true);
      expect(reply.provider).toBe("Together");
    } finally {
      if (previous === undefined) delete process.env.OPENROUTER_PROVIDERS;
      else process.env.OPENROUTER_PROVIDERS = previous;
      setTransport(null);
    }
  });
});
