// Records the sha256 of every migration file. Migrations are immutable once
// committed: the runner keys on file names, so editing an applied file leaves
// deployed databases without the change (origin_shared, 2026-09-03).
// Run after adding a NEW migration; never after editing an old one.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "apps", "server", "migrations");
const rows = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()
  .map((f) => `${createHash("sha256").update(readFileSync(join(dir, f))).digest("hex")}  ${f}`);
writeFileSync(join(dir, "HASHES"), rows.join("\n") + "\n");
console.log(`${rows.length} migrations hashed`);
