import { describe, expect, it } from "vitest";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { BUDGETS, TOOLS, SubmitRequirementInput, validReadInput, type CandidateDossier, type SpatialContextResult } from "@webmcp-hackathon/contracts";
import { ContextPager, inspectResult } from "@webmcp-hackathon/contracts";
import { encodeToolResult } from "../../apps/web/src/webmcp.ts";
import { compactSchema } from "../../packages/contracts/src/compact-schema.ts";

function context(): SpatialContextResult {
  return {
    ok: true, revision: 3, phase: "gathering",
    identity: { participantId: "p_me", displayName: "Alain", role: "organizer" },
    goal: "lunch tomorrow", timezone: "Europe/Berlin", activeStepId: "s1",
    scope: { scopeId: "scope_1", area: { kind: "circle", center: { lat: 52.5, lng: 13.4 }, radiusM: 800 }, transport: ["walk"], category: "food" },
    feasibility: { state: "feasible", eligible: 180, likely: 8, uncertain: 118, unlikely: 1, excluded: 36 },
    candidates: Array.from({ length: 343 }, (_, i) => ({
      candidateId: `pl_${String(i).padStart(3, "0")}`, name: `Place ${i}`, category: i % 2 ? "cafe" : "restaurant",
      location: { lat: 52.5, lng: 13.4 }, priceLevel: null, walkMin: 5 + i,
      eligibility: i < 180 ? "eligible" : i < 188 ? "likely" : i < 306 ? "uncertain" : i < 307 ? "unlikely" : "excluded",
      why: "open Wed 12:00–14:00", imageCount: 1,
    })),
    total: 343, matching: 180, likely: 8, facets: [], privateEffects: [], participants: [], proposals: [],
    activeNeeds: [{ id: "req_time", criterionId: "open:time", ownerId: "p_me", label: "open tomorrow", active: true, visibility: "shared", hardness: "hard", ruledOut: 36, wouldReturn: 0, unknown: 118,
      window: { start: "2026-09-09T12:00:00+02:00", end: "2026-09-09T14:00:00+02:00" } }],
    outstanding: [{ type: "evaluation_request", candidateIds: ["pl_342"], issuedAtRevision: 3 }],
  };
}

