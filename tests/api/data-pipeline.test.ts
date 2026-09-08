import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { pool } from "../../apps/server/src/db.ts";
import {
  admit,
  settleAttempt,
  type ResourceLimit,
  withModelReservation,
} from "../../apps/server/src/admission.ts";
import {
  bindWork,
  currentWork,
  withWork,
} from "../../apps/server/src/work-context.ts";
import { Checkpoints } from "../../apps/server/src/prepopulate/checkpoints.ts";
import { parseOptions } from "../../apps/server/src/prepopulate/options.ts";
import { runPrepopulation } from "../../apps/server/src/prepopulate/run.ts";
import { repairWindow } from "../../apps/server/src/prepopulate/maintenance.ts";
import { importOverture } from "../../apps/server/src/prepopulate/overture.ts";
import { WorkError } from "../../apps/server/src/work-outcome.ts";
import {
  discoverSources,
  overtureRecord,
  setAccessibilityFetch,
} from "../../apps/server/src/enrich/discovery.ts";
import {
  loadCached,
  pageCache,
  persistListingMatches,
  readRefinementSource,
  setEnrichFetch,
} from "../../apps/server/src/enrich/index.ts";
import {
  fetchEvidencePage,
  fetchWebsiteFacts,
} from "../../apps/server/src/enrich/website.ts";
import {
  fetchListingsForCandidates,
  setListingFetch,
} from "../../apps/server/src/enrich/listings.ts";
import { setSearchProvider } from "../../apps/server/src/refine/search.ts";
import type {
  AreaSnapshot,
  SnapshotVenue,
} from "../../apps/server/src/places.ts";
import { DATABASE_URL } from "./helpers.ts";

const options = () =>
  parseOptions(["--area", "berlin-mitte", "--sources", "sites"])!;
const noop = () => undefined;
afterEach(() => {
  vi.unstubAllEnvs();
  setAccessibilityFetch(null);
  setEnrichFetch(null);
  setListingFetch(null);
  setSearchProvider(null);
});
afterAll(async () => {
  await pool.end();
});

