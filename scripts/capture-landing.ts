/** Re-capture the landing's screenshots from the current application.
 * See apps/web/public/landing/README.md for prerequisites and fixture provenance.
 */
import { chromium, expect, type Page } from "@playwright/test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestRoom, startServer } from "../tests/api/helpers.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const base = process.env.LANDING_BASE_URL ?? "http://127.0.0.1:4183";
const captureOnly = process.env.LANDING_CAPTURE_ONLY;
if (!process.env.DATABASE_URL) throw new Error("Set DATABASE_URL to the capture server's isolated database.");
const out = join(root, "apps/web/public/landing");
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const scenes: Record<string, string> = {
  "hero-desktop": "Three people compare 31 Berlin places against shared vegetarian and budget needs and a private condition. Four still work; The Barn is selected with its per-need verdict visible.",
  "hero-mobile": "The same three-person room and four matching places on the mobile map, with shared needs and an anonymous private-condition effect in the brief.",
  "scopes-mobile": "Joe opens the composer disclosure menu: Shared, Private and Agent only. His own private lactose-free need belongs to the same live room.",
  "impasse-mobile": "Zero places are confirmed within 800 m; 17 remain uncertain. Only the organizer sees an adjustment to widen to 1.2 km and bring back four places.",
  "roster-mobile": "The room roster shows Alex, Joe and Sarah present, Alex's location-sharing controls, and a private-condition effect in the brief.",
  "pending-mobile": "A real outdoor-seating submission is held in transit so the current application's optimistic saying-it state can be photographed.",
  "details-mobile": "A data-improvement demo in The Barn's real details panel: verified needs sit beside a likely outdoor-seating result with Confirm and Rule out controls. Outdoor-seating evidence is deliberately made tentative in this isolated capture fixture, not a new claim about the venue. The capture also exercises Confirm through the real API and verifies that the result becomes yes, records the person who confirmed it and offers undo.",
  "drawer-mobile": "The current under-the-hood drawer displays actual session, tool and websocket traffic from the capture session using the WebMCP test shim.",
  "agreement-mobile": "All three participants accept The Barn; the organizer stages and confirms the choice, opening the real settled arrival and navigation UI.",
  "explore-mobile": "A panned Berlin map displays a place from the shipped area snapshot and the real Bring into the room action.",
  "planning-mobile": "The current onboarding review displays two sequential steps, outdoor dinner then a film. The model transport uses the repository's scripted plan fixture; the real API validates and interprets it.",
};
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const room = await createTestRoom(base, { berlin: true });
const extraRooms: Awaited<ReturnType<typeof createTestRoom>>[] = [];
let planServer: Awaited<ReturnType<typeof startServer>> | undefined;
const pages = {} as Record<"org" | "sarah" | "joe", Page>;

async function settled(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1500);
}

async function capture(page: Page, name: string) {
  if (captureOnly && name !== `${captureOnly}-mobile`) return;
  await page.mouse.move(425, 25);
  await settled(page);
  const png = join(out, `${name}.png`);
  await page.screenshot({ path: png, animations: "disabled" });
  const prompt = `Browser screenshot, not AI-generated. ${scenes[name]} Captured from the current Spokes app using scripts/capture-landing.ts. Test participants and requirements; venue evidence comes from checked-in fixtures and is not a fresh factual verification. No DOM or pixel content edits. Source commit: ${sourceCommit}.`;
  execFileSync("python3", ["-c", "from PIL import Image; import sys; exif=Image.Exif(); exif[270]=sys.argv[3]; Image.open(sys.argv[1]).convert('RGB').save(sys.argv[2], 'WEBP', quality=88, method=6, exif=exif)", png, join(out, `${name}.webp`), prompt]);
  await writeFile(join(out, `${name}.webp.json`), JSON.stringify({ prompt, createdAt: new Date().toISOString(), sourceCommit, viewport: page.viewportSize() }, null, 2) + "\n");
  await rm(png);
  console.log(`Captured ${name}.webp`);
}

