import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MAX_IMAGE_DOWNLOAD_BYTES,
  downloadPlaceImage,
  readBoundedImageBody,
  resizePlaceImage,
} from "../../apps/server/src/enrich/images.ts";
import {
  MAX_IMAGE_CANDIDATE_HTML_BYTES,
  extractImageCandidates,
  fetchWebsiteImageCandidates,
  readBoundedHtmlBody,
} from "../../apps/server/src/enrich/website.ts";
import { parseCommonsImageInfo } from "../../apps/server/src/enrich/wikidata.ts";
import { dossierFromTags, KEPT_TAGS } from "../../packages/contracts/src/dossier.ts";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

describe("place image candidate extraction", () => {
  it("orders og, twitter, schema.org JSON-LD and microdata, image_src, then the largest bounded img", () => {
    const html = readFileSync(join(fixtures, "place-images.html"), "utf8");
    expect(extractImageCandidates(html, "https://place.example/about").map((image) => image.url)).toEqual([
      "https://place.example/og.jpg",
      "https://place.example/twitter.jpg",
      "https://place.example/schema.jpg",
      "https://place.example/microdata.jpg",
      "https://place.example/linked.jpg",
      "https://place.example/largest.jpg",
    ]);
  });

  it("returns no candidate for a page with none", () => {
    const html = readFileSync(join(fixtures, "place-images-none.html"), "utf8");
    expect(extractImageCandidates(html, "https://place.example/")).toEqual([]);
  });

  it("labels website candidates with the homepage host", () => {
    expect(extractImageCandidates(
      '<meta property="og:image" content="https://cdn.example/photo.jpg">',
      "https://www.place.example/about",
    )[0]).toMatchObject({
      source: "web:www.place.example",
      pageUrl: "https://www.place.example/about",
    });
  });

  it("keeps both OSM image tags as server lookup inputs", () => {
    expect(KEPT_TAGS).toEqual(expect.arrayContaining(["image", "wikimedia_commons"]));
    expect(dossierFromTags({
      amenity: "library",
      image: "https://images.example/place.jpg",
      wikimedia_commons: "File:Place.jpg",
    }, "2026-09-03T00:00:00Z").extras).toMatchObject({
      image: "https://images.example/place.jpg",
      wikimediaCommons: "File:Place.jpg",
    });
  });
});

describe("place image network and transform boundary", () => {
  it("stops a candidate-only homepage read at 512 KB", async () => {
    let cancelled = false;
    const chunk = new Uint8Array(128 * 1024).fill(97);
    const response = new Response(new ReadableStream({
      pull(controller) {
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    }));
    const html = await readBoundedHtmlBody(response);
    expect(Buffer.byteLength(html)).toBe(MAX_IMAGE_CANDIDATE_HTML_BYTES);
    expect(cancelled).toBe(true);
  });

  it("falls back to the bounded GET when HEAD is unsupported", async () => {
    const methods: string[] = [];
    const candidates = await fetchWebsiteImageCandidates(
      "https://93.184.216.34/place",
      async (url, init) => {
        if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
        methods.push(init?.method ?? "GET");
        if (init?.method === "HEAD") return new Response(null, { status: 405 });
        return new Response('<meta property="og:image" content="/photo.jpg">', {
          headers: { "content-type": "text/html" },
        });
      },
    );
    expect(methods).toEqual(["HEAD", "GET"]);
    expect(candidates).toEqual([expect.objectContaining({
      url: "https://93.184.216.34/photo.jpg",
      source: "web:93.184.216.34",
    })]);
  });

  it("rejects a declared body over six megabytes", async () => {
    const response = new Response("small", {
      headers: { "content-length": String(MAX_IMAGE_DOWNLOAD_BYTES + 1) },
    });
    await expect(readBoundedImageBody(response)).rejects.toThrow("download limit");
  });

  it("rejects decoded non-image bytes even when a response claims image/png", async () => {
    await expect(downloadPlaceImage({
      url: "https://93.184.216.34/not-really.png",
      source: "web:place.example",
      pageUrl: "https://place.example/",
    }, async (url) => url.endsWith("/robots.txt")
      ? new Response("", { status: 404 })
      : new Response("not really a png", { headers: { "content-type": "image/png" } })))
      .rejects.toThrow();
  });

  it("rejects a private target before invoking the image transport", async () => {
    let calls = 0;
    await expect(downloadPlaceImage({
      url: "http://127.0.0.1/private.png",
      source: "web:place.example",
      pageUrl: "https://place.example/",
    }, async () => {
      calls += 1;
      return new Response();
    })).rejects.toThrow("non-public network target");
    expect(calls).toBe(0);
  });

  it("rejects a response whose cache policy forbids the seven-day store", async () => {
    await expect(downloadPlaceImage({
      url: "https://93.184.216.34/photo.png",
      source: "web:place.example",
      pageUrl: "https://place.example/",
    }, async (url) => url.endsWith("/robots.txt")
      ? new Response("", { status: 404 })
      : new Response("bytes", { headers: { "cache-control": "private, no-store" } })))
      .rejects.toThrow("forbids shared caching");
  });

  it("turns a tiny generated image into bounded WebP", async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><rect width="1200" height="800" fill="navy"/></svg>',
    );
    const result = await resizePlaceImage(svg);
    expect(result.mime).toBe("image/webp");
    expect(result.width).toBe(960);
    expect(result.height).toBe(640);
    expect(result.bytes.byteLength).toBeLessThanOrEqual(200 * 1024);
    expect(result.bytes.subarray(8, 12).toString()).toBe("WEBP");
  });

  it("rejects a noisy image that remains over 200 KB after resize", async () => {
    const noisySvg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="960" height="960"><filter id="n"><feTurbulence baseFrequency=".7" numOctaves="5"/></filter><rect width="100%" height="100%" filter="url(#n)"/></svg>',
    );
    await expect(resizePlaceImage(noisySvg)).rejects.toThrow("storage limit");
  });
});

describe("Commons image metadata", () => {
  const doc = (license: string) => ({
    query: {
      pages: [{
        imageinfo: [{
          url: "https://upload.wikimedia.org/photo.jpg",
          descriptionurl: "https://commons.wikimedia.org/wiki/File:Photo.jpg",
          extmetadata: {
            Artist: { value: '<a href="/wiki/User:Ana">Ana Example</a>' },
            LicenseShortName: { value: license },
          },
        }],
      }],
    },
  });

  it("keeps credit and the actual Creative Commons licence", () => {
    expect(parseCommonsImageInfo(doc("CC BY-SA 4.0"), "wikidata:Q1")).toEqual({
      url: "https://upload.wikimedia.org/photo.jpg",
      pageUrl: "https://commons.wikimedia.org/wiki/File:Photo.jpg",
      source: "wikidata:Q1",
      license: "CC BY-SA 4.0",
      credit: "Ana Example",
    });
  });

  it("rejects a non-free licence", () => {
    expect(parseCommonsImageInfo(doc("All rights reserved"), "wikidata:Q1")).toBeNull();
  });
});
