import { test, expect, type Page, type Route } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * MOCKED-SERVER UI lane: renders the Spokes product UI against page.route
 * mocks built from the real Berlin Mitte dataset, so the frontend's states
 * (impasse, adjustment consent, staging, arrival) are verifiable without the
 * domain server. This proves UI behavior only — the live three-user flow is
 * covered by three-user.spec.ts against the real server.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = 5190;
const BASE = `http://127.0.0.1:${PORT}`;

const dataset = JSON.parse(
  readFileSync(
    join(repoRoot, "packages", "contracts", "data", "berlin-mitte-venues.json"),
    "utf8",
  ),
) as {
  manifest: { demoCenter: { lat: number; lng: number }; demoRadii: { narrow: number; wide: number } };
  venues: Array<{
    candidateId: string;
    name: string;
    location: { lat: number; lng: number };
    category: string;
    priceLevel: number | null;
    attributes: Array<Record<string, unknown>>;
    mapRevision: number;
  }>;
};

const ELIGIBLE_WIDE = ["place_24", "place_25", "place_30", "place_31"];
const center = dataset.manifest.demoCenter;

function haversineMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.sqrt(h));
}

function contextFixture(opts: {
  revision: number;
  phase: string;
  radiusM: number;
  impasse?: boolean;
  proposals?: unknown[];
  agreement?: unknown;
  arrival?: unknown;
}) {
  const candidates = dataset.venues.map((v) => {
    const inRadius = haversineMeters(center, v.location) <= opts.radiusM;
    const eligible = inRadius && ELIGIBLE_WIDE.includes(v.candidateId);
    return {
      candidateId: v.candidateId,
      name: v.name,
      location: v.location,
      category: v.category,
      eligibility: eligible ? "eligible" : inRadius ? "excluded" : "excluded",
      why: eligible ? "meets all shared requirements" : "does not meet a shared requirement",
      walkMin: Math.round(haversineMeters(center, v.location) / 75),
      priceLevel: v.priceLevel,
    };
  });
  const eligibleCount = candidates.filter((c) => c.eligibility === "eligible").length;
  return {
    ok: true,
    revision: opts.revision,
    phase: opts.phase,
    scope: {
      scopeId: "scope_1",
      area: { kind: "circle", center, radiusM: opts.radiusM },
      transport: ["walk"],
      category: "food",
    },
    feasibility: {
      state: eligibleCount >= 3 ? "feasible" : eligibleCount >= 1 ? "fragile" : "infeasible",
      eligible: eligibleCount,
      uncertain: 0,
      excluded: candidates.length - eligibleCount,
    },
    candidates,
    proposals: opts.proposals ?? [],
    agreement: opts.agreement,
    arrival: opts.arrival,
    impasse: opts.impasse ? { active: true } : undefined,
  };
}

const identity = {
  participantId: "p_org",
  displayName: "Alex",
  role: "organizer",
  roomId: "room_demo",
};

async function mockApi(page: Page, state: { context: unknown; outstanding?: unknown[] }) {
  const json = (route: Route, body: unknown) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
  await page.route("**/api/meta", (r) => json(r, { buildId: "mock-build" }));
  await page.route("**/api/session/exchange", (r) =>
    json(r, { participantToken: "mock-token", ...identity }),
  );
  await page.route("**/api/sync", (r) =>
    json(r, {
      ok: true,
      revision: (state.context as { revision: number }).revision,
      phase: (state.context as { phase: string }).phase,
      identity,
      brief: "mock",
      delta: { fromRevision: 0, events: [], truncated: false },
      outstanding: state.outstanding ?? [],
    }),
  );
  await page.route("**/api/spatial/context", (r) => json(r, state.context));
  await page.route("**/api/spatial/inspect", (r) => {
    const ids = (r.request().postDataJSON() as { candidateIds: string[] }).candidateIds;
    return json(r, {
      ok: true,
      dossiers: dataset.venues.filter((v) => ids.includes(v.candidateId)),
    });
  });
  await page.route("**/api/spatial/navigation", (r) =>
    json(r, {
      ok: true,
      target: { candidateId: "place_24", name: "The Barn" },
      links: {
        geo: "geo:52.52,13.39?q=52.52,13.39(The%20Barn)",
        googleMaps: "https://www.google.com/maps/dir/?api=1&destination=52.52,13.39",
        appleMaps: "https://maps.apple.com/?daddr=52.52,13.39",
      },
    }),
  );
  await page.route("**/api/commands", (r) =>
    json(r, {
      ok: true,
      revision: (state.context as { revision: number }).revision + 1,
      effect: "Done (mock).",
      outstanding: state.outstanding ?? [],
    }),
  );
}

