/** Capture the built-in agent's real owner-review UI, with model transport scripted.
 *
 * Prerequisites: repository dependencies, Node >=24, Python Pillow, Playwright
 * Chromium, and a PostgreSQL account allowed to create/drop a temporary database.
 * Run from the repo root:
 *   CAPTURE_DATABASE_ADMIN_URL=postgres://webmcp:webmcp@127.0.0.1:55433/postgres \
 *     node scripts/capture-agent-landing.ts
 * Set CAPTURE_CHROMIUM_PATH to use an existing compatible Chromium executable.
 * The original is a 430×932 browser screenshot clip of a 980×932 viewport:
 * the complete desktop review rail and a strip of its live map. The mobile
 * brief's 210px height cap cannot show this real review card in one frame.
 * The script starts its own current-source server, never uses an existing room,
 * and drops only the uniquely named database it creates, including after failure.
 */
import { chromium, expect, type Browser } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { TestRoom, TestServer } from "../tests/api/helpers.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

if (process.env.AGENT_LANDING_FIXTURE_SERVER === "1") {
  // Only the model boundary is scripted. The production language route, agent
  // runner, room projection, pending-action storage and React card all run.
  const { setTransport } = await import("../apps/server/src/nl/llm.ts");
  setTransport(async (body) => {
    const request = body as {
      text?: { format?: { name?: string } };
      tools?: Array<{ name?: string }>;
      input: Array<{ content?: unknown }>;
    };
    if (request.text?.format?.name === "understanding") {
      return { output: [{ type: "message", content: [{ type: "output_text", text:
        JSON.stringify({ intent: "act", confidence: 1, concepts: [], reply: null }),
      }] }] };
    }
    if (!request.tools?.some((tool) => tool.name === "propose_destination")) {
      throw new Error("Capture fixture refuses all unrecognized model requests.");
    }
    const roomMessage = request.input.find((item) => "content" in item
      && typeof item.content === "string" && item.content.startsWith("Room snapshot:\n"));
    if (!roomMessage || !("content" in roomMessage) || typeof roomMessage.content !== "string") {
      throw new Error("Agent did not receive the real room snapshot.");
    }
    const snapshot = JSON.parse(roomMessage.content.slice("Room snapshot:\n".length)) as {
      places: Array<{ candidateId: string; name: string }>;
    };
    const place = snapshot.places.find((candidate) => candidate.name === "The Barn");
    if (!place) throw new Error("The Barn is missing from the actual participant projection.");
    return { output: [{ type: "function_call", call_id: "capture_propose_barn",
      name: "propose_destination", arguments: JSON.stringify({ candidateId: place.candidateId }),
    }] };
  });
  await import("../apps/server/src/server.ts");
} else {
  const adminUrl = process.env.CAPTURE_DATABASE_ADMIN_URL;
  if (!adminUrl) throw new Error("Set CAPTURE_DATABASE_ADMIN_URL; an existing application database is never reused.");
  const admin = new pg.Pool({ connectionString: adminUrl, max: 1, connectionTimeoutMillis: 5000 });
  const database = `spokes_agent_capture_${randomBytes(8).toString("hex")}`;
  const captureUrl = new URL(adminUrl);
  captureUrl.pathname = `/${database}`;
  const out = join(root, "apps/web/public/landing");
  const name = "agent-review";
  const png = join(out, `${name}.png`);
  let createdDatabase = false;
  let server: TestServer | undefined;
  let room: TestRoom | undefined;
  let browser: Browser | undefined;
  try {
    await admin.query(`CREATE DATABASE "${database}"`);
    createdDatabase = true;
    process.env.DATABASE_URL = captureUrl.toString();
    // startServer uses node from PATH; retain the runtime running this script.
    process.env.PATH = `${dirname(process.execPath)}:${process.env.PATH ?? ""}`;
    execFileSync(process.execPath, ["apps/server/src/migrate.ts"], { cwd: root, env: process.env, stdio: "pipe" });
    const { startServer, createTestRoom } = await import("../tests/api/helpers.ts");
    server = await startServer({ entrypoint: "scripts/capture-agent-landing.ts", env: {
      AGENT_LANDING_FIXTURE_SERVER: "1", SERVE_STATIC: "0", NODE_ENV: "development",
      LLM_PROVIDER: "openai", OPENAI_API_KEY: "scripted-only", OPENROUTER_API_KEY: "",
      PARALLEL_API_KEY: "", DATAFORSEO_LOGIN: "", DATAFORSEO_PASSWORD: "",
      ENRICH_NETWORK: "0", POOL_FILL: "0",
    } });
    room = await createTestRoom(server.baseUrl, { berlin: true });
    await room.pool.query(
      "UPDATE rooms SET goal = 'Somewhere to catch up in Mitte', scope = jsonb_set(scope, '{area,radiusM}', '1200') WHERE id = $1",
      [room.roomId],
    );
    browser = await chromium.launch({
      ...(process.env.CAPTURE_CHROMIUM_PATH ? { executablePath: process.env.CAPTURE_CHROMIUM_PATH } : {}),
      args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    });
    const context = await browser.newContext({ viewport: { width: 980, height: 932 },
      deviceScaleFactor: 1, locale: "en-GB", timezoneId: "Europe/Berlin", reducedMotion: "reduce" });
    const page = await context.newPage();
    await page.goto(`${server.baseUrl}/#invite=${room.inviteSecrets.org}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("map-region")).toBeVisible({ timeout: 20000 });
    if (await page.getByTestId("close-drawer").isVisible()) await page.getByTestId("close-drawer").click();
    await page.evaluate(() => document.fonts.ready);
    const revisionBefore = (await room.pool.query("SELECT revision FROM rooms WHERE id = $1", [room.roomId])).rows[0].revision;
    const response = page.waitForResponse((response) => response.url().endsWith("/api/nl/say"));
    await page.getByLabel("What matters to you?").fill("Put The Barn forward for the group.");
    await page.getByLabel("What matters to you?").press("Enter");
    const result = await (await response).json();
    if (!result.ok || !result.pendingAction) throw new Error(`Expected real pending agent action: ${JSON.stringify(result)}`);
    const review = page.getByTestId("agent-action-review");
    await expect(review).toContainText("Propose a place");
    await expect(review).toContainText("The Barn");
    await expect(review.getByRole("button", { name: "Approve change" })).toBeVisible();
    await expect(review.getByRole("button", { name: "Dismiss", exact: true })).toBeVisible();
    await review.scrollIntoViewIfNeeded();
    await page.getByLabel("What matters to you?").blur();
    await page.mouse.move(425, 25);
    await page.waitForTimeout(1500);
    const state = (await room.pool.query(
      `SELECT r.revision, (SELECT count(*)::int FROM proposals WHERE room_id = r.id) AS proposals,
       (SELECT count(*)::int FROM nl_pending_actions WHERE participant_id = $2 AND consumed_at IS NULL) AS pending
       FROM rooms r WHERE r.id = $1`, [room.roomId, room.participantIds.org],
    )).rows[0];
    if (String(state.revision) !== String(revisionBefore) || state.proposals !== 0 || state.pending !== 1) {
      throw new Error(`Suggestion changed the room before owner review: ${JSON.stringify(state)}`);
    }
    const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const createdAt = new Date().toISOString();
    const scene = "Alex asks the built-in agent to put The Barn forward. A scripted route response and tool call pass through the real language endpoint and agent runner. The actual owner-review card names the place and offers Approve change or Dismiss. The proposal has not been applied to the room.";
    const limitations = "Only model transport is scripted; this is not evidence of autonomous model reasoning or an external WebMCP agent. Participants, region scope and place pool are isolated test fixtures. Berlin venue data is checked in and is not fresh factual verification. No DOM or pixel content edits.";
    const prompt = `Browser screenshot, not AI-generated. ${scene} ${limitations} Captured using scripts/capture-agent-landing.ts. Source commit: ${sourceCommit}.`;
    const reviewBounds = await review.boundingBox();
    const replyBounds = await page.getByTestId("agent-reply").boundingBox();
    const clip = { x: 0, y: 0, width: 430, height: 932 };
    if (!replyBounds || replyBounds.x < clip.x || replyBounds.y < clip.y
      || replyBounds.x + replyBounds.width > clip.width || replyBounds.y + replyBounds.height > clip.height) {
      throw new Error("The complete agent reply must fit inside the browser screenshot clip.");
    }
    await mkdir(out, { recursive: true });
    await page.screenshot({ path: png, animations: "disabled", clip });
    execFileSync("python3", ["-c", "from PIL import Image; import sys; exif=Image.Exif(); exif[270]=sys.argv[3]; Image.open(sys.argv[1]).convert('RGB').save(sys.argv[2], 'WEBP', quality=88, method=6, exif=exif)", png, join(out, `${name}.webp`), prompt]);
    await writeFile(join(out, `${name}.webp.json`), JSON.stringify({ prompt, createdAt, sourceCommit,
      viewport: page.viewportSize(), clip, rasterDimensions: { width: clip.width, height: clip.height },
      scene, limitations, captureScript: "scripts/capture-agent-landing.ts",
      reviewBounds, replyBounds, verification: { revisionUnchanged: true, unappliedProposals: state.proposals, pendingOwnerActions: state.pending },
    }, null, 2) + "\n");
    console.log(JSON.stringify({ captured: `${name}.webp`, reviewBounds, replyBounds, verification: state }));
  } catch (error) {
    if (server) console.error(server.logs().slice(-6000));
    throw error;
  } finally {
    await browser?.close();
    await server?.stop();
    // Dropping this exclusively owned database also removes pending-action
    // tables that the older three-person room helper does not explicitly own.
    await room?.pool.end();
    if (createdDatabase) {
      await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
      console.log(`Cleaned up owned database ${database}; capture server and browser stopped.`);
    }
    await admin.end();
    await rm(png, { force: true });
  }
}
