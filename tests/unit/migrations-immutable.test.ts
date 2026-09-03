import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const dir = join(__dirname, "..", "..", "apps", "server", "migrations");

/**
 * The migration runner keys on file names and skips anything already
 * recorded, so a committed migration must never change: an edit reaches
 * fresh databases only, and deployed ones silently miss it. Add a new file
 * instead, then run `node scripts/migration-hashes.mjs`.
 */
describe("migrations are immutable once committed", () => {
  it("matches the recorded hash of every migration file", () => {
    const recorded = new Map(
      readFileSync(join(dir, "HASHES"), "utf8")
        .trim()
        .split("\n")
        .map((line) => line.split(/\s+/) as [string, string])
        .map(([hash, name]) => [name, hash]),
    );
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      const hash = createHash("sha256").update(readFileSync(join(dir, file))).digest("hex");
      expect(recorded.get(file), `${file} is not in HASHES — run scripts/migration-hashes.mjs after adding it`).toBeDefined();
      expect(hash, `${file} changed after it was recorded — add a new migration instead`).toBe(recorded.get(file));
    }
    expect(recorded.size).toBe(files.length);
  });
});
