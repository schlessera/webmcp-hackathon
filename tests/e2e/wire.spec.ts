import { test, expect } from "@playwright/test";
import { createTestRoom, startServer, type TestRoom, type TestServer } from "../api/helpers.ts";

let server: TestServer;
let room: TestRoom;
test.beforeAll(async () => {
  server = await startServer({ entrypoint: "tests/e2e/fixtures/model-disabled-server.ts", env: { SERVE_STATIC: "0" } });
  room = await createTestRoom(server.baseUrl, { berlin: true });
});
test.afterAll(async () => { await room?.cleanup(); await server?.stop(); });

test("Wire preserves causality, freezes a snapshot, exports metadata and bounds the DOM", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({width:1440,height:1000});
  await page.goto(`${server.baseUrl}/?shim=webmcp#invite=${room.inviteSecrets.org}`);
  await page.getByRole("button",{name:"Expand",exact:true}).click();
  // Keep the fixture module reachable. Chromium can collect an unreferenced
  // dynamic-import promise inside evaluate even after its side effects ran.
  await page.addScriptTag({type:"module",content:'import {wire} from "/src/wire-store.ts"; window.__wireFixture = wire;'});
  await page.waitForFunction(() => Boolean((window as any).__wireFixture));
  await page.evaluate(() => {
    const wire = (window as any).__wireFixture;
    wire.clear();
    const at = Date.now() - 10000;
    for (let i=0;i<380;i++) wire.mark({lane:"ws",label:"presence",at:at+i});
    wire.begin({id:"test-turn",lane:"agent",label:"test turn",at:at+1000,endAt:at+4200,durationMs:3200,outcome:"ok"});
    wire.begin({id:"test-request",lane:"http",label:"POST test/inspect",at:at+1050,endAt:at+4000,durationMs:2950,parentId:"test-turn",outcome:"ok",correlationId:"test-correlation",status:200,headersMs:2900,serverMs:2800,bodyMs:30,parseMs:2,bytes:2048,
      serverTrace:{version:1,durationMs:2800,omitted:0,spans:[{kind:"model",label:"fixture-model",offsetMs:20,durationMs:2700,outcome:"ok",inputTokens:100,outputTokens:20}]}});
    wire.mark({id:"test-frame",lane:"ws",label:"event ×1",dir:"in",at:at+4100,correlationId:"test-correlation",revision:12});
    wire.mark({id:"test-failure",lane:"http",label:"POST test/failure",outcome:"error",status:503,at:at+5000});
  });
  const stream = page.getByTestId("wire-stream");
  await page.getByRole("button",{name:"Latest",exact:true}).click();
  await expect.poll(() => page.locator(".wire-event").count()).toBeLessThan(40);
  await page.locator('[data-wire-id="test-request"]').click();
  const inspector = page.getByTestId("wire-inspector");
  await expect(inspector).toContainText("fixture-model");
  await expect(inspector).toContainText("100 in / 20 out tokens");
  await expect(inspector).toContainText("Called by");
  await expect(inspector).toContainText("Same request ID");
  await page.getByRole("button",{name:"Focus related events",exact:true}).click();
  await expect(page.locator(".wire-event")).toHaveCount(3);
  await page.getByRole("button",{name:"Flow",exact:true}).click();
  await expect(page.getByRole("group",{name:"Causal flow diagram"})).toBeVisible();
  await expect(page.locator(".wire-flow-link")).toHaveCount(2);
  await page.screenshot({path:testInfo.outputPath("wire-desktop.png"),fullPage:true});
  await page.getByRole("button",{name:"Inspect test turn",exact:true}).click();
  await expect(inspector.getByRole("heading",{name:"test turn",exact:true})).toBeVisible();
  await page.getByRole("button",{name:"Pause view",exact:true}).click();
  await page.evaluate(() => { (window as any).__wireFixture.mark({lane:"page",label:"after pause"}); });
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button",{name:"Export 3",exact:true}).click();
  const download = await downloadPromise;
  const chunks = [];
  for await (const chunk of (await download.createReadStream())!) chunks.push(chunk);
  const exported = JSON.parse(Buffer.concat(chunks).toString());
  expect(exported.events).toHaveLength(3);
  expect(JSON.stringify(exported)).not.toMatch(/participantToken|inviteSecret|confirmationNonce/);
  await page.getByRole("button",{name:"Resume",exact:true}).click();
  await page.getByRole("button",{name:"Reset filters",exact:true}).click();
  await page.getByRole("button",{name:"Activity",exact:true}).click();
  await page.getByRole("searchbox",{name:"Search wire events"}).fill("after pause");
  await expect(page.locator(".wire-event")).toHaveCount(1);
  await page.getByRole("searchbox",{name:"Search wire events"}).fill("");
  await stream.focus(); await page.keyboard.press("Home");
  await expect(inspector).toContainText("presence");
  await page.keyboard.press("End");
  await expect(inspector).toContainText("after pause");
  await page.setViewportSize({width:390,height:844});
  await expect(inspector).toBeVisible();
  await page.getByRole("button",{name:"Close event details",exact:true}).click();
  await page.getByRole("searchbox",{name:"Search wire events"}).fill("test/inspect");
  await page.locator('[data-wire-id="test-request"]').click();
  await expect(inspector).toContainText("fixture-model");
  await page.screenshot({path:testInfo.outputPath("wire-mobile.png"),fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(390);
  await page.getByRole("button",{name:"Close event details",exact:true}).click();
  await expect(stream).toBeVisible();
  expect(errors).toEqual([]);
});
