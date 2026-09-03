import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { attachWebSocket } from "../../apps/server/src/ws.ts";
import { submitCommand } from "../../apps/server/src/engine.ts";
import { lookupNow, setEnrichFetch } from "../../apps/server/src/enrich/index.ts";
import { storePageCache } from "../../apps/server/src/enrich/cache.ts";
import { setTransport } from "../../apps/server/src/nl/openai.ts";
import {
  apiPost,
  createTestRoom,
  openRealtime,
  startServer,
  type TestRoom,
  type TestServer,
} from "./helpers.ts";

let server: TestServer;
let room: TestRoom;
let revision = 0;

beforeAll(async () => {
  server = await startServer();
  room = await createTestRoom(server.baseUrl);
  revision = (await apiPost<{ revision: number }>(server.baseUrl, "/api/sync", room.tokens.org, {})).body.revision;
});

afterAll(async () => {
  await room.cleanup();
  await server.stop();
});

afterEach(() => {
  setEnrichFetch(null);
  setTransport(null);
  vi.unstubAllEnvs();
});

const command = async (token: string, type: string, input: Record<string, unknown>) => {
  const result = await apiPost<{ ok: boolean; revision?: number }>(
    server.baseUrl,
    "/api/commands",
    token,
    { type, input: { baseRevision: revision, ...input } },
  );
  if (result.body.ok && result.body.revision !== undefined) revision = result.body.revision;
  return result.body;
};

