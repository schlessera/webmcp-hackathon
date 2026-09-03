import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  lookupNow,
  setEnrichFetch,
} from "../../apps/server/src/enrich/index.ts";
import { setTransport } from "../../apps/server/src/nl/openai.ts";
import {
  apiPost,
  createTestRoom,
  startServer,
  type TestRoom,
  type TestServer,
} from "./helpers.ts";

describe("forced evidence re-reads", () => {
  let server: TestServer;
  let room: TestRoom;
  let dogRequirementRevision = 0;

  beforeAll(async () => {
    server = await startServer();
    room = await createTestRoom(server.baseUrl);
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
          delegation: { mode: "locked" },
          payload: {
            kind: "attribute",
            key: "dog-friendly",
            expect: "verified_true",
          },
        },
      },
    );
    expect(submitted.body.ok).toBe(true);
    dogRequirementRevision = submitted.body.revision;
  });

  afterAll(async () => {
    await room.pool.query(
      "DELETE FROM enrichments WHERE osm_ref LIKE $1",
      [`node/reread-%-${room.roomId}`],
    );
    await room.cleanup();
    await server.stop();
  });

  beforeEach(() => {
    vi.stubEnv("ENRICH_NETWORK", "1");
    vi.stubEnv("INFER", "1");
    vi.stubEnv("OPENAI_API_KEY", "test");
  });

  afterEach(() => {
    setEnrichFetch(null);
    setTransport(null);
    vi.unstubAllEnvs();
  });

  function candidateId(letter: "a" | "b"): string {
    return `place_${letter}_${room.roomId.slice("room_test_".length)}`;
  }

  async function contextCandidate(id: string) {
    const response = await apiPost<{
      ok: boolean;
      revision: number;
      candidates: Array<{ candidateId: string; eligibility: string }>;
    }>(server.baseUrl, "/api/spatial/context", room.tokens.org, {});
    expect(response.body.revision).toBeGreaterThanOrEqual(dogRequirementRevision);
    return response.body.candidates.find((candidate) => candidate.candidateId === id);
  }

  async function dossierFact(id: string) {
    const response = await apiPost<{
      candidates: Array<{
        attributes: Array<{
          key: string;
          status: string;
          source: string;
          confidence: number;
          note?: string;
        }>;
      }>;
    }>(server.baseUrl, "/api/spatial/inspect", room.tokens.org, { candidateIds: [id] });
    return response.body.candidates[0].attributes.find((attribute) =>
      attribute.key === "dog-friendly"
    );
  }

  function scriptedSite(): void {
    setEnrichFetch(async (url) => {
      if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
      return new Response(
        `<html><head><meta name="description" content="Pooches are welcome on our terrace. We do not allow dogs inside."></head></html>`,
        { status: 200, headers: { "content-type": "text/html" } },
      );
    });
  }

  it("keeps both a claim and the place eligibility when a forced pass abstains", async () => {
    const id = candidateId("a");
    const osmRef = `node/reread-abstain-${room.roomId}`;
    const website = "https://reread-abstain.example/";
    await room.pool.query(
      `UPDATE candidates
          SET osm_ref = $2,
              extras = $3::jsonb,
              attributes = '[{"key":"dog-friendly","status":"unknown","source":"osm:dog","confidence":0}]'::jsonb
        WHERE id = $1`,
      [id, osmRef, JSON.stringify({ website })],
    );
    scriptedSite();
    let read = 0;
    setTransport(async (body) => {
      const matrix = JSON.parse((body.input as Array<{ content: string }>)[0].content) as {
        places: Array<{ candidateId: string; texts: Array<{ text: string }> }>;
      };
      const place = matrix.places[0];
      const sourceIndex = place.texts.findIndex((text) => text.text.includes("Pooches are welcome"));
      const first = read++ === 0;
      return {
        output: [{
          type: "message",
          content: [{
            type: "output_text",
            text: JSON.stringify({
              claims: [{
                candidateId: place.candidateId,
                criterionId: "dog-friendly",
                lean: first ? "yes" : "abstain",
                confidence: first ? 0.9 : 0,
                evidence: first ? "Pooches are welcome on our terrace" : "",
                sourceIndex: first ? sourceIndex : null,
                explicit: false,
              }],
            }),
          }],
        }],
      };
    });
    const target = { candidateId: id, osmRef, website };

    await lookupNow(room.pool, room.roomId, [target], { keys: ["dog-friendly"], intent: "interactive" });
    const factBefore = await dossierFact(id);
    const eligibilityBefore = await contextCandidate(id);
    const storedBefore = (await room.pool.query(
      "SELECT inferred->'dog-friendly' AS fact FROM enrichments WHERE osm_ref = $1",
      [osmRef],
    )).rows[0].fact;
    expect(factBefore).toMatchObject({
      status: "likely_true",
      source: expect.stringMatching(/^infer:.*:venue_site$/),
      note: "Pooches are welcome on our terrace",
    });
    expect(eligibilityBefore).toMatchObject({ eligibility: "likely" });

    await lookupNow(room.pool, room.roomId, [target], { keys: ["dog-friendly"], intent: "interactive" });
    const factAfter = await dossierFact(id);
    const eligibilityAfter = await contextCandidate(id);
    const storedAfter = (await room.pool.query(
      "SELECT inferred->'dog-friendly' AS fact FROM enrichments WHERE osm_ref = $1",
      [osmRef],
    )).rows[0].fact;

    expect(storedAfter).toEqual(storedBefore);
    expect(factAfter).toEqual(factBefore);
    expect(eligibilityAfter?.eligibility).toBe(eligibilityBefore?.eligibility);
  });

  it("lets an explicit contradiction from the recorded venue site flip the fact", async () => {
    const id = candidateId("b");
    const osmRef = `node/reread-contradiction-${room.roomId}`;
    // Numeric fixture host keeps the injected reader's SSRF-safe transport
    // URL identical to the recorded venue URL, satisfying own-site provenance.
    const website = "https://93.184.216.34/reread-contradiction";
    await room.pool.query(
      `UPDATE candidates
          SET osm_ref = $2,
              extras = $3::jsonb,
              attributes = '[{"key":"dog-friendly","status":"unknown","source":"osm:dog","confidence":0}]'::jsonb
        WHERE id = $1`,
      [id, osmRef, JSON.stringify({ website })],
    );
    scriptedSite();
    let read = 0;
    setTransport(async (body) => {
      const matrix = JSON.parse((body.input as Array<{ content: string }>)[0].content) as {
        places: Array<{ candidateId: string; texts: Array<{ text: string }> }>;
      };
      const place = matrix.places[0];
      const contradicts = read++ > 0;
      const evidence = contradicts
        ? "We do not allow dogs inside"
        : "Pooches are welcome on our terrace";
      return {
        output: [{
          type: "message",
          content: [{
            type: "output_text",
            text: JSON.stringify({
              claims: [{
                candidateId: place.candidateId,
                criterionId: "dog-friendly",
                lean: contradicts ? "no" : "yes",
                confidence: 0.9,
                evidence,
                sourceIndex: place.texts.findIndex((text) => text.text.includes(evidence)),
                explicit: contradicts,
              }],
            }),
          }],
        }],
      };
    });
    const target = { candidateId: id, osmRef, website };

    await lookupNow(room.pool, room.roomId, [target], { keys: ["dog-friendly"], intent: "interactive" });
    expect(await dossierFact(id)).toMatchObject({ status: "likely_true" });

    await room.pool.query(
      "UPDATE enrichments SET website_fetched_at = now() - interval '11 minutes' WHERE osm_ref = $1",
      [osmRef],
    );
    await lookupNow(room.pool, room.roomId, [target], { keys: ["dog-friendly"], intent: "interactive" });
    expect(await dossierFact(id)).toMatchObject({
      status: "verified_false",
      source: "web:93.184.216.34",
      confidence: 0.72,
      note: "We do not allow dogs inside",
    });
    expect((await room.pool.query(
      "SELECT inferred->'dog-friendly' AS fact FROM enrichments WHERE osm_ref = $1",
      [osmRef],
    )).rows[0].fact).toMatchObject({
      lean: "no",
      explicit: true,
      source: "web:93.184.216.34",
    });
  });
});
