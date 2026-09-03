import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  circuitStateForTests,
  classifyOutboundFailure,
  outboundDiagnostics,
  outboundProviderCounts,
  outboundFetch,
  resetOutboundStateForTests,
  routeForPurpose,
  setOutboundSessionFactoryForTests,
  setOutboundTransportForTests,
  type OutboundPurpose,
} from "../../apps/server/src/net/outbound.ts";

const oldProxy = process.env.PROXY;
const oldProxyUrl = process.env.PROXY_URL;

function proxyFailure(status = 503): Error {
  const root = Object.assign(
    new Error(`Proxy response (${status}) !== 200 when HTTP Tunneling`),
    { code: "UND_ERR_ABORTED" },
  );
  return new TypeError("fetch failed", { cause: new Error("Request was cancelled.", { cause: root }) });
}

beforeEach(() => {
  process.env.PROXY = "1";
  process.env.PROXY_URL = "http://user:key@127.0.0.1:31112";
  resetOutboundStateForTests();
});

afterEach(() => {
  if (oldProxy === undefined) delete process.env.PROXY;
  else process.env.PROXY = oldProxy;
  if (oldProxyUrl === undefined) delete process.env.PROXY_URL;
  else process.env.PROXY_URL = oldProxyUrl;
  resetOutboundStateForTests();
});

describe("outbound failure classification", () => {
  it("walks the complete CONNECT cause chain", () => {
    expect(classifyOutboundFailure(proxyFailure(407), "proxy.packetstream.io")).toMatchObject({
      leg: "proxy-auth",
      proxyStatus: 407,
      retryable: false,
    });
    expect(classifyOutboundFailure(proxyFailure(503), "proxy.packetstream.io")).toMatchObject({
      leg: "proxy-reported-target",
      proxyStatus: 503,
      retryable: true,
    });
  });

  it("separates proxy connect failures from target body timeouts", () => {
    expect(classifyOutboundFailure(
      Object.assign(new Error("connect timed out"), { code: "UND_ERR_CONNECT_TIMEOUT" }),
      "proxy.packetstream.io",
    ).leg).toBe("proxy-transport");
    expect(classifyOutboundFailure(
      Object.assign(new Error("body timed out"), { code: "UND_ERR_BODY_TIMEOUT" }),
      "proxy.packetstream.io",
    )).toMatchObject({ leg: "target", retryable: false });
  });
});

describe("purpose routing", () => {
  it("implements an explicit proxy allowlist", () => {
    const proxy: OutboundPurpose[] = [
      "venue-site", "venue-menu", "venue-image", "robots", "image-cdn",
    ];
    const direct: OutboundPurpose[] = [
      "wikimedia", "wikidata", "commons", "geofabrik", "tavily", "parallel", "dataforseo", "openai",
    ];
    for (const purpose of proxy) expect(routeForPurpose(purpose)).toBe("proxy");
    for (const purpose of direct) expect(routeForPurpose(purpose)).toBe("direct");
  });

  it("counts authenticated API providers without exposing request content", async () => {
    process.env.PROXY = "0";
    resetOutboundStateForTests();
    setOutboundTransportForTests(async () => new Response("{}", { status: 200 }));
    for (const purpose of ["parallel", "dataforseo"] as const) {
      const response = await outboundFetch(`https://example.org/${purpose}`, {
        purpose,
        method: "POST",
        body: "secret-body",
        maxBytes: 100,
        timeoutMs: 2_000,
      });
      await response.text();
    }
    expect(outboundProviderCounts()).toMatchObject({
      parallel: { attempts: 1, successes: 1 },
      dataforseo: { attempts: 1, successes: 1 },
    });
    expect(JSON.stringify(outboundProviderCounts())).not.toContain("secret-body");
  });
});

describe("proxy retry behavior", () => {
  it("rotates the opaque session and preserves country before succeeding", async () => {
    const sessions = ["session-a", "session-b", "session-c"];
    setOutboundSessionFactoryForTests(() => sessions.shift() ?? "session-z");
    const seen: Array<{ route: string; session?: string; country?: string }> = [];
    setOutboundTransportForTests(async (_url, _init, context) => {
      seen.push(context);
      if (seen.length === 1) throw proxyFailure(503);
      return new Response("ok", { status: 200 });
    });
    const response = await outboundFetch("https://example.org/", {
      purpose: "venue-site",
      country: "DE",
      session: "venue-pass",
      maxBytes: 100,
      timeoutMs: 2_000,
    });
    expect(await response.text()).toBe("ok");
    expect(seen).toEqual([
      expect.objectContaining({ route: "proxy", session: "venue-pass", country: "DE" }),
      expect.objectContaining({ route: "proxy", session: "session-a", country: "DE" }),
    ]);
  });

  it("does not retry a target status", async () => {
    let attempts = 0;
    setOutboundTransportForTests(async () => {
      attempts += 1;
      return new Response("missing", { status: 404 });
    });
    const response = await outboundFetch("https://example.org/missing", {
      purpose: "venue-site",
      country: "DE",
      maxBytes: 100,
      timeoutMs: 2_000,
    });
    expect(response.status).toBe(404);
    await response.text();
    expect(attempts).toBe(1);
  });
});

