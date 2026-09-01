import {
  chromium,
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  apiPost,
  createTestRoom,
  DATABASE_URL,
  type TestRoom,
} from "../api/helpers.ts";

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
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await fetch(`${BASE}/api/meta`)).ok) break;
    } catch {
      // retry
    }
    if (Date.now() > deadline) throw new Error("server did not start");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const probe = await fetch(`${BASE}/api/spatial/context`, { method: "POST" });
  spatialReady = probe.status !== 404;
  if (!spatialReady) return;
  room = await createTestRoom(BASE, { berlin: true });
  browser = await chromium.launch();
});

test.afterAll(async () => {
  for (const context of contexts) await context.close().catch(() => {});
  await browser?.close().catch(() => {});
  await room?.cleanup();
  server?.kill("SIGTERM");
});

test("demo trajectory through the product UI", async () => {
  test.skip(!spatialReady, "server spatial endpoints not available yet");
  test.setTimeout(180_000);

  const pages: Record<"org" | "sarah" | "joe", Page> = {} as never;
  const bodies: Record<"org" | "sarah" | "joe", string[]> = {
    org: [],
    sarah: [],
    joe: [],
  };
  for (const key of ["org", "sarah", "joe"] as const) {
    const context = await browser.newContext({ viewport: { width: 1180, height: 900 } });
    contexts.push(context);
    const page = await context.newPage();
    page.on("websocket", (socket) =>
      socket.on("framereceived", (frame) => bodies[key].push(`ws:${String(frame.payload)}`)),
    );
    page.on("response", (response) => {
      if (response.url().includes("/api/")) {
        response.text().then((text) => bodies[key].push(text), () => {});
      }
    });
    await page.goto(`${BASE}/?shim=webmcp#invite=${room.inviteSecrets[key]}`);
    await expect(page.getByTestId("map-region")).toHaveAttribute(
      "data-scope-radius",
      "800",
    );
    await page.getByTestId("close-drawer").click();
    pages[key] = page;
  }

  for (const viewer of ["org", "sarah", "joe"] as const) {
    await expect(pages[viewer].getByTestId("invite-card")).toHaveCount(0);
    for (const participant of ["org", "sarah", "joe"] as const) {
      await expect(
        pages[viewer].getByTestId(`avatar-${room.participantIds[participant]}`),
      ).toHaveAttribute("data-present", "true");
    }
  }

  const input = (page: Page) => page.getByLabel("What matters to you?");
  const commandResponse = (page: Page, type?: string) =>
    page.waitForResponse(
      (candidate) =>
        candidate.url().endsWith("/api/commands") &&
        candidate.request().method() === "POST" &&
        (!type || candidate.request().postDataJSON()?.type === type),
    );
  const clickCommand = async (
    page: Page,
    action: () => Promise<unknown>,
    type?: string,
  ) => {
    const response = commandResponse(page, type);
    await action();
    return response;
  };
  const submitText = async (page: Page, text: string) => {
    await input(page).fill(text);
    await clickCommand(page, () => input(page).press("Enter"), "SubmitRequirement");
  };
  const ownNeed = (page: Page, label: string) =>
    page.locator('[data-testid^="need-"]').filter({ hasText: label });

  // A fully excluded set is the honest count-block impasse. Toggle it back
  // off before the demo requirements so the council can find a radius gain.
  await submitText(pages.org, "€1");
  for (const key of ["org", "sarah", "joe"] as const) {
    await expect(pages[key].getByTestId("count-block")).toHaveAttribute(
      "data-state",
      "impasse",
      { timeout: 15_000 },
    );
    await expect(pages[key].getByTestId("ways-out")).toBeVisible();
  }
  const impossibleBudget = ownNeed(pages.org, "budget €1");
  await impossibleBudget.focus();
  await clickCommand(
    pages.org,
    () => pages.org.keyboard.press("Enter"),
    "SetRequirementActive",
  );
  await expect(impossibleBudget).toHaveAttribute("aria-pressed", "false");
  await expect(pages.org.getByTestId("count-block")).toHaveAttribute("data-state", "pre");

  // Needs are stated through the redesigned composer: server-authored pills,
  // Joe's scope menu, and free text parsed into a budget requirement.
  await clickCommand(
    pages.sarah,
    () => pages.sarah.getByTestId("pill-vegetarian-options").click(),
    "SubmitRequirement",
  );
  await expect(ownNeed(pages.sarah, "vegetarian options")).toBeVisible();

  await pages.joe.getByTestId("composer-scope").click();
  await pages.joe.getByTestId("scope-application-private").click();
  await submitText(pages.joe, "lactose-free options");
  await expect(ownNeed(pages.joe, "lactose-free options")).toHaveAttribute(
    "data-variant",
    "private",
  );

  await submitText(pages.org, "€10");
  await expect(ownNeed(pages.org, "budget €10")).toBeVisible();

  // The council declares the impasse, so the count block says so too — and
  // the unknowns stay counted in its subline rather than being folded into
  // the failure (CLAUDE.md §4). Ways out are quantified; the organizer gets a
  // private adjustment.
  await expect(pages.joe.getByTestId("ways-out")).toBeVisible({ timeout: 15_000 });
  for (const key of ["org", "sarah", "joe"] as const) {
    await expect(pages[key].getByTestId("count-block")).toHaveAttribute(
      "data-state",
      "impasse",
    );
    await expect(pages[key].getByTestId("count-block")).toContainText(/\d+ unsure/);
  }
  await expect(pages.org.getByTestId("private-effect")).toBeVisible();
  await expect(pages.sarah.getByTestId("private-effect")).toBeVisible();
  await expect(pages.org.getByTestId("brief")).not.toContainText("lactose-free options");
  await expect(pages.sarah.getByTestId("brief")).not.toContainText("lactose-free options");

  type LiveContext = {
    ok: true;
    matching: number;
    activeNeeds: Array<{
      id: string;
      label: string;
      ownerId: string;
      wouldReturn: number;
    }>;
  };
  const joeLive = (
    await apiPost<LiveContext>(BASE, "/api/spatial/context", room.tokens.joe, {})
  ).body;
  const heldOwn = joeLive.activeNeeds.find(
    (need) => need.ownerId === room.participantIds.joe && need.label === "lactose-free options",
  );
  if (!heldOwn) throw new Error("Joe's held private need was missing from his context");
  expect(heldOwn.wouldReturn).toBeGreaterThan(0);
  const ownPreview = (
    await apiPost<LiveContext>(BASE, "/api/spatial/context", room.tokens.joe, {
      excludeRequirementId: heldOwn.id,
    })
  ).body;
  expect(ownPreview.matching).toBe(joeLive.matching + heldOwn.wouldReturn);

  const liveRegion = pages.joe.locator("#brief-preview-count");
  await expect(liveRegion).toHaveAttribute("role", "status");
  await expect(liveRegion).toHaveAttribute("aria-live", "polite");
  const assertPreview = async (matching: number) => {
    await expect(pages.joe.getByTestId("map-region")).toHaveAttribute(
      "data-preview",
      "true",
    );
    await expect(pages.joe.getByTestId("count-number")).toHaveText(String(matching));
    await expect(liveRegion).toHaveText(`${matching} still work`);
  };
  const assertRestored = async () => {
    await expect(pages.joe.getByTestId("map-region")).not.toHaveAttribute(
      "data-preview",
      "true",
    );
    await expect(pages.joe.getByTestId("count-number")).toHaveText(
      String(joeLive.matching),
    );
    await expect(
      pages.joe.locator('[data-testid^="pin-"][data-state="return"]'),
    ).toHaveCount(0);
  };

  const ownRow = pages.joe.getByTestId(`need-${heldOwn.id}`);
  await ownRow.scrollIntoViewIfNeeded();
  const ownBox = await ownRow.boundingBox();
  if (!ownBox) throw new Error("Joe's need row has no pointer target");
  await pages.joe.mouse.move(
    ownBox.x + ownBox.width / 2,
    ownBox.y + ownBox.height / 2,
  );
  await pages.joe.mouse.down();
  await assertPreview(ownPreview.matching);
  await pages.joe.mouse.up();
  await assertRestored();

  await ownRow.focus();
  await pages.joe.keyboard.down("Space");
  await assertPreview(ownPreview.matching);
  await pages.joe.keyboard.up("Space");
  await assertRestored();

  const heldPeer = joeLive.activeNeeds.find(
    (need) => need.ownerId === room.participantIds.sarah,
  );
  if (!heldPeer) throw new Error("Sarah's peer need was missing from Joe's context");
  const peerPreview = (
    await apiPost<LiveContext>(BASE, "/api/spatial/context", room.tokens.joe, {
      excludeRequirementId: heldPeer.id,
    })
  ).body;
  expect(peerPreview.matching).toBe(joeLive.matching + heldPeer.wouldReturn);
  const peerRow = pages.joe.getByTestId(`need-${heldPeer.id}`);
  await expect(peerRow.locator(".need-toggle")).toHaveCount(0);
  await peerRow.scrollIntoViewIfNeeded();
  const peerBox = await peerRow.boundingBox();
  if (!peerBox) throw new Error("Sarah's peer need row has no pointer target");
  await pages.joe.mouse.move(
    peerBox.x + peerBox.width / 2,
    peerBox.y + peerBox.height / 2,
  );
  await pages.joe.mouse.down();
  await assertPreview(peerPreview.matching);
  await pages.joe.mouse.up();
  await assertRestored();

  // Peer response bodies and websocket frames may carry only the effect of
  // Joe's private condition, never its predicate key/expectation pair.
  const syncBody = async (page: Page) => {
    const response = page.waitForResponse(
      (candidate) =>
        candidate.url().endsWith("/api/sync") &&
        candidate.request().method() === "POST",
    );
    const tool = page.evaluate(async () => {
      const shim = (window as never as {
        __webmcpTestShim: { executeTool(name: string, args: string): Promise<unknown> };
      }).__webmcpTestShim;
      await shim.executeTool("sync_session", '{"sinceRevision":0}');
    });
    const [networkResponse] = await Promise.all([response, tool]);
    return networkResponse.text();
  };
  const privacyBodies = {
    org: await syncBody(pages.org),
    sarah: await syncBody(pages.sarah),
    joe: await syncBody(pages.joe),
  };
  for (const key of ["org", "sarah", "joe"] as const) {
    bodies[key].push(privacyBodies[key]);
  }
  const privatePredicate =
    /"key":\s*"lactose-free-options"[\s\S]{0,120}"expect":\s*"verified_true"/;
  expect(privacyBodies.joe, "Joe's owner projection omitted his private predicate").toMatch(
    privatePredicate,
  );
  for (const key of ["org", "sarah"] as const) {
    expect(privacyBodies[key], `${key} leaked Joe's private predicate`).not.toMatch(
      privatePredicate,
    );
  }

  const radiusAdjustment = pages.org
    .getByTestId("adjustment-card")
    .filter({ hasText: "Widen the area" })
    .first();
  await expect(radiusAdjustment).toBeVisible({ timeout: 15_000 });
  await expect(pages.sarah.getByTestId("adjustment-card")).toHaveCount(0);
  await expect(pages.joe.getByTestId("adjustment-card")).toHaveCount(0);
  const grant = radiusAdjustment.locator('[data-testid^="grant-"]');
  await clickCommand(pages.org, () => grant.click(), "ResolvePrivateRequest");
  const confirm = pages.org.getByTestId("confirm-card").filter({ hasText: "Widen the area" });
  await expect(confirm).toBeVisible({ timeout: 10_000 });
  const confirmationRequest = pages.org.waitForRequest(
    (request) =>
      request.url().endsWith("/api/commands") &&
      request.method() === "POST" &&
      request.postDataJSON()?.type === "ConfirmPrivateRequest",
  );
  const confirmationResponse = commandResponse(pages.org, "ConfirmPrivateRequest");
  await confirm.getByTestId("confirm-grant").click({ timeout: 10_000 });
  const [confirmRequest] = await Promise.all([
    confirmationRequest,
    confirmationResponse,
  ]);
  const confirmBody = confirmRequest.postDataJSON() as {
    input?: { confirmationNonce?: string };
  };
  expect(confirmBody.input?.confirmationNonce).toEqual(expect.any(String));
  expect(confirmBody.input?.confirmationNonce?.length).toBeGreaterThan(0);

  for (const key of ["org", "sarah", "joe"] as const) {
    await expect(pages[key].getByTestId("map-region")).toHaveAttribute(
      "data-scope-radius",
      /1\d{3}/,
      { timeout: 15_000 },
    );
  }

  // Read/focus/propose/inspect through the page's real WebMCP registration
  // shim, retaining the compact-result budget assertions from the old lane.
  const firstProposal = await pages.org.evaluate(async () => {
    const shim = (window as never as {
      __webmcpTestShim: { executeTool(name: string, args: string): Promise<unknown> };
    }).__webmcpTestShim;
    const call = async (name: string, args: unknown) => {
      const result = (await shim.executeTool(name, JSON.stringify(args))) as {
        content: Array<{ text: string }>;
      };
      return {
        parsed: JSON.parse(result.content[0].text),
        rawLen: result.content[0].text.length,
      };
    };
    const context = await call("get_spatial_context", {});
    const candidates = context.parsed.candidates as Array<{
      candidateId: string;
      name: string;
      location?: unknown;
    }>;
    const target = candidates.find((candidate) => candidate.name !== "The Barn")!;
    const focus = await call("focus_destination", { candidateId: target.candidateId });
    const sync = await call("sync_session", {});
    const propose = await call("propose_destination", {
      candidateId: target.candidateId,
      baseRevision: sync.parsed.revision,
    });
    const inspect = await call("inspect_candidates", {
      candidateIds: candidates.slice(0, 3).map((candidate) => candidate.candidateId),
    });
    return {
      target,
      contextOk: context.parsed.ok,
      contextLen: context.rawLen,
      rows: candidates.length,
      rowHasCoords: "location" in (candidates[0] ?? {}),
      focusOk: focus.parsed.ok,
      proposeOk: propose.parsed.ok,
      proposeEffect: propose.parsed.effect ?? propose.parsed.error?.message,
      inspectOk: inspect.parsed.ok,
      inspectLen: inspect.rawLen,
      inspectAttrsCompact:
        typeof inspect.parsed.candidates?.[0]?.attributes?.[0] === "string",
    };
  });
  expect(firstProposal.contextOk).toBe(true);
  expect(firstProposal.rows).toBeLessThanOrEqual(8);
  expect(firstProposal.rowHasCoords).toBe(false);
  expect(firstProposal.contextLen).toBeLessThanOrEqual(2000);
  expect(firstProposal.focusOk).toBe(true);
  expect(firstProposal.proposeOk, String(firstProposal.proposeEffect)).toBe(true);
  expect(firstProposal.inspectOk).toBe(true);
  expect(firstProposal.inspectAttrsCompact).toBe(true);
  expect(firstProposal.inspectLen).toBeLessThanOrEqual(2000);

  const proposedPin = pages.org.getByTestId(`pin-${firstProposal.target.candidateId}`);
  await pages.org.getByTestId("place-details").getByTestId("details-close").click();
  await expect(proposedPin).toHaveAttribute("data-state", "proposed");
  await expect(pages.sarah.getByTestId("stance-card")).toContainText(
    `${firstProposal.target.name} is on the table`,
  );
  await pages.sarah.getByTestId("stance-look").click();
  const vetoDetails = pages.sarah.getByTestId("place-details");
  await expect(vetoDetails).toHaveAttribute("aria-label", firstProposal.target.name);
  await clickCommand(pages.sarah, () => vetoDetails.getByTestId("veto-btn").click());
  await expect(proposedPin).not.toHaveAttribute("data-state", "proposed", {
    timeout: 15_000,
  });

  // A fresh proposal is created through the details panel, not the tool.
  const barnPin = pages.org.getByRole("button", { name: /^The Barn —/ });
  await barnPin.click({ force: true });
  const barnDetails = pages.org.getByTestId("place-details");
  await expect(barnDetails).toHaveAttribute("aria-label", "The Barn");
  await expect(barnDetails.getByTestId("verdict")).toBeVisible();
  await expect(barnDetails.locator(".attr-row").first()).toBeVisible({ timeout: 10_000 });
  await clickCommand(pages.org, () => barnDetails.getByTestId("propose-btn").click());
  await expect(barnDetails.getByTestId("accept-btn")).toBeVisible({ timeout: 10_000 });
  await clickCommand(pages.org, () => barnDetails.getByTestId("accept-btn").click());

  await expect(pages.sarah.getByTestId("stance-card")).toContainText("The Barn is on the table");
  await clickCommand(pages.sarah, () => pages.sarah.getByTestId("stance-accept").click());
  await expect(pages.joe.getByTestId("stance-card")).toContainText("The Barn is on the table");
  await pages.joe.getByTestId("stance-look").click();
  await expect(pages.joe.getByTestId("place-details")).toHaveAttribute("aria-label", "The Barn");
  await clickCommand(pages.joe, () =>
    pages.joe.getByTestId("place-details").getByTestId("accept-btn").click(),
  );

  for (const key of ["org", "sarah", "joe"] as const) {
    await clickCommand(pages[key], () => pages[key].getByTestId("toggle-ready").click());
    await expect(pages[key].getByTestId("toggle-ready")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  }

  const stage = pages.org.getByTestId("stage-card").filter({ hasText: "The Barn" });
  await expect(stage).toBeVisible({ timeout: 15_000 });
  await stage.locator('[data-testid^="stage-"]').click();
  const commit = pages.org.getByTestId("commit-card");
  await expect(commit).toContainText("The Barn is staged", { timeout: 15_000 });
  await expect(pages.org.getByTestId("arrival-banner")).toHaveCount(0);
  await expect(pages.org.getByTestId("composer")).toBeVisible();
  await commit.locator('[data-testid^="commit-"]').click({ timeout: 10_000 });

  for (const key of ["org", "sarah", "joe"] as const) {
    await expect(pages[key].getByTestId("arrival-banner")).toContainText("The Barn", {
      timeout: 15_000,
    });
    await expect(pages[key].getByTestId("room-title")).toHaveText("The Barn");
    await expect(pages[key].getByTestId("navigate-link")).toHaveAttribute(
      "href",
      /google\.com\/maps\/dir\/\?api=1&destination=/,
    );
    const modes = pages[key].getByRole("group", {
      name: "How are you getting there?",
    });
    await clickCommand(pages[key], () => modes.getByRole("button", { name: "Bike" }).click());
    await expect(modes.getByRole("button", { name: "Bike" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  }
});
