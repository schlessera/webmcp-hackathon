import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  INFERENCE_PRUNE_DAYS,
  MAX_QUESTION_INFERENCES,
  saveInferences,
} from "../../apps/server/src/enrich/index.ts";
import { DATABASE_URL } from "./helpers.ts";

/** C7: every inference upsert bounds the shared JSON blob itself. */
describe("inference-cache pruning", () => {
  let pool: pg.Pool;
  const refs: string[] = [];

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    if (refs.length > 0) await pool.query("DELETE FROM enrichments WHERE osm_ref = ANY($1)", [refs]);
    await pool.end();
  });

  async function seededRow(): Promise<{ osmRef: string; keys: string[]; openKeys: string[] }> {
    const osmRef = `test/prune-${randomBytes(8).toString("hex")}`;
    refs.push(osmRef);
    const now = Date.now();
    const keys = Array.from({ length: 70 }, (_, index) =>
      `q:${index.toString(16).padStart(40, "0")}`
    );
    const inferred = Object.fromEntries(keys.map((key, index) => [key, {
      key,
      lean: "yes",
      confidence: 0.5,
      evidence: "direct supporting words",
      source: "infer:test",
      observedAt: new Date(now - index * 60 * 60_000).toISOString(),
    }]));
    const openKeys = Array.from({ length: 70 }, (_, index) =>
      `open:2026-09-${String(index + 1).padStart(2, "0")}T12:00:00Z-${index}`
    );
    for (const [index, key] of openKeys.entries()) {
      inferred[key] = {
        key,
        lean: "yes",
        confidence: 0.5,
        evidence: "legacy time-window evidence",
        source: "infer:test",
        observedAt: new Date(now - index * 60_000).toISOString(),
      };
    }
    inferred.delivery = {
      key: "delivery", lean: "yes", confidence: 0.5,
      evidence: "old delivery evidence", source: "infer:test",
      observedAt: new Date(now - (INFERENCE_PRUNE_DAYS + 1) * 24 * 60 * 60_000).toISOString(),
    };
    inferred.takeaway = {
      key: "takeaway", lean: "yes", confidence: 0.5,
      evidence: "fresh takeaway evidence", source: "infer:test",
      observedAt: new Date(now - 10 * 24 * 60 * 60_000).toISOString(),
    };
    await pool.query(
      `INSERT INTO enrichments (osm_ref, fetched_at, expires_at, inferred)
       VALUES ($1, now(), now() + interval '7 days', $2::jsonb)`,
      [osmRef, JSON.stringify(inferred)],
    );
    return { osmRef, keys, openKeys };
  }

  async function triggerUpsert(osmRef: string): Promise<Record<string, unknown>> {
    const observedAt = new Date().toISOString();
    await saveInferences(pool, [{
      osmRef,
      criteria: [{ id: "dog-friendly", kind: "key", key: "dog-friendly", label: "dogs welcome" }],
      claims: [{
        candidateId: "c1", osmRef, criterionId: "dog-friendly", key: "dog-friendly",
        lean: "yes", status: "likely_true", confidence: 0.5,
        evidence: "Dogs are welcome here", source: "infer:test", sourceIndex: 0,
        observedAt, explicit: false,
      }],
      answeredCriterionIds: ["dog-friendly"],
      observedAt,
    }]);
    return (await pool.query("SELECT inferred FROM enrichments WHERE osm_ref = $1", [osmRef]))
      .rows[0].inferred as Record<string, unknown>;
  }

  it("keeps only the newest 64 question entries after an upsert", async () => {
    const { osmRef, keys } = await seededRow();
    const inferred = await triggerUpsert(osmRef);
    const questionKeys = Object.keys(inferred).filter((key) => key.startsWith("q:"));
    expect(questionKeys).toHaveLength(MAX_QUESTION_INFERENCES);
    expect(questionKeys).toEqual(expect.arrayContaining(keys.slice(0, MAX_QUESTION_INFERENCES)));
    expect(questionKeys).not.toContain(keys[MAX_QUESTION_INFERENCES]);
  });

  it("removes entries older than 30 days while retaining fresh vocabulary entries", async () => {
    const { osmRef } = await seededRow();
    const inferred = await triggerUpsert(osmRef);
    expect(inferred).not.toHaveProperty("delivery");
    expect(inferred).toHaveProperty("takeaway");
    expect(inferred).toHaveProperty("dog-friendly");
  });

  it("caps legacy time-window inference keys", async () => {
    const { osmRef, openKeys } = await seededRow();
    const inferred = await triggerUpsert(osmRef);
    const retained = Object.keys(inferred).filter((key) => key.startsWith("open:"));
    expect(retained).toHaveLength(MAX_QUESTION_INFERENCES);
    expect(retained).toEqual(expect.arrayContaining(openKeys.slice(0, MAX_QUESTION_INFERENCES)));
  });
});
