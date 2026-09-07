import { HELP, parseOptions, selectVenues } from "./prepopulate/options.ts";
import { loadSnapshot } from "./places.ts";

try {
  const options = parseOptions(process.argv.slice(2));
  if (!options) console.log(HELP);
  else {
    const snapshot = loadSnapshot(options.area.id);
    if (!snapshot) throw new Error(`No snapshot for ${options.area.id}`);
    const venues = selectVenues(snapshot, options);
    const { sourceAvailability, runPrepopulation } = await import("./prepopulate/run.ts");
    const availability = sourceAvailability();
    const report = (event: Record<string, unknown>) => console.log(JSON.stringify(event));
    report({ event: "plan", area: options.area.id, radiusM: options.radiusM,
      places: venues.length, concurrency: options.concurrency, dryRun: options.dryRun,
      sources: Object.fromEntries(options.sources.map((source) => [source, availability[source] ?? "enabled"])),
      models: availability.models ?? "enabled",
      searchProvider: process.env.SEARCH_PROVIDER || "parallel",
      parallelCache: "no room scope: snippets are not persisted; validated claims use the normal enrichment store",
    });
    if (!options.dryRun) {
      const { pool } = await import("./db.ts");
      const controller = new AbortController();
      const stop = () => {
        if (!controller.signal.aborted) console.error("Stopping after in-flight work is saved…");
        controller.abort();
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      const heartbeat = setInterval(() => report({ event: "working" }), 15_000);
      try {
        const result = await runPrepopulation(pool, options, snapshot, venues, report, controller.signal);
        report({ event: "complete", ...result });
        process.exitCode = result.interrupted ? 130
          : result.failed || Object.keys(result.sourceErrors).length ? 1 : 0;
      } finally {
        clearInterval(heartbeat);
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        await pool.end();
      }
    }
  }
} catch (error) {
  // Fatal errors here are configuration/DB errors, not provider responses or credentials.
  console.error(error instanceof Error
    ? error.message.replace(/postgres(?:ql)?:\/\/\S+/g, "[database URL]") : "Prepopulation failed");
  process.exitCode = 1;
}
