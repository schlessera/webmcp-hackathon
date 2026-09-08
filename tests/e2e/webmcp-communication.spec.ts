import { test, expect, chromium, type Browser, type Page } from "@playwright/test";
import { TOOL_CONTRACT_VERSION, TOOLS } from "@webmcp-hackathon/contracts";
import { createTestRoom, startServer, apiPost, type TestRoom, type TestServer } from "../api/helpers.ts";

// The same conversation runs through the callback shim or native Chrome. The
// native lane never installs a shim; a missing native API fails the test.
const native = process.env.WEBMCP_NATIVE_FLAGS === "1" || !!process.env.ORIGIN_TRIAL_TOKEN;
let server: TestServer;
let room: TestRoom;
let browser: Browser;

async function call(page: Page, name: string, args: unknown = {}): Promise<any> {
  return page.evaluate(async ({ name, args, native }) => {
    const mc = (document as any).modelContext;
    const envelope = native
      ? JSON.parse(await mc.executeTool((await mc.getTools()).find((t: any) => t.name === name), JSON.stringify(args)))
      : await (window as any).__webmcpTestShim.executeTool(name, args);
    return JSON.parse(envelope.content[0].text);
  }, { name, args, native });
}

async function ready(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => (document as any).modelContext != null)).toBe(true);
  await expect.poll(async () => (await call(page, "sync_session")).identity?.participantId).toBe(room.participantIds.org);
  // The command runner mounts after authentication; the UI identity proves
  // that its effect has installed the same command bus used by the tools.
  if (!await page.getByTestId("diagnostics").isVisible()) {
    await page.getByTestId("open-drawer").click({ timeout: 10_000 });
  }
  await expect(page.getByTestId("participant-id")).toHaveText(room.participantIds.org);
}

test.beforeAll(async () => {
  server = await startServer({ port: native && process.env.WEBMCP_NATIVE_FLAGS !== "1" ? 44173 : undefined });
  room = await createTestRoom(server.baseUrl);
  await room.pool.query("UPDATE rooms SET scope = $2, scope_seq = 1 WHERE id = $1", [room.roomId, JSON.stringify({ scopeId: "scope_1", area: { kind: "circle", center: { lat: 52.5, lng: 13.4 }, radiusM: 800 }, transport: ["walk"], category: "food" })]);
  // Source and observation time must survive the tool's projection.
  await room.pool.query("UPDATE candidates SET attributes = $2 WHERE room_id = $1 AND name = 'Alpha'", [room.roomId, JSON.stringify([{ key: "vegetarian-options", status: "verified_true", source: "osm:fixture", observedAt: "2026-09-01T00:00:00.000Z" }])]);
  await room.pool.query("UPDATE candidates SET attributes = '[]' WHERE room_id = $1 AND name = 'Gamma'", [room.roomId]);
  browser = await chromium.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
    headless: true,
    args: process.env.WEBMCP_NATIVE_FLAGS === "1" ? ["--enable-features=WebMCPTesting"] : native ? [] : ["--disable-features=WebMCP,WebMCPTesting"],
  });
});

test.afterAll(async () => {
  await browser?.close();
  await room?.cleanup();
  await server?.stop();
});

