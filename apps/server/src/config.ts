import { randomUUID } from "node:crypto";

export const config = {
  port: Number(process.env.PORT ?? 4173),
  host: process.env.HOST ?? "0.0.0.0",
  databaseUrl:
    process.env.DATABASE_URL ??
    "postgres://webmcp:webmcp@127.0.0.1:5432/webmcp",
  /**
   * Changes with every deployed bundle (Gate 2/5). In containers the image
   * build injects BUILD_ID; locally each server start counts as a new build,
   * which is exactly what the reload-propagation lane wants to detect.
   */
  // "unknown" is the Dockerfile ARG default: treat it (and empty) as unset so
  // every container/process (re)start gets a fresh id — Compose Watch's
  // restart path relies on clients seeing the change.
  buildId:
    process.env.BUILD_ID && process.env.BUILD_ID !== "unknown"
      ? process.env.BUILD_ID
      : `dev-${randomUUID().slice(0, 8)}`,
  dev: process.env.NODE_ENV !== "production",
  /** HMAC key for deterministic local demo invite secrets. Local dev only. */
  demoSecretKey: process.env.DEMO_SECRET_KEY ?? "local-dev-only",
  /** Chrome WebMCP origin-trial token, injected as a response header when set. */
  originTrialToken: process.env.ORIGIN_TRIAL_TOKEN ?? "",
  /** One honest identity for venue, Wikimedia and keyed-service traffic. */
  identifyingUserAgent:
    process.env.OUTBOUND_USER_AGENT ??
    "spokes-enrich/0.2 (+https://github.com/schlessera/webmcp-hackathon; reads what a venue publishes about itself)",
  /**
   * Natural-language surface (docs/NL-AGENT.md). Absent key: the composer
   * falls back to its label matching and the page never shows an agent card.
   * Two model choices, chosen per job — never per request size:
   *  - the quickest model at the lowest effort: bounded, schema-shaped,
   *    latency-bound work (routing a sentence, turning it into a need payload);
   *  - smart: anything that acts on the room through tools, judges a person's
   *    private condition against evidence, or answers a question about state.
   * "Quickest" never means a paid priority processing tier: nl/openai.ts
   * sets service_tier=default and rejects priority/fast values before fetch.
   */
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  parallelApiKey: process.env.PARALLEL_API_KEY ?? "",
  dataForSeoLogin: process.env.DATAFORSEO_LOGIN ?? "",
  dataForSeoPassword: process.env.DATAFORSEO_PASSWORD ?? "",
  nlFastModel: process.env.NL_FAST_MODEL ?? "gpt-5.6-luna",
  nlSmartModel: process.env.NL_SMART_MODEL ?? "gpt-5.6-sol",
  /** Reads menu photos and PDFs (enrich/menu-reader.ts); vision-capable. */
  menuReaderModel: process.env.MENU_READER_MODEL ?? process.env.NL_SMART_MODEL ?? "gpt-5.6-sol",
  get nlEnabled(): boolean {
    return this.openaiApiKey.length > 0;
  },
};
