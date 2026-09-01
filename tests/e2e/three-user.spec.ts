import { test, expect, chromium, type Browser, type Page, type BrowserContext } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createTestRoom, type TestRoom, DATABASE_URL } from "../api/helpers.ts";

/**
 * Lane 3: one trajectory across three isolated BrowserContexts (Playwright's
 * recommended multi-user pattern — cookies, storage, and in-memory state are
 * per-context). The WebMCP dispatch in step 7 goes through the page's real
 * registration layer via the test-only shim (?shim=webmcp): stock Playwright
 * Chromium has no document.modelContext, so this proves command-bus
 * convergence only. Native discovery/execution is lane 4.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = 43173;
const BASE = `http://127.0.0.1:${PORT}`;

let server: ChildProcess;
let browser: Browser;
let room: TestRoom;
let contexts: BrowserContext[] = [];

function startServer(buildId: string): ChildProcess {
  return spawn("node", [join(repoRoot, "apps", "server", "src", "server.ts")], {
    env: {
      ...process.env,
      DATABASE_URL,
      PORT: String(PORT),
      BUILD_ID: buildId,
      LOG_LEVEL: "warn",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitForServer(): Promise<void> {
  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      if ((await fetch(`${BASE}/api/meta`)).ok) return;
    } catch { /* retry */ }
    if (Date.now() > deadline) throw new Error("server did not start");
    await new Promise((r) => setTimeout(r, 250));
  }
}

test.beforeAll(async () => {
  server = startServer("e2e-build-1");
  await waitForServer();
  room = await createTestRoom(BASE);
  browser = await chromium.launch();
});

test.afterAll(async () => {
  for (const ctx of contexts) await ctx.close().catch(() => {});
  await browser?.close();
  await room?.cleanup();
  server?.kill("SIGTERM");
});

test("three-user trajectory", async () => {
  // 1. Join all three invite URLs in isolated contexts.
  const pages: Record<"org" | "sarah" | "joe", Page> = {} as never;
  const responseBodies: Record<string, string[]> = { org: [], sarah: [], joe: [] };
  for (const key of ["org", "sarah", "joe"] as const) {
    const context = await browser.newContext();
    contexts.push(context);
    const page = await context.newPage();
    page.on("websocket", (socket) => {
      socket.on("framereceived", (frame) => {
        responseBodies[key].push(`ws:${String(frame.payload)}`);
      });
    });
    page.on("response", (response) => {
      if (response.url().includes("/api/")) {
        response.text().then(
          (text) => responseBodies[key].push(text),
          () => {},
        );
      }
    });
    await page.goto(`${BASE}/?shim=webmcp#invite=${room.inviteSecrets[key]}`);
    pages[key] = page;
  }

  // 2. Unique identities; identical room/protocol/build values.
  const identities = new Set<string>();
  const builds = new Set<string>();
  for (const key of ["org", "sarah", "joe"] as const) {
    const page = pages[key];
    await expect(page.getByTestId("participant-id")).toHaveText(
      room.participantIds[key],
    );
    identities.add(await page.getByTestId("participant-id").innerText());
    await expect(page.getByTestId("room-id")).toHaveText(room.roomId);
    await expect(page.getByTestId("protocols")).toHaveText(
      "negotiation/v1 spatial-destination/v1",
    );
    await expect(page.getByTestId("build-id")).not.toHaveText("…");
    builds.add(await page.getByTestId("build-id").innerText());
    await expect(page.getByTestId("diag-ws")).toHaveText("open");
  }
  expect(identities.size).toBe(3);
  expect(builds.size).toBe(1);

  // 3. Shared action from Sarah (dev quick-action inside the diagnostics
  // panel, which stays open under ?shim=webmcp).
  await pages.sarah.getByTestId("submit-shared").click();
  await expect(pages.sarah.getByTestId("last-result")).toContainText(
    "Requirement recorded",
  );

  // 4. Private (application-private) requirement from Joe.
  await pages.joe.getByTestId("submit-private").click();
  await expect(pages.joe.getByTestId("last-result")).toContainText(
    "Requirement recorded",
  );

  // 5. All live revisions converge.
  const target = await pages.joe.getByTestId("revision").innerText();
  for (const key of ["org", "sarah", "joe"] as const) {
    await expect(pages[key].getByTestId("revision")).toHaveText(target);
  }
  // Feeds observed the events live via WS (feed lives in the Activity tab).
  await pages.org.getByTestId("tab-activity").click();
  await expect(pages.org.getByTestId("feed")).toContainText("Sarah");
  await expect(pages.org.getByTestId("feed")).toContainText(
    "private need",
  );

  // 6. Only Joe's network responses contain the private payload. Every page
  // pulls its own full delta first (peers get the aggregate projection).
  for (const key of ["org", "sarah", "joe"] as const) {
    await pages[key].evaluate(async () => {
      const shim = (window as never as {
        __webmcpTestShim: { executeTool(name: string, args: string): Promise<unknown> };
      }).__webmcpTestShim;
      await shim.executeTool("sync_session", '{"sinceRevision":0}');
    });
  }
  await new Promise((r) => setTimeout(r, 500)); // drain response bodies
  const marker = "perPersonMax";
  expect(responseBodies.joe.some((b) => b.includes(marker))).toBe(true);
  for (const key of ["org", "sarah"] as const) {
    for (const body of responseBodies[key]) {
      expect(body, `${key} response leaked private payload`).not.toContain(marker);
    }
  }

  // 7. Tool callback through the page's registration layer (test shim) —
  // converges on the same client command bus as UI gestures.
  const toolResult = await pages.org.evaluate(async () => {
    const shim = (window as never as {
      __webmcpTestShim: {
        getTools(): Array<{ name: string }>;
        executeTool(name: string, args: string): Promise<unknown>;
      };
    }).__webmcpTestShim;
    const tools = shim.getTools().map((t) => t.name);
    const executed = (await shim.executeTool("sync_session", "{}")) as {
      content: Array<{ type: string; text: string }>;
    };
    return { tools, parsed: JSON.parse(executed.content[0].text) };
  });
  expect(toolResult.tools).toContain("sync_session");
  expect(toolResult.parsed.ok).toBe(true);
  expect(toolResult.parsed.identity.participantId).toBe(room.participantIds.org);
  expect(String(toolResult.parsed.revision)).toBe(target);
  expect(toolResult.parsed.manifest.protocols.negotiation).toBe("v1");

  // 8. Change the build; all Chromium clients reload and retain identity.
  server.kill("SIGTERM");
  await new Promise<void>((resolve) => server.once("exit", () => resolve()));
  server = startServer("e2e-build-2");
  await waitForServer();
  for (const key of ["org", "sarah", "joe"] as const) {
    // WS reconnect delivers a welcome with the new buildId -> silent reload.
    await expect(pages[key].getByTestId("build-id")).toHaveText("e2e-build-2", {
      timeout: 20000,
    });
    // Identity survived via sessionStorage (no shared-cookie collision).
    await expect(pages[key].getByTestId("participant-id")).toHaveText(
      room.participantIds[key],
    );
  }
});
