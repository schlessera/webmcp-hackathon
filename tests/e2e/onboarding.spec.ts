import { test, expect, chromium, type Browser } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import { DATABASE_URL } from "../api/helpers.ts";

/**
 * The whole way in, in a real browser against a real server.
 *
 * A person who has never seen Spokes types their name and what they want,
 * gets told what that takes, is asked once about the demo's region limit,
 * and lands in a room they are alone in. Then they hand someone a link, and
 * that someone — in a different browser, with a different device identity —
 * reads what the room is for and joins it as a guest.
 *
 * No model is configured here, so the plan is the offline one: a single
 * step whose class the person chooses. That is deliberate. What this file
 * guards is the FLOW — the screens, the link, the second person — not the
 * reading of the sentence, which the api and unit lanes cover with scripted
 * drafts and a corpus.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = 43177;
const BASE = `http://127.0.0.1:${PORT}`;

let server: ChildProcess;
let browser: Browser;
const pool = new pg.Pool({ connectionString: DATABASE_URL });
const opened: string[] = [];

async function waitForServer(): Promise<void> {
  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      if ((await fetch(`${BASE}/api/meta`)).ok) return;
    } catch {
      /* retry */
    }
    if (Date.now() > deadline) throw new Error("server did not start");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

test.beforeAll(async () => {
  server = spawn("node", [join(repoRoot, "apps", "server", "src", "server.ts")], {
    env: {
      ...process.env,
      DATABASE_URL,
      PORT: String(PORT),
      BUILD_ID: "e2e-onboarding",
      LOG_LEVEL: "warn",
      POOL_FILL: "0",
      OPENAI_API_KEY: "",
      OPENROUTER_API_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForServer();
  browser = await chromium.launch();
});

test.afterAll(async () => {
  await browser?.close();
  for (const roomId of opened) {
    for (const table of [
      "stances", "proposals", "verdicts", "requirements", "adjustments",
      "arrival_plans", "attestations", "events", "candidates",
      "invite_secrets", "room_invites",
    ]) {
      await pool.query(`DELETE FROM ${table} WHERE room_id = $1`, [roomId]);
    }
    await pool.query(
      "DELETE FROM participant_tokens WHERE participant_id IN (SELECT id FROM participants WHERE room_id = $1)",
      [roomId],
    );
    await pool.query("DELETE FROM participants WHERE room_id = $1", [roomId]);
    await pool.query("DELETE FROM rooms WHERE id = $1", [roomId]);
  }
  await pool.end();
  server?.kill("SIGTERM");
});

test("a person opens a room from a sentence, then hands someone a link they use", async () => {
  const organizerContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const organizer = await organizerContext.newPage();

  // --- Screen 1: who you are, what you are trying to do -------------------
  await organizer.goto(`${BASE}/`);
  await organizer.getByTestId("landing-start").click();
  await expect(organizer.getByTestId("onboarding-ask")).toBeVisible();
  // Nothing is asked about regions yet: that is not a question the product has.
  await expect(organizer.getByTestId("region-dialog")).toHaveCount(0);

  await organizer.getByTestId("ask-name").fill("Alex");
  await organizer.getByTestId("ask-goal").fill("Dinner tonight somewhere we can all walk to");
  await organizer.getByTestId("ask-continue").click();

  // --- Screen 2: what that takes ------------------------------------------
  await expect(organizer.getByTestId("onboarding-plan")).toBeVisible();
  await expect(organizer.getByTestId("plan-goal"))
    .toHaveText("Dinner tonight somewhere we can all walk to");
  await expect(organizer.getByTestId("plan-step-s1")).toBeVisible();
  await organizer.getByTestId("plan-step-class-s1").selectOption("food");

  // --- The demo's one limitation, said plainly ----------------------------
  await organizer.getByTestId("plan-confirm").click();
  const dialog = organizer.getByTestId("region-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("demo limit");
  // Counts are absolute, and measured — never a percentage (CLAUDE.md §10).
  await expect(dialog).not.toContainText("%");
  await organizer.getByTestId("region-berlin-mitte").click();

  // --- In the room, alone -------------------------------------------------
  await expect(organizer.getByTestId("map-region")).toBeVisible({ timeout: 20000 });
  await expect(organizer.getByTestId("avatars").locator(".avatar")).toHaveCount(1);
  const roomId = await organizer.evaluate(
    () => JSON.parse(sessionStorage.getItem("participantIdentity") ?? "{}").roomId as string,
  );
  expect(roomId).toMatch(/^room_/);
  opened.push(roomId);

  // --- Handing someone a way in -------------------------------------------
  await organizer.getByTestId("add-person").click();
  const invite = organizer.getByTestId("invite-dialog");
  await expect(invite).toBeVisible();
  await expect(organizer.getByTestId("invite-qr")).toBeVisible();
  const url = (await organizer.getByTestId("invite-url").textContent()) ?? "";
  expect(url).toContain("#join=");
  // The list explains why one link is not every link.
  await expect(organizer.getByTestId("invite-rows")).toContainText("not used yet");
  await expect(invite).toContainText("Each link is for one person");

  // --- The other person ----------------------------------------------------
  // A separate context is a separate browser as far as the device binding is
  // concerned, which is exactly the case the single-use rule is about.
  const guestContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const guest = await guestContext.newPage();
  await guest.goto(url.replace(BASE, BASE));

  await expect(guest.getByTestId("join")).toBeVisible();
  await expect(guest.getByTestId("join-goal"))
    .toHaveText("Dinner tonight somewhere we can all walk to");
  await expect(guest.getByTestId("join")).toContainText("Alex");
  await expect(guest.getByTestId("join")).toContainText("1 person is in so far");
  // Accounts are offered and refused in the same breath, rather than hidden.
  await expect(guest.getByTestId("join-account")).toBeDisabled();
  await expect(guest.getByTestId("join")).toContainText("demo has no accounts");
  // Who else is in the room is not something a URL hands to a stranger.
  await expect(guest.getByTestId("join")).not.toContainText(roomId);

  await guest.getByTestId("join-name").fill("Sarah");
  await guest.getByTestId("join-go").click();
  await expect(guest.getByTestId("map-region")).toBeVisible({ timeout: 20000 });
  await expect(guest.getByTestId("avatars").locator(".avatar")).toHaveCount(2);

  // --- And the organizer sees them arrive ---------------------------------
  await expect(organizer.getByTestId("avatars").locator(".avatar"))
    .toHaveCount(2, { timeout: 15000 });

  // --- A third device cannot take a link that is already someone's ---------
  const strangerContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const stranger = await strangerContext.newPage();
  await stranger.goto(url);
  await expect(stranger.getByTestId("join")).toBeVisible();
  await stranger.getByTestId("join-name").fill("Mallory");
  await stranger.getByTestId("join-go").click();
  const refusal = stranger.getByTestId("join-error");
  await expect(refusal).toBeVisible();
  await expect(refusal).toContainText("already in use");
  // The refusal names nobody: whose link it is stays the room's business.
  await expect(refusal).not.toContainText("Sarah");

  await strangerContext.close();
  await guestContext.close();
  await organizerContext.close();
});

test("the goal a room opened with is what a later link says it is for", async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.goto(`${BASE}/#start`);
  await page.getByTestId("ask-name").fill("Alex");
  await page.getByTestId("ask-goal").fill("A dog-friendly park this afternoon");
  await page.getByTestId("ask-continue").click();
  await page.getByTestId("plan-step-class-s1").selectOption("park");
  await page.getByTestId("plan-confirm").click();
  await page.getByTestId("region-berlin-mitte").click();
  await expect(page.getByTestId("map-region")).toBeVisible({ timeout: 20000 });

  const roomId = await page.evaluate(
    () => JSON.parse(sessionStorage.getItem("participantIdentity") ?? "{}").roomId as string,
  );
  opened.push(roomId);

  // The step's class decided the pool, so the room is pooling parks.
  const classes = await pool.query(
    "SELECT DISTINCT category FROM candidates WHERE room_id = $1",
    [roomId],
  );
  expect(classes.rows.length).toBeGreaterThan(0);
  for (const row of classes.rows) {
    expect(["park", "garden", "dog_park", "playground"]).toContain(row.category);
  }
  // And the name is remembered, so a returning organizer is not asked twice.
  expect(await page.evaluate(() => localStorage.getItem("spokesName"))).toBe("Alex");
  await context.close();
});
