import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import type { Criterion, PipelineMessage } from "@webmcp-hackathon/contracts";
import { config } from "../../apps/server/src/config.ts";
import { setTransport } from "../../apps/server/src/nl/openai.ts";
import {
  resetOutboundStateForTests,
  setOutboundTransportForTests,
  type OutboundRoute,
} from "../../apps/server/src/net/outbound.ts";
import { MatrixBatcher } from "../../apps/server/src/pipeline/batcher.ts";
import { PipelineFrames } from "../../apps/server/src/pipeline/frames.ts";
import { PipelinePool, createPipelinePools } from "../../apps/server/src/pipeline/pools.ts";
import {
  PipelineQueue,
  ReadyBuffer,
  pipelineDedupeKey,
  type PipelineItem,
  type PipelinePriority,
  type ReadyCell,
} from "../../apps/server/src/pipeline/queue.ts";
import {
  PipelineScheduler,
  pipelineScheduler,
  type DispatchResult,
} from "../../apps/server/src/pipeline/scheduler.ts";
import { refreshAssetsThroughPipeline } from "../../apps/server/src/pipeline/stages/assets.ts";
import { judge } from "../../apps/server/src/pipeline/stages/judge.ts";
import {
  searchRefinementPlaces,
  type RefinementSearchRequest,
} from "../../apps/server/src/refine/worker.ts";
import {
  PipelineVolumeModel,
  Rfc6298Estimator,
} from "../../apps/server/src/pipeline/volume.ts";

const sharp = createRequire(new URL("../../apps/server/package.json", import.meta.url))("sharp");

const criterion = (id = "wifi"): Criterion => ({ id, kind: "key", key: id, label: id });

function item(
  candidateId: string,
  overrides: Partial<Omit<PipelineItem, "dedupeKey">> = {},
): PipelineItem {
  const base = {
    roomId: "room-a",
    candidateId,
    osmRef: `node/${candidateId}`,
    kind: "fetch.site" as const,
    criteria: [criterion()],
    priority: 1 as PipelinePriority,
    intent: "background" as const,
    host: `${candidateId}.example`,
    purpose: "venue-site" as const,
    needsEpoch: 1,
    enqueuedAt: 0,
    ...overrides,
  };
  return { ...base, dedupeKey: pipelineDedupeKey(base) };
}

function controlled<T = number>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  setTransport(null);
  setOutboundTransportForTests(null);
  resetOutboundStateForTests();
  pipelineScheduler.reset();
});

