import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  apiPost,
  createTestRoom,
  openRealtime,
  startServer,
  type TestRealtime,
  type TestRoom,
  type TestServer,
} from "./helpers.ts";

const PRIVATE_TEXT = "pipeline-private-otter-938 needs a hidden terrace";
const KNOWN_ATTRIBUTES = [
  "vegetarian-options", "vegan-options", "gluten-free-options", "halal-options",
  "lactose-free-options", "wheelchair-accessible", "outdoor-seating", "dog-friendly",
  "takeaway", "delivery", "price-level",
].map((key) => ({ key, status: "verified_true", source: "curated:test", confidence: 1 }));

describe("pipeline over HTTP, WebSocket, and PostgreSQL", () => {
  let server: TestServer;
  let room: TestRoom;
  let realtime: TestRealtime;
  let candidateId: string;

  beforeAll(async () => {
    server = await startServer({
      entrypoint: "tests/api/fixtures/refine-server.ts",
      env: {
        ENRICH_NETWORK: "1",
        INFER: "1",
        REFINE: "1",
        REFINE_SEARCH_MODE: "split",
        REFINE_TICK_MS: "250",
        REFINE_IDLE_STOP_MS: "200",
        OPENAI_API_KEY: "scripted",
      },
    });
    room = await createTestRoom(server.baseUrl);
    await room.pool.query("UPDATE rooms SET area_id = 'berlin-mitte' WHERE id = $1", [room.roomId]);
    const candidates = (await room.pool.query(
      "SELECT id, name FROM candidates WHERE room_id = $1 ORDER BY name",
      [room.roomId],
    )).rows as Array<{ id: string; name: string }>;
    candidateId = candidates[0].id;
    for (const [index, candidate] of candidates.entries()) {
      await room.pool.query(
        `UPDATE candidates
            SET osm_ref = $2,
                extras = $3::jsonb,
                attributes = $4::jsonb,
                walk_min = $5
          WHERE id = $1`,
        [
          candidate.id,
          `pipeline/${room.roomId}/${candidate.name.toLowerCase()}`,
          JSON.stringify({ website: `https://${candidate.name.toLowerCase()}.example/${room.roomId}` }),
          JSON.stringify(KNOWN_ATTRIBUTES),
          index + 1,
        ],
      );
    }
    await room.pool.query(
      `INSERT INTO requirements
         (id, room_id, owner_id, visibility, hardness, delegation, payload, active)
       VALUES
         ($1, $3, $4, 'shared', 'hard', '{}', $5, true),
         ($2, $3, $4, 'application-private', 'hard', '{}', $6, true)`,
      [
        `pipeline_shared_${room.roomId}`,
        `pipeline_private_${room.roomId}`,
        room.roomId,
        room.participantIds.org,
        JSON.stringify({ kind: "text", text: "free wifi" }),
        JSON.stringify({ kind: "text", text: PRIVATE_TEXT }),
      ],
    );
    realtime = await openRealtime(server.baseUrl, room.tokens.org);
  });

  afterAll(async () => {
    realtime?.close();
    await room?.pool.query("DELETE FROM enrichments WHERE osm_ref LIKE $1", [
      `pipeline/${room.roomId}/%`,
    ]);
    await room?.cleanup();
    await server?.stop();
  });

  it("drains a room with two needs and emits pipeline frames", async () => {
    await waitFor(() => pipelineFrames().some((frame) =>
      frame.outstanding.fetch + frame.inFlight.fetch +
        frame.outstanding.process + frame.inFlight.process > 0
    ), 8_000, () => `frames=${realtime.frames().join("|")} logs=${server.logs()}`);
    await waitFor(async () => {
      const response = await apiPost<{
        refine: { queued: number };
      }>(server.baseUrl, "/api/spatial/context", room.tokens.org, {});
      return response.body.refine.queued === 0;
    }, 10_000);
    await waitFor(() => {
      const frame = pipelineFrames().at(-1);
      return Boolean(frame && frame.outstanding.fetch === 0 && frame.outstanding.process === 0 &&
        frame.inFlight.fetch === 0 && frame.inFlight.process === 0);
    });
    expect(pipelineFrames().length).toBeGreaterThan(1);
    expect(pipelineFrames().some((frame) =>
      frame.outstanding.process + frame.inFlight.process > 0
    )).toBe(true);
  });

  it("keeps vision and decode out of the sweep and enqueues both when a place opens", async () => {
    expect(countLog("pipeline-enqueue process.vision")).toBe(0);
    expect(countLog("pipeline-enqueue process.decode")).toBe(0);
    const response = await apiPost<{ ok: boolean }>(
      server.baseUrl,
      "/api/spatial/inspect",
      room.tokens.org,
      { candidateIds: [candidateId] },
    );
    expect(response.body.ok).toBe(true);
    await waitFor(() => countLog("pipeline-enqueue process.decode") > 0, 8_000, () => server.logs());
    await waitFor(() => countLog("pipeline-enqueue process.vision") > 0, 8_000, () => server.logs());
  });

  it("does one fresh judgement and zero fetches for warm-page Look again", async () => {
    const beforeFetches = countLog("scripted-site-fetch");
    const beforeModels = countLog("scripted-matrix-call");
    const response = await apiPost<{ ok: boolean }>(
      server.baseUrl,
      "/api/spatial/lookup",
      room.tokens.org,
      { candidateIds: [candidateId], keys: ["dog-friendly"], force: true },
    );
    expect(response.body.ok).toBe(true);
    await waitFor(() => countLog("scripted-matrix-call") === beforeModels + 1);
    expect(countLog("scripted-site-fetch")).toBe(beforeFetches);
    expect(countLog("scripted-matrix-call")).toBe(beforeModels + 1);
  });

  it("never writes a private question into any frame or log line", () => {
    expect(realtime.frames().join("\n")).not.toContain(PRIVATE_TEXT);
    expect(server.logs()).not.toContain(PRIVATE_TEXT);
  });

  function pipelineFrames(): Array<{
    outstanding: { fetch: number; process: number };
    inFlight: { fetch: number; process: number };
  }> {
    return realtime.frames().map((raw) => JSON.parse(raw) as {
      type: string;
      outstanding?: { fetch: number; process: number };
      inFlight?: { fetch: number; process: number };
    }).filter((frame): frame is {
      type: "pipeline";
      outstanding: { fetch: number; process: number };
      inFlight: { fetch: number; process: number };
    } => frame.type === "pipeline" && Boolean(frame.outstanding && frame.inFlight));
  }

  function countLog(marker: string): number {
    return server.logs().split("\n").filter((line) => line.includes(marker)).length;
  }
});

async function waitFor(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 8_000,
  detail?: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for pipeline state${detail ? `: ${detail()}` : ""}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
