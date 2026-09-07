import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { IncomingMessage } from "node:http";
import proxyaddr from "@fastify/proxy-addr";
import { authenticateToken, type Participant } from "./auth.ts";

export function securityLimit(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

/** Fixed windows with a hard cardinality bound. Never evict an active quota:
 * cycling identities must not reset an attacker's exhausted budget. */
export class WindowBudget {
  private entries = new Map<string, { count: number; until: number }>();
  readonly limit: number;
  readonly windowMs: number;
  readonly maxEntries: number;
  constructor(limit: number, windowMs: number, maxEntries = 10_000) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxEntries = maxEntries;
  }
  take(key: string, now = Date.now()): boolean {
    let entry = this.entries.get(key);
    if (entry && entry.until <= now) {
      this.entries.delete(key);
      entry = undefined;
    }
    if (!entry) {
      if (this.entries.size >= this.maxEntries) {
        for (const [id, row] of this.entries) if (row.until <= now) this.entries.delete(id);
        if (this.entries.size >= this.maxEntries) return false;
      }
      entry = { count: 0, until: now + this.windowMs };
      this.entries.set(key, entry);
    }
    if (entry.count >= this.limit) return false;
    entry.count += 1;
    return true;
  }
}

/** Reject excess work instead of accumulating an unbounded promise queue. */
export class WorkSlots {
  private active = new Map<string, number>();
  acquire(key: string, limit: number): (() => void) | null {
    const count = this.active.get(key) ?? 0;
    if (count >= limit) return null;
    this.active.set(key, count + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.active.get(key) ?? 1) - 1;
      if (remaining) this.active.set(key, remaining);
      else this.active.delete(key);
    };
  }
}

/** Only explicit IPs/CIDRs are accepted, never arbitrary forwarded headers or
 * hop counts. The proxy must overwrite X-Forwarded-For from internet clients. */
export function trustedProxies(): string[] | false {
  const entries = (process.env.TRUSTED_PROXIES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (entries.some((s) => !/^[\da-fA-F.:]+(?:\/\d{1,3})?$/.test(s))) {
    throw new Error("TRUSTED_PROXIES must contain explicit proxy IPs or CIDRs");
  }
  return entries.length ? entries : false;
}

/** HTTP and upgrade requests use the same explicit proxy trust boundary. */
export function socketClientIp(req: IncomingMessage): string {
  const trusted = trustedProxies();
  return proxyaddr(req, trusted || (() => false));
}

export function allowedOrigin(origin: string | undefined, host: string | undefined): boolean {
  // CLI clients use bearer credentials and need not send an Origin header.
  if (origin === undefined) return true;
  try {
    const parsed = new URL(origin);
    if (!/^https?:$/.test(parsed.protocol) || parsed.origin !== origin) return false;
    const configured = process.env.PUBLIC_ORIGIN;
    return configured ? origin === new URL(configured).origin : parsed.host === host;
  } catch { return false; }
}

const actors = new WeakMap<object, Promise<Participant | null>>();
export function requestActor(req: { headers: Record<string, unknown> }): Promise<Participant | null> {
  let result = actors.get(req);
  if (!result) {
    const header = req.headers.authorization;
    result = typeof header === "string" && /^Bearer [a-f0-9]{64}$/.test(header)
      ? authenticateToken(header.slice(7)) : Promise.resolve(null);
    actors.set(req, result);
  }
  return result;
}

export function installHttpSecurity(app: FastifyInstance, production: boolean): void {
  const ip = new WindowBudget(600, 60_000);
  const global = new WindowBudget(6000, 60_000, 1);
  const rooms = new WindowBudget(securityLimit("ROOM_LIMIT", 50), 3_600_000);
  const globalRooms = new WindowBudget(securityLimit("GLOBAL_ROOM_LIMIT", 100), 3_600_000, 1);
  const invites = new WindowBudget(30, 60_000);
  const globalInvites = new WindowBudget(300, 60_000, 1);
  const participant = new WindowBudget(20, 60_000);
  const room = new WindowBudget(60, 60_000);
  const slots = new WorkSlots();
  const releases = new WeakMap<FastifyRequest, Array<() => void>>();
  const release = (req: FastifyRequest) => {
    for (const done of releases.get(req) ?? []) done();
    releases.delete(req);
  };
  const reject = (reply: FastifyReply) =>
    reply.header("retry-after", "60").code(429).send({
      ok: false, error: { code: "rate_limited", message: "Too many requests. Try again shortly.", recovery: "Wait before retrying." },
    });
  app.addHook("onRequest", async (req, reply) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "no-referrer");
    reply.header("permissions-policy", "camera=(), microphone=(), geolocation=(self), tools=(self)");
    reply.header("content-security-policy", production
      ? "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://tiles.openfreemap.org; font-src 'self'; connect-src 'self' https://tiles.openfreemap.org; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
      : "frame-ancestors 'none'; object-src 'none'; base-uri 'self'");
    if (production && process.env.PUBLIC_ORIGIN?.startsWith("https://")) {
      reply.header("strict-transport-security", "max-age=31536000");
    }
    const path = req.url.split("?", 1)[0];
    if (!path.startsWith("/api/")) return;
    reply.header("cache-control", "no-store");
    if (!allowedOrigin(req.headers.origin, req.headers.host)) {
      return reply.code(403).send({ error: "origin not allowed" });
    }
    // Reject an exhausted caller before spending a shared quota. Otherwise
    // one blocked IP can drain the global bucket and lock everybody out.
    if (!ip.take(req.ip) || !global.take("all")) return reject(reply);
    const done = slots.acquire("http", 128);
    if (!done) return reject(reply);
    releases.set(req, [done]);
    if (path === "/api/rooms" || path === "/api/plans/preview") {
      if (!rooms.take(req.ip) || !globalRooms.take("all")) return reject(reply);
    }
    if (path === "/api/session/exchange" || path.startsWith("/api/invites")) {
      const kind = path === "/api/session/exchange" ? "exchange" : path === "/api/invites" ? "manage" : "claim";
      if (!invites.take(`${kind}:${req.ip}`) || !globalInvites.take("all")) return reject(reply);
    }
  });
  app.addHook("preHandler", async (req, reply) => {
    if (!req.url.startsWith("/api/nl/")) return;
    const actor = await requestActor(req);
    if (!actor) return reply.code(401).send({ ok: false, error: { code: "not_authenticated" } });
    if (!participant.take(actor.id) || !room.take(actor.roomId)) return reject(reply);
    const held = releases.get(req)!;
    for (const [key, limit] of [["nl", 6], [`participant:${actor.id}`, 1], [`room:${actor.roomId}`, 2]] as const) {
      const done = slots.acquire(key, limit);
      if (!done) return reject(reply);
      held.push(done);
    }
  });
  app.addHook("onResponse", async (req) => release(req));
  app.addHook("onError", async (req) => release(req));
}
