import { setEnrichFetch } from "../../../apps/server/src/enrich/index.ts";
import { setTransport } from "../../../apps/server/src/nl/openai.ts";
import { createRequire } from "node:module";

const sharp = createRequire(new URL("../../../apps/server/package.json", import.meta.url))("sharp");

const png = await sharp({
  create: { width: 640, height: 480, channels: 3, background: "navy" },
}).png().toBuffer();

setTransport(async (body) => {
  process.stdout.write("image-fixture model-call\n");
  const input = body.input as Array<{ content?: Array<{ type?: string }> }>;
  const count = input?.[0]?.content?.filter((part) => part.type === "input_image").length ?? 0;
  return {
    output: [{
      type: "message",
      content: [{
        type: "output_text",
        text: JSON.stringify({
          images: Array.from({ length: count }, () => ({
            kind: "venue_exterior",
            confidence: 0.8,
          })),
        }),
      }],
    }],
    usage: { input_tokens: 120, output_tokens: 20 },
  };
});

setEnrichFetch(async (url, init) => {
  const target = new URL(url);
  if (target.hostname === "commons.wikimedia.org") {
    return Response.json({ query: { geosearch: [] } });
  }
  if (target.pathname === "/robots.txt") return new Response("", { status: 404 });
  if (target.pathname === "/photo.png") {
    process.stdout.write("image-fixture image-get /photo.png\n");
    return new Response(png, { headers: { "content-type": "image/png" } });
  }
  if (init?.method === "HEAD") {
    return new Response(null, {
      headers: { "content-type": "text/html", "content-length": "1024" },
    });
  }
  process.stdout.write(`image-fixture homepage-get ${target.pathname}\n`);
  if (target.pathname === "/flag") {
    return new Response(
      '<html><head><meta property="og:image" content="https://93.184.216.34/flag-en.png"></head></html>',
      { headers: { "content-type": "text/html" } },
    );
  }
  return new Response(
    '<html><head><meta property="og:image" content="https://93.184.216.34/photo.png"></head><body>A place</body></html>',
    { headers: { "content-type": "text/html" } },
  );
});

await import("../../../apps/server/src/server.ts");
