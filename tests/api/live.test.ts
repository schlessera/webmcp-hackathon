import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { attachWebSocket } from "../../apps/server/src/ws.ts";
import { submitCommand } from "../../apps/server/src/engine.ts";
import { setEnrichFetch } from "../../apps/server/src/enrich/index.ts";
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
  });
});

describe("need-triggered lookup and realtime facts", () => {
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
         extras = jsonb_build_object('website', 'https://' || id || '.example/')
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
      expect(realtime.frames().some((raw) => {
        const frame = JSON.parse(raw) as { type: string; pending?: string[] };
        return frame.type === "lookups" && frame.pending?.length === 0;
      })).toBe(true);

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
