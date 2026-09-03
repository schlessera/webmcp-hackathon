import { test, expect, chromium, type Browser } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createTestRoom, type TestRoom, DATABASE_URL } from "../api/helpers.ts";

/**
 * The front door. `/` with no invite is the landing page; "Start a room"
 * reveals the area picker under `#start` and the back button returns; an
 * `#invite=` link never shows the landing at all — it goes straight to the
 * room, which is what every existing spec and every shared link relies on.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = 43176;
const BASE = `http://127.0.0.1:${PORT}`;

let server: ChildProcess;
let browser: Browser;
let room: TestRoom;

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
  server = spawn("node", [join(repoRoot, "apps", "server", "src", "server.ts")], {
    env: { ...process.env, DATABASE_URL, PORT: String(PORT), BUILD_ID: "e2e-landing", LOG_LEVEL: "warn", OPENAI_API_KEY: "", OPENROUTER_API_KEY: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForServer();
  room = await createTestRoom(BASE, { berlin: true });
  browser = await chromium.launch();
});

test.afterAll(async () => {
  await browser?.close();
  await room?.cleanup();
  server?.kill("SIGTERM");
});

test("the root is the landing page, and Start a room opens the picker", async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.goto(`${BASE}/`);

  const landing = page.getByTestId("landing");
  await expect(landing).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Decide together");
  // The product half never names the wire; the drawer half does.
  await expect(landing.getByText("Spokes is a hackathon entry.")).toBeAttached();
  await expect(page.getByTestId("start")).toHaveCount(0);

  await page.getByTestId("landing-start").click();
  await expect(page.getByTestId("start")).toBeVisible();
  await expect(page.getByTestId("landing")).toHaveCount(0);
  expect(new URL(page.url()).hash).toBe("#start");

  await page.goBack();
  await expect(page.getByTestId("landing")).toBeVisible();
  await expect(page.getByTestId("map-region")).toHaveCount(0);

  // The picker's own Back clears #start and shows the landing.
  await page.getByTestId("landing-start").click();
  await expect(page.getByTestId("start")).toBeVisible();
  await page.getByTestId("start-back").click();
  await expect(page.getByTestId("landing")).toBeVisible();
  expect(new URL(page.url()).hash).toBe("");
  await context.close();
});

test("Back from a room opened via the picker returns to the picker, then the landing", async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.goto(`${BASE}/`);
  await page.getByTestId("landing-start").click();
  await expect(page.getByTestId("start")).toBeVisible();
  // Enter an existing room the way the picker does (assign + reload), so the
  // history holds landing → #start → #invite=.
  await page.evaluate((secret) => {
    window.location.assign(`/#invite=${secret}`);
  }, room.inviteSecrets.joe);
  await page.reload();
  await expect(page.getByTestId("map-region")).toBeVisible({ timeout: 15000 });
  await page.goBack();
  await expect(page.getByTestId("start")).toBeVisible();
  await expect(page.getByTestId("map-region")).toHaveCount(0);
  await page.goBack();
  await expect(page.getByTestId("landing")).toBeVisible();
  await expect(page.getByTestId("map-region")).toHaveCount(0);
  await context.close();
});

test("nothing on the landing forces a sideways scroll at 360", async () => {
  const context = await browser.newContext({ viewport: { width: 360, height: 780 } });
  const page = await context.newPage();
  await page.goto(`${BASE}/`);
  await expect(page.getByTestId("landing")).toBeVisible();
  const widths = await page.evaluate(() => {
    const doc = document.scrollingElement!;
    const l = document.querySelector(".landing")!;
    return { doc: [doc.scrollWidth, doc.clientWidth], landing: [l.scrollWidth, l.clientWidth] };
  });
  expect(widths.doc[0]).toBe(widths.doc[1]);
  expect(widths.landing[0]).toBe(widths.landing[1]);
  await context.close();
});

test("an invite link goes straight to the room", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${BASE}/#invite=${room.inviteSecrets.sarah}`);
  await expect(page.locator(".app")).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId("landing")).toHaveCount(0);
  await context.close();
});