test("summarize, filter, recover a lost response, reconnect, and undo", async () => {
  const page = await browser.newPage();
  const sent: Array<{ type?: string; candidateId?: string | null }> = [];
  page.on("websocket", (socket) => socket.on("framesent", ({ payload }) => {
    try { sent.push(JSON.parse(String(payload))); } catch { /* non-JSON frames */ }
  }));
  await page.goto(`${server.baseUrl}/${native ? "" : "?shim=webmcp"}#invite=${room.inviteSecrets.org}`);
  await ready(page);
  const registry = await page.evaluate(async (native) => native
    ? (await (document as any).modelContext.getTools()).map((t: any) => ({ name: t.name }))
    : (window as any).__webmcpTestShim.getTools(), native);
  expect(registry.map((t: any) => t.name).sort()).toEqual(TOOLS.map((t) => t.name).sort());
  if (native) expect(await page.evaluate(() => (window as any).__webmcpTestShim)).toBeUndefined();

  const session = await call(page, "sync_session");
  expect(session.toolContractVersion).toBe(TOOL_CONTRACT_VERSION);
  const first = await call(page, "get_spatial_context", { limit: 1 });
  expect(first.ok).toBe(true);
  expect(first.page).toMatchObject({ total: 3, returned: 1, remaining: 2 });
  expect(first.page.nextCursor).toBeTruthy();
  const all = await call(page, "get_spatial_context");
  const alpha = all.candidates.find((c: any) => c.name === "Alpha");
  const beforeInspection = sent.length;
  const inspectRequest = page.waitForRequest((r) => r.url().includes("/spatial/inspect"));
  const inspected = await call(page, "inspect_candidates", { candidateIds: [alpha.candidateId], keys: ["vegetarian-options"], details: ["evidence"] });
  expect((await inspectRequest).postDataJSON()).toMatchObject({ intent: "read" });
  expect(inspected.candidates[0].attributes[0]).toMatchObject({ key: "vegetarian-options", source: "osm:fixture", status: "verified_true" });
  expect(sent.slice(beforeInspection).filter((frame) => frame.type === "viewing" && frame.candidateId)).toEqual([]);

  // The server commits, but the browser loses the response. Repeating exactly
  // the same tool call must recover the original receipt, not create a need.
  let dropped = false;
  const keys: string[] = [];
  await page.route("**/api/commands", async (route) => {
    if (route.request().postDataJSON().type !== "SubmitRequirement") return route.continue();
    keys.push(route.request().headers()["idempotency-key"]);
    if (!dropped) {
      dropped = true;
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  const input = { baseRevision: session.revision, visibility: "shared", hardness: "hard", delegation: { mode: "locked" }, payload: { kind: "attribute", key: "vegetarian-options", expect: "verified_true" } };
  const lost = await call(page, "submit_requirement", input);
  expect(lost.ok).toBe(false);
  const added = await call(page, "submit_requirement", input);
  expect(added.ok).toBe(true);
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBeTruthy();
  expect(keys[1]).toBe(keys[0]);
  expect(added.receipt).toMatchObject({ entity: "requirement", operation: "created", requirement: { active: true, hardness: "hard" } });
  const vegetarian = await call(page, "get_spatial_context");
  expect(vegetarian.feasibility).toMatchObject({ eligible: 1, uncertain: 1, excluded: 1 });
  expect(vegetarian.activeNeeds.filter((n: any) => n.requirementId === added.receipt.id)).toHaveLength(1);
  expect(vegetarian.candidates[0].why).toContain("vegetarian options on record");

  // Later turn, new document: discover again and recover authoritative state.
  // This tests page handles, not the closed Codex REPL's variable persistence.
  await page.reload();
  await ready(page);
  const reconnected = await call(page, "sync_session");
  expect(reconnected.identity.participantId).toBe(session.identity.participantId);
  const expired = await call(page, "get_spatial_context", { cursor: first.page.nextCursor });
  expect(expired.ok).toBe(false);
  expect((await call(page, "get_spatial_context")).activeNeeds.some((n: any) => n.requirementId === added.receipt.id)).toBe(true);

  // Concurrent room change: a stale tool must expose catch-up, not silently
  // replace the agent's revision with the page's newer WebSocket watermark.
  const peer = await apiPost(server.baseUrl, "/api/commands", room.tokens.sarah, { type: "SetReadyState", input: { baseRevision: reconnected.revision, state: "ready" } });
  expect(peer.body.ok).toBe(true);
  const stale = await call(page, "withdraw_requirement", { baseRevision: reconnected.revision, requirementId: added.receipt.id });
  expect(stale.error.code).toBe("sync_required");
  let delta = await call(page, "sync_session", { sinceRevision: reconnected.revision });
  while (delta.delta?.truncated) delta = await call(page, "sync_session", { cursor: delta.delta.cursor });
  const removed = await call(page, "withdraw_requirement", { baseRevision: delta.revision, requirementId: added.receipt.id });
  expect(removed.receipt).toMatchObject({ id: added.receipt.id, operation: "withdrawn" });
  expect((await call(page, "get_spatial_context")).activeNeeds.some((n: any) => n.requirementId === added.receipt.id)).toBe(false);
  // Scope referents are advertised through a local $defs/$ref. Exercise one
  // in native Chrome, not only in the independent Ajv equivalence check.
  const scope = await call(page, "submit_requirement", { ...input, baseRevision: removed.revision, payload: { kind: "scope", dimension: "radius_m", max: 1000, referent: { kind: "point", lat: 52.5, lng: 13.4 } } });
  expect(scope.ok).toBe(true);
  expect(scope.receipt.requirement.payload.referent.kind).toBe("point");
  await page.close();
});