describe("look_up_places route and dossier privacy", () => {
  it("returns current dossiers without pending work on an offline server", async () => {
    const candidateId = `place_a_${room.roomId.slice("room_test_".length)}`;
    const osmRef = `node/offline-${room.roomId}`;
    await room.pool.query(
      "UPDATE candidates SET osm_ref = $2, extras = $3 WHERE id = $1",
      [candidateId, osmRef, JSON.stringify({ website: "https://offline.example/", address: "Teststraße 1", phone: "+49 30 1" })],
    );
    const result = await apiPost<{
      ok: boolean;
      candidates: Array<{ candidateId: string; lookupPending?: boolean }>;
    }>(server.baseUrl, "/api/spatial/lookup", room.tokens.org, {
      candidateIds: [candidateId],
      keys: ["wheelchair-accessible"],
    });
    expect(result.body.ok).toBe(true);
    expect(result.body.candidates).toEqual([
      expect.objectContaining({ candidateId, lookupPending: false }),
    ]);
    expect(result.body.candidates[0]).toMatchObject({ address: "Teststraße 1", phone: "+49 30 1" });
    expect(Number((await room.pool.query("SELECT count(*) FROM enrichments WHERE osm_ref = $1", [osmRef])).rows[0].count)).toBe(0);
  });

  it("collapses every peer private need into one worst-verdict row and keeps own needs full", async () => {
    const candidateId = `place_a_${room.roomId.slice("room_test_".length)}`;
    // place_a is verified_false for takeaway, so the second private need below
    // lands on "no" while the first stays "unknown".
    await room.pool.query(
      `UPDATE candidates
          SET attributes = $2::jsonb
        WHERE id = $1`,
      [
        candidateId,
        JSON.stringify([
          { key: "takeaway", status: "verified_false", source: "osm:test", confidence: 0.9 },
        ]),
      ],
    );
    expect(await command(room.tokens.org, "SubmitRequirement", {
      visibility: "shared",
      hardness: "hard",
      delegation: { mode: "locked" },
      payload: { kind: "attribute", key: "vegetarian-options", expect: "verified_true" },
    })).toMatchObject({ ok: true });
    expect(await command(room.tokens.sarah, "SubmitRequirement", {
      visibility: "application-private",
      hardness: "hard",
      delegation: { mode: "locked" },
      payload: { kind: "attribute", key: "wheelchair-accessible", expect: "verified_true" },
      note: "Sarah's private access detail",
    })).toMatchObject({ ok: true });
    expect(await command(room.tokens.org, "SubmitRequirement", {
      visibility: "application-private",
      hardness: "hard",
      delegation: { mode: "locked" },
      payload: { kind: "attribute", key: "takeaway", expect: "verified_true" },
      note: "the organizer's private takeaway detail",
    })).toMatchObject({ ok: true });

    const peer = await apiPost<{
      ok: boolean;
      candidates: Array<{ needs: Array<Record<string, unknown>> }>;
    }>(server.baseUrl, "/api/spatial/inspect", room.tokens.joe, { candidateIds: [candidateId] });
    const privateRows = peer.body.candidates[0].needs.filter((need) => need.private === true);
    // Two peer-private needs, one row: a count would itself be a leak.
    expect(privateRows).toHaveLength(1);
    // "no" is the worst of {unknown, no}, so the aggregate reports it.
    expect(privateRows[0]).toEqual({ private: true, verdict: "no" });
    expect(privateRows[0]).not.toHaveProperty("requirementId");
    expect(privateRows[0]).not.toHaveProperty("label");
    expect(privateRows[0]).not.toHaveProperty("why");
    expect(peer.raw).not.toContain("Sarah's private access detail");
    expect(peer.raw).not.toContain("the organizer's private takeaway detail");
    expect(peer.body.candidates[0].needs.some((need) => need.label === "vegetarian options")).toBe(true);

    // An owner still sees their own private need as a full, named row.
    const owner = await apiPost<{
      candidates: Array<{ needs: Array<Record<string, unknown>> }>;
    }>(server.baseUrl, "/api/spatial/inspect", room.tokens.sarah, { candidateIds: [candidateId] });
    expect(owner.body.candidates[0].needs.some((need) => need.label === "step-free access" && need.private !== true)).toBe(true);
    // Sarah has exactly one peer-private need (the organizer's), also collapsed.
    expect(owner.body.candidates[0].needs.filter((need) => need.private === true)).toEqual([
      { private: true, verdict: "no" },
    ]);

    const organizerPrivateId = String(
      (
        await room.pool.query(
          `SELECT id FROM requirements
            WHERE room_id = $1 AND owner_id = $2 AND visibility = 'application-private'
            ORDER BY created_at_revision DESC LIMIT 1`,
          [room.roomId, room.participantIds.org],
        )
      ).rows[0].id,
    );
    expect(
      await command(room.tokens.org, "SetRequirementActive", {
        requirementId: organizerPrivateId,
        active: false,
      }),
    ).toMatchObject({ ok: true });
    const afterSetAside = await apiPost<{
      candidates: Array<{ needs: Array<Record<string, unknown>> }>;
    }>(server.baseUrl, "/api/spatial/inspect", room.tokens.joe, { candidateIds: [candidateId] });
    expect(afterSetAside.body.candidates[0].needs.filter((need) => need.private === true)).toEqual([
      { private: true, verdict: "unknown" },
    ]);
    const organizerView = await apiPost<{
      candidates: Array<{ needs: Array<Record<string, unknown>> }>;
    }>(server.baseUrl, "/api/spatial/inspect", room.tokens.org, { candidateIds: [candidateId] });
    expect(
      organizerView.body.candidates[0].needs.some(
        (need) => need.requirementId === organizerPrivateId,
      ),
    ).toBe(false);
  });

  it("limits each participant to a six-token lookup bucket per minute", async () => {
    const candidateId = `place_a_${room.roomId.slice("room_test_".length)}`;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const allowed = await apiPost<{ ok: boolean }>(
        server.baseUrl,
        "/api/spatial/lookup",
        room.tokens.joe,
        { candidateIds: [candidateId] },
      );
      expect(allowed.status).toBe(200);
      expect(allowed.body.ok).toBe(true);
    }
    const limited = await apiPost<{
      ok: boolean;
      error: { code: string; message: string; recovery: string };
    }>(server.baseUrl, "/api/spatial/lookup", room.tokens.joe, {
      candidateIds: [candidateId],
    });
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({
      ok: false,
      error: {
        code: "invalid_input",
        message: "Place lookup rate limit exceeded (6 per minute).",
        recovery: "Wait before asking to look up more places, then retry.",
      },
    });
  });
});

