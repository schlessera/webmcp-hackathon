import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import {
  AREAS,
  ATTRIBUTE_LABELS,
  type Criterion,
} from "@webmcp-hackathon/contracts";
import { loadSnapshot, type SnapshotVenue } from "../apps/server/src/places.ts";
import {
  evaluateMatrix,
  type EvaluateMatrixInput,
} from "../apps/server/src/enrich/evaluate.ts";
import { setTransport } from "../apps/server/src/nl/llm.ts";

// Deliberately network-free. Measures request packing and equal cell coverage;
// production accuracy, provider latency and marginal source coverage need a separate pilot.
process.env.LLM_PROVIDER = "openai";
process.env.OPENAI_API_KEY = "offline-fixture";
const keys = [
  "wifi",
  "dog-friendly",
  "wheelchair-accessible",
  "outdoor-seating",
  "vegetarian-options",
] as const;
const criteria: Criterion[] = keys.map((key) => ({
  id: key,
  kind: "key",
  key,
  label: ATTRIBUTE_LABELS[key],
}));
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const selected: Array<{ area: string; stratum: string; venue: SnapshotVenue }> =
  [];
for (const area of AREAS) {
  const snapshot = loadSnapshot(area.id);
  if (!snapshot) throw new Error(`Missing snapshot ${area.id}`);
  const strata = new Map<string, SnapshotVenue[]>();
  for (const venue of snapshot.venues) {
    const key = `${venue.placeClass ?? "other"}:${Boolean(venue.tags.website || venue.tags["contact:website"])}:${Boolean(venue.tags.wikidata)}`;
    const group = strata.get(key) ?? [];
    group.push(venue);
    strata.set(key, group);
  }
  const groups = [...strata.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [, venues] of groups)
    venues.sort((a, b) => hash(a.ref).localeCompare(hash(b.ref)));
  let count = 0;
  for (let round = 0; count < 100; round++)
    for (const [stratum, venues] of groups) {
      if (count >= 100) break;
      if (!venues[round]) continue;
      selected.push({ area: area.id, stratum, venue: venues[round] });
      count++;
    }
}
const places: EvaluateMatrixInput["places"] = selected.map(({ venue }) => ({
  candidateId: venue.ref,
  osmRef: venue.ref,
  name: venue.name,
  category: venue.placeClass ?? "other",
  texts: [],
}));
let calls = 0;
setTransport(async (body) => {
  calls++;
  const input = JSON.parse(
    (body.input as Array<{ content: string }>)[0].content,
  ) as EvaluateMatrixInput;
  return {
    output: [
      {
        type: "message",
        content: [
          {
            type: "output_text",
            text: JSON.stringify({
              claims: input.places.flatMap((place) =>
                input.criteria.map((criterion) => ({
                  candidateId: place.candidateId,
                  criterionId: criterion.id,
                  lean: "abstain",
                  confidence: 0,
                  evidence: "",
                  sourceIndex: null,
                  explicit: false,
                })),
              ),
            }),
          },
        ],
      },
    ],
  };
});
const arms = [];
for (const width of [1, 8]) {
  calls = 0;
  let answered = 0;
  const latencies: number[] = [];
  for (let at = 0; at < places.length; at += width) {
    const start = performance.now();
    await evaluateMatrix(
      { places: places.slice(at, at + width), criteria },
      async (batch) => {
        answered += batch.answered.length;
      },
    );
    latencies.push(performance.now() - start);
  }
  latencies.sort((a, b) => a - b);
  arms.push({
    placesPerBatch: width,
    modelRequests: calls,
    answeredCells: answered,
    localReplayP50Ms: latencies[Math.floor(latencies.length * 0.5)],
    localReplayP95Ms: latencies[Math.floor(latencies.length * 0.95)],
  });
}
setTransport(null);
if (arms.some((a) => a.answeredCells !== selected.length * criteria.length))
  throw new Error("Cell coverage differs");
const result = {
  mode: "offline-scripted-replay",
  networkRequests: 0,
  paidCostUsd: 0,
  note: "Scripted abstentions over a fixed, stratified snapshot selection. This measures batching, not factual accuracy or production latency.",
  selectionHash: hash(
    JSON.stringify(selected.map((p) => [p.area, p.venue.ref])),
  ),
  places: selected.length,
  criteria: keys,
  arms,
  selection: selected.map((p) => ({
    area: p.area,
    osmRef: p.venue.ref,
    stratum: p.stratum,
  })),
};
const output = process.argv[2];
if (output) await writeFile(output, JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify({ ...result, selection: undefined }, null, 2));
