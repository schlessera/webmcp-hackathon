import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { areaById } from "@webmcp-hackathon/contracts";
import { planPreview, resetPlanCaches } from "../../apps/server/src/nl/plan.ts";
import { setTransport } from "../../apps/server/src/nl/openai.ts";

/**
 * The goal a person types before a room exists (UNDERSTANDING-ARCH.md §10).
 *
 * Stage A is scripted here — one golden draft per corpus row — so the mapping
 * from a read goal to a step class, a title, a time window and pending needs
 * is checked without a model. What the model itself does with these sentences
 * is the live check, reported separately.
 */

// The preview is gated on a configured model; the wire below is scripted, so
// the key only has to exist.
process.env.LLM_PROVIDER = "openai";
process.env.OPENAI_API_KEY ||= "scripted-only";

const area = areaById("berlin-mitte")!;
const NOW = new Date("2026-09-03T10:00:00+02:00");

interface CorpusRow {
  id: string;
  text: string;
  expect: { placeClass: string; needs: string[] };
  tags: string[];
}

const corpusPath = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "nl-corpus.jsonl");
const planRows = readFileSync(corpusPath, "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line) as CorpusRow)
  .filter((row) => row.tags.includes("plan"));

const concept = (overrides: Record<string, unknown>) => ({
  role: "quality",
  surface: "",
  polarity: "include",
  hardness: "hard",
  quantityValue: null,
  quantityUnit: null,
  quantityBound: null,
  mode: null,
  referentKind: null,
  referentName: null,
  attributeKey: null,
  values: [],
  windowStart: null,
  windowEnd: null,
  phrase: null,
  topic: null,
  unresolved: null,
  gist: "",
  ...overrides,
});

const lunch = concept({
  role: "time",
  surface: "lunch",
  windowStart: "2026-09-03T12:00:00+02:00",
  windowEnd: "2026-09-03T14:00:00+02:00",
  phrase: "lunch",
  gist: "lunch",
});
const dinner = concept({
  role: "time",
  surface: "dinner",
  windowStart: "2026-09-03T18:00:00+02:00",
  windowEnd: "2026-09-03T21:00:00+02:00",
  phrase: "dinner",
  gist: "dinner",
});
const dogs = concept({
  role: "attribute",
  surface: "with the dogs",
  attributeKey: "dog-friendly",
  gist: "dogs welcome",
});
const quietRoom = concept({
  role: "quality",
  surface: "a quiet room",
  gist: "quiet room",
});

/** One golden stage-A answer per corpus row. */
const DRAFTS: Record<string, { placeClass: string; concepts: unknown[] }> = {
  "plan-001": { placeClass: "food", concepts: [lunch] },
  "plan-002": { placeClass: "food", concepts: [] },
  "plan-003": { placeClass: "park", concepts: [dogs] },
  "plan-004": {
    placeClass: "park",
    concepts: [concept({ ...dogs, surface: "mit den Hunden" })],
  },
  "plan-005": { placeClass: "food", concepts: [dinner] },
  "plan-006": {
    placeClass: "food",
    concepts: [concept({ ...dinner, surface: "Abendessen", phrase: "Abendessen" })],
  },
  "plan-007": { placeClass: "coworking", concepts: [quietRoom] },
  "plan-008": {
    placeClass: "coworking",
    concepts: [concept({ ...quietRoom, surface: "einem ruhigen Raum", gist: "ruhiger Raum" })],
  },
};

function scripted(draft: { placeClass: string; concepts: unknown[] }): void {
  setTransport(async () => ({
    output: [{
      type: "message",
      content: [{
        type: "output_text",
        text: JSON.stringify({ intent: "plan", confidence: 1, reply: null, ...draft }),
      }],
    }],
  }));
}

afterEach(() => {
  setTransport(null);
  resetPlanCaches();
});

describe("plan preview corpus", () => {
  it("covers the four design sentences in both languages", () => {
    expect(planRows).toHaveLength(8);
    expect(planRows.filter((row) => row.id.endsWith("2") || row.id.endsWith("4") ||
      row.id.endsWith("6") || row.id.endsWith("8"))).toHaveLength(4);
  });

  for (const row of planRows) {
    it(`${row.id}: reads the goal into one step`, async () => {
      scripted(DRAFTS[row.id]);
      const preview = await planPreview(row.text, area, NOW);
      expect(preview.offline).toBe(false);
      expect(preview.steps).toHaveLength(1);
      const step = preview.steps[0];
      expect(step.stepId).toBe("s1");
      expect(step.placeClass.key).toBe(row.expect.placeClass);
      expect(step.placeClass.label.length).toBeGreaterThan(0);
      expect(step.needs.map((need) => need.payload.kind)).toEqual(row.expect.needs);
      expect(step.title.length).toBeLessThanOrEqual(40);
      for (const need of step.needs) {
        expect(need.label.length).toBeGreaterThan(0);
        expect(need.gist.length).toBeGreaterThan(0);
      }
    });
  }
});

describe("plan preview", () => {
  it("keeps the goal verbatim and reports every class the area has", async () => {
    scripted(DRAFTS["plan-001"]);
    const preview = await planPreview(planRows[0].text, area, NOW);
    expect(preview.goal).toBe(planRows[0].text);
    expect(preview.classes.map((row) => row.key)).toContain("food");
    for (const row of preview.classes) {
      expect(row.count).toBeGreaterThan(0);
      expect(row.label.length).toBeGreaterThan(0);
    }
  });

  it("carries a time concept into the step's window and title", async () => {
    scripted(DRAFTS["plan-005"]);
    const preview = await planPreview(planRows[4].text, area, NOW);
    expect(preview.steps[0].when).toEqual({
      start: "2026-09-03T18:00:00+02:00",
      end: "2026-09-03T21:00:00+02:00",
      phrase: "dinner",
    });
    expect(preview.steps[0].title).toBe("dinner");
  });

  it("falls back to the class label when the goal names nothing to title it with", async () => {
    scripted(DRAFTS["plan-003"]);
    const preview = await planPreview(planRows[2].text, area, NOW);
    expect(preview.steps[0].when).toBeNull();
    expect(preview.steps[0].title).toBe("a park");
  });

  it("measures a referent nobody can place yet from the person, and says so", async () => {
    scripted(DRAFTS["plan-001"]);
    const preview = await planPreview(planRows[0].text, area, NOW);
    const scope = preview.steps[0].needs.find((need) => need.payload.kind === "scope")!;
    expect(scope.payload).toMatchObject({ dimension: "walk_min", max: 10 });
    expect(scope.payload.referent).toBeUndefined();
    expect(scope.assumed).toBe("measured from where you start, not Sarah's subway station");
  });

  it("turns a named subject into a question about the place", async () => {
    scripted({
      placeClass: "cinema",
      concepts: [concept({
        role: "subject",
        surface: "the new MCU movie",
        gist: "the new mcu movie",
      })],
    });
    const preview = await planPreview("watch the new MCU movie", area, NOW);
    expect(preview.steps[0].placeClass.key).toBe("cinema");
    expect(preview.steps[0].needs).toEqual([{
      payload: { kind: "text", text: "does this place offer the new MCU movie?" },
      label: "the new MCU movie",
      gist: "the new mcu movie",
    }]);
    expect(preview.steps[0].title).toBe("the new mcu movie");
  });

  it("falls back to one default step when the model answers with an unknown class", async () => {
    scripted({ placeClass: "spaceport", concepts: [] });
    const preview = await planPreview("let's go somewhere", area, NOW);
    expect(preview.steps[0].placeClass).toEqual({ key: "food", label: "somewhere to eat" });
    expect(preview.steps[0].needs).toEqual([]);
  });
});