describe("need-triggered lookup and realtime facts", () => {
  it("serves cached page evidence to the evaluator without calling the fetch dispatcher", async () => {
    vi.stubEnv("ENRICH_NETWORK", "1");
    vi.stubEnv("INFER", "1");
    vi.stubEnv("OPENAI_API_KEY", "test");
    const candidateId = `place_c_${room.roomId.slice("room_test_".length)}`;
    const osmRef = `node/page-cache-${room.roomId}`;
    const website = `https://cached-${room.roomId}.example/`;
    await room.pool.query(
      `UPDATE candidates SET osm_ref = $2, extras = $3::jsonb,
         attributes = '[{"key":"dog-friendly","status":"unknown","source":"osm:dog","confidence":0}]'::jsonb
       WHERE id = $1`,
      [candidateId, osmRef, JSON.stringify({ website })],
    );
    await room.pool.query(
      `INSERT INTO enrichments
         (osm_ref, fetched_at, expires_at, website, website_status,
          website_fetched_at, website_expires_at, image_fetched_at,
          image_expires_at)
       VALUES ($1, now(), now() + interval '7 days', $2::jsonb, 'ok', now(),
               now() + interval '7 days', now(), now() + interval '30 days')
       ON CONFLICT (osm_ref) DO UPDATE SET
         website = EXCLUDED.website, website_status = 'ok',
         website_fetched_at = now(), website_expires_at = now() + interval '7 days',
         image_fetched_at = now(), image_expires_at = now() + interval '30 days'`,
      [osmRef, JSON.stringify({ url: website, host: new URL(website).host, fetchedAt: new Date().toISOString(), types: [] })],
    );
    await storePageCache(room.pool, {
      url: website,
      status: 200,
      text: "Dogs are welcome throughout our quiet courtyard.",
    });

    const dispatcher = vi.fn(async () => {
      throw new Error("cached page must not fetch");
    });
    setEnrichFetch(dispatcher);
    setTransport(async (body) => {
      const matrix = JSON.parse((body.input as Array<{ content: string }>)[0].content) as {
        places: Array<{ candidateId: string }>;
      };
      return {
        output: [{ type: "message", content: [{
          type: "output_text",
          text: JSON.stringify({ claims: [{
            candidateId: matrix.places[0].candidateId,
            criterionId: "dog-friendly",
            lean: "yes",
            confidence: 0.6,
            evidence: "Dogs are welcome throughout",
            sourceIndex: 0,
            explicit: false,
          }] }),
        }] }],
      };
    });

    await lookupNow(room.pool, room.roomId, [{ candidateId, osmRef, website }], {
      keys: ["dog-friendly"],
    });

    expect(dispatcher).not.toHaveBeenCalled();
    const stored = (await room.pool.query(
      "SELECT inferred FROM enrichments WHERE osm_ref = $1",
      [osmRef],
    )).rows[0];
    expect(stored.inferred["dog-friendly"]).toMatchObject({
      lean: "yes",
      evidence: "Dogs are welcome throughout",
    });
  });

  it("a forced lookup validates a claim from cached private page text without putting it in the dossier", async () => {
    vi.stubEnv("ENRICH_NETWORK", "1");
    vi.stubEnv("INFER", "1");
    vi.stubEnv("OPENAI_API_KEY", "test");
    const candidateId = `place_b_${room.roomId.slice("room_test_".length)}`;
    const osmRef = `node/transient-${room.roomId}`;
    const website = "https://transient.example/";
    const marker = "TRANSIENT-PAGE-MARKER";
    await room.pool.query(
      `UPDATE candidates SET osm_ref = $2, extras = $3::jsonb,
         attributes = '[{"key":"dog-friendly","status":"unknown","source":"osm:dog","confidence":0}]'::jsonb
       WHERE id = $1`,
      [candidateId, osmRef, JSON.stringify({ website })],
    );
    setEnrichFetch(async (url) => {
      if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
      return new Response(
        `<html><body><p>${marker} DOGS ARE WELCOME throughout our courtyard.</p></body></html>`,
        { status: 200, headers: { "content-type": "text/html" } },
      );
    });
    let modelInput: Record<string, unknown> | undefined;
    setTransport(async (body) => {
      const message = (body.input as Array<{ content: string }>)[0];
      modelInput = JSON.parse(message.content) as Record<string, unknown>;
      return {
        output: [{
          type: "message",
          content: [{
            type: "output_text",
            text: JSON.stringify({
              claims: [{
                candidateId,
                criterionId: "dog-friendly",
                lean: "yes",
                confidence: 0.9,
                evidence: "dogs are welcome throughout",
                sourceIndex: 0,
                explicit: false,
              }],
            }),
          }],
        }],
      };
    });

    await lookupNow(room.pool, room.roomId, [{ candidateId, osmRef, website }], {
      keys: ["dog-friendly"],
      intent: "interactive",
    });

    expect(modelInput).toMatchObject({
      places: [expect.objectContaining({
        candidateId,
        texts: [expect.objectContaining({
          source: "web",
          text: expect.stringContaining(`${marker} DOGS ARE WELCOME throughout our courtyard.`),
        })],
      })],
    });
    const stored = (
      await room.pool.query(
        `SELECT website, inferred, row_to_json(enrichments)::text AS serialized
           FROM enrichments WHERE osm_ref = $1`,
        [osmRef],
      )
    ).rows[0];
    expect(stored.inferred["dog-friendly"]).toMatchObject({
      lean: "yes",
      confidence: 0.6,
      evidence: "dogs are welcome throughout",
      context: expect.stringContaining(`${marker} DOGS ARE WELCOME throughout our courtyard.`),
      source: expect.stringMatching(/^infer:/),
    });
    expect(stored.inferred["dog-friendly"].context.length).toBeLessThanOrEqual(1_200);
    expect(stored.website).not.toHaveProperty("pageText");
    expect(stored.website).not.toHaveProperty("homepage");
    expect(stored.website).not.toHaveProperty("menu");
    expect(JSON.stringify(stored.website)).not.toContain(marker);
  });

  it("deduplicates concurrent lookup work by room, candidate and key set", async () => {
    vi.stubEnv("ENRICH_NETWORK", "1");
    vi.stubEnv("INFER", "1");
    vi.stubEnv("OPENAI_API_KEY", "test");
    const candidateId = `place_a_${room.roomId.slice("room_test_".length)}`;
    const osmRef = `node/dedupe-${room.roomId}`;
    await room.pool.query(
      `UPDATE candidates SET osm_ref = $2, extras = '{}'::jsonb,
         attributes = '[{"key":"delivery","status":"unknown","source":"osm:delivery","confidence":0}]'::jsonb
       WHERE id = $1`,
      [candidateId, osmRef],
    );
    let modelCalls = 0;
    setTransport(async () => {
      modelCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 150));
      return {
        output: [
          {
            type: "message",
            content: [{
              type: "output_text",
              text: JSON.stringify({
                claims: [{
                  candidateId,
                  criterionId: "delivery",
                  lean: "abstain",
                  confidence: 0,
                  evidence: "",
                  sourceIndex: null,
                  explicit: false,
                }],
              }),
            }],
          },
        ],
      };
    });
    const target = { candidateId, osmRef };
    await Promise.all([
      lookupNow(room.pool, room.roomId, [target], { keys: ["delivery"] }),
      lookupNow(room.pool, room.roomId, [target], { keys: ["delivery"] }),
    ]);
    expect(modelCalls).toBe(1);
  });

  it("negative-caches omitted keys briefly and still fetches a newly available website", async () => {
    vi.stubEnv("ENRICH_NETWORK", "1");
    vi.stubEnv("INFER", "1");
    vi.stubEnv("OPENAI_API_KEY", "test");
    const candidateId = `place_a_${room.roomId.slice("room_test_".length)}`;
    const osmRef = `node/omitted-${room.roomId}`;
    await room.pool.query(
      `UPDATE candidates SET osm_ref = $2,
         extras = '{"description":{"text":"A neighborhood venue with no delivery evidence."}}'::jsonb,
         attributes = '[{"key":"delivery","status":"unknown","source":"osm:delivery","confidence":0}]'::jsonb
       WHERE id = $1`,
      [candidateId, osmRef],
    );
    let deliveryCalls = 0;
    setTransport(async (body) => {
      const matrix = JSON.parse((body.input as Array<{ content: string }>)[0].content) as {
        places: Array<{ candidateId: string }>;
        criteria: Array<{ id: string }>;
      };
      if (matrix.criteria.some((criterion) => criterion.id === "delivery")) deliveryCalls += 1;
      return {
        output: [
          {
            type: "message",
            content: [{
              type: "output_text",
              text: JSON.stringify({ claims: matrix.places.flatMap((place) =>
                matrix.criteria.map((criterion) => ({
                candidateId: place.candidateId,
                criterionId: criterion.id,
                lean: "abstain",
                confidence: 0,
                evidence: "",
                sourceIndex: null,
                explicit: false,
              }))) }),
            }],
          },
        ],
      };
    });
    await lookupNow(room.pool, room.roomId, [{ candidateId, osmRef }], {
      keys: ["delivery"],
    });
    const omitted = (
      await room.pool.query(
        `SELECT inferred, EXTRACT(EPOCH FROM (expires_at - fetched_at)) AS ttl_seconds
           FROM enrichments WHERE osm_ref = $1`,
        [osmRef],
      )
    ).rows[0];
    expect(omitted.inferred.delivery).toMatchObject({ omitted: true });
    expect(Number(omitted.ttl_seconds)).toBeGreaterThan(23 * 60 * 60);
    expect(Number(omitted.ttl_seconds)).toBeLessThanOrEqual(24 * 60 * 60 + 1);

    await lookupNow(room.pool, room.roomId, [{ candidateId, osmRef }], {
      keys: ["delivery"],
    });
    expect(deliveryCalls).toBe(1);

    let siteFetches = 0;
    setEnrichFetch(async (url) => {
      if (url.endsWith("/robots.txt")) return new Response("", { status: 200 });
      siteFetches += 1;
      return new Response("<html></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    });
    await lookupNow(
      room.pool,
      room.roomId,
      [{ candidateId, osmRef, website: "https://93.184.216.34/new-site" }],
      { keys: ["delivery"] },
    );
    expect(siteFetches).toBe(1);
    expect(deliveryCalls).toBe(1);
    expect(
      (
        await room.pool.query(
          "SELECT website FROM enrichments WHERE osm_ref = $1",
          [osmRef],
        )
      ).rows[0].website,
    ).toMatchObject({ host: "93.184.216.34" });
  });

  it("force re-evaluates unchanged cached evidence and refreshes only an expired page", async () => {
    vi.stubEnv("ENRICH_NETWORK", "1");
    vi.stubEnv("INFER", "1");
    vi.stubEnv("OPENAI_API_KEY", "test");
    const candidateId = `place_c_${room.roomId.slice("room_test_".length)}`;
    const osmRef = `node/force-${room.roomId}`;
    const website = "https://93.184.216.34/force-site";
    await room.pool.query(
      `UPDATE candidates SET osm_ref = $2,
         extras = $3::jsonb,
         attributes = '[{"key":"delivery","status":"unknown","source":"osm:delivery","confidence":0}]'::jsonb
       WHERE id = $1`,
      [candidateId, osmRef, JSON.stringify({ website, description: { text: "We deliver across the district every evening." } })],
    );
    let siteFetches = 0;
    setEnrichFetch(async (url) => {
      if (url.endsWith("/robots.txt")) return new Response("", { status: 200 });
      siteFetches += 1;
      return new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } });
    });
    let deliveryCalls = 0;
    setTransport(async (body) => {
      const matrix = JSON.parse((body.input as Array<{ content: string }>)[0].content) as {
        places: Array<{ candidateId: string; texts: Array<{ text: string }> }>;
        criteria: Array<{ id: string }>;
      };
      const claims = matrix.places.flatMap((place) => matrix.criteria.map((criterion) => {
        if (criterion.id !== "delivery") {
          return { candidateId: place.candidateId, criterionId: criterion.id, lean: "abstain", confidence: 0, evidence: "", sourceIndex: null, explicit: false };
        }
        deliveryCalls += 1;
        return deliveryCalls === 1
          ? { candidateId: place.candidateId, criterionId: criterion.id, lean: "abstain", confidence: 0, evidence: "", sourceIndex: null, explicit: false }
          : { candidateId: place.candidateId, criterionId: criterion.id, lean: "yes", confidence: 0.9, evidence: "deliver across the district every evening", sourceIndex: place.texts.findIndex((text) => text.text.includes("deliver across")), explicit: false };
      }));
      return { output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ claims }) }] }] };
    });
    const target = { candidateId, osmRef, website };

    // First pass: the site is read, the model abstains, the omission is stored.
    await lookupNow(room.pool, room.roomId, [target], { keys: ["delivery"] });
    expect(siteFetches).toBe(1);
    expect(deliveryCalls).toBe(1);

    // Plain again: everything is cached, nothing runs.
    await lookupNow(room.pool, room.roomId, [target], { keys: ["delivery"] });
    expect(siteFetches).toBe(1);
    expect(deliveryCalls).toBe(1);

    // Force, minutes after a good read: the page stays cached, but "Look again"
    // asks for a fresh judgement even when the evidence hash is unchanged.
    await lookupNow(room.pool, room.roomId, [target], { keys: ["delivery"], intent: "interactive" });
    expect(siteFetches).toBe(1);
    expect(deliveryCalls).toBe(2);
    const stored = (await room.pool.query("SELECT inferred FROM enrichments WHERE osm_ref = $1", [osmRef])).rows[0];
    expect(stored.inferred.delivery).toMatchObject({ lean: "yes", source: expect.stringMatching(/^infer:/) });

    // Aging the provider clock alone still reuses the seven-day page row while
    // the requested criterion is evaluated again.
    await room.pool.query(
      "UPDATE enrichments SET website_fetched_at = now() - interval '11 minutes' WHERE osm_ref = $1",
      [osmRef],
    );
    await lookupNow(room.pool, room.roomId, [target], { keys: ["delivery"], intent: "interactive" });
    expect(siteFetches).toBe(1);
    expect(deliveryCalls).toBe(3);

    // Once the actual page row expires, a 200 replaces it and the forced
    // judgement still runs independently of the page-cache outcome.
    await room.pool.query(
      "UPDATE page_cache SET expires_at = now() - interval '1 second' WHERE url = $1",
      [website],
    );
    await room.pool.query(
      "UPDATE enrichments SET website_fetched_at = now() - interval '11 minutes' WHERE osm_ref = $1",
      [osmRef],
    );
    await lookupNow(room.pool, room.roomId, [target], { keys: ["delivery"], intent: "interactive" });
    expect(siteFetches).toBe(2);
    expect(deliveryCalls).toBe(4);

    // A failed read keeps its retry TTL even under force.
    setEnrichFetch(async (url) => {
      if (url.endsWith("/robots.txt")) return new Response("", { status: 200 });
      siteFetches += 1;
      throw new Error("site down");
    });
    await room.pool.query(
      "UPDATE enrichments SET website_fetched_at = now() - interval '11 minutes' WHERE osm_ref = $1",
      [osmRef],
    );
    await room.pool.query(
      "UPDATE page_cache SET expires_at = now() - interval '1 second' WHERE url = $1",
      [website],
    );
    await lookupNow(room.pool, room.roomId, [target], { keys: ["delivery"], intent: "interactive" });
    expect(siteFetches).toBe(3);
    expect(deliveryCalls).toBe(5);
    await lookupNow(room.pool, room.roomId, [target], { keys: ["delivery"], intent: "interactive" });
    expect(siteFetches).toBe(3);
    expect(deliveryCalls).toBe(6);

    // The wire accepts force and the dossier says when it was looked up.
    const viaRoute = await apiPost<{ ok: boolean; candidates?: Array<{ lookedUpAt?: string }> }>(
      server.baseUrl,
      "/api/spatial/lookup",
      room.tokens.org,
      { candidateIds: [candidateId], keys: ["delivery"], force: true },
    );
    expect(viaRoute.body.ok).toBe(true);
    expect(typeof viaRoute.body.candidates?.[0]?.lookedUpAt).toBe("string");
  });

  it("keeps a failed website fetch on its one-hour TTL when inference lands", async () => {
    vi.stubEnv("ENRICH_NETWORK", "1");
    vi.stubEnv("INFER", "1");
    vi.stubEnv("OPENAI_API_KEY", "test");
    const candidateId = `place_b_${room.roomId.slice("room_test_".length)}`;
    const osmRef = `node/failure-ttl-${room.roomId}`;
    const evidence = "Dogs are welcome on our terrace";
    await room.pool.query(
      `UPDATE candidates SET osm_ref = $2,
         extras = $3::jsonb,
         attributes = '[{"key":"dog-friendly","status":"unknown","source":"osm:dog","confidence":0}]'::jsonb
       WHERE id = $1`,
      [candidateId, osmRef, JSON.stringify({ description: { text: evidence } })],
    );
    setEnrichFetch(async (url) => {
      if (url.endsWith("/robots.txt")) return new Response("", { status: 200 });
      throw new Error("site down");
    });
    setTransport(async (body) => ({
      output: [
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: JSON.stringify({
                claims: [
                  {
                    candidateId: (JSON.parse((body.input as Array<{ content: string }>)[0].content) as { places: Array<{ candidateId: string }> }).places[0].candidateId,
                    criterionId: "dog-friendly",
                    lean: "yes",
                    confidence: 0.9,
                    evidence,
                    sourceIndex: 0,
                    explicit: false,
                  },
                ],
              }),
            },
          ],
        },
      ],
    }));
    await lookupNow(
      room.pool,
      room.roomId,
      [{ candidateId, osmRef, website: "https://93.184.216.34/failing-site" }],
      { keys: ["dog-friendly"] },
    );
    const cached = (
      await room.pool.query(
        `SELECT error, inferred, EXTRACT(EPOCH FROM (expires_at - fetched_at)) AS ttl_seconds
           FROM enrichments WHERE osm_ref = $1`,
        [osmRef],
      )
    ).rows[0];
    expect(cached.error).toContain("site down");
    expect(cached.inferred["dog-friendly"]).toMatchObject({
      lean: "yes",
      evidence,
    });
    expect(Number(cached.ttl_seconds)).toBeGreaterThan(59 * 60);
    expect(Number(cached.ttl_seconds)).toBeLessThanOrEqual(60 * 60 + 1);
  });

  it("never broadcasts an application-private need label with lookup progress", async () => {
    const networkServer = await startServer({
      entrypoint: "tests/api/fixtures/live-network-server.ts",
      env: { ENRICH_NETWORK: "1", INFER: "0" },
    });
    const privateRoom = await createTestRoom(networkServer.baseUrl);
    const suffix = privateRoom.roomId.slice("room_test_".length);
    const candidateIds = ["a", "b", "c"].map((letter) => `place_${letter}_${suffix}`);
    await privateRoom.pool.query(
      `UPDATE candidates SET
         attributes = '[{"key":"delivery","status":"unknown","source":"osm:delivery","confidence":0}]'::jsonb,
         osm_ref = 'node/private-progress-' || id,
         extras = jsonb_build_object('website', 'https://93.184.216.34/' || id)
       WHERE room_id = $1`,
      [privateRoom.roomId],
    );
    const peer = await openRealtime(networkServer.baseUrl, privateRoom.tokens.sarah);
    try {
      const current = (
        await apiPost<{ revision: number }>(
          networkServer.baseUrl,
          "/api/sync",
          privateRoom.tokens.org,
          {},
        )
      ).body.revision;
      const result = await apiPost<{ ok: boolean }>(
        networkServer.baseUrl,
        "/api/commands",
        privateRoom.tokens.org,
        {
          type: "SubmitRequirement",
          input: {
            baseRevision: current,
            visibility: "application-private",
            hardness: "hard",
            delegation: { mode: "locked" },
            payload: { kind: "attribute", key: "delivery", expect: "verified_true" },
          },
        },
      );
      expect(result.body.ok).toBe(true);

      expect(
        await waitFor(() =>
          peer.frames().some((raw) => {
            const frame = JSON.parse(raw) as { type: string; pending?: string[] };
            return frame.type === "lookups" && Boolean(frame.pending?.length);
          }),
        ),
      ).toBe(true);
      const pending = peer.frames().find((raw) => {
        const frame = JSON.parse(raw) as { type: string; pending?: string[] };
        return frame.type === "lookups" && Boolean(frame.pending?.length);
      })!;
      expect(JSON.parse(pending)).toMatchObject({
        type: "lookups",
        pending: expect.arrayContaining(candidateIds),
        reason: { kind: "need" },
      });
      expect(pending).not.toContain("delivery");
      expect(JSON.parse(pending).reason).not.toHaveProperty("label");
    } finally {
      peer.close();
      await privateRoom.cleanup();
      await networkServer.stop();
    }
  });

  it("looks up only unknown in-scope places and broadcasts a landed fact", async () => {
    vi.stubEnv("ENRICH_NETWORK", "1");
    vi.stubEnv("INFER", "0");
    const suffix = room.roomId.slice("room_test_".length);
    const [alpha, beta, gamma] = ["a", "b", "c"].map((letter) => `place_${letter}_${suffix}`);
    await room.pool.query(
      `UPDATE rooms SET scope = $2 WHERE id = $1`,
      [room.roomId, JSON.stringify({
        scopeId: "scope_live",
        area: { kind: "circle", center: { lat: 52.5, lng: 13.4 }, radiusM: 1000 },
        transport: ["walk"],
        category: "food",
      })],
    );
    await room.pool.query(
      `UPDATE candidates SET
         location = CASE id WHEN $2 THEN '{"lat":52.5,"lng":13.4}'::jsonb WHEN $3 THEN '{"lat":53.5,"lng":13.4}'::jsonb ELSE '{"lat":52.5001,"lng":13.4}'::jsonb END,
         attributes = CASE id WHEN $4 THEN '[{"key":"wheelchair-accessible","status":"verified_true","source":"osm:wheelchair","confidence":0.8}]'::jsonb ELSE '[{"key":"wheelchair-accessible","status":"unknown","source":"osm:wheelchair","confidence":0}]'::jsonb END,
         osm_ref = 'node/' || id,
         extras = jsonb_build_object('website', 'https://93.184.216.34/' || id)
       WHERE room_id = $1`,
      [room.roomId, alpha, beta, gamma],
    );
    const initialMapRevision = Number(
      (await room.pool.query("SELECT map_revision FROM candidates WHERE id = $1", [alpha])).rows[0]
        .map_revision,
    );

    const fetched: string[] = [];
    setEnrichFetch(async (url) => {
      fetched.push(url);
      if (url.endsWith("/robots.txt")) return new Response("", { status: 200 });
      return new Response(
        `<script type="application/ld+json">${JSON.stringify({
          "@type": "LocalBusiness",
          amenityFeature: [{ "@type": "LocationFeatureSpecification", name: "Wheelchair accessible", value: true }],
        })}</script>`,
        { status: 200, headers: { "content-type": "text/html" } },
      );
    });

    const http = createServer();
    attachWebSocket(http);
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const address = http.address();
    const localBase = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    const realtime = await openRealtime(localBase, room.tokens.org);
    try {
      const current = Number((await room.pool.query("SELECT revision FROM rooms WHERE id = $1", [room.roomId])).rows[0].revision);
      const result = await submitCommand(
        {
          id: room.participantIds.org,
          roomId: room.roomId,
          displayName: "Alex",
          role: "organizer",
        },
        "SubmitRequirement",
        {
          baseRevision: current,
          visibility: "shared",
          hardness: "hard",
          delegation: { mode: "locked" },
          payload: { kind: "attribute", key: "wheelchair-accessible", expect: "verified_true" },
        },
      );
      expect(result.ok).toBe(true);

      expect(await waitFor(() => realtime.frames().some((raw) => {
        const frame = JSON.parse(raw) as { type: string; candidateIds?: string[] };
        return frame.type === "facts" && frame.candidateIds?.includes(alpha);
      }))).toBe(true);
      expect(fetched.some((url) => url.includes(alpha))).toBe(true);
      expect(fetched.some((url) => url.includes(beta))).toBe(false);
      expect(fetched.some((url) => url.includes(gamma))).toBe(false);
      expect(Number((await room.pool.query("SELECT map_revision FROM candidates WHERE id = $1", [alpha])).rows[0].map_revision)).toBe(initialMapRevision + 1);
      expect(await waitFor(() => realtime.frames().some((raw) => {
        const frame = JSON.parse(raw) as { type: string; pending?: string[] };
        return frame.type === "lookups" && frame.pending?.length === 0;
      }))).toBe(true);

      const factsBefore = realtime.frames().filter((raw) => JSON.parse(raw).type === "facts").length;
      const requirementId = String((await room.pool.query(
        "SELECT id FROM requirements WHERE room_id = $1 AND owner_id = $2 ORDER BY created_at_revision DESC LIMIT 1",
        [room.roomId, room.participantIds.org],
      )).rows[0].id);
      const moved = Number((await room.pool.query("SELECT revision FROM rooms WHERE id = $1", [room.roomId])).rows[0].revision);
      const same = await submitCommand(
        { id: room.participantIds.org, roomId: room.roomId, displayName: "Alex", role: "organizer" },
        "SubmitRequirement",
        {
          baseRevision: moved,
          requirementId,
          visibility: "shared",
          hardness: "hard",
          delegation: { mode: "locked" },
          payload: { kind: "attribute", key: "wheelchair-accessible", expect: "verified_true" },
        },
      );
      expect(same.ok).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(realtime.frames().filter((raw) => JSON.parse(raw).type === "facts")).toHaveLength(factsBefore);
      expect(Number((await room.pool.query("SELECT map_revision FROM candidates WHERE id = $1", [alpha])).rows[0].map_revision)).toBe(initialMapRevision + 1);
    } finally {
      realtime.close();
      await close(http);
    }
  });
});

const waitFor = async (check: () => boolean, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return check();
};

const close = (server: Server) =>
  new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
