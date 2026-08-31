// Opens Sarah and Joe in isolated Chromium browser contexts (one window each,
// separate storage — no cookie/sessionStorage collisions) and prints the
// organizer URL for ChatGPT's built-in browser. Ctrl+C closes both.
import { createHmac } from "node:crypto";
import { chromium } from "@playwright/test";

const APP_URL = process.env.APP_URL ?? "http://127.0.0.1:4173";
const KEY = process.env.DEMO_SECRET_KEY ?? "local-dev-only";

const secret = (participantId) =>
  createHmac("sha256", KEY).update(`invite:${participantId}`).digest("hex").slice(0, 32);

const organizerUrl = `${APP_URL}/?surface=chatgpt#invite=${secret("p_org")}`;

const browser = await chromium.launch({ headless: false });
for (const [name, id] of [["Sarah", "p_sarah"], ["Joe", "p_joe"]]) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${APP_URL}/#invite=${secret(id)}`);
  console.log(`${name} open in an isolated context.`);
}
console.log("");
console.log("Organizer URL for ChatGPT's built-in browser:");
console.log(`  ${organizerUrl}`);
console.log("");
console.log("Ctrl+C to close the participant windows.");
await new Promise((resolve) => process.on("SIGINT", resolve));
await browser.close();
