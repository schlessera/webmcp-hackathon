// Records the full three-window demo trajectory as three synchronized videos
// (Sarah | Joe | organizer), one per browser context, paced for a human viewer.
// Spins its own server + throwaway room (same lane as the e2e flow), so it
// never touches the live demo stack or room_demo.
//
//   node scripts/record-demo.mjs [--out <dir>] [--pace <ms>]
//
// Output: <out>/{org,sarah,joe}.webm + beats.log with per-beat timestamps,
// usable directly as raw material for the submission video.
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : fallback;
};
const OUT = argOf("--out", join(repoRoot, "test-results", "demo-recording"));
const PACE = Number(argOf("--pace", "2200")); // dwell after each beat, ms
const PORT = 43180;
const BASE = `http://127.0.0.1:${PORT}`;

mkdirSync(OUT, { recursive: true });
const beats = [];
const started = Date.now();
const beat = (label) => {
  const at = ((Date.now() - started) / 1000).toFixed(1);
  beats.push(`${at}s  ${label}`);
  console.log(`▶ ${at}s  ${label}`);
};
const dwell = (ms = PACE) => new Promise((r) => setTimeout(r, ms));

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
const deadline = Date.now() + 20000;
for (;;) {
  try {
    if ((await fetch(`${BASE}/api/meta`)).ok) break;
  } catch {}
  if (Date.now() > deadline) throw new Error("server did not start");
  await dwell(250);
}

const { createTestRoom } = await import("../tests/api/helpers.ts");
const room = await createTestRoom(BASE, { berlin: true });

const browser = await chromium.launch();
const pages = {};
const contexts = [];
for (const key of ["sarah", "joe", "org"]) {
  const context = await browser.newContext({
    viewport: { width: 640, height: 900 },
    recordVideo: { dir: OUT, size: { width: 640, height: 900 } },
  });
  contexts.push([key, context]);
  const page = await context.newPage();
  await page.goto(`${BASE}/?shim=webmcp#invite=${room.inviteSecrets[key]}`);
  await page.getByTestId("map-region").waitFor();
  pages[key] = page;
}
beat("three windows open — 21 of 31 eligible at 800 m");
await dwell(3000);

const addNeed = async (page, need, visibility) => {
  await page.getByTestId("tab-needs").click();
  await page.getByTestId("need-select").selectOption(need);
  await page.getByTestId(`visibility-${visibility}`).click();
  await page.getByTestId("add-need").click();
};

await addNeed(pages.sarah, "vegetarian-options", "shared");
beat("Sarah: vegetarian, shared");
await dwell();

await addNeed(pages.joe, "lactose-free-options", "application-private");
beat("Joe: lactose-free, PRIVATE — impasse fires");
await dwell(3500);

await addNeed(pages.org, "exclude-cuisine", "shared");
await pages.org.getByTestId("need-select").selectOption("budget");
await pages.org.getByTestId("budget-input").fill("15");
await pages.org.getByTestId("visibility-shared").click();
await pages.org.getByTestId("add-need").click();
beat("Alex: exclude Italian + budget ≤ €15");
await dwell(3000);

// Private adjustment request → organizer accepts → in-page confirm.
await pages.org.getByTestId("tab-decisions").click();
const adjustment = pages.org.getByTestId("adjustment-card");
await adjustment.waitFor({ timeout: 20000 });
beat("private council request visible ONLY to Alex");
await dwell(3000);
const requestId = (
  await adjustment.locator('[data-testid^="grant-"]').getAttribute("data-testid")
).replace("grant-", "");
await adjustment.getByTestId(`grant-${requestId}`).click();
const confirm = pages.org.getByTestId("confirm-card");
const staged = await confirm
  .waitFor({ state: "visible", timeout: 6000 })
  .then(() => true, () => false);
beat("grant staged — in-page confirm card");
await dwell(2500);
if (staged) await confirm.getByTestId("confirm-grant").click();
await pages.org
  .getByTestId("map-region")
  .and(pages.org.locator('[data-scope-radius*="1"]'))
  .waitFor({ timeout: 20000 })
  .catch(() => {});
beat("scope ring widens 800 → 1200 m in all windows — 3 candidates");
await dwell(4000);

// Organizer's agent proposes Chén Ché via the WebMCP tool surface.
await pages.org.evaluate(async () => {
  const shim = window.__webmcpTestShim;
  const call = async (name, argsObj) => {
    const result = await shim.executeTool(name, JSON.stringify(argsObj));
    return JSON.parse(result.content[0].text);
  };
  const context = await call("get_spatial_context", {});
  const target = context.candidates.find((c) => c.name === "Chén Ché");
  await call("focus_destination", { candidateId: target.candidateId });
  const sync = await call("sync_session", {});
  await call("propose_destination", {
    candidateId: target.candidateId,
    baseRevision: sync.revision,
  });
});
beat("AGENT proposes Chén Ché through the tool surface");
await dwell(3500);

await pages.sarah.getByTestId("tab-decisions").click();
await pages.sarah.getByTestId("stance-look").click();
await pages.sarah.getByTestId("veto-btn").click();
await pages.sarah.getByTestId("veto-menu").getByText("Visited too recently").click();
beat("Sarah vetoes — 2 candidates remain");
await dwell(3500);

const pin = (page, name) =>
  page.getByRole("button", { name: new RegExp(`^${name} \\(`) });
await pin(pages.org, "The Barn").click({ force: true });
const sheet = pages.org.getByTestId("candidate-sheet");
await sheet.locator(".attr-chip").first().waitFor({ timeout: 10000 });
beat("The Barn dossier open — evidence chips");
await dwell(3000);
await pages.org.getByTestId("propose-btn").click();
beat("Alex proposes The Barn");
await dwell(2500);

for (const key of ["org", "sarah", "joe"]) {
  await pages[key].getByTestId("tab-decisions").click();
  await pages[key].getByTestId("stance-accept").click();
  await pages[key].getByTestId("toggle-ready").click();
}
beat("everyone accepts + ready");
await dwell(2500);

await pages.org.getByTestId("tab-decisions").click();
await pages.org
  .getByTestId("stage-card")
  .locator('button[data-testid^="stage-"]')
  .click();
const commit = pages.org.getByTestId("commit-card");
await commit.waitFor({ timeout: 15000 });
beat("agreement staged — in-page commit card");
await dwell(2500);
await commit.locator('[data-testid^="commit-"]').click();
for (const key of ["org", "sarah", "joe"]) {
  await pages[key].getByTestId("arrival-banner").waitFor({ timeout: 15000 });
}
beat("COMMITTED — gold star, arrival banners everywhere");
await dwell(4000);

const href = await pages.joe.getByTestId("navigate-link").getAttribute("href");
beat(`navigation handoff ready: ${href}`);
await dwell(3000);

writeFileSync(join(OUT, "beats.log"), beats.join("\n") + "\n");
for (const [key, context] of contexts) {
  const page = context.pages()[0];
  const video = page?.video();
  await context.close();
  if (video) {
    const path = await video.path();
    const { renameSync } = await import("node:fs");
    renameSync(path, join(OUT, `${key}.webm`));
  }
}
await browser.close();
await room.cleanup();
server.kill("SIGTERM");
console.log(`\nDone. Videos + beats.log in ${OUT}`);
