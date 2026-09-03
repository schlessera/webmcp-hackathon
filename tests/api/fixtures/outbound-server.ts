import {
  outboundFetch,
  setOutboundSessionFactoryForTests,
  setOutboundTransportForTests,
} from "../../../apps/server/src/net/outbound.ts";

const sessions = ["retry-session", "unused-session"];
setOutboundSessionFactoryForTests(() => sessions.shift() ?? "fallback-session");
let failed = false;
setOutboundTransportForTests(async (url, _init, context) => {
  const path = new URL(url).pathname;
  if (path === "/connect-retry" && !failed) {
    failed = true;
    const root = Object.assign(
      new Error("Proxy response (503) !== 200 when HTTP Tunneling"),
      { code: "UND_ERR_ABORTED" },
    );
    throw new TypeError("fetch failed", {
      cause: new Error("Request was cancelled.", { cause: root }),
    });
  }
  if (path === "/connect-retry" && context.session === "initial-session") {
    throw new Error("session did not rotate");
  }
  if (path === "/missing") return new Response("missing", { status: 404 });
  return new Response("ok", { status: 200 });
});

await import("../../../apps/server/src/server.ts");

const retried = await outboundFetch("https://example.org/connect-retry", {
  purpose: "venue-site",
  country: "DE",
  session: "initial-session",
  maxBytes: 1_024,
  timeoutMs: 2_000,
});
await retried.text();
const missing = await outboundFetch("https://example.org/missing", {
  purpose: "venue-site",
  country: "DE",
  session: "missing-session",
  maxBytes: 1_024,
  timeoutMs: 2_000,
});
await missing.text();
