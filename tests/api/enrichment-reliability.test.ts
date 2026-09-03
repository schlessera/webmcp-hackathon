import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Participant } from "../../apps/server/src/auth.ts";
import {
  ensureEnrichments,
  lookupNow,
  setEnrichFetch,
  type LookupTarget,
  type RoomLookupTarget,
} from "../../apps/server/src/enrich/index.ts";
import { pipelineScheduler } from "../../apps/server/src/pipeline/scheduler.ts";
import { submitCommand } from "../../apps/server/src/engine.ts";
import { inspectCandidates } from "../../apps/server/src/spatial.ts";
import {
  createTestRoom,
  startServer,
  type TestRoom,
  type TestServer,
} from "./helpers.ts";

let server: TestServer;
let room: TestRoom;
const refs = new Set<string>();

beforeAll(async () => {
  server = await startServer();
  room = await createTestRoom(server.baseUrl);
});

afterEach(() => {
  setEnrichFetch(null);
  pipelineScheduler.reset();
});

afterAll(async () => {
  if (refs.size > 0) {
    await room.pool.query("DELETE FROM enrichments WHERE osm_ref = ANY($1)", [[...refs]]);
  }
  await room.cleanup();
  await server.stop();
});

const uniqueRef = (label: string) => {
  const ref = `test/${label}/${room.roomId}`;
  refs.add(ref);
  return ref;
};

const html = (body = "<html></html>") =>
  new Response(body, {
    status: 200,
    headers: { "content-type": "text/html" },
  });

