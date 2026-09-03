import { createHash, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { Pool, ProxyAgent, fetch as undiciFetch } from "undici";
import { config } from "../config.ts";

export type OutboundPurpose =
  | "venue-site"
  | "venue-menu"
  | "venue-image"
  | "robots"
  | "image-cdn"
  | "wikimedia"
  | "wikidata"
  | "commons"
  | "geofabrik"
  | "tavily"
  | "openai";

export type OutboundRoute = "direct" | "proxy";
export type ProxyFailureClass =
  | "proxy-auth"
  | "proxy-transport"
  | "proxy-reported-target";
export type FailureLeg = ProxyFailureClass | "target" | "client" | "aborted" | "unknown";

export interface ClassifiedFailure {
  leg: FailureLeg;
  code?: string;
  proxyStatus?: number;
  retryable: boolean;
  root: Error;
}

export interface OutboundOptions extends Omit<RequestInit, "redirect"> {
  purpose: OutboundPurpose;
  country?: string;
  session?: string;
  direct?: boolean;
  maxBytes: number;
  timeoutMs: number;
}

export interface OutboundDiagRow {
  host: string;
  route: OutboundRoute;
  country: string | null;
  window: { from: string; to: string };
  attempts: number;
  successes: number;
  proxyFailures: Record<ProxyFailureClass, number>;
  targetFailures: Record<"4xx" | "5xx" | "network", number>;
  targetStatus: Record<string, number>;
  latencyMs: { p50: number; p95: number; max: number };
  bytesDown: number;
  lastAt: string;
}

interface ProxyConfig {
  endpoint: string;
  fallbackEndpoint?: string;
  host: string;
  username: string;
  authKey: string;
}

interface AttemptEvent {
  at: number;
  host: string;
  route: OutboundRoute;
  country: string | null;
  latencyMs: number;
  bytes: number;
  success: boolean;
  proxyFailure?: ProxyFailureClass;
  targetFailure?: "4xx" | "5xx" | "network";
  targetStatus?: number;
}

interface TransportContext {
  route: OutboundRoute;
  session?: string;
  country?: string;
  dispatcher?: ProxyAgent;
}

type OutboundTransport = (
  url: string,
  init: RequestInit,
  context: TransportContext,
) => Promise<Response>;

const PROXY_PURPOSES = new Set<OutboundPurpose>([
  "venue-site",
  "venue-menu",
  "venue-image",
  "robots",
  "image-cdn",
]);
const MAX_REDIRECTS = 5;
const RING_MS = 24 * 60 * 60_000;
const BREAKER_WINDOW_MS = 10 * 60_000;
const BREAKER_COOLDOWN_MS = 30 * 60_000;
const PACING_MS = 250;
const PROXY_ATTEMPTS = 3;
const CONNECT_TIMEOUT_MS = 3_000;
const TUNNEL = /^Proxy response \((\d+)\) !== 200 when HTTP Tunneling$/;
const NON_PUBLIC_NAME = /(?:^|\.)(?:localhost|local|internal|home\.arpa)$/i;

let warnedProxyOff = false;
let cachedProxyEnv: string | undefined | null = null;
let cachedProxyConfig: ProxyConfig | null = null;
let events: AttemptEvent[] = [];
let testTransport: OutboundTransport | null = null;
let sessionFactory = () => randomUUID().replace(/-/g, "").slice(0, 16);
const sessionRotations = new Map<string, string>();
const proxyFailures = new Map<string, number[]>();
const breakerUntil = new Map<string, number>();
let lastProxySuccess = 0;
let diagnosticLogger: ((fields: Record<string, unknown>, message: string) => void) | null = null;
let diagnosticTimer: ReturnType<typeof setInterval> | null = null;

class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  async use<T>(job: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.active += 1;
    }
    try {
      return await job();
    } finally {
      this.active -= 1;
      const next = this.waiting.shift();
      if (next) {
        // Reserve the released slot before waking its waiter so a fresh caller
        // cannot barge and temporarily exceed the per-host ceiling.
        this.active += 1;
        next();
      }
    }
  }
}

const hostLimits = new Map<string, Semaphore>();
const sessionNextAt = new Map<string, number>();
const sessionPacing = new Map<string, Promise<void>>();

function oneTimeProxyOff(reason: "disabled" | "missing" | "invalid"): void {
  if (warnedProxyOff) return;
  warnedProxyOff = true;
  console.info(JSON.stringify({ msg: "outbound proxy disabled", reason, route: "direct" }));
}

