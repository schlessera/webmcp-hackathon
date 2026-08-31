import { test, expect, chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createTestRoom, type TestRoom, DATABASE_URL } from "../api/helpers.ts";

/**
 * Live three-context product flow over the REAL server: the demo trajectory
 * (needs → private exclusion → impasse → private consent → widened scope →
 * proposal/veto/accept → staged+committed agreement → arrival) driven through
 * the product UI. Capability-gated: skips until the server exposes
 * /api/spatial/context (impl-core's half of the slice).
 *
 * Requires the API-test room to be seeded with the Berlin Mitte dataset
 * (helpers' createTestRoom with the real venues — see tests/api/helpers.ts).
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = 43174;
const BASE = `http://127.0.0.1:${PORT}`;

let server: ChildProcess;
let browser: Browser;
let room: TestRoom;
let contexts: BrowserContext[] = [];
let spatialReady = false;

test.beforeAll(async () => {
  server = spawn("node", [join(repoRoot, "apps", "server", "src", "server.ts")], {
    env: {
      ...process.env,
      DATABASE_URL,
      PORT: String(PORT),
      BUILD_ID: "e2e-flow-1",
      LOG_LEVEL: "warn",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      if ((await fetch(`${BASE}/api/meta`)).ok) break;
    } catch { /* retry */ }
    if (Date.now() > deadline) throw new Error("server did not start");
    await new Promise((r) => setTimeout(r, 250));
  }
  // Capability probe: 404 → impl-core's spatial endpoints not landed yet.
  const probe = await fetch(`${BASE}/api/spatial/context`, { method: "POST" });
  spatialReady = probe.status !== 404;
  if (!spatialReady) return;
  room = await createTestRoom(BASE, { berlin: true });
  browser = await chromium.launch();
});

test.afterAll(async () => {
  for (const ctx of contexts) await ctx.close().catch(() => {});
  await browser?.close().catch(() => {});
  await room?.cleanup();
  server?.kill("SIGTERM");
});

