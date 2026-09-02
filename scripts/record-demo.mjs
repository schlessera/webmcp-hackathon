// Records the full three-window demo trajectory as three synchronized videos
// (Sarah | Joe | organizer), one per browser context, paced for a human viewer.
// Spins its own server + throwaway room (same lane as the e2e flow), so it
// never touches the live demo stack or room_demo.
//
//   node scripts/record-demo.mjs [--out <dir>] [--pace <ms>]
//
// Output: <out>/{org,sarah,joe}.webm + beats.log with per-beat timestamps,
// usable directly as raw material for the submission video.
import { chromium, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import {
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : fallback;
};
const OUT = argOf("--out", join(repoRoot, "test-results", "demo-recording"));
const RAW_VIDEO_DIR = join(OUT, ".raw");
const PACE = Number(argOf("--pace", "2200")); // dwell after each beat, ms
const PORT = 43180;
const BASE = `http://127.0.0.1:${PORT}`;

mkdirSync(OUT, { recursive: true });
rmSync(RAW_VIDEO_DIR, { recursive: true, force: true });
mkdirSync(RAW_VIDEO_DIR, { recursive: true });

const beats = [];
const started = Date.now();
const beat = (number, label) => {
  const at = ((Date.now() - started) / 1000).toFixed(1);
  beats.push(`${at}s  Beat ${number} reached — ${label}`);
  console.log(`▶ ${at}s  Beat ${number} reached — ${label}`);
};
const dwell = (ms = PACE) => new Promise((resolve) => setTimeout(resolve, ms));

// --- server (UI via Vite middleware, like the e2e lane) ---
const server = spawn("node", [join(repoRoot, "apps", "server", "src", "server.ts")], {
  env: {
    ...process.env,
    DATABASE_URL:
      process.env.DATABASE_URL ?? "postgres://webmcp:webmcp@127.0.0.1:5432/webmcp",
    PORT: String(PORT),
    BUILD_ID: "demo-recording",
    LOG_LEVEL: "warn",
  },
  stdio: ["ignore", "inherit", "inherit"],
});

let room;
let browser;
let shimContext;
let completed = false;
const recordings = [];

try {
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await fetch(`${BASE}/api/meta`)).ok) break;
    } catch {
      // retry while Vite and the server come up
    }
    if (Date.now() > deadline) throw new Error("server did not start");
    await dwell(250);
  }

  // Keep the same helper import pattern and Berlin room fixture as the verified
  // e2e trajectory. Importing after server startup also keeps startup failures
  // separate from fixture creation failures.
  const { createTestRoom } = await import("../tests/api/helpers.ts");
  room = await createTestRoom(BASE, { berlin: true });

  browser = await chromium.launch();
  const pages = {};

  // All three recording contexts exist from the start. Alex's page remains
  // blank until beat 3, leaves again, and returns in beat 5 in the same tab so
  // its sessionStorage preserves the revision it genuinely saw before leaving.
  for (const key of ["sarah", "joe", "org"]) {
    const context = await browser.newContext({
      viewport: { width: 640, height: 900 },
      recordVideo: { dir: RAW_VIDEO_DIR, size: { width: 640, height: 900 } },
    });
    const page = await context.newPage();
    recordings.push({ key, context, page });
    pages[key] = page;
  }

  const recordingUrl = (key) => `${BASE}/#invite=${room.inviteSecrets[key]}`;
  const openRecordingPage = async (key) => {
    const page = pages[key];
    await page.goto(recordingUrl(key));
    await expect(page.getByTestId("map-region")).toHaveAttribute(
      "data-scope-radius",
      "800",
      { timeout: 20_000 },
    );
  };

  const input = (page) => page.getByLabel("What matters to you?");
  const commandResponse = (page, type) =>
    page.waitForResponse(
      (candidate) =>
        candidate.url().endsWith("/api/commands") &&
        candidate.request().method() === "POST" &&
        (!type || candidate.request().postDataJSON()?.type === type),
      { timeout: 20_000 },
    );
  const clickCommand = async (page, action, type) => {
    const pending = commandResponse(page, type);
    await action();
    const response = await pending;
    const body = await response.json();
    if (!body.ok) {
      throw new Error(`${type ?? "command"} failed: ${JSON.stringify(body.error)}`);
    }
    return body;
  };
  const submitText = async (page, text) => {
    await input(page).fill(text);
    return clickCommand(
      page,
      () => input(page).press("Enter"),
      "SubmitRequirement",
    );
  };
  const ownNeed = (page, label) =>
    page.locator('[data-testid^="need-"]').filter({ hasText: label });
  const stanceCard = (page, name) =>
    page.getByTestId("stance-card").filter({ hasText: `${name} is on the table` });

  // Beat 1 — only Sarah and Joe arrive. Alex's recording remains blank, and
  // both visible pages truthfully show the durable not-yet-arrived state.
  await Promise.all([openRecordingPage("sarah"), openRecordingPage("joe")]);
  for (const key of ["sarah", "joe"]) {
    await expect(pages[key].getByTestId("count-number")).toHaveText("21");
    await expect(pages[key].getByTestId("invite-card")).toContainText(
      "Alex hasn't arrived",
    );
    await expect(
      pages[key].getByTestId(`avatar-${room.participantIds.org}`),
    ).toHaveAttribute("data-idle", "true");
  }
  beat(1, "Sarah and Joe open the 800 m room; Alex has not arrived");
  await dwell(3_000);

  // Beat 2 — a server-authored pill, followed by the redesigned press-and-hold
  // preview gesture. The count returns to 21 only while the row is held.
  const sarahNeedResult = await clickCommand(
    pages.sarah,
    () => pages.sarah.getByTestId("pill-vegetarian-options").click(),
    "SubmitRequirement",
  );
  await expect(ownNeed(pages.sarah, "vegetarian options")).toBeVisible();
  await expect(pages.sarah.getByTestId("count-number")).toHaveText("12", {
    timeout: 15_000,
  });
  await expect(ownNeed(pages.sarah, "vegetarian options")).toContainText(
    "5 unknown",
  );

  const vegetarianRow = ownNeed(pages.sarah, "vegetarian options");
  await vegetarianRow.scrollIntoViewIfNeeded();
  const vegetarianBox = await vegetarianRow.boundingBox();
  if (!vegetarianBox) throw new Error("Sarah's need row has no pointer target");
  await pages.sarah.mouse.move(
    vegetarianBox.x + vegetarianBox.width / 2,
    vegetarianBox.y + vegetarianBox.height / 2,
  );
  await pages.sarah.mouse.down();
  await expect(pages.sarah.getByTestId("map-region")).toHaveAttribute(
    "data-preview",
    "true",
  );
  await expect(pages.sarah.getByTestId("count-number")).toHaveText("21");
  await dwell(Math.max(700, Math.floor(PACE / 2)));
  await pages.sarah.mouse.up();
  await expect(pages.sarah.getByTestId("map-region")).not.toHaveAttribute(
    "data-preview",
    "true",
  );
  await expect(pages.sarah.getByTestId("count-number")).toHaveText("12");
  beat(2, "Sarah adds vegetarian options and previews the set without it");
  await dwell();

  // Beat 3 — Alex first arrives after Sarah's move, sees the room, and leaves.
  // Navigating this one recorded page away closes its realtime socket without
  // splitting the organizer recording into multiple WebM files.
  await openRecordingPage("org");
  for (const key of ["sarah", "joe", "org"]) {
    await expect(
      pages[key].getByTestId(`avatar-${room.participantIds.org}`),
    ).toHaveAttribute("data-present", "true", { timeout: 15_000 });
    await expect(pages[key].getByTestId("invite-card")).toHaveCount(0);
  }
  beat(3, "Alex arrives after Sarah's move, looks around, then steps away");
  await dwell(3_000);
  await pages.org.goto("about:blank");
  for (const key of ["sarah", "joe"]) {
    await expect(
      pages[key].getByTestId(`avatar-${room.participantIds.org}`),
    ).not.toHaveAttribute("data-present", "true", { timeout: 15_000 });
  }
  await dwell(Math.max(700, Math.floor(PACE / 2)));

  // Beat 4 — private scope is selected before Joe states the need. Only Joe
  // receives its content and quantified way out; Sarah receives its effect.
  await pages.joe.getByTestId("composer-scope").click();
  await pages.joe.getByTestId("scope-application-private").click();
  await submitText(pages.joe, "lactose-free options");
  await expect(ownNeed(pages.joe, "lactose-free options")).toHaveAttribute(
    "data-variant",
    "private",
  );
  await expect(pages.joe.getByTestId("count-number")).toHaveText("0", {
    timeout: 15_000,
  });
  await expect(pages.joe.getByTestId("count-block")).toContainText("17 unsure");
  await expect(pages.joe.getByTestId("ways-out")).toContainText(
    "Let “lactose-free options” be nice-to-have",
  );
  await expect(pages.joe.getByTestId("ways-out")).toContainText("+12");
  await expect(pages.sarah.getByTestId("private-effect")).toContainText(
    "A private condition",
  );
  await expect(pages.sarah.getByTestId("private-effect")).toContainText("−2");
  await expect(pages.sarah.getByTestId("brief")).not.toContainText(
    "lactose-free options",
  );
  beat(4, "Joe adds lactose-free options privately; the room reaches an impasse");
  await dwell(3_500);

  // Beat 5 — this is a genuine return: App reads the organizer's last server
  // sync and tab revision before advancing either, so the missed span renders
  // as a redacted digest. The private adjustment is organizer-only.
  await openRecordingPage("org");
  await expect(pages.org.getByTestId("digest")).toContainText(
    "While you were away",
    { timeout: 15_000 },
  );
  await expect(pages.org.getByTestId("brief")).toContainText("vegetarian options");
  await expect(pages.org.getByTestId("digest")).toContainText(
    "A private need was updated.",
  );
  await expect(pages.org.getByTestId("digest")).not.toContainText(
    "vegetarian options",
  );
  await expect(pages.org.getByTestId("digest")).not.toContainText(
    "lactose-free options",
  );
  const adjustment = pages.org
    .getByTestId("adjustment-card")
    .filter({ hasText: "Widen the area" })
    .first();
  await expect(adjustment).toBeVisible({ timeout: 15_000 });
  await expect(adjustment).toContainText("only you see this");
  await expect(pages.sarah.getByTestId("adjustment-card")).toHaveCount(0);
  await expect(pages.joe.getByTestId("adjustment-card")).toHaveCount(0);
  beat(5, "Alex returns to a redacted While you were away digest and private consent card");
  await dwell(3_500);

  // All WebMCP calls live in this separate, unrecorded shim context. None of
  // the three recording windows includes ?shim=webmcp, so their diagnostics
  // drawer remains closed throughout.
  shimContext = await browser.newContext({ viewport: { width: 640, height: 900 } });
  const agentPage = await shimContext.newPage();
  await agentPage.goto(`${BASE}/?shim=webmcp#invite=${room.inviteSecrets.org}`);
  await expect(agentPage.getByTestId("map-region")).toHaveAttribute(
    "data-scope-radius",
    "800",
    { timeout: 20_000 },
  );
  await agentPage.waitForFunction(
    () => window.__webmcpTestShim?.getTools().length > 0,
    undefined,
    { timeout: 15_000 },
  );
  const callTool = async (name, argsObject) =>
    agentPage.evaluate(
      async ({ toolName, toolArgs }) => {
        const result = await window.__webmcpTestShim.executeTool(
          toolName,
          JSON.stringify(toolArgs),
        );
        return JSON.parse(result.content[0].text);
      },
      { toolName: name, toolArgs: argsObject },
    );

  // Beat 6 — the explicit sinceRevision is the revision Alex saw in beat 3.
  // The agent receives Joe's move only as a redacted delta and aggregate state.
  const agentSync = await callTool("sync_session", {
    sinceRevision: sarahNeedResult.revision,
  });
  if (!agentSync.ok) throw new Error(`agent sync failed: ${JSON.stringify(agentSync)}`);
  const agentContextAtImpasse = await callTool("get_spatial_context", {});
  if (!agentContextAtImpasse.ok) {
    throw new Error(`agent context failed: ${JSON.stringify(agentContextAtImpasse)}`);
  }
  const agentView = JSON.stringify({ agentSync, agentContextAtImpasse });
  if (agentView.includes("lactose-free options") || agentView.includes("lactose-free-options")) {
    throw new Error("organizer tool projection leaked Joe's private requirement");
  }
  beat(6, "Alex's agent syncs, explains the impasse, and receives no private reason");
  await dwell();

  // Beat 7 — budget through the visible composer, exclusion through the hidden
  // tool page. Both use the same SubmitRequirement command path.
  const budgetResult = await submitText(pages.org, "€15");
  await expect(ownNeed(pages.org, "budget €15")).toBeVisible();
  const exclusionResult = await callTool("submit_requirement", {
    baseRevision: budgetResult.revision,
    visibility: "shared",
    hardness: "hard",
    delegation: { mode: "approval_required" },
    payload: {
      kind: "exclusion",
      key: "cuisine",
      values: ["italian"],
      lifetime: "session",
    },
  });
  if (!exclusionResult.ok) {
    throw new Error(`exclusion tool call failed: ${JSON.stringify(exclusionResult)}`);
  }
  await expect(ownNeed(pages.org, "avoid italian")).toBeVisible({ timeout: 15_000 });
  await expect(pages.org.getByTestId("count-number")).toHaveText("0");
  await expect(pages.org.getByTestId("count-block")).toContainText("14 unsure");
  await expect(pages.sarah.getByTestId("brief")).not.toContainText(
    "lactose-free options",
  );
  beat(7, "Alex adds budget €15 and the agent submits avoid Italian");
  await dwell(3_000);

  // Beat 8 — the first gesture stages the out-of-bound grant and draws the
  // proposed ring. Only the second in-page gesture applies it.
  const grant = adjustment.locator('[data-testid^="grant-"]');
  await clickCommand(
    pages.org,
    () => grant.click(),
    "ResolvePrivateRequest",
  );
  const confirm = pages.org
    .getByTestId("confirm-card")
    .filter({ hasText: "Widen the area" });
  await expect(confirm).toBeVisible({ timeout: 10_000 });
  await dwell(2_500);
  await clickCommand(
    pages.org,
    () => confirm.getByTestId("confirm-grant").click(),
    "ConfirmPrivateRequest",
  );
  for (const key of ["org", "sarah", "joe"]) {
    await expect(pages[key].getByTestId("map-region")).toHaveAttribute(
      "data-scope-radius",
      "1200",
      { timeout: 15_000 },
    );
    await expect(pages[key].getByTestId("count-number")).toHaveText("4");
    await expect(pages[key].getByTestId("count-block")).toContainText("20 unsure");
  }
  beat(8, "Alex accepts and confirms the 1.2 km widening; four places now work");
  await dwell(4_000);

  // Beat 9 — refresh the agent's revision after the human confirmation, then
  // propose the named Berlin candidate from the compact spatial context.
  const widenedSync = await callTool("sync_session", {
    sinceRevision: exclusionResult.revision,
  });
  if (!widenedSync.ok) {
    throw new Error(`post-confirm sync failed: ${JSON.stringify(widenedSync)}`);
  }
  const widenedContext = await callTool("get_spatial_context", {});
  const chen = widenedContext.candidates?.find((candidate) => candidate.name === "Chén Ché");
  const barn = widenedContext.candidates?.find((candidate) => candidate.name === "The Barn");
  if (!chen || !barn) throw new Error("widened tool context omitted Chén Ché or The Barn");
  const chenProposal = await callTool("propose_destination", {
    candidateId: chen.candidateId,
    baseRevision: widenedSync.revision,
  });
  if (!chenProposal.ok) {
    throw new Error(`Chén Ché proposal failed: ${JSON.stringify(chenProposal)}`);
  }
  for (const key of ["org", "sarah", "joe"]) {
    await expect(pages[key].getByTestId(`pin-${chen.candidateId}`)).toHaveAttribute(
      "data-state",
      "proposed",
      { timeout: 15_000 },
    );
    await expect(stanceCard(pages[key], "Chén Ché")).toBeVisible();
  }
  beat(9, "Alex's agent puts Chén Ché forward");
  await dwell(3_500);

  // Beat 10 — the redesigned place panel contains the verdict, evidence rows,
  // and shared stances. Veto is the direct Rule it out action; there is no menu.
  await pages.sarah.getByTestId(`pin-${chen.candidateId}`).click({ force: true });
  const chenDetails = pages.sarah.getByTestId("place-details");
  await expect(chenDetails).toHaveAttribute("aria-label", "Chén Ché");
  await expect(chenDetails.getByTestId("verdict")).toBeVisible();
  await expect(chenDetails.locator(".attr-row").first()).toBeVisible({
    timeout: 10_000,
  });
  await dwell(2_500);
  await clickCommand(
    pages.sarah,
    () => chenDetails.getByTestId("veto-btn").click(),
    "RespondToProposal",
  );
  await expect(pages.org.getByTestId(`pin-${chen.candidateId}`)).not.toHaveAttribute(
    "data-state",
    "proposed",
    { timeout: 15_000 },
  );
  await expect(pages.org.getByTestId("count-number")).toHaveText("4");
  await expect(chenDetails).toContainText("You ruled it out");
  beat(10, "Sarah inspects Chén Ché and rules it out; the eligible count stays four");
  await dwell(3_500);

  // Beat 11 — deliberately reuse the pre-veto agent revision. The stale
  // proposal must fail with sync_required; after consuming that delta, retry
  // against the returned revision and put The Barn forward.
  const staleBarnProposal = await callTool("propose_destination", {
    candidateId: barn.candidateId,
    baseRevision: chenProposal.revision,
  });
  if (staleBarnProposal.ok || staleBarnProposal.error?.code !== "sync_required") {
    throw new Error(
      `expected sync_required after Sarah's veto: ${JSON.stringify(staleBarnProposal)}`,
    );
  }
  const caughtUp = await callTool("sync_session", {
    sinceRevision: chenProposal.revision,
  });
  if (!caughtUp.ok) throw new Error(`agent catch-up failed: ${JSON.stringify(caughtUp)}`);
  const barnProposal = await callTool("propose_destination", {
    candidateId: barn.candidateId,
    baseRevision: caughtUp.revision,
  });
  if (!barnProposal.ok) {
    throw new Error(`The Barn proposal failed: ${JSON.stringify(barnProposal)}`);
  }
  for (const key of ["org", "sarah", "joe"]) {
    await expect(pages[key].getByTestId(`pin-${barn.candidateId}`)).toHaveAttribute(
      "data-state",
      "proposed",
      { timeout: 15_000 },
    );
    await expect(stanceCard(pages[key], "The Barn")).toBeVisible();
  }
  beat(11, "the stale agent catches Sarah's veto and proposes The Barn instead");
  await dwell(3_500);

  // Beat 12 — close Sarah's old dossier, accept from each consent card, then
  // mark every participant done. Staging appears only after all six facts land.
  await chenDetails.getByTestId("details-close").click();
  for (const key of ["org", "sarah", "joe"]) {
    await clickCommand(
      pages[key],
      () => stanceCard(pages[key], "The Barn").getByTestId("stance-accept").click(),
      "RespondToProposal",
    );
  }
  // Accepting marks each person ready; the toggle mirrors the roster.
  for (const key of ["org", "sarah", "joe"]) {
    await expect(pages[key].getByTestId("toggle-ready")).toHaveAttribute(
      "aria-pressed",
      "true",
      { timeout: 10_000 },
    );
  }
  const stage = pages.org.getByTestId("stage-card").filter({ hasText: "The Barn" });
  await expect(stage).toBeVisible({ timeout: 15_000 });
  await expect(stage).toHaveAttribute("data-ready", "true", { timeout: 10_000 });
  beat(12, "all three accept The Barn; everyone is ready");
  await dwell(3_000);

  // Beat 13 — the organizer's first click only stages. The peer cards render
  // their waiting state before the organizer performs the nonce-bound commit.
  await clickCommand(
    pages.org,
    () => stage.locator('[data-testid^="stage-"]').click(),
    "ConfirmAgreement",
  );
  const commit = pages.org.getByTestId("commit-card");
  await expect(commit).toContainText("The Barn is staged", { timeout: 15_000 });
  for (const key of ["sarah", "joe"]) {
    await expect(pages[key].getByTestId("commit-card")).toContainText(
      "Waiting for the organizer to settle it.",
    );
  }
  await dwell(2_500);
  await clickCommand(
    pages.org,
    () => commit.locator('[data-testid^="commit-"]').click(),
    "CommitAgreement",
  );
  for (const key of ["org", "sarah", "joe"]) {
    await expect(pages[key].getByTestId("room-title")).toHaveText("The Barn", {
      timeout: 15_000,
    });
    await expect(pages[key].getByTestId("room-subtitle")).toHaveText(
      "agreed by all three",
    );
    await expect(pages[key].getByTestId("count-block")).toContainText("Settled");
    await expect(pages[key].getByTestId("count-block")).toContainText("11 min from you");
    await expect(pages[key].getByTestId("arrival-banner")).toContainText("The Barn");
    await expect(pages[key].getByTestId("history")).toContainText("How it got here");
  }
  beat(13, "Alex stages and settles The Barn; every window enters arrival mode");
  await dwell(4_000);

  // Beat 14 — one transport choice per participant, then the real Google Maps
  // handoff in each recorded tab. Retargeting the existing link to the same tab
  // keeps exactly one continuous video per participant.
  const modes = { sarah: "Walk", joe: "Bike", org: "Drive" };
  const navigationHrefs = {};
  for (const key of ["sarah", "joe", "org"]) {
    const group = pages[key].getByRole("group", {
      name: "How are you getting there?",
    });
    await clickCommand(
      pages[key],
      () => group.getByRole("button", { name: modes[key] }).click(),
      "PlanArrival",
    );
    await expect(group.getByRole("button", { name: modes[key] })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const link = pages[key].getByTestId("navigate-link");
    await expect(link).toHaveAttribute(
      "href",
      /google\.com\/maps\/dir\/\?api=1&destination=/,
    );
    navigationHrefs[key] = await link.getAttribute("href");
  }
  for (const key of ["sarah", "joe", "org"]) {
    const link = pages[key].getByTestId("navigate-link");
    await link.evaluate((element) => element.setAttribute("target", "_self"));
    const handedOff = pages[key].waitForURL(/google\.com\/maps\/dir/, {
      waitUntil: "commit",
      timeout: 20_000,
    });
    await link.click({ noWaitAfter: true });
    await handedOff;
  }
  beat(
    14,
    `Walk/Bike/Drive selected; Google Maps handoff opened (${navigationHrefs.org})`,
  );
  await dwell(3_000);

  completed = true;
} finally {
  writeFileSync(join(OUT, "beats.log"), beats.join("\n") + (beats.length ? "\n" : ""));

  await shimContext?.close().catch(() => {});
  for (const { key, context, page } of recordings) {
    const video = page.video();
    await context.close().catch(() => {});
    if (video) {
      const path = await video.path().catch(() => null);
      if (path) renameSync(path, join(OUT, `${key}.webm`));
    }
  }
  await browser?.close().catch(() => {});
  await room?.cleanup().catch(() => {});
  server.kill("SIGTERM");
  rmSync(RAW_VIDEO_DIR, { recursive: true, force: true });
}

if (!completed) process.exitCode = 1;
console.log(`\nDone. Videos + beats.log in ${OUT}`);
