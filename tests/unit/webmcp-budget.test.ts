import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BUDGETS,
  CAPABILITY_MANIFEST,
  TOOLS,
} from "@webmcp-hackathon/contracts";
import { nlSay, submitCommand, syncSessionRaw } from "../../apps/web/src/api.ts";
import { encodeToolResult, trimContext } from "../../apps/web/src/webmcp.ts";
import type { SpatialContext } from "../../apps/web/src/spatial-types.ts";

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
  };
}

describe("WebMCP result budgets", () => {
  it("keeps the image count but drops summary image metadata from the agent trim", () => {
    const context = {
      ok: true,
      revision: 1,
      phase: "gathering",
      scope: {
        scopeId: "scope_1",
        area: { kind: "circle", center: { lat: 52.5, lng: 13.4 }, radiusM: 800 },
        transport: ["walk"],
        category: "place",
      },
      feasibility: { state: "feasible", eligible: 1, likely: 0, uncertain: 0, unlikely: 0, excluded: 0 },
      total: 1,
      matching: 1,
      likely: 0,
      candidates: [{
        candidateId: "place_1",
        name: "A place",
        location: { lat: 52.5, lng: 13.4 },
        category: "place",
        eligibility: "eligible",
        why: "",
        walkMin: 2,
        priceLevel: 1,
        imageCount: 1,
        image: {
          url: "/api/places/node%2F1/images/0",
          width: 640,
          height: 480,
          blurhash: "LGF=X50Dx@x]G^IaM|-nyCRnaLt5",
        },
      }],
      facets: [],
      activeNeeds: [],
      privateEffects: [],
      participants: [],
      proposals: [],
    } as unknown as SpatialContext;

    const trimmed = trimContext(context) as { candidates: Array<Record<string, unknown>> };
    expect(trimmed.candidates[0]).toMatchObject({ imageCount: 1 });
    expect(trimmed.candidates[0]).not.toHaveProperty("image");
  });

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

  it("keeps a paged sync cursor, every claimed event, and the complete first-connect manifest", () => {
    const events = Array.from({ length: 3 }, (_, index) => ({
      revision: index + 11,
      type: "requirement_submitted",
      level: "full",
      text: `A participant added need ${index}. ${"detail ".repeat(45)}`,
      payload: { note: `need ${index}` },
    }));
    const fixture = {
      ok: true,
      revision: 20,
      buildId: "build-test",
      toolContractVersion: "3",
      phase: "gathering",
      identity: { participantId: "p_me", displayName: "Me", role: "member" },
      manifest: CAPABILITY_MANIFEST,
      brief: "Three changes are ready to review.",
      delta: {
        fromRevision: 10,
        events,
        truncated: true,
        throughRevision: 13,
        cursor: "d1.first-omitted-revision-14",
      },
      outstanding: [],
      participants: [
        {
          participantId: "p_me",
          displayName: "Me",
          role: "member",
          readyState: "contributing",
          arrived: true,
          present: true,
        },
      ],
      lastSyncedRevision: 10,
    };

    const encoded = encodeToolResult(fixture, BUDGETS.syncResultMax);
    const text = encoded.content[0].text;
    const parsed = JSON.parse(text) as typeof fixture;

    expect(text.length).toBeLessThanOrEqual(BUDGETS.syncResultMax);
    expect(parsed.delta.cursor).toBe(fixture.delta.cursor);
    expect(parsed.delta.events).toHaveLength(events.length);
    expect(parsed.delta.events).toEqual(events);
    expect(parsed.manifest.attributeVocabulary).toEqual(
      CAPABILITY_MANIFEST.attributeVocabulary,
    );
    expect(parsed.participants).toEqual(fixture.participants);
    expect(parsed.lastSyncedRevision).toBe(10);
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
    expect(headers["idempotency-key"]).toMatch(/^i_/);
    expect(headers["idempotency-key"]).not.toBe(headers["x-correlation-id"]);
    expect(result.error.code).toBe("temporarily_unavailable");
  });

  it("reuses one idempotency key across HTTP attempts of a logical mutation", async () => {
    vi.stubGlobal("sessionStorage", { getItem: () => "token" });
    const attempts: Array<Record<string, string>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_path: string, options?: RequestInit) => {
      attempts.push(options?.headers as Record<string, string>);
      return { json: async () => ({ ok: true, revision: 2, outstanding: [] }) };
    }));

    const logicalKey = "mutation-one-logical-key";
    await submitCommand("SetReadyState", { baseRevision: 1, state: "ready" }, undefined, logicalKey);
    await submitCommand("SetReadyState", { baseRevision: 1, state: "ready" }, undefined, logicalKey);

    expect(attempts[0]["idempotency-key"]).toBe(logicalKey);
    expect(attempts[1]["idempotency-key"]).toBe(logicalKey);
    expect(attempts[0]["x-correlation-id"]).not.toBe(attempts[1]["x-correlation-id"]);
  });

  it("retains the hidden key when a WebMCP transport result is ambiguous", async () => {
    vi.stubGlobal("sessionStorage", { getItem: () => "token" });
    const attempts: Array<Record<string, string>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_path: string, options?: RequestInit) => {
      attempts.push(options?.headers as Record<string, string>);
      if (attempts.length === 1) throw new TypeError("connection reset");
      return { json: async () => ({ ok: true, revision: 2, outstanding: [] }) };
    }));

    const input = { baseRevision: 1, state: "ready" };
    await submitCommand("SetReadyState", input);
    await submitCommand("SetReadyState", input);

    expect(attempts[1]["idempotency-key"]).toBe(attempts[0]["idempotency-key"]);
    expect(attempts[1]["x-correlation-id"]).not.toBe(attempts[0]["x-correlation-id"]);
  });

  it("keys a natural-language request as one side-effecting turn", async () => {
    vi.stubGlobal("sessionStorage", { getItem: () => "token" });
    let requestHeaders: Record<string, string> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_path: string, options?: RequestInit) => {
      requestHeaders = options?.headers as Record<string, string>;
      return { json: async () => ({ ok: true, intent: "ask", reply: "Done." }) };
    }));

    await nlSay("What changed?", "shared");
    expect(requestHeaders?.["idempotency-key"]).toMatch(/^i_/);
    expect(requestHeaders?.["idempotency-key"]).not.toBe(
      requestHeaders?.["x-correlation-id"],
    );
  });
});

describe("client transport failures", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("does not label fetch or JSON parsing failures as not_found", async () => {
    vi.stubGlobal("sessionStorage", { getItem: () => "token" });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
    const fetchFailure = await syncSessionRaw({}) as { error: { code: string } };
    expect(fetchFailure.error.code).toBe("temporarily_unavailable");

    vi.stubGlobal("fetch", vi.fn(async () => ({
      json: async () => { throw new SyntaxError("bad json"); },
    })));
    const parseFailure = await syncSessionRaw({}) as { error: { code: string } };
    expect(parseFailure.error.code).toBe("temporarily_unavailable");
  });
});
