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
    const step = input.step as { placeClass?: string; needs?: unknown[] } | undefined;
    const selected = startClasses.find((item) => item.key === step?.placeClass) ?? startClasses[0]!;
    await route.fulfill({
      status: 200,
      json: {
        roomId: "room_goal_start",
        areaId: input.areaId,
        goal,
        step: {
          placeClass: { key: selected.key, label: selected.label },
          seeded: step?.needs?.length ?? 0,
        },
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

test("a goal is reviewed, one pending need can be left out, and invites repeat it", async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const goal = "a film after lunch near Sarah's station";
  const preview = {
    goal,
    offline: false,
    steps: [
      {
        stepId: "s1",
        title: "a film after lunch",
        placeClass: { key: "cinema", label: "a cinema" },
        needs: [
          {
            payload: { kind: "scope", dimension: "walk_min", max: 10 },
            label: "within 10 min walk",
            gist: "near the station",
          },
          {
            payload: { kind: "time_window", start: "2026-09-03T14:00:00+02:00", end: "2026-09-03T18:00:00+02:00" },
            label: "after lunch",
            gist: "after lunch",
          },
        ],
        when: {
          start: "2026-09-03T14:00:00+02:00",
          end: "2026-09-03T18:00:00+02:00",
          phrase: "after lunch",
        },
      },
    ],
    classes: startClasses,
    clarify: null,
    meta: { model: "scripted", ms: 12 },
  };
  const roomBodies = await mockGoalStart(page, preview);
  await page.goto(`${BASE}/#start`);

  await page.getByTestId("start-goal").fill(goal);
  await page.getByTestId("open-room").click();
  await expect(page.getByTestId("plan-preview")).toContainText("From what you said");
  await expect(page.getByTestId("plan-preview")).toContainText("a film after lunch");
  await expect(page.getByTestId("start-class")).toHaveValue("cinema");
  await expect(page.getByTestId("plan-need")).toHaveCount(2);
  await expect(page.getByTestId("plan-need").first().locator('.mark[data-mark="silent"]')).toBeVisible();
  const dropTarget = await page.getByTestId("drop-plan-need-0").boundingBox();
  expect(dropTarget?.height).toBeGreaterThanOrEqual(44);

  await page.getByTestId("drop-plan-need-0").click();
  await expect(page.getByTestId("plan-need")).toHaveCount(1);
  await page.getByTestId("open-room").click();
  await expect(page.getByTestId("start-links")).toBeVisible();
  await expect(page.getByTestId("invite-goal")).toHaveText(goal);
  expect(roomBodies).toHaveLength(1);
  expect(roomBodies[0]).toMatchObject({
    goal,
    step: { placeClass: "cinema", needs: [{ label: "after lunch" }] },
  });
  await context.close();
});

test("a missing preview keeps the server class list and room creation available", async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const roomBodies = await mockGoalStart(page, null);
  await page.goto(`${BASE}/#start`);

  await expect(page.getByTestId("start-class").locator("option")).toHaveCount(startClasses.length);
  await page.getByTestId("start-goal").fill("a walk after work");
  await page.getByTestId("open-room").click();
  await expect(page.getByTestId("plan-preview")).toContainText("Choose the kind of place");
  await page.getByTestId("start-class").selectOption("park");
  await page.getByTestId("open-room").click();
  await expect(page.getByTestId("start-links")).toBeVisible();
  expect(roomBodies[0]).toMatchObject({
    goal: "a walk after work",
    step: { placeClass: "park" },
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
        title: "lunch",
        placeClass: { key: "food", label: "somewhere to eat" },
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
      said: goal,
    },
    meta: { model: "scripted", ms: 9 },
  });
  await page.goto(`${BASE}/#start`);

  await page.getByTestId("start-goal").fill(goal);
  await page.getByTestId("open-room").click();
  await expect(page.getByTestId("plan-clarify")).toBeVisible();
  await expect(page.getByTestId("plan-clarify-text")).toBeVisible();
  await page.getByRole("button", { name: "Alexanderplatz · station" }).click();
  await expect(page.getByTestId("plan-clarify")).toHaveCount(0);
  await expect(page.getByTestId("plan-need")).toHaveCount(2);
  await expect(page.getByTestId("plan-preview")).toContainText("within 10 min walk of Alexanderplatz");
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
