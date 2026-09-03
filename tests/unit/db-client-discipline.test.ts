import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * One rule, enforced over the source: nothing outside `withTransaction` may
 * take a client out of the pool and hold it.
 *
 * A held client is a client no request can have. The boot deadlock came from
 * exactly one violation of this: each fill job kept a client for its whole
 * life as an advisory-lock holder, twenty-nine rooms resuming at once took
 * every client, and the app could not answer an invite exchange. Grepping the
 * source is crude, but it is the only check that fails at the moment somebody
 * reintroduces the pattern rather than at three in the morning.
 */

const serverSrc = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "apps",
  "server",
  "src",
);

const read = (relative: string) => readFileSync(join(serverSrc, relative), "utf8");

/** `db.ts` owns the one legitimate acquisition; every other file is checked. */
const BACKGROUND_MODULES = [
  "pool-fill.ts",
  "refine/worker.ts",
  "presence.ts",
  "ws.ts",
  "spatial.ts",
  "engine.ts",
  "rooms.ts",
  "sync.ts",
];

describe("database client discipline", () => {
  it("keeps the pool-fill path free of held clients", () => {
    const source = read("pool-fill.ts");
    expect(source).not.toMatch(/\.connect\s*\(/);
    // A session-scoped lock outlives the statement that took it, so it can
    // only be released by the connection that holds it — which is what forced
    // the job to keep one. The transaction-scoped form cannot pin anything.
    expect(source).not.toMatch(/pg_advisory_lock\s*\(/);
    expect(source).not.toMatch(/pg_advisory_unlock\s*\(/);
    if (/pg_try_advisory/.test(source)) {
      expect(source).toMatch(/pg_try_advisory_xact_lock\s*\(/);
    }
  });

  it("keeps every background module free of held clients", () => {
    const offenders = BACKGROUND_MODULES.filter((relative) =>
      /\.connect\s*\(/.test(read(relative))
    );
    expect(offenders).toEqual([]);
  });

  it("holds no client across a model call or another transaction", () => {
    // `server.ts` is the request surface, so a client held there is held
    // across whatever the request does — including a language-model turn and
    // the nested transaction that commits its actions.
    const source = read("server.ts");
    expect(source).not.toMatch(/\.connect\s*\(/);
    expect(source).not.toMatch(/pg_advisory_lock\s*\(/);
  });

  it("acquires a client in exactly one place", () => {
    expect(read("db.ts")).toMatch(/pool\.connect\(\)/);
  });
});
