import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { pool } from "../../apps/server/src/db.ts";
import { parseOptions } from "../../apps/server/src/prepopulate/options.ts";
import { runPrepopulation } from "../../apps/server/src/prepopulate/run.ts";
import type { AreaSnapshot, SnapshotVenue } from "../../apps/server/src/places.ts";
import { loadCached, setEnrichFetch, warmCachedImages } from "../../apps/server/src/enrich/index.ts";
import { setListingFetch } from "../../apps/server/src/enrich/listings.ts";
import { setSearchProvider } from "../../apps/server/src/refine/search.ts";
import { setTransport } from "../../apps/server/src/nl/openai.ts";

const options = () => parseOptions(["--area", "berlin-mitte", "--sources", "listings,sites", "--concurrency", "2"])!;
const snapshot = { manifest: { extract: { timestamp: new Date().toISOString() } } } as AreaSnapshot;
const venue = (): SnapshotVenue => ({
  ref: `node/prepopulate-${randomUUID()}`, name: "Preparation Test Cafe",
  tags: { amenity: "cafe" }, placeClass: "cafe", location: options().area.center,
});
const report = () => undefined;

beforeEach(() => {
  vi.stubEnv("ENRICH_NETWORK", "1");
  vi.stubEnv("INFER", "0");
  vi.stubEnv("LISTINGS", "1");
  vi.stubEnv("DATAFORSEO_LOGIN", "test");
  vi.stubEnv("DATAFORSEO_PASSWORD", "test");
  vi.stubEnv("SEARCH_PROVIDER", "tavily");
  vi.stubEnv("TAVILY_API_KEY", "test");
});
afterEach(() => {
  setEnrichFetch(null);
  setListingFetch(null);
  setSearchProvider(null);
  setTransport(null);
  vi.unstubAllEnvs();
});
afterAll(async () => { await pool.end(); });