/** Parse once per environment value without ever retaining or logging a URL with userinfo. */
function proxyConfig(): ProxyConfig | null {
  const raw = process.env.PROXY_URL;
  if (process.env.PROXY === "0") {
    oneTimeProxyOff("disabled");
    return null;
  }
  if (raw === cachedProxyEnv) return cachedProxyConfig;
  cachedProxyEnv = raw;
  cachedProxyConfig = null;
  if (!raw) {
    oneTimeProxyOff("missing");
    return null;
  }
  try {
    const parsed = new URL(raw);
    if (!/^https?:$/.test(parsed.protocol) || !parsed.hostname || !parsed.username || !parsed.password) {
      throw new Error("incomplete proxy URL");
    }
    const username = decodeURIComponent(parsed.username);
    const authKey = decodeURIComponent(parsed.password);
    // PacketStream's TLS gateway is supported by undici 6 and protects the
    // client-to-gateway credential hop. Non-PacketStream URLs retain their
    // explicitly configured scheme/port (useful for local scripted proxies).
    const packetStream = parsed.hostname.toLowerCase() === "proxy.packetstream.io";
    const protocol = packetStream ? "https:" : parsed.protocol;
    const port = packetStream ? "31111" : parsed.port;
    cachedProxyConfig = {
      endpoint: `${protocol}//${parsed.hostname}${port ? `:${port}` : ""}`,
      ...(packetStream ? { fallbackEndpoint: `http://${parsed.hostname}:31112` } : {}),
      host: parsed.hostname.toLowerCase(),
      username,
      authKey,
    };
    return cachedProxyConfig;
  } catch {
    oneTimeProxyOff("invalid");
    return null;
  }
}

export function proxyEnabled(): boolean {
  return proxyConfig() !== null;
}

export function routeForPurpose(purpose: OutboundPurpose): OutboundRoute {
  return PROXY_PURPOSES.has(purpose) ? "proxy" : "direct";
}

/** Stable across processes and releases: exactly buckets 0..9 of 0..99. */
export function isDirectControlHost(host: string): boolean {
  const digest = createHash("sha256").update(host.toLowerCase()).digest();
  return digest.readUInt32BE(0) % 100 < 10;
}

function causes(error: unknown): Error[] {
  const out: Error[] = [];
  let current = error;
  for (let depth = 0; current instanceof Error && depth < 12; depth += 1) {
    out.push(current);
    current = (current as Error & { cause?: unknown }).cause;
  }
  return out;
}

export function classifyOutboundFailure(error: unknown, proxyHost: string): ClassifiedFailure {
  const chain = causes(error);
  const root = chain.at(-1) ?? (error instanceof Error ? error : new Error(String(error)));
  const firstCode = chain.find((item) => typeof (item as Error & { code?: unknown }).code === "string") as
    | (Error & { code?: string })
    | undefined;
  const result = (
    leg: FailureLeg,
    retryable: boolean,
    extra: Partial<ClassifiedFailure> = {},
  ): ClassifiedFailure => ({ leg, retryable, root, ...(firstCode?.code ? { code: firstCode.code } : {}), ...extra });
  const has = (...codes: string[]) => chain.some((item) =>
    codes.includes(String((item as Error & { code?: unknown }).code ?? "")),
  );

  if (root.name === "AbortError" || root.name === "TimeoutError") return result("aborted", false);
  if (has("UND_ERR_PRX_TLS", "UND_ERR_PRX_CONN", "UND_ERR_SOCKS5")) {
    return result("proxy-transport", true);
  }
  for (const item of chain) {
    const match = TUNNEL.exec(item.message);
    if (!match) continue;
    const status = Number(match[1]);
    if (status === 401 || status === 403 || status === 407) {
      return result("proxy-auth", false, { proxyStatus: status });
    }
    return result(status >= 500 ? "proxy-reported-target" : "proxy-transport", true, {
      proxyStatus: status,
    });
  }
  if (chain.some((item) =>
    (item as Error & { code?: string }).code === "UND_ERR_INVALID_ARG" &&
    /Proxy Authentication Required \(407\)/.test(item.message)
  )) return result("proxy-auth", false, { proxyStatus: 407 });
  if (has(
    "UND_ERR_CONNECT_TIMEOUT",
    "ECONNREFUSED",
    "ENOTFOUND",
    "EAI_AGAIN",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "ETIMEDOUT",
  )) return result("proxy-transport", true);
  if (chain.some((item) => /^(?:ERR_TLS_|ERR_SSL_|DEPTH_|UNABLE_TO_|CERT_|SELF_SIGNED)/.test(
    String((item as Error & { code?: unknown }).code ?? ""),
  ))) {
    const namedHost = chain.find((item) => {
      const value = item as Error & { hostname?: string; host?: string };
      return value.hostname || value.host;
    }) as (Error & { hostname?: string; host?: string }) | undefined;
    return result((namedHost?.hostname ?? namedHost?.host) === proxyHost ? "proxy-transport" : "target", true);
  }
  if (has("UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_RES_CONTENT_LENGTH_MISMATCH") ||
      chain.some((item) => String((item as Error & { code?: unknown }).code ?? "").startsWith("HPE_"))) {
    return result("target", false);
  }
  // A fetch rejection under ProxyAgent happened before response headers (and
  // therefore before target bytes). A socket failure in that phase is a
  // rotating-exit failure; mid-body socket errors are classified by the body wrapper.
  if (has("UND_ERR_SOCKET", "ECONNRESET", "EPIPE")) return result("proxy-transport", true);
  if (has("UND_ERR_INVALID_ARG", "UND_ERR_DESTROYED", "UND_ERR_CLOSED", "UND_ERR_NOT_SUPPORTED")) {
    return result("client", false);
  }
  return result("unknown", false);
}

function publicIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b, c] = parts;
  return !(
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) || a >= 224
  );
}

export function isPublicAddress(address: string): boolean {
  if (address.includes(".")) {
    const mapped = address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
    return publicIpv4(mapped ?? address);
  }
  const value = address.toLowerCase();
  if (!value.includes(":") || value === "::" || value === "::1") return false;
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(value);
  if (mappedHex) {
    const high = Number.parseInt(mappedHex[1], 16);
    const low = Number.parseInt(mappedHex[2], 16);
    return publicIpv4(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
  }
  if (value.startsWith("::")) return false;
  const first = Number.parseInt(value.split(":")[0] || "0", 16);
  return Number.isFinite(first) &&
    (first & 0xfe00) !== 0xfc00 &&
    (first & 0xffc0) !== 0xfe80 &&
    (first & 0xff00) !== 0xff00 &&
    !/^2001:db8(?::|$)/.test(value);
}

export async function assertPublicTarget(target: URL): Promise<string[]> {
  const hostname = target.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!hostname || isIP(hostname) !== 0 || NON_PUBLIC_NAME.test(hostname)) {
    throw new Error("non-public network target");
  }
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new Error("non-public network target");
  }
  return addresses.map(({ address }) => address);
}

function prune(now = Date.now()): void {
  events = events.filter((event) => now - event.at <= RING_MS);
  for (const [host, failures] of proxyFailures) {
    const fresh = failures.filter((at) => now - at <= BREAKER_WINDOW_MS);
    if (fresh.length) proxyFailures.set(host, fresh);
    else proxyFailures.delete(host);
  }
  for (const [host, until] of breakerUntil) if (until <= now) breakerUntil.delete(host);
}

function record(event: AttemptEvent): void {
  events.push(event);
  prune(event.at);
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]);
}

export function outboundDiagnostics(): { generatedAt: string; rows: OutboundDiagRow[] } {
  prune();
  const grouped = new Map<string, AttemptEvent[]>();
  for (const event of events) {
    const key = `${event.host}\u0000${event.route}`;
    const group = grouped.get(key) ?? [];
    group.push(event);
    grouped.set(key, group);
  }
  const rows = [...grouped.values()].map((group): OutboundDiagRow => {
    const latencies = group.map((event) => event.latencyMs);
    const first = Math.min(...group.map((event) => event.at));
    const last = Math.max(...group.map((event) => event.at));
    const targetStatus: Record<string, number> = {};
    for (const event of group) {
      if (event.targetStatus !== undefined) {
        targetStatus[String(event.targetStatus)] = (targetStatus[String(event.targetStatus)] ?? 0) + 1;
      }
    }
    const count = <T extends string>(pick: (event: AttemptEvent) => T | undefined, value: T) =>
      group.filter((event) => pick(event) === value).length;
    return {
      host: group[0].host,
      route: group[0].route,
      country: group.find((event) => event.country)?.country ?? null,
      window: { from: new Date(first).toISOString(), to: new Date(last).toISOString() },
      attempts: group.length,
      successes: group.filter((event) => event.success).length,
      proxyFailures: {
        "proxy-auth": count((event) => event.proxyFailure, "proxy-auth"),
        "proxy-transport": count((event) => event.proxyFailure, "proxy-transport"),
        "proxy-reported-target": count((event) => event.proxyFailure, "proxy-reported-target"),
      },
      targetFailures: {
        "4xx": count((event) => event.targetFailure, "4xx"),
        "5xx": count((event) => event.targetFailure, "5xx"),
        network: count((event) => event.targetFailure, "network"),
      },
      targetStatus,
      latencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), max: Math.round(Math.max(...latencies)) },
      bytesDown: group.reduce((sum, event) => sum + event.bytes, 0),
      lastAt: new Date(last).toISOString(),
    };
  }).sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  return { generatedAt: new Date().toISOString(), rows };
}

