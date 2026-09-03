import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const serverSource = fileURLToPath(new URL("../../apps/server/src/", import.meta.url));

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && path.endsWith(".ts") ? [path] : [];
  });
}

describe("pipeline-only server", () => {
  it("contains no removed flag or legacy concurrency symbols", () => {
    const removed = [
      "lookupSlots",
      "LOOKUP_CONCURRENCY",
      "AsyncLimiter",
      "refinementSearchLimiter",
      "runRefinementTick",
      "pipelineEnabled",
      "process.env.PIPELINE",
    ];
    const matches = sourceFiles(serverSource).flatMap((path) => {
      const source = readFileSync(path, "utf8");
      return removed.filter((symbol) => source.includes(symbol)).map((symbol) => ({ path, symbol }));
    });
    expect(matches).toEqual([]);
  });
});