describe("candidate snapshot paging", () => {
  it("keeps counts coherent through budget-limited pages of all 343 candidates", () => {
    const pager = new ContextPager();
    let page = pager.read("participant-token", {}, context(), 2600);
    const seen: string[] = [];
    while (page.ok) {
      expect(JSON.stringify(page).length).toBeLessThanOrEqual(2600);
      expect(page.page.returned).toBe(page.candidates.length);
      expect(page.page.offset + page.page.returned + page.page.remaining).toBe(343);
      expect(page.page.remainingEligible).toBe(180 - [...seen, ...page.candidates.map((c) => c.candidateId)].filter((id) => Number(id.slice(3)) < 180).length);
      expect(page.activeNeeds[0].requirementId).toBe("req_time");
      expect(page.outstanding[0]).toMatchObject({ candidateIds: ["pl_342"] });
      expect(JSON.parse(encodeToolResult(page, 2600).content[0].text)).toEqual(JSON.parse(JSON.stringify(page)));
      seen.push(...page.candidates.map((c) => c.candidateId));
      if (!page.page.nextCursor) break;
      page = pager.read("participant-token", { cursor: page.page.nextCursor }, undefined, 2600);
    }
    expect(page.ok).toBe(true);
    expect(seen).toHaveLength(343);
    expect(new Set(seen).size).toBe(343);
  });

  it("continues the original snapshot after concurrent page-store changes and replays the same cursor", () => {
    const pager = new ContextPager();
    const live = context();
    const first = pager.read("owner", { limit: 2 }, live);
    if (!first.ok) throw new Error(first.error.message);
    const cursor = first.page.nextCursor!;
    live.revision = 5;
    live.candidates.reverse();
    live.activeNeeds[0].label = "a different need";
    const next = pager.read("owner", { cursor });
    expect(next).toEqual(pager.read("owner", { cursor }));
    expect(next).toMatchObject({ revision: 3, candidates: [{ candidateId: "pl_002" }, { candidateId: "pl_003" }], activeNeeds: [{ label: "open tomorrow" }] });
  });

  it("binds cursors to the participant and document, expires snapshots, and rejects changed query arguments", () => {
    let now = 1000;
    const pager = new ContextPager(() => now);
    const first = pager.read("owner", {}, context());
    if (!first.ok) throw new Error(first.error.message);
    const cursor = first.page.nextCursor!;
    expect(pager.read("owner", { cursor, limit: 4 }).ok).toBe(false);
    expect(new ContextPager().read("owner", { cursor }).ok).toBe(false);
    now += 5 * 60_000;
    expect(pager.read("owner", { cursor }).ok).toBe(false);
    const fresh = pager.read("owner", {}, context());
    if (!fresh.ok) throw new Error(fresh.error.message);
    expect(pager.read("someone-else", { cursor: fresh.page.nextCursor }).ok).toBe(false);
  });

  it("searches names and categories with exact filtered totals", () => {
    const result = new ContextPager().read("owner", { query: "cafe", eligibility: "eligible", limit: 20 }, context());
    if (!result.ok) throw new Error(result.error.message);
    expect(result.page.total).toBe(90);
    expect(result.candidates.every((c) => c.category === "cafe" && c.eligibility === "eligible")).toBe(true);
    expect(result.classification.uncertain).toContain("not a confirmed failure");
    expect(result.ranking.walkMin).toContain("Straight-line estimate");
  });

  it("rejects malformed projection inputs even through the shim", () => {
    expect(validReadInput("sync_session", {})).toBe(true);
    expect(validReadInput("sync_session", { passive: false })).toBe(false);
    expect(validReadInput("sync_session", null)).toBe(false);
    for (const args of [{ limit: 0 }, { limit: 1.2 }, { cursor: "" }, { query: 7 }, { eligibility: "best" }, { extra: true }]) {
      expect(validReadInput("get_spatial_context", args)).toBe(false);
    }
    expect(validReadInput("inspect_candidates", { candidateIds: ["p"], intent: "open" })).toBe(false);
    expect(validReadInput("inspect_candidates", { candidateIds: ["p"], keys: ["vegetarian-options"], details: ["evidence"] })).toBe(true);
  });
});

function dossier(id: string): CandidateDossier {
  return {
    candidateId: id, name: "A long but valid restaurant name ".repeat(4), category: "restaurant", mapRevision: 12,
    location: { lat: 52.5, lng: 13.4 }, priceLevel: null, hours: [{ day: "Wed", open: "12:00", close: "14:00" }],
    timezone: "Europe/Berlin", asOf: "2026-09-08T10:00:00.000Z",
    attributes: ["wifi", "vegetarian-options", "vegan-options"].map((key) => ({ key, status: "verified_true", source: "osm:node/123", observedAt: "2026-08-31T00:00:00Z", confidence: 1, note: "Recorded source statement", sourceUrl: "https://example.com/menu" })),
    needs: [{ requirementId: "req_veg", criterionId: "vegetarian-options", label: "vegetarian options", verdict: "yes" }],
    images: [{ url: "/private-photo", width: 2, height: 2, source: "test" }],
  };
}

