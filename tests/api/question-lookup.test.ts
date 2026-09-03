import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { questionKey } from "@webmcp-hackathon/contracts";
import {
  apiPost,
  createTestRoom,
  openRealtime,
  startServer,
  type TestRoom,
  type TestServer,
} from "./helpers.ts";

/** U1/privacy over HTTP+WS: free text is looked up per place and private copy never enters a shared lookup frame. */
describe("question-criterion lookup over the API", () => {
  let server: TestServer;
  let room: TestRoom;

  beforeAll(async () => {
    server = await startServer({
      entrypoint: "tests/api/fixtures/criteria-server.ts",
      env: { ENRICH_NETWORK: "1", INFER: "1", OPENAI_API_KEY: "test" },
    });
    room = await createTestRoom(server.baseUrl);
    const candidates = (await room.pool.query(
      "SELECT id, name FROM candidates WHERE room_id = $1 ORDER BY name",
      [room.roomId],
    )).rows as Array<{ id: string; name: string }>;
    for (const candidate of candidates) {
      await room.pool.query(
        `UPDATE candidates
            SET osm_ref = $2,
                extras = $3::jsonb,
                attributes = '[]'::jsonb
          WHERE id = $1`,
        [
          candidate.id,
          `criteria/${room.roomId}/${candidate.name.toLowerCase()}`,
          JSON.stringify({ website: `https://criteria.example/${candidate.name.toLowerCase()}` }),
        ],
      );
    }
  });

  afterAll(async () => {
    await room.cleanup();
    await server.stop();
  });

  it("makes supported free wifi likely, leaves silence unknown, and cites the source", async () => {
    const submitted = await apiPost<{ ok: boolean; revision: number }>(
      server.baseUrl,
      "/api/commands",
      room.tokens.org,
      {
        type: "SubmitRequirement",
        input: {
          baseRevision: 0,
          visibility: "shared",
          hardness: "hard",
          delegation: { mode: "approval_required" },
          payload: { kind: "text", text: "free wifi" },
        },
      },
    );
    expect(submitted.body.ok).toBe(true);
    const key = questionKey("free wifi");
    await waitFor(async () => {
      const row = (await room.pool.query(
        "SELECT inferred FROM enrichments WHERE osm_ref LIKE $1",
        [`criteria/${room.roomId}/alpha`],
      )).rows[0];
      return Boolean(row?.inferred?.[key]?.lean);
    });

    const context = await apiPost<{
      candidates: Array<{ name: string; eligibility: string }>;
    }>(server.baseUrl, "/api/spatial/context", room.tokens.org, {});
    expect(context.body.candidates.find((candidate) => candidate.name === "Alpha"))
      .toMatchObject({ eligibility: "likely" });
    expect(context.body.candidates.find((candidate) => candidate.name === "Beta"))
      .toMatchObject({ eligibility: "uncertain" });

    const alphaId = String((await room.pool.query(
      "SELECT id FROM candidates WHERE room_id = $1 AND name = 'Alpha'",
      [room.roomId],
    )).rows[0].id);
    const dossier = await apiPost<{
      candidates: Array<{ attributes: Array<Record<string, unknown>> }>;
    }>(server.baseUrl, "/api/spatial/inspect", room.tokens.org, { candidateIds: [alphaId] });
    expect(dossier.body.candidates[0].attributes.find((attribute) => attribute.key === key))
      .toMatchObject({
        key,
        label: "free wifi",
        status: "likely_true",
        note: "Free wireless internet is available",
        sourceUrl: "https://criteria.example/alpha",
      });
  });

  it("omits a private text need's sentence from the shared lookups frame", async () => {
    const privateRoom = await createTestRoom(server.baseUrl);
    try {
      await privateRoom.pool.query(
        `UPDATE candidates
            SET osm_ref = 'criteria/' || $1 || '/' || lower(name),
                extras = jsonb_build_object('website', 'https://criteria.example/' || lower(name)),
                attributes = '[]'::jsonb
          WHERE room_id = $1`,
        [privateRoom.roomId],
      );
      const realtime = await openRealtime(server.baseUrl, privateRoom.tokens.joe);
      try {
        const submitted = await apiPost<{ ok: boolean }>(
          server.baseUrl,
          "/api/commands",
          privateRoom.tokens.org,
          {
            type: "SubmitRequirement",
            input: {
              baseRevision: 0,
              visibility: "application-private",
              hardness: "hard",
              delegation: { mode: "approval_required" },
              payload: { kind: "text", text: "private rooftop password" },
            },
          },
        );
        expect(submitted.body.ok).toBe(true);
        await waitFor(async () => realtime.frames().some((raw) => {
          const frame = JSON.parse(raw) as { type: string; pending?: string[] };
          return frame.type === "lookups" && Boolean(frame.pending?.length);
        }));
        const lookupFrames = realtime.frames()
          .map((raw) => JSON.parse(raw) as Record<string, unknown>)
          .filter((frame) => frame.type === "lookups" && (frame.pending as unknown[])?.length);
        expect(lookupFrames.length).toBeGreaterThan(0);
        for (const frame of lookupFrames) {
          expect(frame).toMatchObject({ reason: { kind: "need" } });
          expect(frame.reason).not.toHaveProperty("label");
          expect(JSON.stringify(frame)).not.toContain("private rooftop password");
        }
      } finally {
        realtime.close();
      }
    } finally {
      await privateRoom.cleanup();
    }
  });

  it("keeps application-private question copy with its owner across rooms sharing a place", async () => {
    const privateRoom = await createTestRoom(server.baseUrl);
    const otherRoom = await createTestRoom(server.baseUrl);
    const sentence = "Does the owner still date my ex?";
    const key = questionKey(sentence);
    const osmRef = `criteria/private-boundary-${privateRoom.roomId}`;
    const peerRealtime = await openRealtime(server.baseUrl, privateRoom.tokens.joe);
    const otherRealtime = await openRealtime(server.baseUrl, otherRoom.tokens.sarah);
    try {
      for (const testRoom of [privateRoom, otherRoom]) {
        await testRoom.pool.query(
          `UPDATE candidates
              SET osm_ref = $2,
                  extras = '{"website":"https://criteria.example/alpha"}'::jsonb,
                  attributes = '[]'::jsonb
            WHERE room_id = $1 AND name = 'Alpha'`,
          [testRoom.roomId, osmRef],
        );
      }
      const submitted = await apiPost<{ ok: boolean }>(
        server.baseUrl,
        "/api/commands",
        privateRoom.tokens.org,
        {
          type: "SubmitRequirement",
          input: {
            baseRevision: 0,
            visibility: "application-private",
            hardness: "hard",
            delegation: { mode: "approval_required" },
            payload: { kind: "text", text: sentence },
          },
        },
      );
      expect(submitted.body.ok).toBe(true);
      await waitFor(async () => {
        const entry = (await privateRoom.pool.query(
          "SELECT inferred->$2 AS entry FROM enrichments WHERE osm_ref = $1",
          [osmRef, key],
        )).rows[0]?.entry;
        return entry?.lean === "yes";
      });
      await waitFor(() => peerRealtime.frames().some((raw) => {
        const frame = JSON.parse(raw) as { type?: string };
        return frame.type === "facts";
      }));

      const alphaId = async (testRoom: TestRoom) => String((await testRoom.pool.query(
        "SELECT id FROM candidates WHERE room_id = $1 AND name = 'Alpha'",
        [testRoom.roomId],
      )).rows[0].id);
      const inspect = (testRoom: TestRoom, token: string, candidateId: string) => apiPost<{
        candidates: Array<{
          attributes: Array<Record<string, unknown>>;
          needs: Array<Record<string, unknown>>;
        }>;
      }>(server.baseUrl, "/api/spatial/inspect", token, { candidateIds: [candidateId] });

      const [owner, peer, other] = await Promise.all([
        inspect(privateRoom, privateRoom.tokens.org, await alphaId(privateRoom)),
        inspect(privateRoom, privateRoom.tokens.joe, await alphaId(privateRoom)),
        inspect(otherRoom, otherRoom.tokens.sarah, await alphaId(otherRoom)),
      ]);

      expect(owner.body.candidates[0].attributes.find((attribute) => attribute.key === key))
        .toMatchObject({ key, label: sentence, status: "likely_true" });
      expect(peer.body.candidates[0].attributes.some((attribute) => attribute.key === key)).toBe(false);
      expect(other.body.candidates[0].attributes.some((attribute) => attribute.key === key)).toBe(false);
      expect(peer.body.candidates[0].needs).toContainEqual({ private: true, verdict: "likely" });
      expect(peer.raw).not.toContain(sentence);
      expect(other.raw).not.toContain(sentence);
      expect(JSON.stringify(peerRealtime.frames())).not.toContain(sentence);
      expect(JSON.stringify(otherRealtime.frames())).not.toContain(sentence);

      const cached = (await privateRoom.pool.query(
        "SELECT inferred->$2 AS entry FROM enrichments WHERE osm_ref = $1",
        [osmRef, key],
      )).rows[0].entry as Record<string, unknown>;
      expect(cached).toMatchObject({
        key,
        lean: "yes",
        confidence: 0.6,
        evidence: "Free wireless internet is available",
        sourceUrl: "https://criteria.example/alpha",
      });
      expect(cached).not.toHaveProperty("question");
      expect(cached).not.toHaveProperty("label");
    } finally {
      peerRealtime.close();
      otherRealtime.close();
      await privateRoom.pool.query("DELETE FROM enrichments WHERE osm_ref = $1", [osmRef]);
      await privateRoom.cleanup();
      await otherRoom.cleanup();
    }
  });
});

async function waitFor(check: () => Promise<boolean> | boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect(await check()).toBe(true);
}