let preview: ChildProcess;

test.beforeAll(async () => {
  preview = spawn(
    "pnpm",
    ["--filter", "@webmcp-hackathon/web", "exec", "vite", "preview", "--host", "127.0.0.1", "--port", String(PORT), "--strictPort"],
    { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
  );
  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      if ((await fetch(BASE)).ok) break;
    } catch {
      /* retry */
    }
    if (Date.now() > deadline) throw new Error("vite preview did not start");
    await new Promise((r) => setTimeout(r, 250));
  }
});

test.afterAll(() => {
  preview?.kill("SIGTERM");
});

test.use({ viewport: { width: 620, height: 900 } });

test("impasse state: banner, dimmed pins, private adjustment card", async ({ page }) => {
  await mockApi(page, {
    context: contextFixture({ revision: 20, phase: "deliberation", radiusM: 800, impasse: true }),
    outstanding: [
      {
        type: "adjustment_request",
        requestId: "adj_1",
        kind: "scope_change",
        change: { dimension: "radius_m", from: 800, to: 1400 },
        projectedGain: { newCandidates: 4 },
        withinDelegatedBound: false,
      },
    ],
  });
  await page.goto(`${BASE}/#invite=deadbeef`);

  await expect(page.getByTestId("impasse-banner")).toContainText("Impasse");
  await expect(page.getByTestId("feasibility-chip")).toHaveText("impasse");
  await expect(page.getByTestId("map-region")).toHaveAttribute("data-scope-radius", "800");
  // All 31 pins stay visible; excluded ones are dimmed, not hidden.
  await expect(page.locator(".pin")).toHaveCount(31);
  await expect(page.locator('.pin[data-eligibility="excluded"]').first()).toBeVisible();

  await page.getByTestId("tab-decisions").click();
  const card = page.getByTestId("adjustment-card");
  await expect(card).toContainText("Widen the search area from 800 m to 1400 m?");
  await expect(card).toContainText("only you see this");
  await page.screenshot({ path: "test-results/spokes-impasse.png", fullPage: true });

  // Grant → mocked consent_required is not returned here (mock says ok);
  // the consent_required staging path is covered in the next test via UI.
  await card.getByTestId("grant-adj_1").click();
  await expect(page.getByTestId("last-result")).toContainText("Done (mock).");
});

test("deliberation at 1400m: eligible pins, proposal rings, sheet actions, veto menu", async ({ page }) => {
  await mockApi(page, {
    context: contextFixture({
      revision: 30,
      phase: "deliberation",
      radiusM: 1400,
      proposals: [
        {
          proposalId: "prop_1",
          candidateId: "place_30",
          status: "vetoed",
          stanceCounts: { accept: 1, reject: 1, other: 0 },
        },
        {
          proposalId: "prop_2",
          candidateId: "place_24",
          status: "open",
          stanceCounts: { accept: 2, reject: 0, other: 0 },
          ownStance: undefined,
        },
      ],
    }),
    outstanding: [{ type: "stance_needed", proposalId: "prop_2" }],
  });
  await page.goto(`${BASE}/#invite=deadbeef`);

  await expect(page.getByTestId("feasibility-chip")).toContainText("4 of 31 eligible");
  await expect(page.locator('.pin[data-eligibility="eligible"]')).toHaveCount(4);
  await expect(page.locator('.pin[data-proposed="true"]')).toHaveCount(1);
  await expect(page.locator('.pin[data-vetoed="true"]')).toHaveCount(1);

  // Stance card in Decisions.
  await page.getByTestId("tab-decisions").click();
  await expect(page.getByTestId("stance-card")).toContainText("The Barn");
  // Organizer also sees the staging card for the open proposal.
  await expect(page.getByTestId("stage-card")).toContainText("Stage the agreement?");

  // Pin → candidate sheet with real dossier attributes and actions.
  await page.getByTestId("pin-place_24").click();
  const sheet = page.getByTestId("candidate-sheet");
  await expect(sheet.getByTestId("sheet-name")).toHaveText("The Barn");
  await expect(sheet.getByTestId("accept-btn")).toBeVisible();
  await sheet.getByTestId("veto-btn").click();
  await expect(sheet.getByTestId("veto-menu")).toContainText("Visited too recently");
  await sheet.getByTestId("details-btn").click();
  await expect(sheet.getByTestId("dossier-details")).toContainText("vegetarian-options");
  await page.screenshot({ path: "test-results/spokes-deliberation.png", fullPage: true });
});

