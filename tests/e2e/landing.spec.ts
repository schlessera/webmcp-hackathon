import { test, expect, chromium, type Browser, type Page } from "@playwright/test";
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

const startClasses = [
  { key: "food", label: "somewhere to eat", count: 18 },
  { key: "cinema", label: "a cinema", count: 4 },
  { key: "park", label: "a park", count: 7 },
];

async function mockGoalStart(
  page: Page,
  preview: Record<string, unknown> | null,
): Promise<Array<Record<string, unknown>>> {
  const roomBodies: Array<Record<string, unknown>> = [];
  await page.route("**/api/areas", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { areas: Array<Record<string, unknown>> };
    await route.fulfill({
      response,
      json: { areas: body.areas.map((area) => ({ ...area, classes: startClasses })) },
    });
  });
  await page.route("**/api/plans/preview", async (route) => {
    if (preview === null) {
      await route.fulfill({ status: 404, json: { error: "not available" } });
      return;
    }
    await route.fulfill({ status: 200, json: preview });
  });
  await page.route("**/api/rooms", async (route) => {
    const input = route.request().postDataJSON() as Record<string, unknown>;
    roomBodies.push(input);
    const goal = typeof input.goal === "string" ? input.goal : "Somewhere in Berlin Mitte";
    const planned = (input.steps as Array<{ placeClass?: string; needs?: unknown[] }> | undefined)
      ?? (input.step ? [input.step as { placeClass?: string; needs?: unknown[] }] : []);
    const classOf = (key: string | undefined) =>
      startClasses.find((item) => item.key === key) ?? startClasses[0]!;
    const selected = classOf(planned[0]?.placeClass);
    await route.fulfill({
      status: 200,
      json: {
        roomId: "room_goal_start",
        areaId: input.areaId,
        goal,
        step: {
          placeClass: { key: selected.key, label: selected.label },
          seeded: planned[0]?.needs?.length ?? 0,
        },
        steps: planned.map((step, index) => ({
          stepId: `s${index + 1}`,
          index: index + 1,
          title: classOf(step.placeClass).label,
          placeClass: {
            key: classOf(step.placeClass).key,
            label: classOf(step.placeClass).label,
          },
          relation: index === 0
            ? { kind: "first" }
            : { kind: "then", afterStepId: `s${index}` },
          when: null,
          status: index === 0 ? "active" : "pending",
          settled: null,
        })),
        activeStepId: planned.length > 0 ? "s1" : null,
        invites: [
          {
            participantId: "p_goal_org",
            displayName: input.organizerName,
            role: "organizer",
            inviteSecret: "goalorgsecret",
          },
          {
            participantId: "p_goal_sarah",
            displayName: "Sarah",
            role: "member",
            inviteSecret: "goalsarahsecret",
          },
        ],
      },
    });
  });
  return roomBodies;
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