function log(fields: Record<string, unknown>, message: string): void {
  if (diagnosticLogger) diagnosticLogger(fields, message);
  else console.info(JSON.stringify({ msg: message, ...fields }));
}

export function startOutboundDiagnosticLogging(
  logger: (fields: Record<string, unknown>, message: string) => void,
): void {
  diagnosticLogger = logger;
  if (diagnosticTimer) return;
  diagnosticTimer = setInterval(() => {
    const snapshot = outboundDiagnostics();
    logger({ rows: snapshot.rows }, "outbound diag");
  }, 5 * 60_000);
  diagnosticTimer.unref?.();
}

function noteProxyFailure(host: string, failure: ProxyFailureClass, now: number): void {
  const history = (proxyFailures.get(host) ?? []).filter((at) => now - at <= BREAKER_WINDOW_MS);
  history.push(now);
  proxyFailures.set(host, history);
  if (history.length >= 5 && !breakerUntil.has(host)) {
    breakerUntil.set(host, now + BREAKER_COOLDOWN_MS);
    log({ host, route: "direct", reason: failure, cooldownMs: BREAKER_COOLDOWN_MS }, "outbound circuit open");
  }
}

function noteDirectRateLimit(host: string, status: number, now: number): void {
  if ((status === 403 || status === 429) && breakerUntil.has(host) && now - lastProxySuccess <= BREAKER_WINDOW_MS) {
    breakerUntil.delete(host);
    proxyFailures.delete(host);
    log({ host, route: "proxy", reason: `direct-${status}` }, "outbound circuit closed");
  }
}

function selectedRoute(host: string, options: OutboundOptions): OutboundRoute {
  if (options.direct || routeForPurpose(options.purpose) === "direct") return "direct";
  if (!proxyEnabled() || isDirectControlHost(host) || (breakerUntil.get(host) ?? 0) > Date.now()) return "direct";
  return "proxy";
}

async function pace(session: string): Promise<void> {
  const previous = sessionPacing.get(session) ?? Promise.resolve();
  const turn = previous.then(async () => {
    const now = Date.now();
    const next = sessionNextAt.get(session) ?? 0;
    if (next > now) await new Promise((resolve) => setTimeout(resolve, next - now));
    sessionNextAt.set(session, Date.now() + PACING_MS);
  });
  sessionPacing.set(session, turn);
  await turn;
  if (sessionPacing.get(session) === turn) sessionPacing.delete(session);
}

function proxyAgent(
  proxy: ProxyConfig,
  country: string | undefined,
  session: string,
  endpoint = proxy.endpoint,
): ProxyAgent {
  const countrySuffix = country ? `_country-${country.toUpperCase()}` : "";
  const password = `${proxy.authKey}${countrySuffix}_session-${session}`;
  const token = `Basic ${Buffer.from(`${proxy.username}:${password}`).toString("base64")}`;
  return new ProxyAgent({
    uri: endpoint,
    token,
    pipelining: 0,
    headersTimeout: 20_000,
    bodyTimeout: 20_000,
    connectTimeout: CONNECT_TIMEOUT_MS,
    proxyTls: { timeout: CONNECT_TIMEOUT_MS, servername: proxy.host },
    clientFactory: (origin, options) => {
      const poolOptions = options as Pool.Options;
      return new Pool(origin, {
        ...poolOptions,
        headersTimeout: CONNECT_TIMEOUT_MS,
        bodyTimeout: CONNECT_TIMEOUT_MS,
        connect: typeof poolOptions.connect === "object"
          ? { ...poolOptions.connect, timeout: CONNECT_TIMEOUT_MS }
          : { timeout: CONNECT_TIMEOUT_MS },
      });
    },
  });
}

