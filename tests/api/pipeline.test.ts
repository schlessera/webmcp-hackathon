import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
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
  let openRoom: TestRoom;
  let hangRoom: TestRoom;
  let realtime: TestRealtime;
  let hangRealtime: TestRealtime;
  let candidateId: string;
  let openCandidateId: string;

  beforeAll(async () => {
    server = await startServer({
      entrypoint: "tests/api/fixtures/refine-server.ts",
      env: {
        ENRICH_NETWORK: "1",
        INFER: "1",
        REFINE: "1",
        REFINE_TICK_MS: "250",
        REFINE_PLAN_WATCHDOG_MS: "300",
        REFINE_IDLE_STOP_MS: "200",
        PIPELINE_TIMEOUT_FETCH_SITE_MS: "150",
        OPENAI_API_KEY: "scripted",
        PARALLEL_API_KEY: "scripted",
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
    openRoom = await createTestRoom(server.baseUrl);
    const openCandidate = (await openRoom.pool.query(
      "SELECT id, name FROM candidates WHERE room_id = $1 ORDER BY name LIMIT 1",
      [openRoom.roomId],
    )).rows[0] as { id: string; name: string };
    openCandidateId = openCandidate.id;
    await openRoom.pool.query(
      `UPDATE candidates
          SET osm_ref = $2,
              extras = $3::jsonb,
              attributes = $4::jsonb
        WHERE id = $1`,
      [
        openCandidateId,
        `pipeline-open/${openRoom.roomId}/alpha`,
        JSON.stringify({ website: `https://alpha.example/${openRoom.roomId}` }),
        JSON.stringify(KNOWN_ATTRIBUTES),
      ],
    );
    await openRoom.pool.query(
      `INSERT INTO requirements
         (id, room_id, owner_id, visibility, hardness, delegation, payload, active)
       VALUES ($1, $2, $3, 'shared', 'hard', '{}', $4, true)`,
      [
        `pipeline_open_${openRoom.roomId}`,
        openRoom.roomId,
        openRoom.participantIds.org,
        JSON.stringify({ kind: "text", text: "free wifi" }),
      ],
    );
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

    hangRoom = await createTestRoom(server.baseUrl);
    const hangCandidate = (await hangRoom.pool.query(
      "SELECT id FROM candidates WHERE room_id = $1 ORDER BY id LIMIT 1",
      [hangRoom.roomId],
    )).rows[0].id as string;
    await hangRoom.pool.query(
      "UPDATE candidates SET osm_ref = NULL WHERE room_id = $1",
      [hangRoom.roomId],
    );
    await hangRoom.pool.query(
      `UPDATE candidates
          SET osm_ref = $2, extras = $3::jsonb, attributes = $4::jsonb
        WHERE id = $1`,
      [
        hangCandidate,
        `pipeline-hang/${hangRoom.roomId}/alpha`,
        JSON.stringify({ website: "https://hang-forever.example/place" }),
        JSON.stringify(KNOWN_ATTRIBUTES),
      ],
    );
    await hangRoom.pool.query(
      `INSERT INTO requirements
         (id, room_id, owner_id, visibility, hardness, delegation, payload, active)
       VALUES ($1, $2, $3, 'shared', 'hard', '{}', $4, true)`,
      [
        `pipeline_hang_${hangRoom.roomId}`,
        hangRoom.roomId,
        hangRoom.participantIds.org,
        JSON.stringify({ kind: "text", text: "free wifi" }),
      ],
    );
    hangRealtime = await openRealtime(server.baseUrl, hangRoom.tokens.org);
  });

  afterAll(async () => {
    realtime?.close();
    hangRealtime?.close();
    await room?.pool.query("DELETE FROM enrichments WHERE osm_ref LIKE $1", [
      `pipeline/${room.roomId}/%`,
    ]);
    await room?.cleanup();
    await openRoom?.cleanup();
    await hangRoom?.cleanup();
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
    expect(pipelineFrames().some((frame) => frame.done > 0)).toBe(true);
    expect(server.logs().split("\n").filter((line) =>
      line.includes('"msg":"pipeline loop started"') &&
      line.includes(`"roomId":"${room.roomId}"`)
    )).toHaveLength(1);
    expect(countLog('"msg":"pipeline tick"')).toBeGreaterThan(0);
    expect(countLog('"command":"InspectCandidates"')).toBe(0);
  });

  it("times out a stuck dispatch, releases its slot, and replans the occupied room", async () => {
    const roomMarker = `\"roomId\":\"${hangRoom.roomId}\"`;
    await waitFor(() => server.logs().split("\n").some((line) =>
      line.includes('"msg":"pipeline timeout"') && line.includes(roomMarker) &&
      line.includes('"kind":"fetch.site"')
    ), 8_000, () => server.logs());
    await waitFor(() => server.logs().split("\n").filter((line) =>
      line.includes('"msg":"pipeline tick"') && line.includes(roomMarker)
    ).length >= 2, 8_000, () => server.logs());
    const timeoutLine = server.logs().split("\n").find((line) =>
      line.includes('"msg":"pipeline timeout"') && line.includes(roomMarker)
    );
    expect(timeoutLine).toContain('"timeoutMs":150');
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

  it("returns cached inspect_candidates content immediately and streams the open fast track", async () => {
    const frameStart = realtime.frames().length;
    const started = performance.now();
    const response = await apiPost<{ ok: boolean; candidates: Array<{ candidateId: string }> }>(
      server.baseUrl,
      "/api/spatial/inspect",
      room.tokens.org,
      { candidateIds: [candidateId], intent: "open" },
    );
    const elapsedMs = performance.now() - started;
    expect(response.body.ok).toBe(true);
    expect(response.body.candidates[0]?.candidateId).toBe(candidateId);
    expect(elapsedMs).toBeLessThan(1_000);
    await waitFor(() => realtime.frames().slice(frameStart).some((raw) => {
      const frame = JSON.parse(raw) as { type?: string; reason?: string; stage?: string };
      return frame.type === "facts" && frame.reason === "interactive" && frame.stage === "site";
    }), 8_000, () => realtime.frames().slice(frameStart).join("|"));
  });

  it("runs one open plan inside the cooldown and facts-driven reads run none", async () => {
    const planMarker = `\"candidateId\":\"${openCandidateId}\"`;
    const modelMarker = `scripted-matrix-call candidates=${openCandidateId}`;
    const plans = countLog(planMarker);
    const modelCalls = countLog(modelMarker);
    const firstOpen = await apiPost<{ ok: boolean }>(
      server.baseUrl,
      "/api/spatial/inspect",
      openRoom.tokens.org,
      { candidateIds: [openCandidateId], intent: "open" },
    );
    expect(firstOpen.body.ok).toBe(true);
    await waitFor(() => countLog(planMarker) === plans + 1, 8_000, () => server.logs());
    const callsAfterFirst = countLog(modelMarker);
    expect(callsAfterFirst).toBeGreaterThan(modelCalls);
    const secondOpen = await apiPost<{ ok: boolean }>(
      server.baseUrl,
      "/api/spatial/inspect",
      openRoom.tokens.org,
      { candidateIds: [openCandidateId], intent: "open" },
    );
    expect(secondOpen.body.ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(countLog(planMarker), server.logs()).toBe(plans + 1);
    expect(countLog(modelMarker)).toBe(callsAfterFirst);

    const factsRead = await apiPost<{ ok: boolean }>(
      server.baseUrl,
      "/api/spatial/inspect",
      openRoom.tokens.org,
      { candidateIds: [openCandidateId] },
    );
    expect(factsRead.body.ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(countLog(planMarker), server.logs()).toBe(plans + 1);
    expect(countLog(modelMarker)).toBe(callsAfterFirst);

    const freeWifiCriterion = `q:${createHash("sha1").update("free wifi").digest("hex")}`;
    await openRoom.pool.query(
      `UPDATE candidates
          SET attributes = attributes || $2::jsonb
        WHERE room_id = $1 AND id = $3`,
      [
        openRoom.roomId,
        JSON.stringify([{
          key: freeWifiCriterion,
          status: "verified_true",
          source: "curated:test",
          confidence: 1,
        }]),
        openCandidateId,
      ],
    );
    const noOpRealtime = await openRealtime(server.baseUrl, openRoom.tokens.org);
    const frameStart = noOpRealtime.frames().length;
    const cachedForce = await apiPost<{ ok: boolean }>(
      server.baseUrl,
      "/api/spatial/inspect",
      openRoom.tokens.org,
      { candidateIds: [openCandidateId], intent: "open", force: true },
    );
    expect(cachedForce.body.ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(countLog(planMarker), server.logs()).toBe(plans + 1);
    expect(noOpRealtime.frames().slice(frameStart).some((raw) => {
      const frame = JSON.parse(raw) as { type?: string; reason?: string; candidateIds?: string[] };
      return frame.type === "facts" && frame.reason === "interactive" &&
        frame.candidateIds?.includes(openCandidateId);
    })).toBe(false);
    noOpRealtime.close();

    const line = server.logs().split("\n").find((entry) => entry.includes(planMarker))!;
    expect(line).toContain('"modelCalls":');
    expect(line).toContain('"costUsd":');
    expect(line).not.toContain(PRIVATE_TEXT);
  });

  it("lets force bypass the interactive-open cooldown", async () => {
    await openRoom.pool.query(
      `INSERT INTO requirements
         (id, room_id, owner_id, visibility, hardness, delegation, payload, active)
       VALUES ($1, $2, $3, 'shared', 'hard', '{}', $4, true)`,
      [
        `pipeline_force_${openRoom.roomId}`,
        openRoom.roomId,
        openRoom.participantIds.org,
        JSON.stringify({ kind: "text", text: "late-night counter service" }),
      ],
    );
    const planMarker = `\"candidateId\":\"${openCandidateId}\"`;
    const modelMarker = `scripted-matrix-call candidates=${openCandidateId}`;
    const plans = countLog(planMarker);
    const modelCalls = countLog(modelMarker);
    const response = await apiPost<{ ok: boolean }>(
      server.baseUrl,
      "/api/spatial/inspect",
      openRoom.tokens.org,
      { candidateIds: [openCandidateId], intent: "open", force: true },
    );
    expect(response.body.ok).toBe(true);
    await waitFor(() => countLog(planMarker) === plans + 1, 8_000, () => server.logs());
    expect(countLog(modelMarker)).toBeGreaterThan(modelCalls);
  });

  it("runs previewing as cheap work without search or vision", async () => {
    const previewId = (await room.pool.query(
      "SELECT id FROM candidates WHERE room_id = $1 AND id <> $2 ORDER BY id DESC LIMIT 1",
      [room.roomId, candidateId],
    )).rows[0].id as string;
    const searches = countLog(`pipeline-enqueue fetch.search ${previewId} priority=1`);
    const visions = countLog(`pipeline-enqueue process.vision ${previewId} priority=1`);
    const siteJobs = countLog("pipeline-enqueue fetch.site");
    realtime.send({ type: "previewing", candidateId: previewId });
    await waitFor(() => countLog("pipeline-enqueue fetch.site") > siteJobs, 8_000, () => server.logs());
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(countLog(`pipeline-enqueue fetch.search ${previewId} priority=1`)).toBe(searches);
    expect(countLog(`pipeline-enqueue process.vision ${previewId} priority=1`)).toBe(visions);
    realtime.send({ type: "previewing", candidateId: null });
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
    done: number;
  }> {
    return realtime.frames().map((raw) => JSON.parse(raw) as {
      type: string;
      outstanding?: { fetch: number; process: number };
      inFlight?: { fetch: number; process: number };
      done?: number;
    }).filter((frame): frame is {
      type: "pipeline";
      outstanding: { fetch: number; process: number };
      inFlight: { fetch: number; process: number };
      done: number;
    } => frame.type === "pipeline" && Boolean(frame.outstanding && frame.inFlight) &&
      typeof frame.done === "number");
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
