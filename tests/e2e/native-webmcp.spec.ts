import { test, expect, chromium, type Browser } from "@playwright/test";
import { TOOL_CONTRACT_VERSION } from "@webmcp-hackathon/contracts";
import { createTestRoom, startServer, type TestRoom, type TestServer } from "../api/helpers.ts";

/**
 * Lane 4: native WebMCP discovery and execution in real Chrome 149+.
 *
 * Primary mechanism (the one WEBMCP-REFERENCE.md documents): register the test
 * origin for the Chrome WebMCP origin trial and inject the token as an
 * Origin-Trial response header — the server does this when ORIGIN_TRIAL_TOKEN
 * is set. For local development WEBMCP_NATIVE_FLAGS=1 instead enables
 * Chromium's WebMCPTesting feature. See WEBMCP-AGENT-RECOVERY.md for source
 * and the Chrome 151 verification; this is still native, never a polyfill.
 *
 * Requirements:
 *   - real Chrome >= 149 (CHROME_PATH env, or the "chrome" channel)
 *   - ORIGIN_TRIAL_TOKEN env valid for http://127.0.0.1:44173
 *
 * The test FAILS immediately when document.modelContext is absent. It never
 * falls back to the shim: a polyfill passing is not proof that ChatGPT can
 * discover the page's tools.
 */

let server: TestServer;
let browser: Browser;
let room: TestRoom;

test.beforeAll(async () => {
  if (!process.env.ORIGIN_TRIAL_TOKEN && process.env.WEBMCP_NATIVE_FLAGS !== "1") {
    throw new Error(
      "ORIGIN_TRIAL_TOKEN is not set. Register http://127.0.0.1:44173 for the " +
        "Chrome WebMCP origin trial and export the token. This lane must run " +
      "against native WebMCP — there is no shim fallback. For local development " +
        "with a supporting Chrome, WEBMCP_NATIVE_FLAGS=1 enables WebMCPTesting.",
    );
  }
  server = await startServer({
    port: process.env.WEBMCP_NATIVE_FLAGS === "1" ? undefined : 44173,
    env: { BUILD_ID: "native-lane", LOG_LEVEL: "warn" },
  });
  room = await createTestRoom(server.baseUrl);
  browser = await chromium.launch(
    process.env.CHROME_PATH
      ? { executablePath: process.env.CHROME_PATH, headless: true, args: process.env.WEBMCP_NATIVE_FLAGS === "1" ? ["--enable-features=WebMCPTesting"] : [] }
      : { channel: "chrome", headless: true, args: process.env.WEBMCP_NATIVE_FLAGS === "1" ? ["--enable-features=WebMCPTesting"] : [] },
  );
});

test.afterAll(async () => {
  await browser?.close();
  await room?.cleanup();
  await server?.stop();
});

test("native Chrome discovers and executes the real tool registry", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${server.baseUrl}/#invite=${room.inviteSecrets.org}`);

  const hasModelContext = await page.evaluate(
    () => typeof (document as never as { modelContext?: unknown }).modelContext !== "undefined",
  );
  expect(
    hasModelContext,
    "document.modelContext is absent: Chrome version < 149, origin-trial token " +
      "invalid for this origin, or WebMCP not enabled. This lane never uses the shim.",
  ).toBe(true);

  // Registration happened at page load; open the under-the-hood drawer to
  // read the diagnostics without putting protocol state in the main chrome.
  await page.getByTestId("open-drawer").click();
  await expect(page.getByTestId("diagnostics")).toBeVisible();
  await expect(page.getByTestId("diag-registration")).toHaveText("registered");
  await expect(page.getByTestId("participant-id")).toHaveText(
    room.participantIds.org,
  );

  // Discover through document.modelContext.getTools().
  const toolNames = await page.evaluate(async () => {
    const mc = (document as never as {
      modelContext: { getTools(): Promise<Array<{ name: string }>> };
    }).modelContext;
    return (await mc.getTools()).map((t) => t.name);
  });
  expect(toolNames).toContain("sync_session");

  // Execute through executeTool(tool, args) — first argument is the
  // RegisteredTool from getTools(), args may be an already-serialized JSON
  // string, and the promise resolves with the STRINGIFIED tool result
  // (WEBMCP-REFERENCE.md §6.7/§6.8).
  const executed = await page.evaluate(async () => {
    const mc = (document as never as {
      modelContext: {
        getTools(): Promise<Array<{ name: string }>>;
        executeTool(tool: unknown, args: string): Promise<string>;
      };
    }).modelContext;
    const tool = (await mc.getTools()).find((t) => t.name === "sync_session");
    return mc.executeTool(tool, "{}");
  });
  // Our execute returns the MCP content-block shape (the convention OpenAI's
  // runtime normalizes); native Chrome stringifies it verbatim.
  const envelope = JSON.parse(executed) as {
    content: Array<{ type: string; text: string }>;
  };
  const parsed = JSON.parse(envelope.content[0].text);
  expect(parsed.ok).toBe(true);
  expect(parsed.identity.participantId).toBe(room.participantIds.org);
  expect(parsed.manifest.protocols.domain).toBe("spatial-destination/v1");
  expect(parsed.toolContractVersion).toBe(TOOL_CONTRACT_VERSION);

  await context.close();
});
