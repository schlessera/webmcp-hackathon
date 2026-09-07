import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { allowedOrigin, installHttpSecurity, trustedProxies, WindowBudget, WorkSlots } from "../../apps/server/src/security.ts";

afterEach(() => vi.unstubAllEnvs());

describe("security budgets", () => {
  it("does not let identity churn evict an exhausted window", () => {
    const budget = new WindowBudget(1, 100, 2);
    expect(budget.take("a", 0)).toBe(true);
    expect(budget.take("b", 0)).toBe(true);
    expect(budget.take("c", 0)).toBe(false);
    expect(budget.take("a", 99)).toBe(false);
    expect(budget.take("c", 100)).toBe(true);
    expect(budget.take("a", 100)).toBe(true);
  });
  it("bounds concurrent work and releases a slot at most once", () => {
    const slots = new WorkSlots();
    const release = slots.acquire("global", 1)!;
    expect(slots.acquire("global", 1)).toBeNull();
    release(); release();
    expect(slots.acquire("global", 1)).toBeTypeOf("function");
    expect(slots.acquire("global", 1)).toBeNull();
  });
});

describe("origin and proxy boundaries", () => {
  it("requires the exact configured origin and does not trust sibling sites", () => {
    vi.stubEnv("PUBLIC_ORIGIN", "https://spokes.example.com");
    expect(allowedOrigin("https://spokes.example.com", "app:4173")).toBe(true);
    for (const origin of ["null", "https://evil.example.com", "http://spokes.example.com", "https://spokes.example.com/path"]) {
      expect(allowedOrigin(origin, "spokes.example.com")).toBe(false);
    }
    expect(allowedOrigin(undefined, "app:4173")).toBe(true);
  });
  it("ignores forwarded client addresses unless the actual peer is trusted", async () => {
    vi.stubEnv("TRUSTED_PROXIES", "192.0.2.10");
    const app = Fastify({ trustProxy: trustedProxies() });
    app.get("/ip", async (req) => ({ ip: req.ip }));
    expect((await app.inject({ url: "/ip", remoteAddress: "192.0.2.10", headers: { "x-forwarded-for": "198.51.100.1" } })).json().ip).toBe("198.51.100.1");
    expect((await app.inject({ url: "/ip", remoteAddress: "192.0.2.11", headers: { "x-forwarded-for": "198.51.100.1" } })).json().ip).toBe("192.0.2.11");
    await app.close();
    vi.stubEnv("TRUSTED_PROXIES", "true");
    expect(trustedProxies).toThrow();
  });
  it("sets browser/cache defenses on errors as well as successful private responses", async () => {
    vi.stubEnv("PUBLIC_ORIGIN", "https://spokes.example.com");
    vi.stubEnv("ROOM_LIMIT", "");
    vi.stubEnv("GLOBAL_ROOM_LIMIT", "51");
    const app = Fastify({ bodyLimit: 65_536 });
    installHttpSecurity(app, true);
    app.get("/api/private", async () => ({ private: true }));
    app.post("/api/rooms", async () => ({ ok: true }));
    app.post("/api/plans/preview", async () => ({ ok: true }));
    for (const url of ["/api/private", "/api/missing"]) {
      const response = await app.inject(url);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["x-frame-options"]).toBe("DENY");
      expect(response.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
      expect(response.headers["referrer-policy"]).toBe("no-referrer");
    }
    expect((await app.inject({ method: "POST", url: "/api/rooms", headers: { origin: "https://evil.example.com" }, payload: {} })).statusCode).toBe(403);
    const attempts = await Promise.all(Array.from({ length: 51 }, (_, i) => app.inject({ method: "POST", url: i % 2 ? "/api/plans/preview" : "/api/rooms", payload: {} })));
    expect(attempts.filter((r) => r.statusCode === 200)).toHaveLength(50);
    expect(attempts[50].statusCode).toBe(429);
    expect(attempts[50].headers["retry-after"]).toBe("60");
    // Over-budget traffic from the first IP cannot consume the fifty-first
    // global slot that belongs to another caller.
    expect((await app.inject({ method: "POST", url: "/api/rooms", remoteAddress: "198.51.100.2", payload: {} })).statusCode).toBe(200);
    await app.close();
  });
});