test("arrival: banner, mode picker, navigation handoff link", async ({ page }) => {
  await mockApi(page, {
    context: contextFixture({
      revision: 44,
      phase: "arrival",
      radiusM: 1400,
      proposals: [
        {
          proposalId: "prop_2",
          candidateId: "place_24",
          status: "committed",
          stanceCounts: { accept: 3, reject: 0, other: 0 },
        },
      ],
      agreement: { proposalId: "prop_2", candidateId: "place_24", committedAtRevision: 43 },
      arrival: { mode: "walk" },
    }),
  });
  await page.goto(`${BASE}/#invite=deadbeef`);

  const banner = page.getByTestId("arrival-banner");
  await expect(banner).toContainText("The Barn");
  await expect(page.getByTestId("navigate-link")).toHaveAttribute(
    "href",
    "https://www.google.com/maps/dir/?api=1&destination=52.52,13.39",
  );
  // Committed destination renders as the gold star.
  await expect(page.locator('[data-testid="pin-place_24"][data-committed="true"]')).toBeVisible();
  await page.screenshot({ path: "test-results/spokes-arrival.png", fullPage: true });
});

test("consent staging card appears when a command returns consent_required", async ({ page }) => {
  await mockApi(page, {
    context: contextFixture({ revision: 21, phase: "deliberation", radiusM: 800, impasse: true }),
    outstanding: [
      {
        type: "adjustment_request",
        requestId: "adj_2",
        kind: "scope_change",
        change: { dimension: "radius_m", from: 800, to: 1400 },
        projectedGain: { newCandidates: 4 },
        withinDelegatedBound: false,
      },
    ],
  });
  // Override /api/commands to mirror the real server: a grant outside the
  // delegated bound succeeds but flips the outstanding item to staged:true.
  await page.route("**/api/commands", (route) => {
    const body = route.request().postDataJSON() as { type: string };
    if (body.type === "ResolvePrivateRequest") {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          revision: 22,
          effect: "Grant staged — confirm on the page.",
          outstanding: [
            {
              type: "adjustment_request",
              requestId: "adj_2",
              kind: "scope_change",
              change: { dimension: "radius_m", from: 800, to: 1400 },
              projectedGain: { newCandidates: 4 },
              withinDelegatedBound: false,
              staged: true,
            },
          ],
        }),
      });
    }
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        revision: 23,
        effect: "Confirmed (mock).",
        outstanding: [],
      }),
    });
  });
  await page.goto(`${BASE}/#invite=deadbeef`);

  await page.getByTestId("tab-decisions").click();
  await page.getByTestId("grant-adj_2").click();
  const confirm = page.getByTestId("confirm-card");
  await expect(confirm).toContainText("Confirm on this page");
  await expect(confirm).toContainText("Widen the search area");
  await page.screenshot({ path: "test-results/spokes-consent.png", fullPage: true });
  await confirm.getByTestId("confirm-grant").click();
  await expect(page.getByTestId("last-result")).toContainText("Confirmed (mock).");
});