describe("region cache prepopulation", () => {
  it("discovers sites from listings, persists reusable data, and makes no requests on a rerun", async () => {
    const place = venue();
    const website = `https://${randomUUID()}.example/`;
    let listingCalls = 0;
    let siteCalls = 0;
    setListingFetch(async () => {
      listingCalls++;
      return Response.json({ status_code: 20000, tasks: [{ status_code: 20000, result: [{ items: [{
        title: place.name, latitude: place.location.lat, longitude: place.location.lng,
        url: website, check_url: "https://www.google.com/maps?cid=123",
      }] }] }] });
    });
    setEnrichFetch(async (url) => {
      siteCalls++;
      return url.endsWith("robots.txt") ? new Response("", { status: 404 })
        : new Response('<html><head><meta name="description" content="A small independent place with seating and refreshments."></head></html>',
          { headers: { "content-type": "text/html" } });
    });
    const first = await runPrepopulation(pool, options(), snapshot, [place], report);
    expect(first).toMatchObject({ completed: 1, failed: 0, listingMatches: 1 });
    const saved = (await loadCached(pool, [place.ref])).get(place.ref)!;
    expect(saved.listing?.website).toBe(website);
    expect(saved.website).toBeTruthy();
    expect(saved.providerStatus?.website.status).toBe("ok");
    const counts = [listingCalls, siteCalls];
    expect(counts.every((count) => count > 0)).toBe(true);
    const second = await runPrepopulation(pool, options(), snapshot, [place], report);
    expect(second.failed).toBe(0);
    expect([listingCalls, siteCalls]).toEqual(counts);
    expect((await pool.query("SELECT id FROM candidates WHERE osm_ref = $1", [place.ref])).rows).toEqual([]);
    // A failed listing refresh keeps last-known-good data and backs off durably.
    await pool.query("UPDATE prepopulate_listing_fetches SET expires_at = now() - interval '1 second'");
    setListingFetch(async () => { listingCalls++; throw new Error("provider unavailable"); });
    const failed = await runPrepopulation(pool, options(), snapshot, [place], report);
    expect(failed.sourceErrors.listings).toBe(1);
    const failedCount = listingCalls;
    await runPrepopulation(pool, options(), snapshot, [place], report);
    expect(listingCalls).toBe(failedCount);
    expect((await loadCached(pool, [place.ref])).get(place.ref)?.listing?.website).toBe(website);
  });

  it("keeps searches retryable after transport failures, and shares validated cached facts", async () => {
    vi.stubEnv("INFER", "1");
    vi.stubEnv("LLM_PROVIDER", "openai");
    vi.stubEnv("OPENAI_API_KEY", "test");
    vi.stubEnv("OPENROUTER_API_KEY", "");
    const place = venue();
    const selected = { ...options(), sources: ["search"] as const };
    let searches = 0;
    let failSearch = true;
    setSearchProvider({ search: async () => {
      searches++;
      if (failSearch) throw new Error("search unavailable");
      return [{ url: "https://evidence.example/visit", title: "Visit", snippet: "Four-legged companions can sit beside their people here." }];
    } });
    setTransport(async (body) => {
      const input = JSON.parse((body.input as Array<{ content: string }>)[0].content);
      return { output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({
        claims: input.places.flatMap((p: { candidateId: string; texts: Array<{ text: string }> }) =>
          input.criteria.map((criterion: { id: string }) => {
            const claim = criterion.id === "dog-friendly" && p.texts.some((text) => text.text.includes("Four-legged"));
            return { candidateId: p.candidateId, criterionId: criterion.id,
              lean: claim ? "yes" : "abstain", confidence: claim ? 0.8 : 0,
              evidence: claim ? "Four-legged companions can sit beside their people here" : "",
              sourceIndex: claim ? 0 : null, explicit: false };
          })),
      }) }] }] };
    });
    const run = () => runPrepopulation(pool, { ...selected, sources: [...selected.sources] }, snapshot, [place], report);
    expect((await run()).sourceErrors.search).toBe(1);
    expect((await pool.query("SELECT * FROM search_cache WHERE osm_ref = $1", [place.ref])).rows).toHaveLength(0);
    failSearch = false;
    expect((await run()).failed).toBe(0);
    expect(searches).toBe(2);
    const cached = (await loadCached(pool, [place.ref])).get(place.ref)!;
    expect(cached.inferred?.["dog-friendly"]).toMatchObject({ lean: "yes", sourceUrl: "https://evidence.example/visit" });
    await run();
    expect(searches).toBe(2);
  });

  it("honors image expiry instead of the interactive ten-minute refresh window", async () => {
    const place = venue();
    await pool.query(`INSERT INTO enrichments (osm_ref, fetched_at, expires_at, image_fetched_at, image_expires_at)
      VALUES ($1, now(), now() + interval '7 days', now() - interval '1 day', now() + interval '20 days')`, [place.ref]);
    const fetch = vi.fn(async () => { throw new Error("fresh images must not fetch"); });
    setEnrichFetch(fetch);
    await warmCachedImages(pool, { osmRef: place.ref, website: "https://fresh-images.example/" }, { enrichment: null });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("stops admitting places when interrupted and retains in-flight work", async () => {
    const controller = new AbortController();
    const places = [venue(), venue(), venue()];
    places.forEach((place) => { place.tags.website = `https://${randomUUID()}.example/`; });
    setEnrichFetch(async (url) => {
      controller.abort();
      return url.endsWith("robots.txt") ? new Response("", { status: 404 })
        : new Response('<html><head><meta name="description" content="A quiet neighborhood meeting place."></head></html>',
          { headers: { "content-type": "text/html" } });
    });
    const result = await runPrepopulation(pool, { ...options(), sources: ["sites"], concurrency: 1 }, snapshot, places, report, controller.signal);
    expect(result).toMatchObject({ interrupted: true, selected: 3, completed: 1, failed: 0 });
    expect((await loadCached(pool, [places[0].ref])).get(places[0].ref)?.website).toBeTruthy();
    expect((await loadCached(pool, [places[1].ref])).size).toBe(0);
  });
});