test("demo trajectory through the product UI", async () => {
  test.skip(!spatialReady, "server spatial endpoints not available yet");
  // Three live contexts, remote basemap tiles, and a full negotiation arc —
  // comfortably more than the default 60s budget.
  test.setTimeout(180000);

  const pages: Record<"org" | "sarah" | "joe", Page> = {} as never;
  const bodies: Record<string, string[]> = { org: [], sarah: [], joe: [] };
  for (const key of ["org", "sarah", "joe"] as const) {
    const context = await browser.newContext({ viewport: { width: 640, height: 900 } });
    contexts.push(context);
    const page = await context.newPage();
    page.on("websocket", (socket) =>
      socket.on("framereceived", (frame) => bodies[key].push(`ws:${String(frame.payload)}`)),
    );
    page.on("response", (response) => {
      if (response.url().includes("/api/")) {
        response.text().then((t) => bodies[key].push(t), () => {});
      }
    });
    await page.goto(`${BASE}/?shim=webmcp#invite=${room.inviteSecrets[key]}`);
    await expect(page.getByTestId("map-region")).toBeVisible();
    pages[key] = page;
  }

  const addNeed = async (
    page: Page,
    need: string,
    visibility: "shared" | "application-private",
  ) => {
    await page.getByTestId("tab-needs").click();
    await page.getByTestId("need-select").selectOption(need);
    await page.getByTestId(`visibility-${visibility}`).click();
    await page.getByTestId("add-need").click();
  };

  // Sarah: shared vegetarian. Joe: private lactose-free. Org: exclusion+budget.
  await addNeed(pages.sarah, "vegetarian-options", "shared");
  await addNeed(pages.joe, "lactose-free-options", "application-private");
  await addNeed(pages.org, "exclude-cuisine", "shared");
  await pages.org.getByTestId("need-select").selectOption("budget");
  await pages.org.getByTestId("budget-input").fill("15");
  await pages.org.getByTestId("visibility-shared").click();
  await pages.org.getByTestId("add-need").click();

  // Impasse reached in every context; peers never saw Joe's payload.
  for (const key of ["org", "sarah", "joe"] as const) {
    await expect(pages[key].getByTestId("impasse-banner")).toBeVisible({ timeout: 15000 });
  }
  // The attribute NAME legitimately appears in the capability manifest and in
  // candidate dossiers; what must never reach peers is Joe's requirement
  // PAYLOAD (key + expectation pair).
  for (const key of ["org", "sarah"] as const) {
    for (const body of bodies[key]) {
      expect(body, `${key} leaked lactose requirement payload`).not.toMatch(
        /"key":\s*"lactose-free-options"\s*,\s*"expect"/,
      );
    }
  }

  // The scope adjustment is offered privately (organizer consents in v1).
  await pages.org.getByTestId("tab-decisions").click();
  const adjustment = pages.org.getByTestId("adjustment-card");
  await expect(adjustment).toBeVisible({ timeout: 15000 });
  const requestId = (await adjustment
    .locator('[data-testid^="grant-"]')
    .getAttribute("data-testid"))!.replace("grant-", "");
  // Adjustment content stays out of the other contexts.
  await expect(pages.sarah.getByTestId("adjustment-card")).toHaveCount(0);
  await expect(pages.joe.getByTestId("adjustment-card")).toHaveCount(0);

  await adjustment.getByTestId(`grant-${requestId}`).click();
  // A grant outside delegated bounds stages and asks for in-page consent; the
  // card renders after the command result lands, so wait for it briefly.
  const confirm = pages.org.getByTestId("confirm-card");
  const staged = await confirm
    .waitFor({ state: "visible", timeout: 5000 })
    .then(() => true, () => false);
  if (staged) await confirm.getByTestId("confirm-grant").click();

  // Scope widens in ALL three contexts; impasse resolves.
  for (const key of ["org", "sarah", "joe"] as const) {
    await expect(pages[key].getByTestId("map-region")).toHaveAttribute(
      "data-scope-radius",
      /1[0-9]{3}/,
      { timeout: 15000 },
    );
    await expect(pages[key].getByTestId("impasse-banner")).toHaveCount(0);
  }

  // Candidate ids carry a per-room suffix in test fixtures — address pins by
  // their accessible name. Force: maplibre keeps nudging marker transforms
  // under software WebGL, so strict stability never settles.
  const pin = (page: Page, name: string) =>
    page.getByRole("button", { name: new RegExp(`^${name} \\(`) });

  // The organizer's AGENT proposes the veto target through the WebMCP tool
  // surface (real registration layer via the test shim): reads the trimmed
  // spatial context, focuses the pin locally, then dispatches the same
  // ProposeDestination command a pin tap produces.
  const toolPropose = await pages.org.evaluate(async () => {
    const shim = (window as never as {
      __webmcpTestShim: { executeTool(name: string, args: string): Promise<unknown> };
    }).__webmcpTestShim;
    const call = async (name: string, args: unknown) => {
      const result = (await shim.executeTool(name, JSON.stringify(args))) as {
        content: Array<{ text: string }>;
      };
      return { parsed: JSON.parse(result.content[0].text), rawLen: result.content[0].text.length };
    };
    const context = await call("get_spatial_context", {});
    const target = (context.parsed.candidates as Array<{ candidateId: string; name: string; location?: unknown }>)
      .find((c) => c.name === "Chén Ché")!;
    const focus = await call("focus_destination", { candidateId: target.candidateId });
    const sync = await call("sync_session", {});
    const propose = await call("propose_destination", {
      candidateId: target.candidateId,
      baseRevision: sync.parsed.revision,
    });
    // Trimmed inspect: three full dossiers must fit the ~1.5K result budget.
    const inspect = await call("inspect_candidates", {
      candidateIds: (context.parsed.candidates as Array<{ candidateId: string }>)
        .slice(0, 3)
        .map((c) => c.candidateId),
    });
    return {
      contextOk: context.parsed.ok,
      contextLen: context.rawLen,
      rows: context.parsed.candidates.length,
      rowHasCoords: "location" in (context.parsed.candidates[0] ?? {}),
      focusOk: focus.parsed.ok,
      proposeOk: propose.parsed.ok,
      proposeEffect: propose.parsed.effect ?? propose.parsed.error?.message,
      inspectOk: inspect.parsed.ok,
      inspectLen: inspect.rawLen,
      inspectAttrsCompact:
        typeof inspect.parsed.candidates?.[0]?.attributes?.[0] === "string",
    };
  });
  expect(toolPropose.contextOk).toBe(true);
  expect(toolPropose.rows).toBeLessThanOrEqual(8);
  expect(toolPropose.rowHasCoords).toBe(false);
  expect(toolPropose.contextLen, "tool result exceeds the ~1.5K budget").toBeLessThanOrEqual(2000);
  expect(toolPropose.focusOk).toBe(true);
  expect(toolPropose.proposeOk, String(toolPropose.proposeEffect)).toBe(true);
  expect(toolPropose.inspectOk).toBe(true);
  expect(toolPropose.inspectAttrsCompact, "inspect trim not applied").toBe(true);
  expect(toolPropose.inspectLen, "3 dossiers exceed the ~1.5K budget").toBeLessThanOrEqual(2000);
  // The agent's action landed on the org's own map (UI-before-return)…
  await expect(pages.org.locator('.pin[data-proposed="true"]')).toHaveCount(1);
  await pages.sarah.getByTestId("tab-decisions").click();
  await pages.sarah.getByTestId("stance-look").click();
  await pages.sarah.getByTestId("veto-btn").click();
  await pages.sarah.getByTestId("veto-menu").getByText("Visited too recently").click();
  await expect(pages.org.locator('.pin[data-vetoed="true"]')).toHaveCount(1, {
    timeout: 15000,
  });

  // Propose The Barn from the org's sheet; everyone accepts via their stance
  // card and flips ready. The sheet's dossier comes from the REAL
  // /api/spatial/inspect here — attribute chips and evidence must render
  // (regression guard: the client once read a key the server never returns).
  await pin(pages.org, "The Barn").click({ force: true });
  const sheet = pages.org.getByTestId("candidate-sheet");
  await expect(sheet.locator(".attr-chip").first()).toBeVisible({ timeout: 10000 });
  await expect(sheet.locator('.attr-chip[data-status="verified_true"]').first()).toBeVisible();
  await sheet.getByTestId("details-btn").click();
  await expect(sheet.getByTestId("dossier-details")).toContainText("osm:");
  await pages.org.screenshot({
    path: "test-results/spokes-live-details.png",
    fullPage: true,
  });
  await sheet.getByTestId("details-btn").click(); // collapse again
  await pages.org.getByTestId("propose-btn").click();
  for (const key of ["org", "sarah", "joe"] as const) {
    await pages[key].getByTestId("tab-decisions").click();
    await pages[key].getByTestId("stance-accept").click();
    await pages[key].getByTestId("toggle-ready").click();
  }

  // Organizer stages, then commits in-page.
  await pages.org.getByTestId("tab-decisions").click();
  await pages.org.getByTestId("stage-card").locator('button[data-testid^="stage-"]').click();
  const commit = pages.org.getByTestId("commit-card");
  await expect(commit).toBeVisible({ timeout: 15000 });
  await commit.locator('[data-testid^="commit-"]').click();

  // Arrival mode lands everywhere with a working handoff link.
  for (const key of ["org", "sarah", "joe"] as const) {
    await expect(pages[key].getByTestId("arrival-banner")).toBeVisible({ timeout: 15000 });
    await expect(pages[key].getByTestId("navigate-link")).toHaveAttribute(
      "href",
      /google\.com\/maps\/dir\/\?api=1&destination=/,
    );
  }
});