async function command(page: Page, act: () => Promise<unknown>, type = "SubmitRequirement") {
  const response = page.waitForResponse(r => r.url().endsWith("/api/commands") && r.request().postDataJSON()?.type === type);
  await act();
  const result = await (await response).json();
  if (!result.ok) throw new Error(JSON.stringify(result));
}

async function say(page: Page, words: string) {
  const input = page.getByLabel("What matters to you?");
  await input.fill(words);
  await command(page, () => input.press("Enter"));
}

/** Keep the evidence-improvement scene independent of the settled group story. */
async function captureDetailsDemo() {
  const demo = await createTestRoom(base, { berlin: true, withOsmRefs: true });
  extraRooms.push(demo);
  await demo.pool.query(
    "UPDATE rooms SET goal = 'Somewhere to catch up in Mitte', scope = jsonb_set(scope, '{area,radiusM}', '1200') WHERE id = $1",
    [demo.roomId],
  );
  // Only the owned capture room changes. The shipped venue dataset stays intact.
  await demo.pool.query(
    `UPDATE candidates SET attributes = (
       SELECT jsonb_agg(CASE WHEN attribute->>'key' = 'outdoor-seating'
         THEN attribute || '{"status":"likely_true","confidence":0.6,"source":"curated:capture-scenario"}'::jsonb
         ELSE attribute END)
       FROM jsonb_array_elements(attributes) AS attribute
     ) WHERE room_id = $1 AND name = 'The Barn'`,
    [demo.roomId],
  );
  const participants = {} as Record<"org" | "sarah" | "joe", Page>;
  for (const key of ["org", "sarah", "joe"] as const) {
    const context = await browser.newContext({ viewport: { width: 430, height: 932 },
      deviceScaleFactor: 1, locale: "en-GB", timezoneId: "Europe/Berlin", reducedMotion: "reduce" });
    const page = await context.newPage();
    participants[key] = page;
    await page.goto(`${base}/#invite=${demo.inviteSecrets[key]}`);
    await expect(page.getByTestId("map-region")).toBeVisible({ timeout: 20000 });
    if (await page.getByTestId("close-drawer").isVisible()) await page.getByTestId("close-drawer").click();
  }
  await command(participants.sarah, () => participants.sarah.getByTestId("pill-vegetarian-options").click());
  await participants.joe.getByTestId("composer-scope").click();
  await participants.joe.getByTestId("scope-application-private").click();
  await say(participants.joe, "lactose-free options");
  const organizer = participants.org;
  await say(organizer, "€20");
  await command(organizer, () => organizer.getByTestId("pill-outdoor-seating").click());
  await organizer.locator('[data-testid^="pin-"][aria-label^="The Barn —"]').press("Enter");
  const details = organizer.getByTestId("place-details");
  await expect(details).toHaveAttribute("aria-label", "The Barn");
  const tentative = details.locator(".check-row").filter({ hasText: "outdoor seating" });
  await expect(tentative).toHaveAttribute("data-mark", "likely");
  await expect(tentative.getByRole("button", { name: "Confirm", exact: true })).toBeVisible();
  await expect(tentative.getByRole("button", { name: "Rule out", exact: true })).toBeVisible();
  const definitive = details.locator('.check-row:is([data-mark="in"], [data-mark="out"], [data-mark="private"])');
  expect(await definitive.count()).toBeGreaterThan(0);
  await expect(definitive.getByRole("button", { name: /^(Confirm|Rule out)$/ })).toHaveCount(0);
  await details.getByTestId("facts-summary").click();
  await capture(organizer, "details-mobile");

  // The published image is the choice before acting; verify the action works too.
  await command(organizer, () => tentative.getByRole("button", { name: "Confirm", exact: true }).click(), "ConfirmFact");
  await expect(tentative).toHaveAttribute("data-mark", "in");
  await expect(tentative).toContainText("confirmed by you");
  await expect(tentative.getByRole("button", { name: "undo", exact: true })).toBeVisible();
  await expect(tentative.getByRole("button", { name: /^(Confirm|Rule out)$/ })).toHaveCount(0);
  const sidecar = join(out, "details-mobile.webp.json");
  const metadata = JSON.parse(await readFile(sidecar, "utf8"));
  await writeFile(sidecar, JSON.stringify({ ...metadata,
    fixture: { attribute: "outdoor-seating", status: "likely_true", confidence: 0.6, scope: "isolated capture room only" },
    verification: { before: "likely", confirmVisible: true, ruleOutVisible: true,
      definitiveConfirmationActions: 0, command: "ConfirmFact", after: "yes", attributionVisible: true, undoVisible: true },
  }, null, 2) + "\n");
  console.log("Verified details demo: likely → Confirm → yes, attributed to you, with undo.");
  for (const page of Object.values(participants)) await page.context().close();
}

