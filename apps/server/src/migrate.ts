import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pool, withTransaction } from "./db.ts";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

await withTransaction(async (client) => {
  await client.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
  );
  const applied = new Set(
    (await client.query("SELECT name FROM schema_migrations")).rows.map(
      (r) => r.name,
    ),
  );
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    if (applied.has(file)) continue;
    console.log(`applying ${file}`);
    await client.query(readFileSync(join(dir, file), "utf8"));
    await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [
      file,
    ]);
  }
});
console.log("migrations complete");
await pool.end();
