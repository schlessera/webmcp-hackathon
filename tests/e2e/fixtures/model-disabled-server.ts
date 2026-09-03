import { setTransport } from "../../../apps/server/src/nl/openai.ts";

setTransport(async () => {
  throw new Error("model calls are disabled in e2e tests");
});

await import("../../../apps/server/src/server.ts");
