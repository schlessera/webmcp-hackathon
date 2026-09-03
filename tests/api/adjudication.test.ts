import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  apiPost,
  createTestRoom,
  openRealtime,
  startServer,
  type TestRoom,
  type TestServer,
} from "./helpers.ts";

const EVIDENCE = "Hunde sind in allen Restaurants von HANS IM GLÜCK herzlich willkommen";
const CONTEXT = `Willkommen bei HANS IM GLÜCK. ${EVIDENCE}. Mehr zu unseren Restaurants.`;

describe("focused adjudication over the API", () => {
  let server: TestServer;
  const rooms: TestRoom[] = [];
  const refs: string[] = [];

  beforeAll(async () => {
    server = await startServer({
      entrypoint: "tests/api/fixtures/adjudication-server.ts",
      env: {
        ENRICH_NETWORK: "1",
        INFER: "1",
        REFINE: "1",
        REFINE_TICK_MS: "200",
        REFINE_IDLE_TICK_MS: "300",
        REFINE_IDLE_STOP_MS: "300",
        OPENAI_API_KEY: "scripted",
      },
    });
  });

  afterAll(async () => {
    if (refs.length) await rooms[0]?.pool.query("DELETE FROM enrichments WHERE osm_ref = ANY($1)", [refs]);
    for (const room of rooms) await room.cleanup();
    await server?.stop();
  });

  async function seededLikelyRoom(): Promise<{ room: TestRoom; candidateId: string; requirementId: string }> {
    const room = await createTestRoom(server.baseUrl);
    rooms.push(room);
    const suffix = room.roomId.slice("room_test_".length);
    const candidateId = `place_a_${suffix}`;
    const osmRef = `adjudication/${room.roomId}`;
    const requirementId = `need_dogs_${suffix}`;
    refs.push(osmRef);
    await room.pool.query(
      `UPDATE candidates
          SET name = 'HANS IM GLÜCK Berlin',
              category = 'restaurant',
              osm_ref = $2,
              walk_min = 1,
              extras = $3::jsonb,
              attributes = $4::jsonb
        WHERE id = $1`,
      [
        candidateId,
        osmRef,
        JSON.stringify({ website: "https://different-osm-website.example/berlin" }),
        JSON.stringify([{ key: "dog-friendly", status: "unknown", confidence: 0 }]),
      ],
    );
    await room.pool.query(
      `INSERT INTO requirements
         (id, room_id, owner_id, visibility, hardness, delegation, payload, active)
       VALUES ($1, $2, $3, 'shared', 'hard', '{}', $4, true)`,
      [
        requirementId,
        room.roomId,
        room.participantIds.org,
        JSON.stringify({ kind: "attribute", key: "dog-friendly", expect: "verified_true" }),
      ],
    );
    await room.pool.query(
      `INSERT INTO enrichments
         (osm_ref, fetched_at, expires_at, website, wikidata, inferred, inferred_at,
          error, website_status, website_fetched_at, website_expires_at,
          wikidata_status, image_expires_at)
       VALUES ($1, now(), now() + interval '7 days', $2, NULL, $3, now(), NULL,
               'ok', now(), now() + interval '7 days', 'never', now() + interval '7 days')`,
      [
        osmRef,
        JSON.stringify({
          url: "https://different-osm-website.example/berlin",
          host: "different-osm-website.example",
          fetchedAt: new Date().toISOString(),
          types: [],
        }),
        JSON.stringify({
          "dog-friendly": {
            key: "dog-friendly",
            lean: "yes",
            confidence: 0.6,
            evidence: EVIDENCE,
            context: CONTEXT,
            pageTitle: "HANS IM GLÜCK | Burgergrill & Bar",
            publisherNames: ["HANS IM GLÜCK"],
            source: "infer:scripted:venue_site",
            sourceUrl: "https://hansimglueck-burgergrill.de/hunde",
            observedAt: new Date().toISOString(),
            explicit: true,
          },
        }),
      ],
    );
    return { room, candidateId, requirementId };
  }

  const callCount = () => server.logs().split("\n")
    .filter((line) => line.includes("adjudication-scripted-call")).length;

  it("opening a place promotes its likely row and the evidence hash prevents a second call", async () => {
    const { room, candidateId } = await seededLikelyRoom();
    const before = callCount();
    const inspected = await apiPost<{
      ok: boolean;
      candidates: Array<{ attributes: Array<Record<string, unknown>> }>;
    }>(server.baseUrl, "/api/spatial/inspect", room.tokens.org, { candidateIds: [candidateId] });
    expect(inspected.body.ok).toBe(true);
    expect(inspected.body.candidates[0].attributes).toContainEqual(expect.objectContaining({
      key: "dog-friendly",
      status: "verified_true",
      confidence: 0.75,
      source: "adjudicated:hansimglueck-burgergrill.de",
      note: EVIDENCE,
    }));
    expect(callCount()).toBe(before + 1);
    expect(server.logs()).toMatch(
      /"msg":"adjudication batch".*"cells":1.*"verdicts":\{"yes":1,"no":0,"unclear":0\}.*"costUsd":0\.000189.*"latencyMs":\d+/,
    );

    await apiPost(server.baseUrl, "/api/spatial/inspect", room.tokens.org, {
      candidateIds: [candidateId],
    });
    expect(callCount()).toBe(before + 1);
    const stored = (await room.pool.query(
      "SELECT inferred->'dog-friendly' AS claim FROM enrichments WHERE osm_ref = $1",
      [`adjudication/${room.roomId}`],
    )).rows[0].claim as Record<string, unknown>;
    expect(stored).toMatchObject({
      source: "adjudicated:hansimglueck-burgergrill.de",
      adjudication: { verdict: "yes", publisher: "chain" },
    });
  });

  it("the <=20 proactive trigger fires once and remains cached across a need wake", async () => {
    const { room, requirementId } = await seededLikelyRoom();
    const before = callCount();
    const realtime = await openRealtime(server.baseUrl, room.tokens.org);
    try {
      await waitFor(() => callCount() === before + 1);
      const current = await apiPost<{ revision: number }>(
        server.baseUrl,
        "/api/spatial/context",
        room.tokens.org,
        {},
      );
      const off = await apiPost<{ ok: boolean; revision?: number }>(
        server.baseUrl,
        "/api/commands",
        room.tokens.org,
        {
          type: "SetRequirementActive",
          input: { baseRevision: current.body.revision, requirementId, active: false },
        },
      );
      expect(off.body.ok).toBe(true);
      const on = await apiPost<{ ok: boolean }>(
        server.baseUrl,
        "/api/commands",
        room.tokens.org,
        {
          type: "SetRequirementActive",
          input: { baseRevision: off.body.revision, requirementId, active: true },
        },
      );
      expect(on.body.ok).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 900));
      expect(callCount()).toBe(before + 1);
    } finally {
      realtime.close();
    }
  });
});

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 6_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
