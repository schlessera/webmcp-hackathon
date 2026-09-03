import { test, expect, chromium, type Browser } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createTestRoom, type TestRoom, DATABASE_URL } from "../api/helpers.ts";

/**
 * Lane 4: native WebMCP discovery and execution in real Chrome 149+.
 *
 * Primary mechanism (the one WEBMCP-REFERENCE.md documents): register the test
 * origin for the Chrome WebMCP origin trial and inject the token as an
 * Origin-Trial response header — the server does this when ORIGIN_TRIAL_TOKEN
 * is set. chrome://flags/#enable-webmcp-testing is interactive-only; no
 * command-line --enable-features equivalent is documented, so this lane does
 * NOT attempt a flag-based launch (that would need its own verification
 * mini-spike against Chromium source first).
 *
 * Requirements:
 *   - real Chrome >= 149 (CHROME_PATH env, or the "chrome" channel)
 *   - ORIGIN_TRIAL_TOKEN env valid for http://127.0.0.1:44173
 *
 * The test FAILS immediately when document.modelContext is absent. It never
 * falls back to the shim: a polyfill passing is not proof that ChatGPT can
 * discover the page's tools.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = 44173;
const BASE = `http://127.0.0.1:${PORT}`;

let server: ChildProcess;
let browser: Browser;
let room: TestRoom;

test.beforeAll(async () => {
  if (!process.env.ORIGIN_TRIAL_TOKEN) {
    throw new Error(
      "ORIGIN_TRIAL_TOKEN is not set. Register http://127.0.0.1:44173 for the " +
        "Chrome WebMCP origin trial and export the token. This lane must run " +
        "against native WebMCP — there is no shim fallback.",
    );
  }
  server = spawn("node", [join(repoRoot, "apps", "server", "src", "server.ts")], {
    env: {
      ...process.env,
      DATABASE_URL,
      PORT: String(PORT),
      // Test servers never talk to the model: the composer takes its offline path.
      OPENAI_API_KEY: "",
      BUILD_ID: "native-lane",
      LOG_LEVEL: "warn",
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      if ((await fetch(`${BASE}/api/meta`)).ok) break;
    } catch { /* retry */ }
    if (Date.now() > deadline) throw new Error("server did not start");
    await new Promise((r) => setTimeout(r, 250));
  }
  room = await createTestRoom(BASE);
  browser = await chromium.launch(
    process.env.CHROME_PATH
      ? { executablePath: process.env.CHROME_PATH, headless: true }
      : { channel: "chrome", headless: true },
  );
});

test.afterAll(async () => {
  await browser?.close();
  await room?.cleanup();
  server?.kill("SIGTERM");
});

test("native Chrome discovers and executes the real tool registry", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${BASE}/#invite=${room.inviteSecrets.org}`);

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
  expect(parsed.toolContractVersion).toBe("2");

  await context.close();
});
