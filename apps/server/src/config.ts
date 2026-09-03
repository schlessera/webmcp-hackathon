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
   * Natural-language surface (docs/NL-AGENT.md). Both historical tiers now
   * default to the one deployment model; the old names remain deliberate
   * per-site override seams. Paid priority processing is still forbidden in
   * nl/llm.ts.
   */
  get openaiApiKey(): string {
    return process.env.OPENAI_API_KEY ?? "";
  },
  get openrouterApiKey(): string {
    return process.env.OPENROUTER_API_KEY ?? "";
  },
  parallelApiKey: process.env.PARALLEL_API_KEY ?? "",
  dataForSeoLogin: process.env.DATAFORSEO_LOGIN ?? "",
  dataForSeoPassword: process.env.DATAFORSEO_PASSWORD ?? "",
  llmModel: process.env.LLM_MODEL || "z-ai/glm-5.3-flash",
  nlFastModel:
    process.env.NL_FAST_MODEL || process.env.LLM_MODEL || "z-ai/glm-5.3-flash",
  nlSmartModel:
    process.env.NL_SMART_MODEL || process.env.LLM_MODEL || "z-ai/glm-5.3-flash",
  /** Reads menu photos and PDFs (enrich/menu-reader.ts); vision-capable. */
  menuReaderModel:
    process.env.MENU_READER_MODEL ||
    process.env.NL_SMART_MODEL ||
    process.env.LLM_MODEL ||
    "z-ai/glm-5.3-flash",
  get llmProvider(): "openai" | "openrouter" {
    if (process.env.LLM_PROVIDER === "openai") return "openai";
    if (process.env.LLM_PROVIDER === "openrouter") return "openrouter";
    return this.openrouterApiKey.length > 0 ? "openrouter" : "openai";
  },
  get nlEnabled(): boolean {
    return this.llmProvider === "openrouter"
      ? this.openrouterApiKey.length > 0
      : this.openaiApiKey.length > 0;
  },
};