describe("phase A pipeline", () => {
  it("refills fetch.search continuously instead of waiting behind the slow request", async () => {
    vi.useFakeTimers();
    vi.stubEnv("PIPELINE", "1");
    const finished: string[] = [];
    const requests = Array.from({ length: 8 }, (_, index): RefinementSearchRequest => ({
      candidateId: `search-${index}`,
      osmRef: `node/search-${index}`,
      name: `Place ${index}`,
      category: "cafe",
      siteTextUsable: false,
      criteria: [criterion()],
      searchCriteria: [criterion()],
    }));
    const job = searchRefinementPlaces(
      requests,
      { city: "Berlin", label: "Berlin", countryCode: "DE" },
      async (query) => {
        const index = Number(/Place (\d+)/.exec(query)?.[1] ?? 0);
        await new Promise((resolve) => setTimeout(resolve, index === 0 ? 5_000 : 100));
        finished.push(String(index));
        return [];
      },
      { pipeline: { roomId: "search-room", needsEpoch: 1 } },
    );

    await vi.advanceTimersByTimeAsync(4_999);
    expect(finished).toHaveLength(7);
    await vi.advanceTimersByTimeAsync(1);
    await expect(job).resolves.toHaveLength(8);
    expect(pipelineScheduler.pools.search.maxInFlight).toBe(4);
  });

  it("never contributes a private need to a pipeline search query", async () => {
    vi.stubEnv("PIPELINE", "1");
    const privateNeed: Criterion = {
      id: "q:private",
      kind: "question",
      label: "private-zebra-741",
      text: "private-zebra-741 needs a quiet courtyard",
    };
    const queries: string[] = [];
    await searchRefinementPlaces([{
      candidateId: "private-search",
      osmRef: "node/private-search",
      name: "Public place name",
      category: "cafe",
      siteTextUsable: false,
      criteria: [criterion("wifi"), privateNeed],
      searchCriteria: [criterion("wifi")],
    }], { city: "Berlin", label: "Berlin", countryCode: "DE" }, async (query) => {
      queries.push(query);
      return [];
    }, { pipeline: { roomId: "private-room", needsEpoch: 1 } });
    expect(queries).toEqual(["Public place name Berlin wifi"]);
    expect(queries.join(" ")).not.toContain("private-zebra-741");
  });

  it("shares the llm-matrix budget between judge and adjudicate cells", async () => {
    const scheduler = new PipelineScheduler({
      pools: createPipelinePools({ direct: 1, proxy: 1, search: 1, "llm-matrix": 2, vision: 1, "image-decode": 1 }),
      hostGateOpen: () => true,
    });
    const releases = [controlled(), controlled(), controlled()];
    const started: string[] = [];
    const jobs = ["process.judge", "process.adjudicate", "process.adjudicate"].map((kind, index) => {
      const pipelineItem = item(`matrix-${index}`, {
        kind: kind as "process.judge" | "process.adjudicate",
        host: undefined,
        purpose: undefined,
      });
      return scheduler.enqueue(pipelineItem, async () => {
        started.push(kind);
        await releases[index].promise;
        return { value: index, actualRoute: "direct" };
      });
    });
    await vi.waitFor(() => expect(started).toHaveLength(2));
    expect(started).toEqual(["process.judge", "process.adjudicate"]);
    expect(scheduler.pools["llm-matrix"].inFlight).toBe(2);
    releases[0].resolve(0);
    await vi.waitFor(() => expect(started).toHaveLength(3));
    releases[1].resolve(1);
    releases[2].resolve(2);
    await Promise.all(jobs);
    expect(scheduler.pools["llm-matrix"].maxInFlight).toBe(2);
  });

  it("keeps direct site occupancy full while a slow proxied asset downloads", async () => {
    const scheduler = new PipelineScheduler({
      pools: createPipelinePools({ direct: 4, proxy: 1, search: 1, "llm-matrix": 1, vision: 1, "image-decode": 1 }),
      routeFor: (_host, purpose) => purpose === "image-cdn" ? "proxy" : "direct",
      hostGateOpen: () => true,
    });
    const assetRelease = controlled();
    const siteReleases = Array.from({ length: 4 }, () => controlled());
    const asset = item("asset", {
      kind: "fetch.asset",
      purpose: "image-cdn",
      intent: "background",
      priority: 4,
    });
    const assetJob = scheduler.enqueue(asset, async (route) => {
      await assetRelease.promise;
      return { value: 1, actualRoute: route ?? "proxy" };
    });
    const siteJobs = siteReleases.map((release, index) => scheduler.enqueue(item(`site-${index}`), async (route) => {
      await release.promise;
      return { value: 1, actualRoute: route ?? "direct" };
    }));
    await vi.waitFor(() => expect(scheduler.pools.proxy.inFlight).toBe(1));
    await vi.waitFor(() => expect(scheduler.pools.direct.inFlight).toBe(4));
    expect(scheduler.pools.direct.maxInFlight).toBe(4);
    assetRelease.resolve(1);
    for (const release of siteReleases) release.resolve(1);
    await Promise.all([assetJob, ...siteJobs]);
  });

  it("enqueues decode and vision only for interactive asset materialisation", async () => {
    const scheduler = new PipelineScheduler({
      pools: createPipelinePools({ direct: 2, proxy: 1, search: 1, "llm-matrix": 1, vision: 1, "image-decode": 2 }),
      routeFor: () => "direct",
      hostGateOpen: () => true,
    });
    const kinds: string[] = [];
    scheduler.onEnqueue((entry) => kinds.push(entry.kind));
    const png = await sharp({
      create: { width: 640, height: 480, channels: 3, background: "navy" },
    }).png().toBuffer();
    const client = {
      query: async () => ({ rows: [], rowCount: 1 }),
      release: () => undefined,
    };
    const db = { query: client.query, connect: async () => client };
    const base = {
      db: db as never,
      roomId: "asset-room",
      candidateId: "asset-place",
      osmRef: "node/asset-place",
      placeName: "Asset place",
      candidates: [{
        url: "https://93.184.216.34/place.png",
        source: "web:place.example",
        pageUrl: "https://place.example/",
        imagePolicy: {
          class: "structured" as const,
          minimumWidth: 480,
          minimumHeight: 320,
          confidenceThreshold: 0.6,
        },
      }],
      fetchForRoute: () => async (url: string | URL) => String(url).endsWith("/robots.txt")
        ? new Response("", { status: 404 })
        : new Response(png, { headers: { "cache-control": "max-age=86400" } }),
      scheduler,
    };
    await refreshAssetsThroughPipeline({ ...base, intent: "background" });
    expect(kinds).toEqual([]);
    const previousKey = config.openaiApiKey;
    config.openaiApiKey = "scripted";
    setTransport(async () => ({
      output: [{
        type: "message",
        content: [{
          type: "output_text",
          text: JSON.stringify({ images: [{ kind: "venue_exterior", confidence: 0.9 }] }),
        }],
      }],
    }));
    try {
      await refreshAssetsThroughPipeline({ ...base, intent: "interactive" });
    } finally {
      config.openaiApiKey = previousKey;
    }
    expect(kinds).toEqual(["fetch.asset", "process.decode", "process.vision"]);
  });

  it("continuously refills an eight-slot pool when short tasks settle", async () => {
    vi.useFakeTimers();
    const pool = new PipelinePool("proxy", 8);
    const completedAt: number[] = [];
    const jobs = Array.from({ length: 15 }, (_, index) => pool.submit(async () => {
      await new Promise((resolve) => setTimeout(resolve, index === 0 ? 5_000 : 100));
      completedAt.push(Date.now());
    }));

    await vi.advanceTimersByTimeAsync(4_999);
    expect(completedAt).toHaveLength(14);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all(jobs);
    expect(completedAt).toHaveLength(15);
    expect(pool.maxInFlight).toBe(8);
  });

  it("checks the host gate before taking a pool slot", async () => {
    const releases: Array<ReturnType<typeof controlled>> = [];
    const started: string[] = [];
    let crowdedAdmissions = 0;
    let crowdedReleased = false;
    const scheduler = new PipelineScheduler({
      pools: createPipelinePools({ direct: 8, proxy: 1, search: 1, "llm-matrix": 1, vision: 1, "image-decode": 1 }),
      routeFor: () => "direct",
      hostGateOpen: (host) => host !== "crowded.example" || crowdedReleased || crowdedAdmissions++ < 2,
    });
    const jobs = [
      ...Array.from({ length: 10 }, (_, index) => item(`crowded-${index}`, {
        host: "crowded.example",
        intent: "interactive",
        priority: 0,
      })),
      ...Array.from({ length: 6 }, (_, index) => item(`free-${index}`, {
        host: `free-${index}.example`,
        intent: "interactive",
        priority: 0,
      })),
    ].map((pipelineItem) => {
      const release = controlled();
      releases.push(release);
      return scheduler.enqueue(pipelineItem, async (route) => {
        started.push(pipelineItem.candidateId);
        await release.promise;
        return { value: 1, actualRoute: route ?? "direct" };
      });
    });

    await vi.waitFor(() => expect(started).toHaveLength(8));
    expect(started.filter((id) => id.startsWith("free-"))).toHaveLength(6);
    expect(scheduler.pools.direct.inFlight).toBe(8);
    crowdedReleased = true;
    for (const release of releases) release.resolve(1);
    scheduler.notifyHostGateReleased("crowded.example");
    await Promise.all(jobs);
  });

  it("bounds a closed-host selection scan at 32 probes", () => {
    const queue = new PipelineQueue();
    for (let index = 0; index < 2_000; index += 1) {
      const pipelineItem = item(String(index), { predictedPool: "direct", host: "closed.example" });
      queue.enqueue(pipelineItem, async () => 1);
    }
    expect(queue.take("direct", () => false)).toBeUndefined();
    expect(queue.lastProbeCount).toBe(32);
  });

  it("wakes an idle pool immediately when a host gate is released", async () => {
    let open = false;
    let started = 0;
    const scheduler = new PipelineScheduler({
      pools: createPipelinePools({ direct: 1, proxy: 1, search: 1, "llm-matrix": 1, vision: 1, "image-decode": 1 }),
      routeFor: () => "direct",
      hostGateOpen: () => open,
    });
    const job = scheduler.enqueue(item("waiting", { intent: "interactive", priority: 0 }), async () => {
      started += 1;
      return { value: 1, actualRoute: "direct" };
    });
    await Promise.resolve();
    expect(started).toBe(0);
    open = true;
    scheduler.notifyHostGateReleased("waiting.example");
    await expect(job).resolves.toBe(1);
    expect(started).toBe(1);
  });

  it("prefers direct for interactive fetches and retries one block through proxy", async () => {
    const routes: Array<{ route?: OutboundRoute; attempt: number }> = [];
    const scheduler = new PipelineScheduler({
      pools: createPipelinePools({ direct: 1, proxy: 1, search: 1, "llm-matrix": 1, vision: 1, "image-decode": 1 }),
      routeFor: () => "proxy",
      hostGateOpen: () => true,
    });
    const result = await scheduler.enqueue(item("interactive", {
      intent: "interactive",
      priority: 0,
    }), async (route, attempt): Promise<DispatchResult<string>> => {
      routes.push({ route, attempt });
      return attempt === 0
        ? { value: "blocked", actualRoute: "direct", status: 429 }
        : { value: "ok", actualRoute: "proxy" };
    });
    expect(result).toBe("ok");
    expect(routes).toEqual([
      { route: "direct", attempt: 0 },
      { route: "proxy", attempt: 1 },
    ]);
  });

  it("uses the dispatch route after routeFor diverges and accounts the reported route", async () => {
    const routeFor = vi.fn()
      .mockReturnValueOnce("proxy")
      .mockReturnValueOnce("direct");
    const seen: Array<OutboundRoute | undefined> = [];
    const scheduler = new PipelineScheduler({
      pools: createPipelinePools({ direct: 1, proxy: 1, search: 1, "llm-matrix": 1, vision: 1, "image-decode": 1 }),
      routeFor,
      hostGateOpen: () => true,
    });
    await scheduler.enqueue(item("divergent"), async (route) => {
      seen.push(route);
      return { value: 1, actualRoute: "direct" };
    });
    expect(routeFor).toHaveBeenCalledTimes(2);
    expect(seen).toEqual(["direct"]);
    expect(scheduler.accounting().completions).toEqual({ direct: 1, proxy: 0 });
  });

  it("refreshes judgement from warm page evidence without an outbound fetch", async () => {
    vi.stubEnv("ENRICH_NETWORK", "1");
    vi.stubEnv("INFER", "1");
    vi.stubEnv("OPENAI_API_KEY", "scripted");
    let fetches = 0;
    let modelCalls = 0;
    setOutboundTransportForTests(async () => {
      fetches += 1;
      return new Response("unexpected");
    });
    setTransport(async () => {
      modelCalls += 1;
      return {
        output: [{
          type: "message",
          content: [{
            type: "output_text",
            text: JSON.stringify({
              claims: [{
                candidateId: "warm",
                criterionId: "wifi",
                lean: "abstain",
                confidence: 0,
                evidence: "",
                sourceIndex: null,
                explicit: false,
              }],
            }),
          }],
        }],
      };
    });
    const queries: string[] = [];
    const cacheDb = {
      query: async (sql: string) => {
        queries.push(sql);
        return { rows: [], rowCount: 0 };
      },
    };
    await judge({
      places: [{
        candidateId: "warm",
        osmRef: "node/warm",
        name: "Warm page",
        category: "cafe",
        texts: [{ source: "web", text: "Cached page evidence remains available for judging." }],
      }],
      criteria: [criterion()],
    }, undefined, cacheDb as never, "interactive");
    expect(fetches).toBe(0);
    expect(modelCalls).toBe(1);
    expect(queries.some((sql) => sql.includes("SELECT m.osm_ref"))).toBe(false);
  });

  it("keeps fetches, drops stale queued judge cells, and leaves in-flight work alone", async () => {
    let fetchGateOpen = false;
    const scheduler = new PipelineScheduler({
      pools: createPipelinePools({ direct: 1, proxy: 1, search: 1, "llm-matrix": 1, vision: 1, "image-decode": 1 }),
      routeFor: () => "direct",
      hostGateOpen: (host) => host !== "fetch-kept.example" || fetchGateOpen,
    });
    const running = controlled<number>();
    const first = item("judge-running", {
      kind: "process.judge",
      host: undefined,
      purpose: undefined,
      predictedPool: undefined,
    });
    const stale = item("judge-stale", {
      kind: "process.judge",
      host: undefined,
      purpose: undefined,
    });
    const fetch = item("fetch-kept", { needsEpoch: 1, host: "fetch-kept.example" });
    const firstJob = scheduler.enqueue(first, async () => ({
      value: await running.promise,
      actualRoute: "direct",
    }));
    const staleJob = scheduler.enqueue(stale, async () => ({ value: 2, actualRoute: "direct" }));
    void staleJob.catch(() => undefined);
    const fetchJob = scheduler.enqueue(fetch, async () => ({ value: 3, actualRoute: "direct" }));
    await vi.waitFor(() => expect(scheduler.pools["llm-matrix"].inFlight).toBe(1));
    const dropped = scheduler.needsChanged("room-a", 2, new Set(["new"]));
    expect(dropped.map((entry) => entry.candidateId)).toEqual(["judge-stale"]);
    expect(scheduler.queue.roomItems("room-a").find((entry) => entry.candidateId === "fetch-kept")?.needsEpoch).toBe(2);
    running.resolve(1);
    fetchGateOpen = true;
    scheduler.notifyHostGateReleased("fetch-kept.example");
    await expect(firstJob).resolves.toBe(1);
    await expect(staleJob).rejects.toThrow("stale need set");
    await expect(fetchJob).resolves.toBe(3);

    scheduler.ready.push({ roomId: "room-a", candidateId: "a", criterionId: "old", priority: 1, bytes: 1, value: 1 });
    scheduler.ready.push({ roomId: "room-a", candidateId: "a", criterionId: "new", priority: 1, bytes: 1, value: 2 });
    expect(scheduler.ready.rematch("room-a", new Set(["new"])).map((cell) => cell.value)).toEqual([2]);
  });

  it("pauses only the full room's fetches and resumes them on drain", async () => {
    const ready = new ReadyBuffer(100, 10);
    const buffered: ReadyCell<number> = {
      roomId: "full",
      candidateId: "buffered",
      criterionId: "wifi",
      priority: 0,
      bytes: 10,
      value: 1,
    };
    ready.push(buffered);
    const scheduler = new PipelineScheduler({
      ready,
      pools: createPipelinePools({ direct: 1, proxy: 1, search: 1, "llm-matrix": 1, vision: 1, "image-decode": 1 }),
      routeFor: () => "direct",
      hostGateOpen: () => true,
    });
    const otherRelease = controlled<number>();
    const started: string[] = [];
    const fullJob = scheduler.enqueue(item("full-item", { roomId: "full", intent: "interactive" }), async () => {
      started.push("full");
      return { value: 1, actualRoute: "direct" };
    });
    const otherJob = scheduler.enqueue(item("other-item", { roomId: "other", intent: "interactive" }), async () => {
      started.push("other");
      await otherRelease.promise;
      return { value: 1, actualRoute: "direct" };
    });
    await vi.waitFor(() => expect(started).toEqual(["other"]));
    let batches = 0;
    const batcher = new MatrixBatcher<number>((cells) => {
      batches += 1;
      ready.take((cell) => cells.includes(cell));
    });
    batcher.add(buffered);
    expect(batches).toBe(1);
    otherRelease.resolve(1);
    await Promise.all([fullJob, otherJob]);
    expect(started).toEqual(["other", "full"]);
  });

  it("serves a four-item room within one DRR round beside a 2,000-item room", () => {
    const queue = new PipelineQueue();
    for (let index = 0; index < 2_000; index += 1) {
      const queued = item(`large-${index}`, { roomId: "large", predictedPool: "direct" });
      queue.enqueue(queued, async () => 1, 4);
    }
    for (let index = 0; index < 4; index += 1) {
      const queued = item(`small-${index}`, { roomId: "small", predictedPool: "direct" });
      queue.enqueue(queued, async () => 1, 4);
    }
    const admitted = Array.from({ length: 8 }, () => queue.take("direct", () => true)!.item);
    expect(admitted.filter((entry) => entry.roomId === "small")).toHaveLength(4);
  });

  it("counts only priority zero and one and follows RFC 6298 EWMA/DEV", () => {
    const volume = new PipelineVolumeModel({ fetch: 1, process: 1 });
    for (const priority of [0, 1, 2, 3, 4] as PipelinePriority[]) {
      volume.enqueue(item(`p${priority}`, { priority }));
    }
    expect(volume.snapshot("room-a").outstanding.fetch).toBe(2);
    expect(volume.snapshot("room-a").total).toBe(2);

    const estimate = new Rfc6298Estimator();
    estimate.sample(100);
    estimate.sample(120);
    estimate.sample(80);
    expect(estimate.ewma).toBeCloseTo(99.6875);
    expect(estimate.dev).toBeCloseTo(37.5);
    expect(estimate.estimate()).toBeCloseTo(249.6875);
  });

  it("coalesces to four frames per second, emits quiet starts immediately, and always clears", () => {
    vi.useFakeTimers();
    const volume = new PipelineVolumeModel();
    const frames = new PipelineFrames(volume);
    const seen: PipelineMessage[] = [];
    frames.onPipeline((_roomId, message) => seen.push(message));
    const pipelineItem = item("frame");
    volume.enqueue(pipelineItem);
    frames.update(pipelineItem, "queued");
    expect(seen).toHaveLength(1);
    volume.start(pipelineItem, 0);
    frames.update(pipelineItem, "fetching");
    volume.settle(pipelineItem, 100);
    frames.update(pipelineItem, null);
    expect(seen).toHaveLength(1);
    vi.advanceTimersByTime(249);
    expect(seen).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(seen).toHaveLength(2);
    expect(seen.at(-1)).toMatchObject({
      outstanding: { fetch: 0, process: 0 },
      inFlight: { fetch: 0, process: 0 },
    });
  });

  it("never puts private or agent-private labels in a frame", () => {
    const volume = new PipelineVolumeModel();
    const frames = new PipelineFrames(volume);
    const shared = item("shared");
    const privateItem = item("private");
    const agentItem = item("agent");
    frames.update(shared, "queued", { kind: "need", label: "public wifi", visibility: "shared" });
    expect(frames.currentLookups("room-a").reason).toEqual({ kind: "need", label: "public wifi" });
    frames.update(privateItem, "queued", {
      kind: "need",
      label: "private-zebra-741",
      visibility: "application-private",
    });
    frames.update(agentItem, "queued", {
      kind: "need",
      label: "agent-secret-992",
      visibility: "agent-private",
    });
    const wire = JSON.stringify([
      frames.currentPipeline("room-a"),
      frames.currentLookups("room-a"),
    ]);
    expect(wire).not.toContain("private-zebra-741");
    expect(wire).not.toContain("agent-secret-992");
    expect(frames.currentLookups("room-a").reason).toBeUndefined();
  });
});
