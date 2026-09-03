import { describe, expect, it, vi } from "vitest";
import {
  cacheTtlMsForSource,
  MAX_CACHED_PAGE_TEXT,
  storePageCache,
  type PageCacheEntry,
  type StorePageInput,
} from "../../apps/server/src/enrich/cache.ts";
import { cacheTtlMs, IMAGE_TTL_MS } from "../../apps/server/src/enrich/images.ts";
import {
  fetchWebsiteFacts,
  type WebsitePageCache,
} from "../../apps/server/src/enrich/website.ts";

const DAY = 24 * 60 * 60_000;
const target = "https://93.184.216.34/venue";

function entry(overrides: Partial<PageCacheEntry> = {}): PageCacheEntry {
  return {
    url: target,
    host: "93.184.216.34",
    fetchedAt: "2026-08-01T00:00:00.000Z",
    expiresAt: "2026-08-08T00:00:00.000Z",
    status: 200,
    fresh: false,
    ...overrides,
  };
}

function pageCache(page: PageCacheEntry) {
  const store = vi.fn(async (_input: StorePageInput) => undefined);
  const refresh = vi.fn(async () => undefined);
  const cache: WebsitePageCache = {
    load: vi.fn(async (url) => new URL(url).pathname === "/robots.txt"
      ? entry({ url: "https://93.184.216.34/robots.txt", robots: "", fresh: true })
      : page),
    store,
    refresh,
  };
  return { cache, store, refresh };
}

describe("outbound cache policy", () => {
  it("selects the required TTL for each source", () => {
    expect(cacheTtlMsForSource("dns")).toBe(10 * 60_000);
    expect(cacheTtlMsForSource("robots")).toBe(DAY);
    expect(cacheTtlMsForSource("page")).toBe(7 * DAY);
    expect(cacheTtlMsForSource("search")).toBe(7 * DAY);
    expect(cacheTtlMsForSource("wikidata")).toBe(30 * DAY);
    expect(cacheTtlMsForSource("commons")).toBe(30 * DAY);
    expect(cacheTtlMsForSource("image")).toBe(30 * DAY);
  });

  it("keeps the image TTL under the source max-age while retaining its floor", () => {
    expect(IMAGE_TTL_MS).toBe(30 * DAY);
    expect(cacheTtlMs("public, max-age=172800")).toBe(2 * DAY);
    expect(cacheTtlMs("public, max-age=60")).toBe(DAY);
    expect(cacheTtlMs("public, max-age=99999999")).toBe(30 * DAY);
  });

  it("refreshes a 304 without reading or replacing the cached page body", async () => {
    const stale = entry({
      etag: '"page-v1"',
      lastModified: "Wed, 02 Sep 2026 12:00:00 GMT",
      text: "Dogs are welcome in the courtyard.",
      imageCandidates: [{ url: "https://img.example/a.jpg", source: "web:93.184.216.34", pageUrl: target }],
    });
    const { cache, store, refresh } = pageCache(stale);
    const dispatcher = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("if-none-match")).toBe('"page-v1"');
      expect(headers.get("if-modified-since")).toBe("Wed, 02 Sep 2026 12:00:00 GMT");
      return new Response(null, { status: 304 });
    });

    const result = await fetchWebsiteFacts(target, dispatcher, cache, {
      url: target,
      host: "93.184.216.34",
      fetchedAt: "2026-08-01T00:00:00.000Z",
      types: [],
    });

    expect(result.pageText?.homepage).toBe("Dogs are welcome in the courtyard.");
    expect(dispatcher).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith(new URL(target), 7 * DAY);
    expect(store).not.toHaveBeenCalled();
  });

  it("replaces extracted text and validators after a 200 refresh", async () => {
    const { cache, store, refresh } = pageCache(entry({ etag: '"page-v1"', text: "Old words" }));
    const dispatcher = vi.fn(async () => new Response(
      "<html><body><main><p>New accessible entrance information for every guest.</p></main></body></html>",
      {
        status: 200,
        headers: { "content-type": "text/html", etag: '"page-v2"' },
      },
    ));

    const result = await fetchWebsiteFacts(target, dispatcher, cache);

    expect(result.pageText?.homepage).toContain("New accessible entrance information");
    expect(store).toHaveBeenCalledWith(expect.objectContaining({
      url: target,
      etag: '"page-v2"',
      text: expect.stringContaining("New accessible entrance information"),
    }));
    expect(refresh).not.toHaveBeenCalled();
  });

  it("bounds persisted page text to 6000 characters", async () => {
    let values: unknown[] = [];
    const db = { query: vi.fn(async (_sql: string, next: unknown[]) => {
      values = next;
      return { rows: [], rowCount: 1 };
    }) };
    await storePageCache(db as never, {
      url: target,
      status: 200,
      text: "x".repeat(MAX_CACHED_PAGE_TEXT + 500),
    });
    expect(values[7]).toBe("x".repeat(MAX_CACHED_PAGE_TEXT));
  });
});
