import { setTransport } from "../../../apps/server/src/nl/openai.ts";

let calls = 0;
process.stdout.write(`NL_SERVER_PID=${process.pid}\n`);
setTransport(async (body) => {
  calls += 1;
  if (Array.isArray(body.tools)) {
    return {
      output: [{
        type: "message",
        content: [{ type: "output_text", text: "The room is ready to review." }],
      }],
    };
  }
  return {
    output: [{
      type: "message",
      content: [{
        type: "output_text",
        text: JSON.stringify({ intent: "ask", needs: [], reply: null }),
      }],
    }],
  };
});

process.on("SIGUSR2", () => {
  process.stdout.write(`NL_TRANSPORT_CALLS=${calls}\n`);
});

await import("../../../apps/server/src/server.ts");
