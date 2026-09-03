import { setEnrichFetch } from "../../../apps/server/src/enrich/index.ts";

// Full-process API seam for privacy tests: network is nominally enabled, but
// every venue response is deterministic and slow enough to publish progress.
setEnrichFetch(async (url) => {
  if (url.endsWith("/robots.txt")) return new Response("", { status: 200 });
  await new Promise((resolve) => setTimeout(resolve, 400));
  return new Response("<html></html>", {
    status: 200,
    headers: { "content-type": "text/html" },
  });
});

await import("../../../apps/server/src/server.ts");
