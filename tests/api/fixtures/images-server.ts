import { setEnrichFetch } from "../../../apps/server/src/enrich/index.ts";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEElEQVQImWMQSTkBRww4OQAcRg8Bm8OhhQAAAABJRU5ErkJggg==",
  "base64",
);

setEnrichFetch(async (url) => {
  const target = new URL(url);
  if (target.pathname === "/robots.txt") return new Response("", { status: 404 });
  if (target.pathname === "/photo.png") {
    return new Response(png, { headers: { "content-type": "image/png" } });
  }
  return new Response(
    '<html><head><meta property="og:image" content="/photo.png"></head><body>A place</body></html>',
    { headers: { "content-type": "text/html" } },
  );
});

await import("../../../apps/server/src/server.ts");