test("a goal becomes step boxes, a need can be left out, and a region opens the room", async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const goal = "dinner, then a film near there";
  const roomBodies = await mockGoalStart(page, {
    goal,
    offline: false,
    steps: [
      {
        stepId: "s1",
        index: 1,
        title: "dinner",
        placeClass: { key: "food", label: "somewhere to eat" },
        relation: { kind: "first" },
        needs: [
          {
            payload: { kind: "attribute", key: "outdoor-seating", expect: "verified_true" },
            label: "outdoor seating",
            gist: "outdoor seating",
          },
          {
            payload: { kind: "scope", dimension: "walk_min", max: 10 },
            label: "within 10 min walk",
            gist: "within 10 min walk",
          },
        ],
        when: null,
      },
      {
        stepId: "s2",
        index: 2,
        title: "a film",
        placeClass: { key: "cinema", label: "a cinema" },
        relation: { kind: "then", afterStepId: "s1" },
        needs: [],
        when: null,
      },
    ],
    classes: [],
    clarify: null,
    meta: { model: "scripted", ms: 12 },
  });
  await page.goto(`${BASE}/#start`);

  await page.getByTestId("ask-name").fill("Alex");
  await page.getByTestId("ask-goal").fill(goal);
  await page.getByTestId("ask-continue").click();

  // Two boxes, in order, and the second says it follows the first.
  await expect(page.getByTestId("onboarding-plan")).toBeVisible();
  await expect(page.getByTestId("plan-count")).toContainText("2 places to find");
  await expect(page.getByTestId("plan-step-s1")).toContainText("Step 1 of 2");
  await expect(page.getByTestId("plan-step-s2")).toContainText("Step 2 of 2");
  await expect(page.getByTestId("plan-step-s2")).toContainText("after that, near there");
  await expect(page.getByTestId("plan-step-class-s2")).toHaveValue("cinema");

  // A pending row can be dropped, and its tap target clears the floor.
  const drop = page.getByTestId("plan-step-s1").getByRole("button", { name: /Leave out/ }).first();
  expect((await drop.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await drop.click();
  await expect(page.getByTestId("plan-step-s1").locator(".step-need")).toHaveCount(1);

  // The region dialog is the last thing asked, and says why it exists.
  await page.getByTestId("plan-confirm").click();
  const dialog = page.getByTestId("region-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("demo limit");
  await expect(dialog).toContainText("built to work anywhere");
  await page.getByTestId("region-berlin-mitte").click();

  expect(roomBodies).toHaveLength(1);
  expect(roomBodies[0]).toMatchObject({
    areaId: "berlin-mitte",
    organizerName: "Alex",
    goal,
    steps: [
      { placeClass: "food", needs: [{ label: "within 10 min walk" }] },
      { placeClass: "cinema" },
    ],
  });
  await context.close();
});

test("a missing preview still opens a room, with the class the person picks", async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const roomBodies = await mockGoalStart(page, null);
  await page.goto(`${BASE}/#start`);

  await page.getByTestId("ask-name").fill("Alex");
  await page.getByTestId("ask-goal").fill("a walk after work");
  await page.getByTestId("ask-continue").click();

  await expect(page.getByTestId("onboarding-plan")).toBeVisible();
  await expect(page.getByTestId("start")).toContainText("could not be read");
  // The class list still comes from the server, so the room is still openable.
  await expect(page.getByTestId("plan-step-class-s1").locator("option"))
    .toHaveCount(startClasses.length);
  await page.getByTestId("plan-step-class-s1").selectOption("park");
  await page.getByTestId("plan-confirm").click();
  await page.getByTestId("region-berlin-mitte").click();

  expect(roomBodies[0]).toMatchObject({
    goal: "a walk after work",
    steps: [{ placeClass: "park" }],
  });
  await context.close();
});

test("a preview clarification adds the chosen needs to the pending rows", async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const goal = "lunch near the station";
  await mockGoalStart(page, {
    goal,
    offline: false,
    steps: [
      {
        stepId: "s1",
        index: 1,
        title: "lunch",
        placeClass: { key: "food", label: "somewhere to eat" },
        relation: { kind: "first" },
        needs: [
          {
            payload: { kind: "time_window", start: "2026-09-03T12:00:00+02:00", end: "2026-09-03T14:00:00+02:00" },
            label: "at lunch",
            gist: "at lunch",
          },
        ],
        when: null,
      },
    ],
    classes: startClasses,
    clarify: {
      question: "Which station?",
      choices: [
        {
          id: "alexanderplatz",
          label: "Alexanderplatz · station",
          needs: [
            {
              payload: {
                kind: "scope",
                dimension: "walk_min",
                max: 10,
                referent: { kind: "landmark", landmarkId: "alexanderplatz" },
              },
              label: "within 10 min walk of Alexanderplatz",
              gist: "near Alexanderplatz",
            },
          ],
        },
      ],
      allowFreeText: true,
      mode: "one",
      stepId: "s1",
      said: goal,
    },
    meta: { model: "scripted", ms: 9 },
  });
  await page.goto(`${BASE}/#start`);

  await page.getByTestId("ask-name").fill("Alex");
  await page.getByTestId("ask-goal").fill(goal);
  await page.getByTestId("ask-continue").click();
  await expect(page.getByTestId("plan-clarify")).toBeVisible();
  await expect(page.getByTestId("plan-clarify")).toContainText("Pick one");
  await expect(page.getByTestId("plan-clarify-words")).toBeVisible();
  await page.getByTestId("plan-clarify-alexanderplatz").click();
  await expect(page.getByTestId("plan-clarify")).toHaveCount(0);
  // The answer lands on the step it was asked about.
  await expect(page.getByTestId("plan-step-s1").locator(".step-need")).toHaveCount(2);
  await expect(page.getByTestId("plan-step-s1"))
    .toContainText("within 10 min walk of Alexanderplatz");
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