const productionTransport: OutboundTransport = async (url, init, context) => {
  return undiciFetch(url, {
    ...init,
    ...(context.dispatcher ? { dispatcher: context.dispatcher } : {}),
  } as Parameters<typeof undiciFetch>[1]) as unknown as Response;
};

function limitedResponse(
  response: Response,
  maxBytes: number,
  abort: AbortController,
  onBytes: (count: number) => void,
  onDone: () => void,
  onBodyFailure: () => void,
): Response {
  if (!response.body) {
    onDone();
    return response;
  }
  const reader = response.body.getReader();
  let size = 0;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    onDone();
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          finish();
          controller.close();
          return;
        }
        size += value.byteLength;
        if (size > maxBytes) {
          abort.abort();
          await reader.cancel("decoded response exceeds byte limit").catch(() => undefined);
          onBodyFailure();
          finish();
          controller.error(new Error("decoded response exceeds byte limit"));
          return;
        }
        onBytes(value.byteLength);
        controller.enqueue(value);
      } catch (error) {
        onBodyFailure();
        finish();
        controller.error(error);
      }
    },
    async cancel(reason) {
      abort.abort();
      await reader.cancel(reason).catch(() => undefined);
      finish();
    },
  });
  const wrapped = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  Object.defineProperties(wrapped, {
    url: { value: response.url },
    redirected: { value: response.redirected },
    type: { value: response.type },
  });
  return wrapped;
}

async function oneAttempt(
  target: URL,
  options: OutboundOptions,
  route: OutboundRoute,
  session: string | undefined,
  proxyEndpoint?: string,
): Promise<Response> {
  const started = Date.now();
  const abort = new AbortController();
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout, abort.signal]) : AbortSignal.any([timeout, abort.signal]);
  const headers = new Headers(options.headers);
  headers.set("user-agent", config.identifyingUserAgent);
  // CONNECT, target TLS SNI and HTTP Host all derive from this exact URL.
  // Keeping Host explicit makes an accidental URL/header split fail visibly.
  headers.set("host", target.host);
  let dispatcher: ProxyAgent | undefined;
  const proxy = proxyConfig();
  if (route === "proxy") {
    if (!proxy || !session) throw new Error("proxy route unavailable");
    dispatcher = proxyAgent(proxy, options.country, session, proxyEndpoint);
  }
  let event: AttemptEvent = {
    at: started,
    host: target.hostname.toLowerCase(),
    route,
    country: route === "proxy" ? options.country?.toUpperCase() ?? null : null,
    latencyMs: 0,
    bytes: 0,
    success: false,
  };
  try {
    const response = await (testTransport ?? productionTransport)(target.toString(), {
      method: options.method,
      headers,
      body: options.body,
      signal,
      redirect: "manual",
      cache: options.cache,
      credentials: options.credentials,
      integrity: options.integrity,
      keepalive: options.keepalive,
      mode: options.mode,
      referrer: options.referrer,
      referrerPolicy: options.referrerPolicy,
    }, { route, session, country: options.country, dispatcher });
    event.latencyMs = Date.now() - started;
    if (route === "proxy") lastProxySuccess = Date.now();
    const statusClass = response.status >= 500 ? "5xx" : response.status >= 400 ? "4xx" : undefined;
    event.success = statusClass === undefined;
    if (statusClass) {
      event.targetFailure = statusClass;
      event.targetStatus = response.status;
    }
    if (route === "direct") noteDirectRateLimit(event.host, response.status, Date.now());
    record(event);
    let closed = false;
    const commit = () => {
      if (closed) return;
      closed = true;
      void dispatcher?.close();
    };
    // Empty and HEAD responses have no useful body to wait for.
    if (!response.body || options.method === "HEAD" || response.status === 204 || response.status === 304) {
      commit();
      return response;
    }
    return limitedResponse(
      response,
      options.maxBytes,
      abort,
      (bytes) => { event.bytes += bytes; },
      commit,
      () => {
        event.success = false;
        event.targetFailure = "network";
      },
    );
  } catch (error) {
    event.latencyMs = Date.now() - started;
    const classified = route === "proxy"
      ? classifyOutboundFailure(error, proxy?.host ?? "")
      : classifyOutboundFailure(error, "");
    if (route === "proxy" && classified.leg.startsWith("proxy-")) {
      event.proxyFailure = classified.leg as ProxyFailureClass;
      noteProxyFailure(event.host, event.proxyFailure, Date.now());
    } else {
      event.targetFailure = "network";
    }
    record(event);
    void dispatcher?.close();
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { outboundFailure: classified });
  }
}

function redirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

export async function outboundFetch(url: string | URL, options: OutboundOptions): Promise<Response> {
  let current = url instanceof URL ? new URL(url) : new URL(url);
  if (!/^https?:$/.test(current.protocol)) throw new Error("not a fetchable URL");
  const originalHost = current.hostname.toLowerCase();
  const route = selectedRoute(originalHost, options);
  const baseSession = options.session ?? sessionFactory();
  let session = sessionRotations.get(baseSession) ?? baseSession;
  let method = options.method;
  let body = options.body;

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    await assertPublicTarget(current);
    const host = current.hostname.toLowerCase();
    const hostRoute = route === "proxy" && !isDirectControlHost(host) && (breakerUntil.get(host) ?? 0) <= Date.now()
      ? "proxy"
      : "direct";
    const limit = hostLimits.get(host) ?? new Semaphore(2);
    hostLimits.set(host, limit);
    let response: Response | undefined;
    let lastError: unknown;
    const attempts = hostRoute === "proxy" ? PROXY_ATTEMPTS : 1;
    let proxyEndpoint: string | undefined;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (hostRoute === "proxy") await pace(session);
      try {
        response = await (hostRoute === "proxy" ? limit.use(() => oneAttempt(
          current,
          { ...options, method, body },
          hostRoute,
          session,
          proxyEndpoint,
        )) : oneAttempt(current, { ...options, method, body }, hostRoute, undefined));
        break;
      } catch (error) {
        lastError = error;
        const classified = (error as Error & { outboundFailure?: ClassifiedFailure }).outboundFailure;
        if (!classified || !classified.leg.startsWith("proxy-") || !classified.retryable || attempt === attempts - 1) throw error;
        if (classified.leg === "proxy-transport") {
          proxyEndpoint = proxyConfig()?.fallbackEndpoint;
        }
        session = sessionFactory();
        sessionRotations.set(baseSession, session);
        await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * Math.min(2_000, 200 * 2 ** attempt))));
      }
    }
    if (!response) throw lastError;
    if (!redirectStatus(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) return response;
    await response.body?.cancel();
    if (redirects === MAX_REDIRECTS) throw new Error("too many redirects");
    const next = new URL(location, current);
    if (!/^https?:$/.test(next.protocol)) throw new Error("redirected to a non-fetchable URL");
    // The next loop rejects literal/private targets before transport sees them.
    current = next;
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
      method = "GET";
      body = undefined;
    }
  }
  throw new Error("too many redirects");
}

export function outboundFetchFor(
  purpose: OutboundPurpose,
  context: Omit<OutboundOptions, keyof RequestInit | "purpose" | "maxBytes" | "timeoutMs"> & {
    country?: string;
    session?: string;
    direct?: boolean;
    maxBytes: number;
    timeoutMs: number;
  },
): (url: string, init?: RequestInit) => Promise<Response> {
  return (url, init = {}) => outboundFetch(url, { ...init, ...context, purpose });
}

/** Test-only seams are explicit exports so production call sites cannot accidentally use them. */
export function setOutboundTransportForTests(transport: OutboundTransport | null): void {
  testTransport = transport;
}

export function setOutboundSessionFactoryForTests(factory: (() => string) | null): void {
  sessionFactory = factory ?? (() => randomUUID().replace(/-/g, "").slice(0, 16));
}

export function resetOutboundStateForTests(): void {
  events = [];
  proxyFailures.clear();
  breakerUntil.clear();
  sessionRotations.clear();
  hostLimits.clear();
  sessionNextAt.clear();
  sessionPacing.clear();
  lastProxySuccess = 0;
  warnedProxyOff = false;
  cachedProxyEnv = null;
  cachedProxyConfig = null;
  testTransport = null;
  setOutboundSessionFactoryForTests(null);
}

export function circuitStateForTests(host: string): { open: boolean; until?: number } {
  const until = breakerUntil.get(host.toLowerCase());
  return { open: Boolean(until && until > Date.now()), ...(until ? { until } : {}) };
}