describe("actionable dossier output", () => {
  it("preserves requested order, need verdicts, map revisions and provenance for three records", () => {
    const input = { candidateIds: ["c3", "c1", "c2"], keys: ["vegetarian-options", "missing"], details: ["evidence", "hours"] as const };
    const result = inspectResult({ ok: true, revision: 5, candidates: [dossier("c1"), dossier("c2"), dossier("c3")] }, { ...input, details: [...input.details] });
    const encoded = encodeToolResult(result, BUDGETS.inspectResultMax);
    expect(encoded.truncated).toBe(false);
    const body = JSON.parse(encoded.content[0].text);
    expect(body.candidates.map((c: CandidateDossier) => c.candidateId)).toEqual(input.candidateIds);
    for (const candidate of body.candidates) {
      expect(candidate).toMatchObject({ mapRevision: 12, timezone: "Europe/Berlin", needs: [{ requirementId: "req_veg", verdict: "yes" }] });
      expect(candidate.attributes[0]).toMatchObject({ key: "vegetarian-options", source: "osm:node/123", observedAt: "2026-08-31T00:00:00Z", sourceUrl: "https://example.com/menu" });
      expect(candidate.attributes[1]).toMatchObject({ key: "missing", status: "unknown" });
      expect(candidate).not.toHaveProperty("images");
      expect(candidate).not.toHaveProperty("location");
      expect(candidate.hours).toHaveLength(1);
    }
  });

  it("defaults to active needs and returns attribute discovery without losing private aggregates", () => {
    const d = dossier("c1");
    d.attributes.forEach((a) => a.status = "unknown");
    d.needs!.push({ private: true, verdict: "unknown" });
    const result = inspectResult({ ok: true, revision: 5, candidates: [d] }, { candidateIds: ["c1"] });
    if (!result.ok) throw new Error(result.error.message);
    expect(result.candidates[0].attributes).toEqual([expect.objectContaining({ key: "vegetarian-options" })]);
    expect(result.candidates[0].needs.at(-1)).toEqual({ private: true, verdict: "unknown" });
    expect(result.candidates[0].availableKeys).toContain("wifi");
  });
});

describe("discovery schema equivalence", () => {
  const ajv = new Ajv({ strict: false });
  addFormats(ajv);
  const original = ajv.compile(SubmitRequirementInput);
  const compact = ajv.compile(TOOLS.find((t) => t.name === "submit_requirement")!.inputSchema);
  const base = { baseRevision: 3, visibility: "shared", hardness: "hard", delegation: { mode: "locked" } };

  it("keeps enum, referent and closed-object validation after deduplication", () => {
    const referents = [{ kind: "self" }, { kind: "landmark", landmarkId: "station" }, { kind: "point", lat: 52, lng: 13 }, { kind: "participant", participantId: "p", stepId: "s2" }];
    for (const dimension of ["radius_m", "walk_min", "travel_min", "wrong"]) {
      for (const referent of [...referents, ...referents.map((r) => ({ ...r, bad: true }))]) {
        for (const mode of [undefined, "walk", "transit", "teleport"]) {
          const input = { ...base, payload: { kind: "scope", dimension, max: 20, referent, ...(mode ? { mode } : {}) } };
          expect(compact(input)).toBe(original(input));
        }
      }
    }
    for (const tool of TOOLS) expect(() => ajv.compile(tool.inputSchema)).not.toThrow();
    expect(JSON.stringify(TOOLS.find((t) => t.name === "submit_requirement")!.inputSchema).length).toBeLessThan(6500);
  });

  it("advertises passive reads and explicit writes honestly", () => {
    for (const name of ["get_spatial_context", "inspect_candidates", "sync_session"]) expect(TOOLS.find((t) => t.name === name)!.annotations.readOnlyHint).toBe(true);
    for (const name of ["focus_destination", "look_up_places", "submit_requirement"]) expect(TOOLS.find((t) => t.name === name)!.annotations.readOnlyHint).toBe(false);
  });

  it("does not weaken sibling constraints when shortening a string union", () => {
    for (const constraint of [{ type: "number" }, { enum: ["a"] }]) {
      const schema = { ...constraint, anyOf: [{ type: "string", const: "a" }, { type: "string", const: "b" }] };
      const original = ajv.compile(schema);
      const compact = ajv.compile(compactSchema(schema));
      for (const value of ["a", "b", "c", 1, null]) expect(compact(value)).toBe(original(value));
    }
    expect(JSON.stringify(TOOLS).length).toBeLessThan(30_000);
  });
});
