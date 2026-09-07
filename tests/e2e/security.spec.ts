import { test, expect, chromium, type Browser } from "@playwright/test";
import { stageAgentAction } from "../../apps/server/src/nl/approvals.ts";
import { createTestRoom, startServer, type TestRoom, type TestServer } from "../api/helpers.ts";

let fixture: TestServer;
let server: TestServer;
let room: TestRoom;
let browser: Browser;
test.beforeAll(async () => {
  fixture = await startServer();
  room = await createTestRoom(fixture.baseUrl, { berlin: true });
  server = await startServer({ env: { NODE_ENV: "production" } });
  browser = await chromium.launch();
});
test.afterAll(async () => {
  await browser?.close();
  await room?.cleanup();
  await server?.stop();
  await fixture?.stop();
});

for (const width of [1280, 390]) {
  test(`AI proposal requires an explicit page approval at ${width}px`, async () => {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    const scriptErrors: string[] = [];
    page.on("pageerror", (error) => scriptErrors.push(error.message));
    const desired = width === 1280 ? "ready" : "contributing";
    const revision = Number((await room.pool.query("SELECT revision FROM rooms WHERE id = $1", [room.roomId])).rows[0].revision);
    const pendingAction = await stageAgentAction({
      id: room.participantIds.org, roomId: room.roomId, displayName: "Alex", role: "organizer", readyState: "contributing",
    }, "SetReadyState", { baseRevision: revision, state: desired }, new Map());
    await page.route("**/api/meta", async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...await response.json(), nl: true } });
    });
    await page.route("**/api/nl/say", (route) => route.fulfill({ json: {
      ok: true, intent: "act", reply: "Review this suggestion before applying it to the room.", actions: [], pendingAction,
    } }));
    await page.goto(`${server.baseUrl}/?shim=webmcp#invite=${room.inviteSecrets.org}`);
    await page.getByTestId("close-drawer").click();
    await page.getByLabel("What matters to you?").fill("Please update my ready state");
    await page.getByLabel("What matters to you?").press("Enter");
    const review = page.getByTestId("agent-action-review");
    await expect(review).toBeVisible();
    await expect(review).toContainText(desired);
    expect(Number((await room.pool.query("SELECT revision FROM rooms WHERE id = $1", [room.roomId])).rows[0].revision)).toBe(revision);
    await page.screenshot({ path: `/tmp/spokes-security-${width}.png`, fullPage: true });
    const applied = page.waitForResponse((response) => response.url().endsWith(`/api/nl/actions/${pendingAction!.id}/approve`));
    await review.getByRole("button", { name: "Approve change" }).click();
    expect((await (await applied).json()).ok).toBe(true);
    await expect(review).toHaveCount(0);
    expect((await room.pool.query("SELECT ready_state FROM participants WHERE id = $1", [room.participantIds.org])).rows[0].ready_state).toBe(desired);
    expect(scriptErrors).toEqual([]);
    const response = await page.request.get(`${server.baseUrl}/`);
    expect(response.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await context.close();
  });
}