describe("decoded response safety", () => {
  it("aborts while streaming once decoded bytes exceed the cap", async () => {
    process.env.PROXY = "0";
    resetOutboundStateForTests();
    let cancelled = false;
    setOutboundTransportForTests(async () => new Response(new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
      },
      cancel() {
        cancelled = true;
      },
    }), { headers: { "content-encoding": "gzip", "content-length": "1" } }));
    const response = await outboundFetch("https://example.org/data", {
      purpose: "wikidata",
      maxBytes: 5,
      timeoutMs: 2_000,
    });
    await expect(response.arrayBuffer()).rejects.toThrow("decoded response exceeds byte limit");
    expect(cancelled).toBe(true);
  });

  it("rejects a private redirect before a second dispatch", async () => {
    let calls = 0;
    setOutboundTransportForTests(async () => {
      calls += 1;
      return new Response(null, { status: 302, headers: { location: "http://10.1.2.3/admin" } });
    });
    await expect(outboundFetch("https://example.org/", {
      purpose: "venue-site",
      country: "DE",
      maxBytes: 100,
      timeoutMs: 2_000,
    })).rejects.toThrow("non-public network target");
    expect(calls).toBe(1);
  });
});

describe("per-host routing state", () => {
  it("opens the circuit after five proxy-class failures", async () => {
    let routes: string[] = [];
    setOutboundTransportForTests(async (_url, _init, context) => {
      routes.push(context.route);
      if (context.route === "proxy") throw proxyFailure(503);
      return new Response("direct", { status: 200 });
    });
    const request = () => outboundFetch("https://example.org/", {
      purpose: "venue-site" as const,
      country: "DE",
      maxBytes: 100,
      timeoutMs: 2_000,
    });
    await expect(request()).rejects.toThrow();
    await expect(request()).rejects.toThrow();
    await expect(request()).rejects.toThrow();
    expect(circuitStateForTests("example.org").open).toBe(true);
    const direct = await request();
    expect(await direct.text()).toBe("direct");
    expect(routes.at(-1)).toBe("direct");
    expect(outboundDiagnostics().rows.some((row) =>
      row.host === "example.org" && row.route === "proxy" && row.attempts >= 5
    )).toBe(true);
  });

  it("closes an open circuit when direct is rate-limited and the proxy is healthy", async () => {
    let failExample = false;
    const routes: string[] = [];
    setOutboundTransportForTests(async (url, _init, context) => {
      routes.push(`${new URL(url).hostname}:${context.route}`);
      if (context.route === "proxy" && new URL(url).hostname === "example.org" && failExample) {
        throw proxyFailure(503);
      }
      if (context.route === "direct" && new URL(url).hostname === "example.org") {
        return new Response("limited", { status: 429 });
      }
      return new Response("ok", { status: 200 });
    });
    const healthy = await outboundFetch("https://www.iana.org/", {
      purpose: "venue-site",
      country: "DE",
      maxBytes: 100,
      timeoutMs: 2_000,
    });
    await healthy.text();
    failExample = true;
    const request = () => outboundFetch("https://example.org/", {
      purpose: "venue-site" as const,
      country: "DE",
      maxBytes: 100,
      timeoutMs: 2_000,
    });
    await expect(request()).rejects.toThrow();
    await expect(request()).rejects.toThrow();
    await expect(request()).rejects.toThrow();
    expect(circuitStateForTests("example.org").open).toBe(true);
    const limited = await request();
    await limited.text();
    expect(limited.status).toBe(429);
    expect(circuitStateForTests("example.org").open).toBe(false);
    await expect(request()).rejects.toThrow();
    expect(routes.at(-1)).toBe("example.org:proxy");
  });

  it("reuses one proxy session per target host so the tunnel is not rebuilt", async () => {
    const sessions: string[] = [];
    setOutboundTransportForTests(async (_url, _init, context) => {
      if (context.session) sessions.push(context.session);
      return new Response("ok", { status: 200 });
    });
    const read = (url: string) =>
      outboundFetch(url, { purpose: "venue-site", country: "DE", maxBytes: 100, timeoutMs: 2_000 });
    await read("https://example.org/a");
    await read("https://example.org/b");
    await read("https://www.iana.org/a");
    expect(sessions).toHaveLength(3);
    expect(sessions[0]).toBe(sessions[1]);
    expect(sessions[2]).not.toBe(sessions[0]);
  });
});