try {
  if (!["planning", "explore", "details"].includes(captureOnly ?? "")) {
    await room.pool.query("UPDATE rooms SET goal = 'Somewhere to catch up in Mitte' WHERE id = $1", [room.roomId]);
    for (const key of ["org", "sarah", "joe"] as const) {
      const context = await browser.newContext({ viewport: key === "org" ? { width: 1440, height: 900 } : { width: 430, height: 932 }, deviceScaleFactor: 1, locale: "en-GB", timezoneId: "Europe/Berlin" });
      const page = await context.newPage();
      pages[key] = page;
      await page.goto(`${base}/?shim=webmcp#invite=${room.inviteSecrets[key]}`);
      await expect(page.getByTestId("map-region")).toBeVisible({ timeout: 20000 });
      await page.getByTestId("close-drawer").click();
    }
    await command(pages.sarah, () => pages.sarah.getByTestId("pill-vegetarian-options").click());
    await pages.joe.getByTestId("composer-scope").click();
    await pages.joe.getByTestId("scope-application-private").click();
    await say(pages.joe, "lactose-free options");
    await say(pages.org, "€20");
    const organizer = pages.org;
    await organizer.setViewportSize({ width: 430, height: 932 });
    const adjustment = organizer.getByTestId("adjustment-card").filter({ hasText: "Widen the area" }).first();
    await expect(adjustment).toBeVisible({ timeout: 15000 });
    await capture(organizer, "impasse-mobile");
    await command(organizer, () => adjustment.locator('[data-testid^="grant-"]').click(), "ResolvePrivateRequest");
    const confirmation = organizer.getByTestId("confirm-card").filter({ hasText: "Widen the area" });
    await command(organizer, () => confirmation.getByTestId("confirm-grant").click(), "ConfirmPrivateRequest");
    await expect(organizer.getByTestId("count-number")).toHaveText("4", { timeout: 15000 });

    await organizer.setViewportSize({ width: 1440, height: 900 });
    const barn = organizer.locator('[data-testid^="pin-"][aria-label^="The Barn —"]');
    await barn.press("Enter");
    await expect(organizer.getByTestId("place-details")).toHaveAttribute("aria-label", "The Barn");
    await capture(pages.org, "hero-desktop");

    await organizer.getByTestId("details-close").click();
    await organizer.setViewportSize({ width: 430, height: 932 });
    await organizer.reload();
    await expect(organizer.getByTestId("map-region")).toBeVisible({ timeout: 20000 });
    if (await organizer.getByTestId("close-drawer").isVisible()) await organizer.getByTestId("close-drawer").click();
    await capture(organizer, "hero-mobile");
    await organizer.setViewportSize({ width: 430, height: 932 });

    await pages.joe.getByTestId("composer-scope").click();
    await capture(pages.joe, "scopes-mobile");
    await pages.joe.keyboard.press("Escape");

    await organizer.getByTestId("avatars").click();
    await expect(organizer.getByTestId("roster-card")).toBeVisible();
    await capture(organizer, "roster-mobile");
    await organizer.keyboard.press("Escape");

    // Hold this actual request long enough to photograph the real optimistic state.
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await organizer.route("**/api/commands", async route => {
      if (route.request().postDataJSON()?.type === "SubmitRequirement") await gate;
      await route.continue();
    });
    await organizer.getByTestId("pill-outdoor-seating").click();
    await expect(organizer.getByTestId("need-provisional")).toBeVisible();
    try {
      await capture(organizer, "pending-mobile");
    } finally {
      release();
    }
    await expect(organizer.getByTestId("need-provisional")).toHaveCount(0);
    await organizer.unroute("**/api/commands");

    await barn.press("Enter");
    const details = organizer.getByTestId("place-details");
    await expect(details).toHaveAttribute("aria-label", "The Barn");
    await details.getByTestId("facts-summary").click();
    await details.getByTestId("details-close").click();

    await organizer.getByTestId("open-drawer").click();
    await capture(organizer, "drawer-mobile");
    await organizer.getByTestId("close-drawer").click();

    // All three people accept, then the organizer stages and confirms in the UI.
    await barn.press("Enter");
    await command(organizer, () => details.getByTestId("propose-btn").click(), "ProposeDestination");
    await command(organizer, () => details.getByTestId("accept-btn").click(), "RespondToProposal");
    for (const key of ["sarah", "joe"] as const) {
      await expect(pages[key].getByTestId("stance-card")).toContainText("The Barn", { timeout: 15000 });
      await command(pages[key], () => pages[key].getByTestId("stance-accept").click(), "RespondToProposal");
    }
    await details.getByTestId("details-close").click();
    const stage = organizer.getByTestId("stage-card").filter({ hasText: "The Barn" });
    await expect(stage).toHaveAttribute("data-ready", "true", { timeout: 15000 });
    await stage.locator('[data-testid^="stage-"]').click();
    await organizer.getByTestId("commit-card").locator('[data-testid^="commit-"]').click();
    await expect(organizer.getByTestId("arrival-banner")).toContainText("The Barn", { timeout: 15000 });
    await capture(organizer, "agreement-mobile");
  }

  if (!captureOnly || captureOnly === "details") await captureDetailsDemo();

  if (!captureOnly || captureOnly === "explore") {
    // Explore uses the actual checked-in Berlin snapshot, through the normal API.
    const exploreRoom = await createTestRoom(base, { berlin: true, withOsmRefs: true });
    extraRooms.push(exploreRoom);
    await exploreRoom.pool.query("UPDATE rooms SET goal = 'A place by the river', area_id = 'berlin-mitte' WHERE id = $1", [exploreRoom.roomId]);
    const exploreContext = await browser.newContext({ viewport: { width: 430, height: 932 }, locale: "en-GB" });
    const explorer = await exploreContext.newPage();
    let snapshotPlaces: Array<{ candidateId?: string; location: { lat: number; lng: number } }> = [];
    explorer.on("response", async response => {
      if (response.ok() && response.url().includes(`/api/rooms/${exploreRoom.roomId}/places?`)) {
        snapshotPlaces = (await response.json()).places ?? [];
      }
    });
    await explorer.goto(`${base}/?shim=webmcp#invite=${exploreRoom.inviteSecrets.org}`);
    await expect(explorer.getByTestId("map-region")).toBeVisible();
    await explorer.getByTestId("close-drawer").click();
    await settled(explorer);
    const canvas = await explorer.locator(".maplibregl-canvas").boundingBox();
    if (!canvas) throw new Error("Missing explore map canvas");
    await explorer.mouse.move(canvas.x + canvas.width * .75, canvas.y + canvas.height * .65);
    await explorer.mouse.down();
    await explorer.mouse.move(canvas.x + 35, canvas.y + canvas.height * .65, { steps: 16 });
    await explorer.mouse.up();
    await settled(explorer);
    const exploreSelect = explorer.getByLabel("Explore places in view");
    await expect.poll(() => exploreSelect.locator("option").count()).toBeGreaterThan(1);
    // The map's read-only stats expose its actual camera. Project real snapshot
    // coordinates to click a visible dot precisely; no map or UI state is injected.
    const camera = await explorer.evaluate(() => (window as unknown as {
      __spokesMapStats(): { center: [number, number]; zoom: number };
    }).__spokesMapStats());
    const worldSize = 512 * 2 ** camera.zoom;
    const project = (lng: number, lat: number) => {
      const sin = Math.sin(lat * Math.PI / 180);
      return [(lng + 180) / 360 * worldSize, (.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * worldSize];
    };
    const centre = project(...camera.center);
    const points = snapshotPlaces.filter(place => !place.candidateId).map(place => {
      const point = project(place.location.lng, place.location.lat);
      return { x: point[0] - centre[0] + canvas.width / 2, y: point[1] - centre[1] + canvas.height / 2 };
    }).filter(point => point.x > 150 && point.x < 280 && point.y > 160 && point.y < canvas.height - 80)
      .sort((a, b) => (a.x - 215) ** 2 + (a.y - canvas.height * .6) ** 2 - (b.x - 215) ** 2 - (b.y - canvas.height * .6) ** 2);
    let readable = false;
    for (const { x, y } of points.slice(0, 20)) {
      await explorer.mouse.click(canvas.x + x, canvas.y + y);
      await explorer.waitForTimeout(300);
      const selectedCard = explorer.getByTestId("explore-card");
      const card = await selectedCard.isVisible() ? await selectedCard.boundingBox() : null;
      if (card && card.x >= 5 && card.y >= 70 && card.x + card.width <= 425 && card.y + card.height <= canvas.y + canvas.height) {
        readable = true;
        break;
      }
      if (await explorer.getByTestId("details-close").isVisible()) await explorer.getByTestId("details-close").click();
    }
    if (!readable) throw new Error("Could not open a fully visible exploration card.");
    console.log(`Explore card: ${await explorer.getByTestId("explore-card").innerText()}`);
    await capture(explorer, "explore-mobile");
  }

  if (!captureOnly || captureOnly === "planning") {
    // Only the model transport is scripted. The real plan API validates and
    // interprets its output, and the current onboarding UI renders that response.
    planServer = await startServer({
      entrypoint: "tests/api/fixtures/plans-server.ts",
      env: { LLM_PROVIDER: "openai", OPENAI_API_KEY: "scripted-only", POOL_FILL: "0" },
    });
    const planContext = await browser.newContext({ viewport: { width: 430, height: 932 }, locale: "en-GB", timezoneId: "Europe/Berlin" });
    const planner = await planContext.newPage();
    await planner.route("**/api/plans/preview", async route => {
      // The browser's original Origin belongs to the first local server. Send
      // the same JSON directly, rather than violating the second server's CSRF guard.
      const response = await fetch(`${planServer!.baseUrl}/api/plans/preview`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: route.request().postData(),
      });
      await route.fulfill({ status: response.status, contentType: "application/json", body: await response.text() });
    });
    await planner.goto(`${base}/#start`);
    await planner.getByTestId("ask-name").fill("Alex");
    await planner.getByTestId("ask-goal").fill("Dinner outdoors, then the new MCU film");
    await planner.getByTestId("ask-continue").click();
    await expect(planner.getByTestId("plan-step-s2")).toBeVisible();
    await capture(planner, "planning-mobile");
  }
} catch (error) {
  for (const [key, page] of Object.entries(pages)) {
    console.error(`${key}: ${(await page.locator("body").innerText()).slice(0, 1200)}`);
  }
  throw error;
} finally {
  await browser.close();
  await planServer?.stop();
  for (const extra of extraRooms) await extra.cleanup();
  await room.cleanup();
}