describe("R11 provider-specific enrichment cache", () => {
  it("retains a good provider value when its refresh fails and retries only that provider soon", async () => {
    const ref = uniqueRef("partial");
    const oldWebsite = {
      url: "https://place.example/",
      host: "place.example",
      fetchedAt: "2026-08-01T00:00:00.000Z",
      types: ["LocalBusiness"],
      description: "last known good website description",
    };
    const oldWiki = {
      id: "Q42",
      fetchedAt: "2026-08-01T00:00:00.000Z",
      description: "old Wikidata description",
      awards: [],
      cuisineItems: [],
    };
    await room.pool.query(
      `INSERT INTO enrichments
         (osm_ref, fetched_at, expires_at, website, wikidata,
          website_status, website_fetched_at, website_expires_at,
          wikidata_status, wikidata_fetched_at, wikidata_expires_at)
       VALUES ($1, now() - interval '8 days', now() - interval '1 day', $2, $3,
               'ok', now() - interval '8 days', now() - interval '1 day',
               'ok', now() - interval '8 days', now() - interval '1 day')`,
      [ref, JSON.stringify(oldWebsite), JSON.stringify(oldWiki)],
    );

    setEnrichFetch(async (url) => {
      const value = String(url);
      if (value.endsWith("/robots.txt")) return new Response("", { status: 404 });
      if (value.startsWith("https://place.example/")) {
        return new Response("temporarily unavailable", { status: 503 });
      }
      if (value.includes("Special:EntityData/Q42.json")) {
        return new Response(
          JSON.stringify({
            entities: {
              Q42: {
                descriptions: { en: { value: "fresh Wikidata description" } },
                claims: {},
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected URL ${value}`);
    });

    await ensureEnrichments(
      room.pool,
      [{ osmRef: ref, website: "https://place.example/", wikidata: "Q42" }],
      2000,
    );
    const row = (
      await room.pool.query("SELECT * FROM enrichments WHERE osm_ref = $1", [ref])
    ).rows[0];
    expect(row.website).toEqual(oldWebsite);
    expect(row.website_status).toBe("error");
    expect(row.website_error).toBe("HTTP 503");
    expect(row.wikidata).toMatchObject({ description: "fresh Wikidata description" });
    expect(row.wikidata_status).toBe("ok");
    expect(row.wikidata_error).toBeNull();
    const websiteRetryMs = new Date(row.website_expires_at).getTime() - Date.now();
    const wikidataRetryMs = new Date(row.wikidata_expires_at).getTime() - Date.now();
    expect(websiteRetryMs).toBeGreaterThan(50 * 60 * 1000);
    expect(websiteRetryMs).toBeLessThan(70 * 60 * 1000);
    expect(wikidataRetryMs).toBeGreaterThan(6 * 24 * 60 * 60 * 1000);
  });

  it("uses one database lease when two workers request the same osm_ref", async () => {
    const ref = uniqueRef("lease");
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fetchStarted = new Promise<void>((resolve) => (started = resolve));
    let homepageFetches = 0;
    setEnrichFetch(async (url) => {
      const value = String(url);
      if (value.endsWith("/robots.txt")) {
        started();
        await gate;
        return new Response("", { status: 404 });
      }
      homepageFetches += 1;
      return html();
    });

    const target = { osmRef: ref, website: "https://lease.example/" };
    const first = ensureEnrichments(room.pool, [target], 2000);
    const second = ensureEnrichments(room.pool, [target], 2000);
    await fetchStarted;
    release();
    await Promise.all([first, second]);
    expect(homepageFetches).toBe(1);
  });
});

describe("R9 inspect enrichment bounds", () => {
  it("admits place lookups through the global direct pipeline pool", async () => {
    const directLimit = pipelineScheduler.pools.direct.limit;
    const targets: RoomLookupTarget[] = Array.from(
      { length: directLimit + 2 },
      (_, index) => ({
        candidateId: `pipeline_bounded_${index}_${room.roomId}`,
        osmRef: uniqueRef(`bounded-${index}`),
        website: `https://bounded-${index}.example/`,
      }),
    );
    await Promise.all(targets.map((target, index) => room.pool.query(
      `INSERT INTO candidates
         (id, room_id, osm_ref, name, category, price_level, walk_min, location, attributes, extras)
       VALUES ($1, $2, $3, $4, 'cafe', 2, $5, '{"lat":52.5,"lng":13.4}', '[]', $6)`,
      [
        target.candidateId,
        room.roomId,
        target.osmRef,
        `Bounded ${index}`,
        index + 1,
        JSON.stringify({ website: target.website }),
      ],
    )));
    let active = 0;
    let maximum = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let saturated!: () => void;
    const reachedLimit = new Promise<void>((resolve) => (saturated = resolve));
    setEnrichFetch(async (url) => {
      active += 1;
      maximum = Math.max(maximum, active);
      if (maximum === directLimit) saturated();
      await gate;
      active -= 1;
      return String(url).endsWith("/robots.txt") ? new Response("", { status: 404 }) : html();
    });

    const work = lookupNow(room.pool, room.roomId, targets, {
      intent: "interactive",
      keys: [],
    });
    await reachedLimit;
    expect(maximum).toBe(directLimit);
    const leased = Number(
      (
        await room.pool.query(
          `SELECT count(*)::int AS count FROM enrichments
            WHERE osm_ref = ANY($1) AND lease_owner IS NOT NULL`,
          [targets.map((target) => target.osmRef)],
        )
      ).rows[0].count,
    );
    // X4: queued jobs must not spend their two-minute lease while waiting.
    expect(leased).toBe(directLimit);
    release();
    await work;
    expect(maximum).toBe(directLimit);
  });

  it("does not hold the room lock or a DB client while a slow lookup reaches the request deadline", async () => {
    const ref = uniqueRef("slow-inspect");
    const candidateId = (
      await room.pool.query("SELECT id FROM candidates WHERE room_id = $1 ORDER BY id LIMIT 1", [
        room.roomId,
      ])
    ).rows[0].id as string;
    await room.pool.query(
      "UPDATE candidates SET osm_ref = $2, extras = $3 WHERE room_id = $1 AND id = $4",
      [room.roomId, ref, JSON.stringify({ website: "https://slow.example/" }), candidateId],
    );

    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fetchStarted = new Promise<void>((resolve) => (started = resolve));
    setEnrichFetch(async (url) => {
      if (String(url).endsWith("/robots.txt")) {
        started();
        await gate;
        return new Response("", { status: 404 });
      }
      return html();
    });

    const actor: Participant = {
      id: room.participantIds.org,
      roomId: room.roomId,
      displayName: "Alex",
      role: "organizer",
      readyState: "contributing",
    };
    const inspectStarted = Date.now();
    const inspection = inspectCandidates(actor, [candidateId]);
    await fetchStarted;

    const revision = Number(
      (await room.pool.query("SELECT revision FROM rooms WHERE id = $1", [room.roomId])).rows[0]
        .revision,
    );
    const mutationStarted = Date.now();
    const mutation = await Promise.race([
      submitCommand(actor, "SetReadyState", {
        baseRevision: revision,
        state: "ready",
      }),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 500)),
    ]);
    expect(mutation).not.toBe("blocked");
    expect(Date.now() - mutationStarted).toBeLessThan(500);

    const dossier = await inspection;
    const elapsed = Date.now() - inspectStarted;
    expect(dossier.ok).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(2800);
    expect(elapsed).toBeLessThan(4000);

    release();
    const leaseDeadline = Date.now() + 2000;
    while (Date.now() < leaseDeadline) {
      const lease = (
        await room.pool.query("SELECT lease_owner FROM enrichments WHERE osm_ref = $1", [ref])
      ).rows[0]?.lease_owner;
      if (!lease) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  });
});
