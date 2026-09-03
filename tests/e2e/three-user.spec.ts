import { test, expect, chromium, type Browser, type Page, type BrowserContext } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createTestRoom, type TestRoom, DATABASE_URL } from "../api/helpers.ts";
import { areaById } from "@webmcp-hackathon/contracts";

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
  room = await createTestRoom(BASE, { berlin: true });
  const fixtures = areaById("berlin-mitte")!.fixtureOrigins;
  for (const [index, key] of (["org", "sarah", "joe"] as const).entries()) {
    await room.pool.query(
      "UPDATE participants SET origin = $2 WHERE id = $1",
      [
        room.participantIds[key],
        JSON.stringify({
          ...fixtures[index],
          source: "fixture",
          updatedAt: "2026-09-03T00:00:00.000Z",
        }),
      ],
    );
  }
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

  // Once every page has synced and opened realtime, the arrived roster and
  // live-presence marks converge for all three viewers.
  for (const viewer of ["org", "sarah", "joe"] as const) {
    await expect(pages[viewer].getByTestId("room-subtitle")).toContainText(
      "three in the room",
    );
    await expect(pages[viewer].getByTestId("invite-card")).toHaveCount(0);
    for (const participant of ["org", "sarah", "joe"] as const) {
      await expect(
        pages[viewer].getByTestId(`avatar-${room.participantIds[participant]}`),
      ).toHaveAttribute("data-present", "true");
    }
  }

  // Opt-in position sharing is presence, not room state: Sarah's switch adds
  // an initials squircle on Alex's map, then the next frame removes it.
  await pages.sarah.getByTestId("close-drawer").click();
  await pages.org.getByTestId("close-drawer").click();
  await pages.sarah.getByTestId("avatars").click();
  const sharing = pages.sarah.getByTestId("origin-sharing");
  await expect(sharing).toHaveAttribute("aria-checked", "false");
  await sharing.click();
  await expect(sharing).toHaveAttribute("aria-checked", "true");
  const personMark = pages.org.getByTestId(`person-mark-${room.participantIds.sarah}`);
  await expect(personMark).toBeVisible();
  await expect(personMark).not.toHaveClass(/marker-dot/);
  const palette = await personMark.locator(".person-mark-badge").evaluate((mark) => {
    const sample = (token: string) => {
      const element = document.createElement("i");
      element.style.background = `var(${token})`;
      document.body.append(element);
      const value = getComputedStyle(element).backgroundColor;
      element.remove();
      return value;
    };
    return {
      person: getComputedStyle(mark).backgroundColor,
      semantic: ["--spoke-works", "--spoke-unsure", "--spoke-scope", "--spoke-act"].map(sample),
    };
  });
  expect(palette.semantic).not.toContain(palette.person);
  await expect(pages.org.getByTestId(`avatar-${room.participantIds.sarah}`))
    .toHaveAttribute("data-sharing", "true");

  await sharing.click();
  await expect(sharing).toHaveAttribute("aria-checked", "false");
  await expect(personMark).toHaveCount(0);
  await expect(pages.org.getByTestId(`avatar-${room.participantIds.sarah}`))
    .not.toHaveAttribute("data-sharing", "true");
  await pages.sarah.getByTestId("open-drawer").click();
  await pages.org.getByTestId("open-drawer").click();

  // 3. Shared action from Sarah (dev quick-action inside the diagnostics
  // panel, which stays open under ?shim=webmcp).
  await pages.sarah.getByTestId("submit-shared").click();
  await expect(
    pages.sarah.locator('[data-testid^="need-"]').filter({ hasText: "vegetarian options" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    pages.org.locator('[data-testid^="need-"]').filter({ hasText: "vegetarian options" }),
  ).toBeVisible();
  await expect(pages.sarah.getByTestId("last-result")).toHaveCount(0);

  // The shared row carries its author in peer briefs.
  await expect(
    pages.org.locator('[data-testid^="need-"]').filter({ hasText: "vegetarian options" }),
  ).toContainText("Sarah");

  // 4. Private (application-private) requirement from Joe.
  await pages.joe.getByTestId("submit-private").click();
  const joePrivate = pages.joe
    .locator('[data-testid^="need-"]')
    .filter({ hasText: "budget €18" });
  await expect(joePrivate).toContainText("private");
  await expect(joePrivate).toHaveAttribute("aria-pressed", "true");
  await expect(pages.org.getByTestId("private-effect")).toContainText(
    "A private condition",
  );
  await expect(pages.sarah.getByTestId("private-effect")).toContainText(
    "A private condition",
  );
  await expect(pages.org.getByTestId("brief")).not.toContainText("budget €18");
  await expect(pages.sarah.getByTestId("brief")).not.toContainText("budget €18");
  await expect(pages.joe.getByTestId("last-result")).toHaveCount(0);

  // 5. All live revisions converge.
  const target = await pages.joe.getByTestId("revision").innerText();
  for (const key of ["org", "sarah", "joe"] as const) {
    await expect(pages[key].getByTestId("revision")).toHaveText(target);
  }
  // The new brief is the live projection: shared content is named while a
  // peer's private contribution is represented only by its coarse effect.
  for (const key of ["org", "sarah"] as const) {
    await expect(pages[key].getByTestId("brief-needs")).toContainText(
      "vegetarian options",
    );
    await expect(pages[key].getByTestId("private-effect")).toBeVisible();
  }

  // 6. Only Joe's network responses contain the private payload. Every page
  // pulls its own full delta first (peers get the aggregate projection).
  const syncBodies: Record<"org" | "sarah" | "joe", string> = {} as never;
  for (const key of ["org", "sarah", "joe"] as const) {
    const response = pages[key].waitForResponse(
      (candidate) =>
        candidate.url().endsWith("/api/sync") &&
        candidate.request().method() === "POST",
    );
    const tool = pages[key].evaluate(async () => {
      const shim = (window as never as {
        __webmcpTestShim: { executeTool(name: string, args: string): Promise<unknown> };
      }).__webmcpTestShim;
      await shim.executeTool("sync_session", '{"sinceRevision":0}');
    });
    const [networkResponse] = await Promise.all([response, tool]);
    syncBodies[key] = await networkResponse.text();
    responseBodies[key].push(syncBodies[key]);
  }
  const marker = "perPersonMax";
  expect(syncBodies.joe).toContain(marker);
  for (const key of ["org", "sarah"] as const) {
    expect(syncBodies[key], `${key} response leaked private payload`).not.toContain(marker);
    const sync = JSON.parse(syncBodies[key]) as {
      delta?: {
        events?: Array<{
          type?: string;
          level?: string;
          actorId?: string;
          payload?: unknown;
        }>;
      };
    };
    const privateEvent = sync.delta?.events?.find(
      (event) => event.type === "requirement_submitted" && event.level === "aggregate",
    );
    expect(privateEvent, `${key} did not receive Joe's aggregate private event`).toBeDefined();
    expect(privateEvent?.actorId).toBeUndefined();
    expect(privateEvent?.payload).toBeUndefined();
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