describe("shared admission and durable recovery", () => {
  it("rejects an unmigrated database before starting a run or provider work", async () => {
    vi.stubEnv("ENRICH_NETWORK", "1");
    const schema = `unmigrated_${randomUUID().replaceAll("-", "")}`;
    await pool.query(`CREATE SCHEMA ${schema}`);
    const oldDb = new pg.Pool({
      connectionString: DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const report = vi.fn();
    try {
      await expect(
        runPrepopulation(oldDb, options(), {} as AreaSnapshot, [], report),
      ).rejects.toThrow("Apply the server migrations");
      expect(report).not.toHaveBeenCalled();
    } finally {
      await oldDb.end();
      await pool.query(`DROP SCHEMA ${schema}`);
    }
  });
  it("atomically protects interactive headroom across independent database pools", async () => {
    const other = new pg.Pool({ connectionString: DATABASE_URL, max: 5 });
    const resource: ResourceLimit = {
      key: `test:${randomUUID()}`,
      hourly: 10,
      daily: 100,
      interactiveReserve: 0.2,
      backgroundReserve: 0.3,
    };
    try {
      const outcomes = await Promise.allSettled(
        Array.from({ length: 16 }, (_, i) =>
          admit([resource], { workload: "prepopulate" }, i % 2 ? pool : other),
        ),
      );
      expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(5);
      for (let i = 0; i < 3; i++)
        await admit([resource], { workload: "background" }, other);
      await expect(
        admit([resource], { workload: "background" }, pool),
      ).rejects.toMatchObject({ failure: { code: "quota" } });
      for (let i = 0; i < 2; i++)
        await admit([resource], { workload: "interactive" }, other);
      await expect(
        admit([resource], { workload: "interactive" }, pool),
      ).rejects.toMatchObject({ failure: { code: "quota" } });
      expect(
        (
          await pool.query(
            "SELECT sum(used)::int AS total FROM resource_usage WHERE resource=$1 AND window_seconds=3600",
            [resource.key],
          )
        ).rows[0].total,
      ).toBe(10);
    } finally {
      await other.end();
    }
  });
  it("counts reservations against run request caps and preserves reported costs through failures", async () => {
    const job = new Checkpoints(
      pool,
      { ...options(), maxRequests: 3, maxCostUsd: 0.5 },
      noop,
    );
    await job.start(["node/cap"]);
    await withWork({ workload: "prepopulate", runId: job.id }, async () => {
      await withModelReservation(
        2,
        async () => {
          const resource: ResourceLimit = {
            key: `wire:${randomUUID()}`,
            hourly: 100,
            daily: 100,
            interactiveReserve: 0,
            backgroundReserve: 0,
          };
          const id = await admit(
            [resource],
            { provider: "fixture", estimatedCostUsd: 0.1 },
            pool,
          );
          await settleAttempt(id, { outcome: "ok", actualCostUsd: 0.02 }, pool);
          await settleAttempt(
            id,
            {
              outcome: "failed",
              failure: {
                provider: "fixture",
                code: "invalid_response",
                deferred: false,
              },
            },
            pool,
          );
          expect(
            (
              await pool.query(
                "SELECT actual_cost_usd FROM provider_attempts WHERE id=$1",
                [id],
              )
            ).rows[0].actual_cost_usd,
          ).toBe("0.02");
          await expect(
            admit(
              [resource],
              { provider: "fixture", estimatedCostUsd: 0.1 },
              pool,
            ),
          ).rejects.toMatchObject({
            failure: { provider: "run", code: "quota" },
          });
        },
        pool,
      );
    });
    await job.finish(false, false);
  });
  it("resumes only unfinished stages and rejects competing owners or changed selections", async () => {
    const selected = options();
    const job = new Checkpoints(pool, selected, noop);
    await job.start(["node/resume"]);
    let completed = 0;
    await job.stage("node/resume", "sites", async () => {
      completed++;
    });
    await job.stage("node/resume", "search", async () => {
      throw new WorkError({ provider: "run", code: "quota", deferred: true });
    });
    await expect(
      new Checkpoints(pool, { ...selected, resume: job.id }, noop).start([
        "node/resume",
      ]),
    ).rejects.toThrow("already active");
    expect((await job.finish(false, true)).status).toBe("deferred");
    await expect(
      new Checkpoints(pool, { ...selected, resume: job.id }, noop).start([
        "node/different",
      ]),
    ).rejects.toThrow("same region");
    const resumed = new Checkpoints(
      pool,
      { ...selected, resume: job.id },
      noop,
    );
    await resumed.start(["node/resume"]);
    expect(
      await resumed.stage("node/resume", "sites", async () => {
        completed++;
      }),
    ).toBeNull();
    await resumed.stage("node/resume", "search", async () => "done");
    expect((await resumed.finish(false, false)).status).toBe("complete");
    expect(completed).toBe(1);
  });
  it("does not buy search when its evaluator cannot be reserved", async () => {
    vi.stubEnv("ENRICH_NETWORK", "1");
    vi.stubEnv("INFER", "1");
    vi.stubEnv("OPENAI_API_KEY", "fixture");
    vi.stubEnv("LLM_PROVIDER", "openai");
    vi.stubEnv("SEARCH_PROVIDER", "tavily");
    vi.stubEnv("TAVILY_API_KEY", "fixture");
    let searches = 0;
    setSearchProvider({
      search: async () => {
        searches++;
        return [];
      },
    });
    const venue: SnapshotVenue = {
      ref: `node/${randomUUID()}`,
      name: "Quota Fixture",
      location: options().area.center,
      tags: { amenity: "cafe" },
      placeClass: "cafe",
    };
    const summary = await runPrepopulation(
      pool,
      { ...options(), sources: ["search"], maxRequests: 1 },
      {
        manifest: { extract: { timestamp: new Date().toISOString() } },
      } as AreaSnapshot,
      [venue],
      noop,
    );
    expect(summary.status).toBe("deferred");
    expect(searches).toBe(0);
    expect(
      (await loadCached(pool, [venue.ref])).get(venue.ref)?.inferred ?? {},
    ).toEqual({});
  });
  it("retains the submitter's context when another workload dispatches a callback", async () => {
    const dispatch = withWork(
      { workload: "prepopulate", runId: "bulk", modelReservation: "held" },
      () => bindWork(() => currentWork(), "background"),
    );
    expect(withWork({ workload: "interactive" }, dispatch)).toMatchObject({
      workload: "prepopulate",
      runId: "bulk",
      modelReservation: "held",
    });
    const interactive = bindWork(() => currentWork(), "interactive");
    expect(withWork({ workload: "prepopulate" }, interactive).workload).toBe(
      "interactive",
    );
  });
});

describe("shared sources and page reads", () => {
  it("atomically replaces a bounded Overture extract and preserves it after invalid or empty imports", async () => {
    const directory = await mkdtemp(join(tmpdir(), "spokes-overture-"));
    const file = join(directory, "places.geojsonseq");
    const area = { ...options().area, id: `import-${randomUUID()}` };
    const feature = (id: string, location = area.center) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [location.lng, location.lat] },
      properties: {
        id,
        names: { primary: `Place ${id}` },
        websites: ["https://fixture.example/"],
      },
    });
    const load = async (text: string, release = "2026-08-19.0") => {
      await writeFile(file, text);
      return importOverture(
        pool,
        file,
        area,
        release,
        createHash("sha256").update(text).digest("hex"),
      );
    };
    const saved = async () =>
      (
        await pool.query(
          "SELECT id,release FROM overture_places WHERE region=$1 ORDER BY id",
          [area.id],
        )
      ).rows;
    try {
      const text = [feature("first"), feature("outside", { lat: 0, lng: 0 })]
        .map((value) => `\x1e${JSON.stringify(value)}\n`)
        .join("");
      expect(await load(text)).toMatchObject({ imported: 1, skipped: 1 });
      await expect(
        importOverture(pool, file, area, "2026-08-19.0", "0".repeat(64)),
      ).rejects.toThrow("SHA-256 mismatch");
      await expect(
        load(`${JSON.stringify(feature("second"))}\n{broken\n`),
      ).rejects.toThrow();
      await expect(load("")).rejects.toThrow("no usable places");
      expect(await saved()).toEqual([{ id: "first", release: "2026-08-19.0" }]);
      expect(
        await load(
          `${JSON.stringify(feature("replacement"))}\n`,
          "2026-09-01.0",
        ),
      ).toMatchObject({ imported: 1, skipped: 0 });
      expect(await saved()).toEqual([
        { id: "replacement", release: "2026-09-01.0" },
      ]);
    } finally {
      await pool.query("DELETE FROM overture_places WHERE region=$1", [
        area.id,
      ]);
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("coalesces a concurrent page miss and reuses parsed facts in the website reader", async () => {
    const url = `https://93.184.216.34/${randomUUID()}`;
    let content = 0;
    const fetcher = async (requested: string) => {
      if (requested.endsWith("robots.txt"))
        return new Response("", { status: 404 });
      content++;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return new Response(
        '<html><p>Dogs are welcome inside this independent place.</p><script type="application/ld+json">{"@type":"CafeOrCoffeeShop","servesCuisine":"Italian"}</script></html>',
        { headers: { "content-type": "text/html", etag: "fixture-v1" } },
      );
    };
    const [a, b] = await Promise.all([
      fetchEvidencePage(url, fetcher, pageCache(pool)),
      fetchEvidencePage(url, fetcher, pageCache(pool)),
    ]);
    expect(a.text).toBe(b.text);
    expect(content).toBe(1);
    const site = await fetchWebsiteFacts(url, fetcher, pageCache(pool));
    expect(site.facts?.cuisine).toEqual(["italian"]);
    expect(content).toBe(1);
  });
  it("shares Overture website discovery and attributed accessibility with live enrichment", async () => {
    vi.stubEnv("OVERTURE", "1");
    vi.stubEnv("ENRICH_NETWORK", "1");
    vi.stubEnv("INFER", "0");
    vi.stubEnv("ACCESSIBILITY_CLOUD_TOKEN", "fixture-token-never-persist");
    const sourceId = randomUUID();
    vi.stubEnv("ACCESSIBILITY_CLOUD_SOURCE_IDS", sourceId);
    const id = randomUUID(),
      location = { lat: 52.521, lng: 13.402 },
      name = `Fixture ${id}`,
      osmRef = `node/${id}`;
    const record = overtureRecord(
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [location.lng, location.lat] },
        properties: {
          id,
          names: { primary: name },
          websites: ["https://fixture.example/"],
          operating_status: "open",
        },
      },
      "2026-08-19.0",
    )!;
    await pool.query(
      "INSERT INTO overture_places(region,id,release,name,lat,lng,facts) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [
        id,
        id,
        record.release,
        name,
        location.lat,
        location.lng,
        JSON.stringify(record),
      ],
    );
    let calls = 0;
    setAccessibilityFetch(async (url) => {
      calls++;
      expect(new URL(url).searchParams.has("latitude")).toBe(false);
      return Response.json({
        type: "FeatureCollection",
        related: {
          sources: {
            [sourceId]: {
              name: "City survey",
              licenseId: "cc",
              originWebsiteURL: "https://city.example/",
            },
          },
          licenses: {
            cc: {
              name: "CC BY 4.0",
              consideredAs: "CCBY",
              websiteURL: "https://creativecommons.org/licenses/by/4.0/",
            },
          },
        },
        features: [
          {
            type: "Feature",
            geometry: {
              type: "Point",
              coordinates: [location.lng, location.lat],
            },
            properties: {
              _id: id,
              name,
              sourceId,
              originalId: "survey-1",
              accessibility: { accessibleWith: { wheelchair: false } },
            },
          },
        ],
      });
    });
    await discoverSources(pool, [{ osmRef, name, location }]);
    const firstCalls = calls;
    await discoverSources(pool, [{ osmRef, name, location }]);
    expect(calls).toBe(firstCalls);
    setEnrichFetch(async (url) =>
      url.endsWith("robots.txt")
        ? new Response("", { status: 404 })
        : new Response(
            "<html><p>A welcoming local place with seating.</p></html>",
            { headers: { "content-type": "text/html" } },
          ),
    );
    const pass = await readRefinementSource(pool, {
      osmRef,
      placeName: name,
      location,
    });
    expect(pass.enrichment?.website).toBeTruthy();
    expect(pass.enrichment?.discoveries?.overture?.website).toBe(
      "https://fixture.example/",
    );
    expect(pass.enrichment?.inferred?.["wheelchair-accessible"]).toMatchObject({
      lean: "no",
      source: `accessibility.cloud:${sourceId}`,
      explicit: false,
    });
    const saved = JSON.stringify(
      (
        await pool.query(
          "SELECT discoveries FROM enrichments WHERE osm_ref=$1",
          [osmRef],
        )
      ).rows,
    );
    expect(saved).toContain("CC BY 4.0");
    expect(saved).not.toContain("fixture-token");
  });
  it("retains earlier listing pages after a later task error and resumes from the recorded offset", async () => {
    vi.stubEnv("DATAFORSEO_LOGIN", "fixture");
    vi.stubEnv("DATAFORSEO_PASSWORD", "fixture");
    const ref = `node/${randomUUID()}`,
      location = { lat: 52.52, lng: 13.4 };
    const candidates = [
      {
        candidateId: ref,
        osmRef: ref,
        name: "Paged fixture",
        location,
        placeClass: "cafe",
      },
    ];
    const scope = { center: location, radiusM: 1000 };
    const offsets: number[] = [];
    let fail = true;
    setListingFetch(async (_url, init) => {
      const offset = JSON.parse(String(init?.body))[0].offset;
      offsets.push(offset);
      if (offset === 1 && fail)
        return Response.json({
          status_code: 20000,
          tasks: [{ status_code: 50000, cost: 0.01, result: null }],
        });
      return Response.json({
        status_code: 20000,
        tasks: [
          {
            status_code: 20000,
            cost: 0.01,
            result: [
              {
                total_count: 2,
                items: [
                  {
                    title: offset === 0 ? "Paged fixture" : "Unrelated",
                    latitude: location.lat,
                    longitude: location.lng,
                    check_url: "https://www.google.com/maps?cid=123",
                    url: "https://paged.example/",
                  },
                ],
              },
            ],
          },
        ],
      });
    });
    const persistence = {
      db: pool,
      onPage: (matches: Parameters<typeof persistListingMatches>[1]) =>
        persistListingMatches(pool, matches),
    };
    await expect(
      fetchListingsForCandidates(candidates, scope, undefined, persistence),
    ).rejects.toThrow("dataforseo");
    expect((await loadCached(pool, [ref])).get(ref)?.listing?.website).toBe(
      "https://paged.example/",
    );
    await pool.query(
      "UPDATE listing_batches SET expires_at=now()-interval '1 second' WHERE status='deferred'",
    );
    fail = false;
    await fetchListingsForCandidates(candidates, scope, undefined, persistence);
    expect(offsets).toEqual([0, 1, 1]);
    const otherRoom = await fetchListingsForCandidates(
      [{ ...candidates[0], candidateId: "another-room-candidate" }],
      scope,
      undefined,
      persistence,
    );
    expect(otherRoom.matches[0].candidate.candidateId).toBe(
      "another-room-candidate",
    );
    expect(offsets).toEqual([0, 1, 1]);
  });
  it("audits historical omissions without deleting claims or successful abstentions", async () => {
    const ref = `node/${randomUUID()}`,
      time = new Date().toISOString();
    await pool.query(
      `INSERT INTO enrichments(osm_ref,inferred,expires_at,website_status,website_error,website_fetched_at)
      VALUES($1,$2,now(),'error','Error: outbound budget reached',$3)`,
      [
        ref,
        JSON.stringify({
          uncertain: {
            omitted: true,
            observedAt: time,
            searchDay: time.slice(0, 10),
            searchAttempts: 1,
          },
          answered: {
            omitted: true,
            observedAt: time,
            searchDay: time.slice(0, 10),
          },
          claim: {
            lean: "yes",
            evidence: "A valid retained claim",
            observedAt: time,
          },
        }),
        time,
      ],
    );
    await pool.query(
      "INSERT INTO matrix_cache(osm_ref,criterion_id,evidence_hash,answered,evaluated_at) VALUES($1,'answered','fixture',true,$2)",
      [ref, time],
    );
    const from = new Date(Date.parse(time) - 1000).toISOString(),
      to = new Date(Date.parse(time) + 1000).toISOString();
    expect(await repairWindow(pool, [ref], from, to)).toMatchObject({
      applied: false,
      uncertainSearchMarkers: 1,
      localWebsiteRefusals: 1,
    });
    await repairWindow(pool, [ref], from, to, true);
    const saved = (
      await pool.query(
        "SELECT inferred,website_status FROM enrichments WHERE osm_ref=$1",
        [ref],
      )
    ).rows[0];
    expect(saved.inferred.uncertain.searchDay).toBeUndefined();
    expect(saved.inferred.answered.searchDay).toBeTruthy();
    expect(saved.inferred.claim.evidence).toBe("A valid retained claim");
    expect(saved.website_status).toBe("never");
  });
});
