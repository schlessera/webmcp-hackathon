import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_IMAGE_DOWNLOAD_BYTES,
  downloadPlaceImage,
  readBoundedImageBody,
  refreshPlaceImages,
  resizePlaceImage,
} from "../../apps/server/src/enrich/images.ts";
import {
  MAX_IMAGE_CANDIDATE_HTML_BYTES,
  extractImageCandidates,
  fetchWebsiteImageCandidates,
  readBoundedHtmlBody,
  websiteImageCandidateAllowed,
} from "../../apps/server/src/enrich/website.ts";
import {
  commonsGeosearchNameMatches,
  geosearchCommonsImages,
  parseCommonsGeosearchImageInfo,
  parseCommonsImageInfo,
} from "../../apps/server/src/enrich/wikidata.ts";
import {
  classifyPlaceImages,
  keepPlaceImageVerdict,
  placeImageVerdictsFromAnswer,
} from "../../apps/server/src/enrich/image-classifier.ts";
import { setTransport } from "../../apps/server/src/nl/openai.ts";
import { dossierFromTags, KEPT_TAGS } from "../../packages/contracts/src/dossier.ts";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const sharp = createRequire(new URL("../../apps/server/package.json", import.meta.url))("sharp");

afterEach(() => setTransport(null));

describe("place image candidate extraction", () => {
  it("orders structured representative-image declarations before the page image", () => {
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

  it("rejects chrome words and unsafe types without rejecting near misses", () => {
    for (const url of [
      "https://place.example/assets/flag-en.png",
      "https://place.example/logo.png",
      "https://place.example/ui/sprite.webp",
    ]) expect(websiteImageCandidateAllowed({ url })).toBe(false);
    expect(websiteImageCandidateAllowed({
      url: "https://place.example/photo.jpg",
      alt: "language flag",
    })).toBe(false);
    expect(websiteImageCandidateAllowed({
      url: "https://place.example/photo.jpg",
      className: "site-logo hero",
    })).toBe(false);
    expect(websiteImageCandidateAllowed({
      url: "https://place.example/place.svg",
    })).toBe(false);
    expect(websiteImageCandidateAllowed({
      url: "https://place.example/place",
      declaredType: "image/gif",
    })).toBe(false);
    expect(websiteImageCandidateAllowed({
      url: "https://place.example/photos/flagship-hotel.jpg",
    })).toBe(true);
    expect(websiteImageCandidateAllowed({
      url: "https://bannerman.de/photos/dining-room.jpg",
    })).toBe(true);
  });

  it("rejects a chrome img even in the hero region", () => {
    expect(extractImageCandidates(
      '<header><img src="/flag-en.png" width="1200" height="800" alt="English flag"></header>',
      "https://place.example/",
    )).toEqual([]);
  });

  it("takes the largest declared hero image and ignores images below the first section", () => {
    const candidates = extractImageCandidates(`
      <header><img src="/header.jpg" width="300" height="200"></header>
      <section class="hero">
        <img src="/first.jpg">
        <img src="/winner.jpg" srcset="/winner-small.jpg 640w, /winner-large.jpg 1600w">
      </section>
      <section><img src="/too-late.jpg" width="2400" height="1600"></section>
    `, "https://place.example/");
    expect(candidates).toEqual([expect.objectContaining({
      url: "https://place.example/winner-large.jpg",
      source: "web:page-image:place.example",
      imagePolicy: expect.objectContaining({ class: "page-image", confidenceThreshold: 0.7 }),
    })]);
  });

  it("emits at most one page image and falls back to first-in-document order", () => {
    const candidates = extractImageCandidates(
      '<section><img src="/first.jpg"><img src="/second.jpg"></section>',
      "https://place.example/",
    );
    expect(candidates.filter((candidate) => candidate.imagePolicy.class === "page-image"))
      .toEqual([expect.objectContaining({ url: "https://place.example/first.jpg" })]);
  });

  it("uses the bounded prefix and a lazy source when semantic top blocks are absent", () => {
    const candidates = extractImageCandidates(
      '<div><img src="data:image/svg+xml,placeholder" data-src="/lazy-room.jpg" width="1000" height="700"></div>',
      "https://place.example/",
    );
    expect(candidates).toEqual([expect.objectContaining({
      url: "https://place.example/lazy-room.jpg",
      source: "web:page-image:place.example",
    })]);
  });

  it("uses the first main content block rather than a pre-main utility section", () => {
    const candidates = extractImageCandidates(`
      <section hidden><img src="/notice.jpg" width="100" height="100"></section>
      <main><section><img src="/spacer.gif" data-origsrc="/venue-large.jpg" data-width="1200" height="800"></section></main>
      <section><img src="/gallery.jpg" width="2000" height="1200"></section>
    `, "https://place.example/");
    expect(candidates).toEqual([expect.objectContaining({
      url: "https://place.example/venue-large.jpg",
      source: "web:page-image:place.example",
    })]);
  });

  it("uses companion social-image alt text to reject disguised chrome", () => {
    expect(extractImageCandidates(
      '<meta property="og:image" content="/media/123.png"><meta property="og:image:alt" content="English flag">',
      "https://place.example/",
    )).toEqual([]);
    expect(extractImageCandidates(
      '<meta name="twitter:image" content="/media/456.jpg"><meta name="twitter:image:alt" content="Venue terrace">',
      "https://place.example/",
    )).toHaveLength(1);
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

  it("turns a sufficiently large raster into bounded WebP", async () => {
    const png = await sharp({
      create: { width: 1200, height: 800, channels: 3, background: "navy" },
    }).png().toBuffer();
    const result = await resizePlaceImage(png);
    expect(result.mime).toBe("image/webp");
    expect(result.width).toBe(960);
    expect(result.height).toBe(640);
    expect(result.bytes.byteLength).toBeLessThanOrEqual(200 * 1024);
    expect(result.bytes.subarray(8, 12).toString()).toBe("WEBP");
  });

  it("rejects small and implausibly shaped decoded images", async () => {
    const small = await sharp({
      create: { width: 479, height: 320, channels: 3, background: "navy" },
    }).png().toBuffer();
    const portraitStrip = await sharp({
      create: { width: 480, height: 1000, channels: 3, background: "navy" },
    }).png().toBuffer();
    const wideStrip = await sharp({
      create: { width: 1800, height: 400, channels: 3, background: "navy" },
    }).png().toBuffer();
    await expect(resizePlaceImage(small)).rejects.toThrow("too small");
    await expect(resizePlaceImage(portraitStrip)).rejects.toThrow("aspect ratio");
    await expect(resizePlaceImage(wideStrip)).rejects.toThrow("aspect ratio");
  });

  it("keeps the structured 480x320 floor and applies 640x400 to page images", async () => {
    const structuredFloor = await sharp({
      create: { width: 480, height: 320, channels: 3, background: "navy" },
    }).png().toBuffer();
    const belowPageFloor = await sharp({
      create: { width: 639, height: 500, channels: 3, background: "navy" },
    }).png().toBuffer();
    await expect(resizePlaceImage(structuredFloor)).resolves.toMatchObject({ width: 480, height: 320 });
    await expect(resizePlaceImage(belowPageFloor, { width: 640, height: 400 }))
      .rejects.toThrow("too small");
  });

  it("rejects SVG and GIF after decode and ICO by extension before download", async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><rect width="1200" height="800" fill="navy"/></svg>',
    );
    const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");
    await expect(resizePlaceImage(svg)).rejects.toThrow("not an image");
    await expect(resizePlaceImage(gif)).rejects.toThrow("not an image");
    let calls = 0;
    await expect(downloadPlaceImage({
      url: "https://93.184.216.34/favicon.ico",
      source: "web:place.example",
      pageUrl: "https://place.example/",
    }, async () => {
      calls += 1;
      return new Response();
    })).rejects.toThrow("file type");
    expect(calls).toBe(0);
  });

  it("rejects a noisy image that remains over 200 KB after resize", async () => {
    const noisy = await sharp(randomBytes(960 * 960 * 3), {
      raw: { width: 960, height: 960, channels: 3 },
    }).png().toBuffer();
    await expect(resizePlaceImage(noisy)).rejects.toThrow("storage limit");
  });
});

describe("place image vision verdicts", () => {
  const answer = (kind: string, confidence: number) => ({ images: [{ kind, confidence }] });

  it("keeps place views and food at 0.6, and rejects every other kind", () => {
    for (const kind of ["venue_exterior", "venue_interior", "food_or_drink"] as const) {
      const verdict = placeImageVerdictsFromAnswer(answer(kind, 0.6), 1)![0];
      expect(keepPlaceImageVerdict(verdict)).toBe(true);
    }
    expect(keepPlaceImageVerdict(placeImageVerdictsFromAnswer(answer("venue_exterior", 0.599), 1)![0])).toBe(false);
    for (const kind of ["people", "logo", "flag_or_icon", "map_or_screenshot", "text_or_graphic", "other"] as const) {
      expect(keepPlaceImageVerdict(placeImageVerdictsFromAnswer(answer(kind, 0.99), 1)![0])).toBe(false);
    }
  });

  it("keeps a 0.65 structured venue but rejects a 0.65 page image", () => {
    const verdict = placeImageVerdictsFromAnswer(answer("venue_interior", 0.65), 1)![0];
    const [structured, page] = extractImageCandidates(
      '<meta property="og:image" content="/structured.jpg"><section><img src="/page.jpg"></section>',
      "https://place.example/",
    );
    expect(keepPlaceImageVerdict(verdict, structured.imagePolicy.confidenceThreshold)).toBe(true);
    expect(keepPlaceImageVerdict(verdict, page.imagePolicy.confidenceThreshold)).toBe(false);
  });

  it("never downloads or stores a page image while the classifier is off", async () => {
    const previous = process.env.PLACE_IMAGE_CLASSIFIER;
    process.env.PLACE_IMAGE_CLASSIFIER = "0";
    const statements: string[] = [];
    const client = {
      query: async (sql: string) => {
        statements.push(sql);
        return { rows: [], rowCount: 0 };
      },
      release: () => undefined,
    };
    const db = { connect: async () => client, query: client.query };
    const [candidate] = extractImageCandidates(
      '<section><img src="https://93.184.216.34/page.jpg" width="1200" height="800"></section>',
      "https://place.example/",
    );
    try {
      await expect(refreshPlaceImages(
        db as never,
        "node/classifier-off",
        "Classifier Off",
        [candidate],
        async () => { throw new Error("must not download"); },
      )).resolves.toBe(0);
      expect(statements.some((sql) => sql.includes("INSERT INTO place_images"))).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.PLACE_IMAGE_CLASSIFIER;
      else process.env.PLACE_IMAGE_CLASSIFIER = previous;
    }
  });

  it("rejects a malformed, invalid-confidence, or short answer as a whole", () => {
    expect(placeImageVerdictsFromAnswer(null, 1)).toBeNull();
    expect(placeImageVerdictsFromAnswer({ images: [] }, 1)).toBeNull();
    expect(placeImageVerdictsFromAnswer({ images: [{ kind: "logo" }] }, 1)).toBeNull();
    expect(placeImageVerdictsFromAnswer(answer("venue_exterior", 2), 1)).toBeNull();
  });

  it("sends one low-detail structured call for the whole place batch", async () => {
    let sent: Record<string, unknown> | undefined;
    setTransport(async (body) => {
      sent = body;
      return {
        output: [{
          type: "message",
          content: [{ type: "output_text", text: JSON.stringify({ images: [
            { kind: "venue_exterior", confidence: 0.8 },
            { kind: "logo", confidence: 0.95 },
          ] }) }],
        }],
        usage: { input_tokens: 111, output_tokens: 22 },
      };
    });
    const result = await classifyPlaceImages("A place", [
      { bytes: Buffer.from("first") },
      { bytes: Buffer.from("second") },
    ]);
    const content = (sent?.input as Array<{ content: Array<Record<string, unknown>> }>)[0].content;
    expect(content.filter((part) => part.type === "input_image")).toEqual([
      expect.objectContaining({ detail: "low" }),
      expect.objectContaining({ detail: "low" }),
    ]);
    expect(sent?.text).toMatchObject({ format: {
      type: "json_schema",
      name: "place_image_verdicts",
      strict: true,
    } });
    expect(result).toMatchObject({
      inputTokens: 111,
      outputTokens: 22,
      verdicts: [
        { kind: "venue_exterior", confidence: 0.8 },
        { kind: "logo", confidence: 0.95 },
      ],
    });
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

  it("normalises diacritics and accepts only a geosearch hit carrying the place name", () => {
    expect(commonsGeosearchNameMatches(
      "Café Einstein",
      "File:Cafe Einstein, Berlin 2025.jpg",
    )).toBe(true);
    expect(commonsGeosearchNameMatches(
      "Café Einstein",
      "File:Unrelated cafe terrace.jpg",
    )).toBe(false);
    expect(commonsGeosearchNameMatches("Cafe", "File:Nearby cafe.jpg")).toBe(false);

    // Three wrong pictures from a live Berlin run, each now refused.
    // A category is the photographer's filing, not their subject.
    expect(commonsGeosearchNameMatches(
      "Grimm Café",
      "File:(20250217) Berlin 04.jpg",
      ["Category:Jacob und Wilhelm Grimm Zentrum"],
    )).toBe(false);
    // A token inside a hyphenated compound belongs to a different name: this
    // is a university library, not the café next door.
    expect(commonsGeosearchNameMatches(
      "Grimm Café",
      "File:Mitte Planckstraße Jacob-und Wilhelm-Grimm-Zentrum.JPG",
    )).toBe(false);
    // Scattered tokens must not let a long title borrow a name.
    expect(commonsGeosearchNameMatches(
      "Nhat Long",
      "File:Long walk past the Nhat gallery.jpg",
    )).toBe(false);

    // Pinned live pairs. Short names need a standalone venue-kind word in the
    // title or a category that itself names the place.
    for (const [name, title, categories, matches] of [
      ["Bar Tausend", "File:Bar Tausend Berlin.jpg", [], true],
      ["Cafe Einstein", "File:Café Einstein - panoramio.jpg", [], true],
      ["Café im Bode-Museum", "File:Bode Museum, Berlin, Germany Feb 15, 2018.jpeg", [], true],
      ["Kamala", "File:Kamala Fine Thai Food (23963637).jpeg", [], true],
      ["Keyser Soze", "File:Keyser Soze sidewalk terrace, Berlin, 2017.jpg", [], true],
      ["Nhat Long", "File:Nhat Long restaurant in Berlin.jpg", [], true],
      ["Sophieneck", "File:Berlin - Sophieneck (Sophia Corner).jpg", ["Category:Sophieneck"], true],
      ["Ständige Vertretung", 'File:"Ständige Vertretung" Berlin Innenansicht 1.jpg', [], true],
      ["Pizza Hut", "File:Oven-Baked Pasta, Pizza Hut Berlin Oranienburger Strasse.jpg", [], true],
      ["Velvet 52", "File:20230629 xl 0837-Arcotel Velvet Berlin.jpg", [], false],
    ] as Array<[string, string, string[], boolean]>) {
      expect([name, commonsGeosearchNameMatches(name, title, categories)])
        .toEqual([name, matches]);
    }

    const matching = doc("CC BY-SA 4.0") as any;
    matching.query.pages[0].title = "File:Cafe Einstein street scene.jpg";
    matching.query.pages[0].categories = [{ title: "Category:Cafe Einstein Berlin" }];
    expect(parseCommonsGeosearchImageInfo(matching, "Café Einstein")).toHaveLength(1);
    expect(parseCommonsGeosearchImageInfo(matching, "Café Kranzler")).toEqual([]);
    // Category alone can corroborate, never carry.
    matching.query.pages[0].title = "File:Street scene.jpg";
    expect(parseCommonsGeosearchImageInfo(matching, "Café Einstein")).toEqual([]);
  });

  it("queries Commons namespace 6 within 40 m and resolves only named CC hits", async () => {
    const requests: URL[] = [];
    const result = await geosearchCommonsImages(
      "Café Einstein",
      { lat: 52.5, lng: 13.4 },
      async (raw) => {
        const url = new URL(raw);
        requests.push(url);
        if (url.searchParams.get("list") === "geosearch") {
          return Response.json({ query: { geosearch: [
            { title: "File:Cafe Einstein front.jpg" },
            { title: "File:Random street.jpg" },
          ] } });
        }
        const matching = doc("CC BY-SA 4.0") as any;
        matching.query.pages[0].title = "File:Cafe Einstein front.jpg";
        matching.query.pages.push({
          title: "File:Random street.jpg",
          categories: [{ title: "Category:Berlin streets" }],
          imageinfo: matching.query.pages[0].imageinfo,
        });
        return Response.json(matching);
      },
    );
    expect(requests[0].searchParams.get("list")).toBe("geosearch");
    expect(requests[0].searchParams.get("gsnamespace")).toBe("6");
    expect(requests[0].searchParams.get("gsradius")).toBe("40");
    expect(result).toEqual([expect.objectContaining({ source: "commons:geosearch" })]);
  });
});
