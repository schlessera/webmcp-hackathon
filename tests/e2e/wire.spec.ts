import { test, expect } from "@playwright/test";
import { createTestRoom, startServer, type TestRoom, type TestServer } from "../api/helpers.ts";

let server: TestServer;
let room: TestRoom;
test.beforeAll(async () => {
  server = await startServer({ entrypoint: "tests/e2e/fixtures/model-disabled-server.ts", env: { SERVE_STATIC: "0" } });
  room = await createTestRoom(server.baseUrl, { berlin: true });
});
test.afterAll(async () => { await room?.cleanup(); await server?.stop(); });

test("Wire shows conversation, tools and live socket descriptions without opening metadata", async ({ page }, testInfo) => {
  const localRoom = await createTestRoom(server.baseUrl, { berlin: true });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.route("**/api/meta", async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...await response.json(), nl: true } });
    });
    let response: object = { ok: true, intent: "ask", reply: "Two gardens are worth comparing. One still needs a dog policy check.",
      meta: { agent: { model: "scripted", rounds: 2, ms: 140, calls: [
        { tool: "inspect_candidates", round: 1, ok: true, ms: 20, state: "completed", summary: "2 places returned" },
        { tool: "look_up_places", round: 2, ok: false, ms: 30, state: "failed", summary: "rate_limited" },
      ] } }, partial: true, failureCategory: "tool" };
    await page.route("**/api/nl/say", (route) => route.fulfill({ json: response }));
    await page.goto(`${server.baseUrl}/?shim=webmcp#invite=${localRoom.inviteSecrets.org}`);
    await page.addScriptTag({ type: "module", content: 'import {wire} from "/src/wire-store.ts"; window.__wireFixture = wire;' });
    await page.waitForFunction(() => Boolean((window as any).__wireFixture));
    await page.getByTestId("close-drawer").click();
    const input = page.getByLabel("What matters to you?");
    const said = "Which places should we compare, and what would you still need to check before making a useful suggestion for this group?";
    await input.fill(said);
    await input.press("Enter");
    await expect(page.getByTestId("agent-busy")).toHaveCount(0);
    await expect(input).toHaveValue(said); // Partial response keeps retry text.
    await page.getByTestId("open-drawer").click();
    await page.getByRole("button", { name: "Expand", exact: true }).click();
    const search = page.getByRole("searchbox", { name: "Search wire events" });
    await search.fill("gardens");
    await expect(page.locator(".wire-event")).toHaveCount(1);
    await expect(page.locator(".wire-event")).toContainText("say · Which places");
    await expect(page.locator(".wire-event")).toContainText("Two gardens");
    await page.locator(".wire-event").click();
    const inspector = page.getByTestId("wire-inspector");
    await expect(inspector.getByText(said, { exact: true })).toBeVisible();
    await expect(inspector.getByText("Two gardens are worth comparing. One still needs a dog policy check.", { exact: true })).toBeVisible();
    await expect(inspector.locator(".wire-call-list")).toContainText("inspect_candidates");
    await expect(inspector.locator(".wire-call-list")).toContainText("2 places returned");
    await expect(inspector.locator(".wire-call-list")).toContainText("Round 2 · failed");
    await expect(inspector.locator("details")).not.toHaveAttribute("open");
    await page.screenshot({ path: testInfo.outputPath("wire-conversation.png"), fullPage: true });
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export event", exact: true }).click();
    const download = await downloadPromise;
    const chunks = [];
    for await (const chunk of (await download.createReadStream())!) chunks.push(chunk);
    const exported = Buffer.concat(chunks).toString();
    expect(JSON.parse(exported).events).toHaveLength(1);
    expect(exported).not.toMatch(/Which places|Two gardens|content|dog policy/);
    await search.fill("POST nl/say");
    await page.locator(".wire-event").click();
    await expect(inspector).toContainText("Conversation that started this request");
    await expect(inspector).toContainText(said);

    // A real command and real socket frame exercise capture, not just a store fixture.
    await page.getByTestId("close-drawer").click();
    response = { ok: true, intent: "need", needs: [{ payload: { kind: "attribute", key: "quiet", expect: "verified_true" },
      label: "quiet for this check", gist: "quiet for this check" }] };
    await input.fill("Please make a useful requirement from this sentence");
    await input.press("Enter");
    await expect(input).toHaveValue("");
    await page.getByTestId("open-drawer").click();
    await search.fill("requirement_submitted");
    const frame = page.locator(".wire-event").filter({ hasText: "requirement_submitted" }).first();
    await expect(frame).toBeVisible();
    await frame.click();
    await expect(inspector).toContainText("Events in this frame");
    await expect(inspector.locator(".wire-call-list")).toContainText("You added a shared need: quiet");
    await expect(inspector.locator("details")).not.toHaveAttribute("open");
    await page.screenshot({ path: testInfo.outputPath("wire-events.png"), fullPage: true });

    await page.getByTestId("close-drawer").click();
    response = { ok: true, intent: "act", reply: "Review this suggestion before applying it to the room.",
      pendingAction: { id: "approval-secret-excluded-from-wire", title: "Mark you ready", details: [], expiresAt: new Date(Date.now() + 60000).toISOString() },
      meta: { agent: { model: "scripted", rounds: 1, ms: 50, calls: [
        { tool: "set_ready_state", round: 1, ok: true, ms: 10, state: "approval_required", summary: "Awaiting your approval; no change applied" },
      ] } } };
    await input.fill("Please suggest the next step for this group");
    await input.press("Enter");
    await expect(input).toHaveValue("");
    await page.getByTestId("open-drawer").click();
    await search.fill("suggest the next step");
    await page.locator(".wire-event").click();
    await expect(inspector).toContainText("Approval requested");
    await expect(inspector).toContainText("Mark you ready");
    await expect(inspector.locator(".wire-call-list")).toContainText("Round 1 · approval required");
    expect(await page.evaluate(() => JSON.stringify((window as any).__wireFixture.state))).not.toContain("approval-secret-excluded-from-wire");
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(inspector).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await page.screenshot({ path: testInfo.outputPath("wire-content-mobile.png"), fullPage: true });

    // The held-text route must not start recording its input or interpretation.
    await page.getByTestId("close-drawer").click();
    await page.route("**/api/nl/condition", (route) => route.fulfill({ json: { ok: true } }));
    await page.getByTestId("composer-scope").click();
    await page.getByTestId("scope-agent-private").click();
    await input.fill("Held private words must never enter the recording");
    await input.press("Enter");
    await expect(input).toHaveValue("");
    expect(await page.evaluate(() => JSON.stringify((window as any).__wireFixture.state))).not.toContain("Held private words");
    expect(await page.evaluate(() => (window as any).__wireFixture.state.events.filter((e: any) => e.content).length)).toBeGreaterThan(2);
    expect(errors).toEqual([]);
  } finally { await localRoom.cleanup(); }
});

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
    const at = Date.now() - 60000;
    wire.begin({id:"test-turn",lane:"agent",label:"test turn",at,endAt:at+55000,durationMs:55000,outcome:"ok"});
    for (let i=0;i<4796;i++) wire.mark({lane:"ws",label:"presence",at:at+1000+i*10});
    wire.begin({id:"test-request",lane:"http",label:"POST test/inspect",at:at+50000,endAt:at+52950,durationMs:2950,parentId:"test-turn",outcome:"ok",correlationId:"test-correlation",status:200,headersMs:2900,serverMs:2800,bodyMs:30,parseMs:2,bytes:2048,
      serverTrace:{version:1,durationMs:2800,omitted:0,spans:[{kind:"model",label:"fixture-model",offsetMs:20,durationMs:2700,outcome:"ok",inputTokens:100,outputTokens:20}]}});
    wire.mark({id:"test-frame",lane:"ws",label:"event ×1",dir:"in",at:at+53000,correlationId:"test-correlation",revision:12});
    wire.mark({id:"test-failure",lane:"http",label:"POST test/failure",outcome:"error",status:503,at:at+54000});
  });
  const stream = page.getByTestId("wire-stream");
  await expect(page.getByRole("group",{name:"Visualization",exact:true})).toHaveCount(0);
  await expect(page.getByTestId("diag-wire").getByRole("button",{name:/^(Activity|Timing|Flow)$/})).toHaveCount(0);
  await expect(page.getByRole("group",{name:"Lanes shown"}).getByRole("button")).toHaveText(["Page", "Agent", "Tool", "HTTP", "Socket", "Keepalives"]);
  await page.getByRole("button",{name:"Latest",exact:true}).click();
  await expect.poll(() => page.locator(".wire-event").count()).toBeLessThan(40);
  await expect(page.getByTestId("wire-graph")).toBeVisible();
  await expect(page.locator(".wire-flow-link")).toHaveCount(2);
  await expect(page.getByRole("button",{name:"↑ 1 linked above",exact:true})).toBeVisible();
  await page.getByRole("button",{name:"↑ 1 linked above",exact:true}).click();
  await expect(page.getByTestId("wire-inspector")).toContainText("test turn");
  await page.getByRole("button",{name:"Latest",exact:true}).click();
  await page.locator('[data-wire-id="test-request"]').click();
  const inspector = page.getByTestId("wire-inspector");
  await expect(inspector).toContainText("fixture-model");
  await expect(inspector).toContainText("100 in / 20 out tokens");
  await expect(inspector).toContainText("Called by");
  await expect(inspector).toContainText("Same request ID");
  await expect(inspector).toContainText("3 connected events · 55.0s elapsed");
  await page.screenshot({path:testInfo.outputPath("wire-history.png"),fullPage:true});
  await page.getByRole("button",{name:"Focus related events",exact:true}).click();
  await expect(page.locator(".wire-event")).toHaveCount(3);
  await expect(page.getByTestId("wire-graph")).toBeVisible();
  await expect(page.locator(".wire-flow-link")).toHaveCount(2);
  await page.screenshot({path:testInfo.outputPath("wire-desktop.png"),fullPage:true});
  await page.locator('[data-wire-id="test-turn"]').click();
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
  await page.getByRole("searchbox",{name:"Search wire events"}).fill("after pause");
  await expect(page.locator(".wire-event")).toHaveCount(1);
  await page.getByRole("searchbox",{name:"Search wire events"}).fill("");
  await expect.poll(() => page.locator(".wire-event").count()).toBeGreaterThan(10);
  await stream.focus(); await page.keyboard.press("Home");
  await expect(inspector).toContainText("test turn");
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
  await expect(page.locator(".wire-flow-link[data-filtered]")).toHaveCount(2);
  await expect(page.getByRole("button",{name:"2 linked events hidden by filters · Show",exact:true})).toBeVisible();
  await page.getByRole("button",{name:"2 linked events hidden by filters · Show",exact:true}).click();
  await page.setViewportSize({width:1440,height:1000});
  const recordingMs = await page.evaluate(() => {
    const wire = (window as any).__wireFixture;
    wire.clear();
    const started = performance.now(), at = Date.now() - 10000;
    for (let i=0;i<5000;i++) wire.mark({id:`fan-${i}`,lane:i===0?"agent":"http",label:i===0?"large fan-out":`child ${i}`,at:at+i,...(i?{parentId:"fan-0"}:{})});
    return performance.now()-started;
  });
  await page.getByRole("button",{name:"Latest",exact:true}).click();
  await expect.poll(() => page.locator(".wire-event").count()).toBeLessThan(40);
  await expect.poll(() => page.locator(".wire-flow-link").count()).toBeLessThan(40);
  await page.getByRole("button",{name:"↑ 1 linked above",exact:true}).click();
  await expect(inspector).toContainText("large fan-out");
  await expect(inspector.locator(".wire-connection")).toHaveCount(21); // 20 paged links + longest HTTP
  await page.getByRole("button",{name:"Next connections",exact:true}).click();
  await expect(inspector).toContainText("21–40 of");
  expect(await page.evaluate(() => (window as any).__wireFixture.state.events.filter((event: any)=>event.parentId==="fan-0").length)).toBeGreaterThan(4980);
  await page.screenshot({path:testInfo.outputPath("wire-fan-out.png"),fullPage:true});
  await testInfo.attach("recording-performance",{body:JSON.stringify({events:5000,recordingMs}),contentType:"application/json"});
  expect(errors).toEqual([]);
});
