import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Pool, ProxyAgent, fetch } from "../apps/server/node_modules/undici/index.js";

const raw = process.env.PROXY_URL;
if (!raw) throw new Error("PROXY_URL is not set");
const configured = new URL(raw);
const username = decodeURIComponent(configured.username);
const authKey = decodeURIComponent(configured.password);
const proxyHost = configured.hostname;
const endpoint = proxyHost === "proxy.packetstream.io"
  ? `https://${proxyHost}:31111`
  : `${configured.protocol}//${proxyHost}${configured.port ? `:${configured.port}` : ""}`;
const gateway = endpoint.startsWith("https:") ? "HTTPS/31111" : "HTTP/configured";
const ua = "spokes-enrich/0.2 (+https://github.com/schlessera/webmcp-hackathon; reads what a venue publishes about itself)";

function agent(password) {
  const token = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  return new ProxyAgent({
    uri: endpoint,
    token,
    pipelining: 0,
    headersTimeout: 20_000,
    bodyTimeout: 20_000,
    connectTimeout: 3_000,
    proxyTls: { timeout: 3_000, servername: proxyHost },
    clientFactory: (origin, options) => new Pool(origin, {
      ...options,
      headersTimeout: 3_000,
      bodyTimeout: 3_000,
      connect: typeof options.connect === "object"
        ? { ...options.connect, timeout: 3_000 }
        : { timeout: 3_000 },
    }),
  });
}

function errorShape(error) {
  const chain = [];
  for (let item = error, depth = 0; item instanceof Error && depth < 12; item = item.cause, depth += 1) {
    chain.push(item);
  }
  const tunnel = chain.map((item) =>
    /^Proxy response \((\d+)\) !== 200 when HTTP Tunneling$/.exec(item.message)?.[1]
  ).find(Boolean);
  const code = chain.map((item) => item.code).find((value) => typeof value === "string");
  return { outcome: "error", proxyStatus: tunnel ? Number(tunnel) : null, code: code ?? null };
}

async function bounded(response, max = 1_500_000) {
  if (!response.body) return 0;
  const reader = response.body.getReader();
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return bytes;
      bytes += value.byteLength;
      if (bytes > max) {
        await reader.cancel();
        return max;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function proxyRequest(label, target, password) {
  const dispatcher = agent(password);
  const started = performance.now();
  try {
    const response = await fetch(target, {
      dispatcher,
      headers: { "user-agent": ua },
      signal: AbortSignal.timeout(25_000),
    });
    const bytes = await bounded(response);
    return {
      label,
      outcome: "response",
      status: response.status,
      ms: Math.round(performance.now() - started),
      bytes,
    };
  } catch (error) {
    return { label, ...errorShape(error), ms: Math.round(performance.now() - started), bytes: 0 };
  } finally {
    await dispatcher.close().catch(() => undefined);
  }
}

async function echo(country) {
  const session = randomUUID().replaceAll("-", "").slice(0, 12);
  const dispatcher = agent(`${authKey}_country-${country}_session-${session}`);
  try {
    const response = await fetch("https://ipinfo.io/json", {
      dispatcher,
      headers: { "user-agent": ua, accept: "application/json" },
      signal: AbortSignal.timeout(25_000),
    });
    const doc = await response.json();
    return { requested: country, status: response.status, ip: String(doc.ip ?? ""), observed: String(doc.country ?? "") };
  } catch (error) {
    return { requested: country, ...errorShape(error) };
  } finally {
    await dispatcher.close().catch(() => undefined);
  }
}

const snapshot = JSON.parse(readFileSync(
  new URL("../packages/contracts/data/areas/berlin-mitte.json", import.meta.url),
  "utf8",
));
const venues = [];
const seen = new Set();
for (const venue of snapshot.venues) {
  const rawSite = venue.tags?.website;
  if (!rawSite) continue;
  try {
    const site = new URL(rawSite.includes("://") ? rawSite : `https://${rawSite}`);
    if (!/^https?:$/.test(site.protocol) || seen.has(site.hostname)) continue;
    seen.add(site.hostname);
    venues.push({ name: venue.name, url: site.toString(), host: site.hostname });
    if (venues.length === 20) break;
  } catch {}
}

async function measured(venue, route) {
  const started = performance.now();
  let dispatcher;
  try {
    if (route === "proxy") {
      const session = randomUUID().replaceAll("-", "").slice(0, 12);
      dispatcher = agent(`${authKey}_country-DE_session-${session}`);
    }
    const response = await fetch(venue.url, {
      ...(dispatcher ? { dispatcher } : {}),
      headers: { "user-agent": ua, accept: "text/html,application/xhtml+xml" },
      signal: AbortSignal.timeout(25_000),
    });
    const bytes = await bounded(response);
    return {
      status: response.status,
      ok: response.status >= 200 && response.status < 400,
      ms: Math.round(performance.now() - started),
      bytes,
    };
  } catch (error) {
    return { status: errorShape(error).code ?? "error", ok: false, ms: Math.round(performance.now() - started), bytes: 0 };
  } finally {
    await dispatcher?.close().catch(() => undefined);
  }
}

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

async function mapLimit(items, limit, work) {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await work(items[index]);
    }
  }));
  return results;
}

const four = [
  await proxyRequest("bad-auth", "https://api.ipify.org?format=json", `${authKey}-deliberately-bad`),
  await proxyRequest("unavailable-country", "https://api.ipify.org?format=json", `${authKey}_country-VA_session-probeva`),
  await proxyRequest("blocked-target", "https://example.invalid/", `${authKey}_country-DE_session-probeblocked`),
  await proxyRequest("success", "https://api.ipify.org?format=json", `${authKey}_country-DE_session-probeok`),
];
const echoes = [await echo("DE"), await echo("US")];
const comparisons = await mapLimit(venues, 4, async (venue) => ({
  name: venue.name,
  host: venue.host,
  direct: await measured(venue, "direct"),
  proxy: await measured(venue, "proxy"),
}));
const summary = Object.fromEntries(["direct", "proxy"].map((route) => {
  const rows = comparisons.map((row) => row[route]);
  return [route, {
    success: rows.filter((row) => row.ok).length,
    total: rows.length,
    p50Ms: percentile(rows.map((row) => row.ms), 0.5),
    p95Ms: percentile(rows.map((row) => row.ms), 0.95),
    bytes: rows.reduce((sum, row) => sum + row.bytes, 0),
  }];
}));
console.log(JSON.stringify({ gateway, four, echoes, summary, comparisons }, null, 2));
