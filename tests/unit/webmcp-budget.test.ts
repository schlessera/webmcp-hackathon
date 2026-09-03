import { afterEach, describe, expect, it, vi } from "vitest";
import { BUDGETS, TOOLS } from "@webmcp-hackathon/contracts";
import { submitCommand, syncSessionRaw } from "../../apps/web/src/api.ts";
import { encodeToolResult } from "../../apps/web/src/webmcp.ts";

const long = "quoted \\\"provider text\\\" and participant text ".repeat(80);

function worstCaseSuccess(tool: string) {
  return {
    ok: true,
    revision: 999,
    effect: long,
    tool,
    candidates: Array.from({ length: 50 }, (_, index) => ({
      candidateId: `place_${index}`,
      name: long,
      why: long,
      attributes: Array.from({ length: 30 }, (_unused, attribute) => ({
        key: `attribute_${attribute}`,
        status: "unknown",
        note: long,
      })),
    })),
    outstanding: Array.from({ length: 20 }, (_, index) => ({
      type: "evaluation_request",
      candidateIds: Array.from({ length: 10 }, (_unused, id) => `place_${index}_${id}`),
      issuedAtRevision: index,
    })),
  };
}

function worstCaseError(tool: string) {
  return {
    ok: false,
    error: { code: "invalid_input", message: `${tool}: ${long}`, recovery: long },
    delta: {
      fromRevision: 0,
      truncated: true,
      events: Array.from({ length: 50 }, (_, revision) => ({
        revision,
        type: "requirement_submitted",
        level: "full",
        text: long,
        payload: { note: long },
      })),
    },
  };
}

describe("WebMCP result budgets", () => {
  it("serializes worst-case success and error fixtures for every tool", () => {
    for (const tool of TOOLS) {
      for (const fixture of [worstCaseSuccess(tool.name), worstCaseError(tool.name)]) {
        const result = encodeToolResult(fixture);
        const text = result.content[0].text;
        expect(text.length, tool.name).toBeLessThanOrEqual(BUDGETS.resultMax);
        const parsed = JSON.parse(text) as Record<string, unknown>;
        expect(parsed.ok, tool.name).toBe(fixture.ok);
        expect(parsed.truncated, tool.name).toBe(true);
        expect(parsed.omitted, tool.name).toEqual(expect.objectContaining({
          arrayItems: expect.any(Number),
          objectFields: expect.any(Number),
          stringCharacters: expect.any(Number),
        }));
        if (!fixture.ok) {
          expect(parsed.error, tool.name).toEqual(expect.objectContaining({
            code: "invalid_input",
            message: expect.any(String),
            recovery: expect.any(String),
          }));
        }
      }
    }
  });
});

describe("WebMCP cancellation", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("does not dispatch a read whose signal is already cancelled", async () => {
    vi.stubGlobal("sessionStorage", { getItem: () => "token" });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    controller.abort();

    const result = await syncSessionRaw({}, controller.signal) as {
      ok: false; error: { code: string };
    };
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.error.code).toBe("temporarily_unavailable");
  });

  it("passes cancellation to an in-flight mutation with idempotency attached", async () => {
    vi.stubGlobal("sessionStorage", { getItem: () => "token" });
    let requestHeaders: HeadersInit | undefined;
    vi.stubGlobal("fetch", vi.fn((_path: string, options?: RequestInit) => {
      requestHeaders = options?.headers;
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    }));
    const controller = new AbortController();
    const pending = submitCommand("SetReadyState", { baseRevision: 1, state: "ready" }, controller.signal);
    controller.abort();
    const result = await pending as { ok: false; error: { code: string } };
    const headers = requestHeaders as Record<string, string>;
    expect(headers["idempotency-key"]).toBe(headers["x-correlation-id"]);
    expect(result.error.code).toBe("temporarily_unavailable");
  });
});
