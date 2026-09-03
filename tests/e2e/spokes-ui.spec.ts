import {
  expect,
  test,
  type Page,
  type Request,
  type Route,
} from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = 5190;
const BASE = `http://127.0.0.1:${PORT}`;

type Need = {
  id: string;
  label: string;
  ruledOut: number;
  wouldReturn: number;
  unknown: number;
  active: boolean;
  visibility: "shared" | "application-private";
  hardness: "hard";
  ownerId: string;
};

type Candidate = {
  candidateId: string;
  ref?: string;
  name: string;
  location: { lat: number; lng: number };
  category: string;
  eligibility: "eligible" | "uncertain" | "excluded";
  why: string;
  walkMin: number;
  priceLevel: number | null;
};

type MockContext = {
  ok: true;
  revision: number;
  phase: string;
  scope: {
    scopeId: string;
    area: { kind: "circle"; center: { lat: number; lng: number }; radiusM: number };
    transport: string[];
    category: string;
  };
  pool?: { size: number; cap: number; explorable: boolean };
  feasibility: {
    state: "feasible" | "fragile" | "infeasible" | "uncertain";
    eligible: number;
    uncertain: number;
    excluded: number;
  };
  total: number;
  matching: number;
  candidates: Candidate[];
  facets: Array<Record<string, unknown>>;
  activeNeeds: Need[];
  privateEffects: Array<{ owner: string; ruledOut: number; topic?: string }>;
  participants: Array<{
    participantId: string;
    displayName: string;
    role: "organizer" | "member";
    readyState: "contributing" | "ready";
    arrived: boolean;
    present: boolean;
  }>;
  proposals: Array<Record<string, unknown>>;
  agreement?: { proposalId: string; candidateId: string; status: "staged" | "committed"; committedAtRevision?: number };
  arrival?: { mode?: string };
  impasse?: { active: true; text: string };
};

type MockIdentity = typeof identity;

const dataset = JSON.parse(
  readFileSync(
    join(repoRoot, "packages", "contracts", "data", "berlin-mitte-venues.json"),
    "utf8",
  ),
) as {
  manifest: {
    demoCenter: { lat: number; lng: number };
    demoRadii: { narrow: number; wide: number };
  };
  venues: Array<{
    candidateId: string;
    name: string;
    location: { lat: number; lng: number };
    category: string;
    priceLevel: number | null;
    attributes: Array<Record<string, unknown>>;
    hours?: Array<Record<string, unknown>>;
    mapRevision: number;
  }>;
};

const center = dataset.manifest.demoCenter;
const identity = {
  participantId: "p_org",
  displayName: "Alex",
  role: "organizer",
  roomId: "room_demo",
};
const participants = [
  { participantId: "p_org", displayName: "Alex", role: "organizer" as const, readyState: "contributing" as const, arrived: true, present: true },
  { participantId: "p_sarah", displayName: "Sarah", role: "member" as const, readyState: "contributing" as const, arrived: true, present: true },
  { participantId: "p_joe", displayName: "Joe", role: "member" as const, readyState: "contributing" as const, arrived: true, present: true },
];
const PRIVATE_EFFECT_RULED_OUT = 2;
const DEFAULT_ELIGIBLE_IDS = ["place_24", "place_25", "place_30", "place_31"];
const DEFAULT_UNCERTAIN_IDS = ["place_1", "place_2", "place_3", "place_4"];
const DOMAIN_WORDS = /restaurant|dinner|food|cuisine|park|museum|cinema/i;

function haversineMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
) {
  const rad = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.sqrt(h));
}

function fixture(options: {
  revision?: number;
  phase?: string;
  radiusM?: number;
  matching?: number;
  uncertain?: number;
  eligibleIds?: string[];
  uncertainIds?: string[];
  scopeCenter?: { lat: number; lng: number };
  impasse?: boolean;
  activeNeeds?: Need[];
  privateEffects?: MockContext["privateEffects"];
  proposals?: MockContext["proposals"];
  agreement?: MockContext["agreement"];
  arrival?: MockContext["arrival"];
} = {}): MockContext {
  const radiusM = options.radiusM ?? 800;
  const scopeCenter = options.scopeCenter ?? center;
  const inScope = dataset.venues.filter(
    (venue) => haversineMeters(scopeCenter, venue.location) <= radiusM,
  );
  const inScopeIds = new Set(inScope.map((venue) => venue.candidateId));
  const eligibleIds = new Set(
    options.eligibleIds ?? DEFAULT_ELIGIBLE_IDS.slice(0, options.matching ?? 4),
  );
  const uncertainIds = new Set(
    options.uncertainIds ?? DEFAULT_UNCERTAIN_IDS.slice(0, options.uncertain ?? 0),
  );
  const candidates: Candidate[] = dataset.venues.map((venue) => {
    const inside = inScopeIds.has(venue.candidateId);
    const eligibility: Candidate["eligibility"] =
      inside && eligibleIds.has(venue.candidateId)
        ? "eligible"
        : inside && uncertainIds.has(venue.candidateId)
          ? "uncertain"
          : "excluded";
    return {
      candidateId: venue.candidateId,
      name: venue.name,
      location: venue.location,
      category: venue.category,
      eligibility,
      why:
        eligibility === "uncertain"
          ? "not checked yet"
          : eligibility === "excluded"
            ? "does not clear every stated need"
            : "meets all evaluable requirements",
      walkMin: Math.max(1, Math.round(haversineMeters(scopeCenter, venue.location) / 75)),
      priceLevel: venue.priceLevel,
    };
  });
  const matching = candidates.filter((candidate) => candidate.eligibility === "eligible").length;
  const uncertain = candidates.filter((candidate) => candidate.eligibility === "uncertain").length;
  return {
    ok: true,
    revision: options.revision ?? 20,
    phase: options.phase ?? "deliberation",
    scope: {
      scopeId: "scope_1",
      area: { kind: "circle", center: scopeCenter, radiusM },
      transport: ["walk", "bike", "car"],
      category: "food",
    },
    feasibility: {
      state: matching > 2 ? "feasible" : matching > 0 ? "fragile" : uncertain > 0 ? "uncertain" : "infeasible",
      eligible: matching,
      uncertain,
      excluded: Math.max(0, inScope.length - matching - uncertain),
    },
    total: inScope.length,
    matching,
    candidates,
    facets: [
      { key: "outdoor-seating", label: "outdoor seating", type: "boolean", counts: { yes: 17, no: 2, unknown: 2 }, salience: 1 },
      { key: "vegetarian-options", label: "vegetarian options", type: "boolean", counts: { yes: 15, no: 0, unknown: 6 }, salience: 0.9 },
      { key: "wheelchair-accessible", label: "step-free access", type: "boolean", counts: { yes: 9, no: 6, unknown: 6 }, salience: 0.8 },
    ],
    activeNeeds: options.activeNeeds ?? [],
    privateEffects: options.privateEffects ?? [],
    participants,
    proposals: options.proposals ?? [],
    ...(options.agreement ? { agreement: options.agreement } : {}),
    ...(options.arrival ? { arrival: options.arrival } : {}),
    ...(options.impasse
      ? { impasse: { active: true as const, text: "No option currently clears every confirmed requirement." } }
      : {}),
  };
}

function applyEligibility(
  context: MockContext,
  eligibleIds: string[],
  uncertainIds: string[],
) {
  const eligible = new Set(eligibleIds);
  const uncertain = new Set(uncertainIds);
  const { center: scopeCenter, radiusM } = context.scope.area;
  for (const candidate of context.candidates) {
    const inside = haversineMeters(scopeCenter, candidate.location) <= radiusM;
    candidate.eligibility =
      inside && eligible.has(candidate.candidateId)
        ? "eligible"
        : inside && uncertain.has(candidate.candidateId)
          ? "uncertain"
          : "excluded";
    candidate.why =
      candidate.eligibility === "eligible"
        ? "meets all evaluable requirements"
        : candidate.eligibility === "uncertain"
          ? "not checked yet"
          : "does not clear every stated need";
  }
  const inScope = context.candidates.filter(
    (candidate) => haversineMeters(scopeCenter, candidate.location) <= radiusM,
  );
  context.total = inScope.length;
  context.matching = inScope.filter((candidate) => candidate.eligibility === "eligible").length;
  context.feasibility.eligible = context.matching;
  context.feasibility.uncertain = inScope.filter(
    (candidate) => candidate.eligibility === "uncertain",
  ).length;
  context.feasibility.excluded =
    context.total - context.feasibility.eligible - context.feasibility.uncertain;
  context.feasibility.state =
    context.matching > 2
      ? "feasible"
      : context.matching > 0
        ? "fragile"
        : context.feasibility.uncertain > 0
          ? "uncertain"
          : "infeasible";
}

type MockState = {
  context: MockContext;
  outstanding: Array<Record<string, unknown>>;
  audit?: string[];
  identity?: MockIdentity;
  syncEvents?: Array<Record<string, unknown>>;
  command?: (request: Record<string, unknown>, state: MockState) => Record<string, unknown>;
  explore?: Array<{
    ref: string;
    name: string;
    category: string;
    location: { lat: number; lng: number };
  }>;
  exploreAtViewportCenter?: boolean;
  exploreTruncated?: boolean;
};

async function mockApi(page: Page, state: MockState) {
  const viewerIdentity = state.identity ?? identity;
  const recordRequest = (request: Request) => {
    const body = request.postData();
    if (body) state.audit?.push(body);
  };
  const respond = (route: Route, body: unknown) => {
    state.audit?.push(JSON.stringify(body));
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
  };

  await page.route("**/api/meta", (route) => respond(route, { buildId: "mock-build" }));
  await page.route("**/api/session/exchange", (route) => {
    recordRequest(route.request());
    return respond(route, { participantToken: "mock-token", ...viewerIdentity });
  });
  await page.route("**/api/sync", (route) => {
    recordRequest(route.request());
    return respond(route, {
      ok: true,
      revision: state.context.revision,
      phase: state.context.phase,
      identity: viewerIdentity,
      brief: "mock",
      delta: { fromRevision: 0, events: state.syncEvents ?? [], truncated: false },
      outstanding: state.outstanding,
      participants: state.context.participants,
      lastSyncedRevision: state.context.revision,
    });
  });
  await page.route("**/api/spatial/context", (route) => {
    recordRequest(route.request());
    const request = (route.request().postDataJSON() ?? {}) as { excludeRequirementId?: string };
    const held = state.context.activeNeeds.find((need) => need.id === request.excludeRequirementId);
    if (!held) return respond(route, state.context);
    const preview = structuredClone(state.context);
    preview.matching = state.context.matching + held.wouldReturn;
    let remaining = held.wouldReturn;
    for (const candidate of preview.candidates) {
      const candidateInScope =
        haversineMeters(center, candidate.location) <= preview.scope.area.radiusM;
      if (remaining > 0 && candidateInScope && candidate.eligibility !== "eligible") {
        candidate.eligibility = "eligible";
        candidate.why = "returns in preview";
        remaining -= 1;
      }
    }
    applyEligibility(
      preview,
      preview.candidates
        .filter((candidate) => candidate.eligibility === "eligible")
        .map((candidate) => candidate.candidateId),
      preview.candidates
        .filter((candidate) => candidate.eligibility === "uncertain")
        .map((candidate) => candidate.candidateId),
    );
    return respond(route, preview);
  });
  await page.route("**/api/rooms/*/places?*", (route) => {
    const url = new URL(route.request().url());
    const parts = (url.searchParams.get("bbox") ?? "").split(",").map(Number);
    const [south, west, north, east] = parts;
    let places = (state.explore ?? []).filter(
      (place) =>
        place.location.lat >= south &&
        place.location.lat <= north &&
        place.location.lng >= west &&
        place.location.lng <= east,
    );
    if (state.exploreAtViewportCenter && parts.length === 4) {
      places = (state.explore ?? []).map((place) => ({
        ...place,
        location: { lat: (south + north) / 2, lng: (west + east) / 2 },
      }));
    }
    return respond(route, {
      ok: true,
      places,
      truncated: state.exploreTruncated ?? false,
    });
  });
  await page.route("**/api/spatial/inspect", (route) => {
    recordRequest(route.request());
    const ids = (route.request().postDataJSON() as { candidateIds: string[] }).candidateIds;
    return respond(route, {
      ok: true,
      revision: state.context.revision,
      candidates: dataset.venues.filter((venue) => ids.includes(venue.candidateId)),
    });
  });
  await page.route("**/api/spatial/navigation", (route) => {
    recordRequest(route.request());
    return respond(route, {
      ok: true,
      target: { candidateId: "place_24", name: "The Barn" },
      links: {
        geo: "geo:52.52,13.39?q=52.52,13.39(The%20Barn)",
        googleMaps: "https://www.google.com/maps/dir/?api=1&destination=52.52,13.39",
        appleMaps: "https://maps.apple.com/?daddr=52.52,13.39",
      },
    });
  });
  await page.route("**/api/commands", (route) => {
    recordRequest(route.request());
    const request = route.request().postDataJSON() as Record<string, unknown>;
    const result = state.command?.(request, state) ?? {
      ok: true,
      revision: ++state.context.revision,
      effect: "Done (mock).",
      outstanding: state.outstanding,
    };
    return respond(route, result);
  });
}

async function markerTransforms(page: Page, ids: string[]) {
  return page.evaluate((candidateIds) => {
    return Object.fromEntries(
      candidateIds.map((id) => {
        const pin = document.querySelector(`[data-testid="pin-${id}"]`);
        const wrapper = pin?.closest(".maplibregl-marker") as HTMLElement | null;
        return [id, wrapper?.style.transform ?? "missing"];
      }),
    );
  }, ids);
}

/**
 * A baseline that has actually settled. The self-hosted display font lands
 * after first paint and can resize the map region, which moves every marker
 * once; two samples 100 ms apart were passing inside that window. Wait for
 * fonts, then require the positions to hold for three samples 200 ms apart.
 */
async function stableMarkerTransforms(page: Page, ids: string[]) {
  await page.evaluate(() => document.fonts.ready);
  let previous = "";
  let stable = "";
  let streak = 0;
  await expect
    .poll(
      async () => {
        const current = JSON.stringify(await markerTransforms(page, ids));
        stable = current;
        streak = current === previous ? streak + 1 : 0;
        previous = current;
        return streak >= 2;
      },
      { intervals: [200], timeout: 10_000 },
    )
    .toBe(true);
  return JSON.parse(stable) as Record<string, string>;
}

async function closeDrawer(page: Page) {
  const close = page.getByTestId("close-drawer");
  await expect(close).toBeVisible();
  await close.click();
  await expect(page.getByTestId("diagnostics")).toHaveCount(0);
}

async function expectDomainNeutralCopy(locator: ReturnType<Page["locator"]>) {
  await expect(locator.first()).toBeVisible();
  const copy = (await locator.allTextContents()).join(" ").replace(/\s+/g, " ").trim();
  expect(copy.length, `domain-neutral copy was unexpectedly short: ${copy}`).toBeGreaterThan(40);
  expect(copy).not.toMatch(DOMAIN_WORDS);
}

let previewServer: ChildProcess;

test.beforeAll(async () => {
  previewServer = spawn(
    "pnpm",
    [
      "--filter",
      "@webmcp-hackathon/web",
      "exec",
      "vite",
      "preview",
      "--host",
      "127.0.0.1",
      "--port",
      String(PORT),
      "--strictPort",
    ],
    { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
  );
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await fetch(BASE)).ok) break;
    } catch {
      // retry
    }
    if (Date.now() > deadline) throw new Error("vite preview did not start");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
});

test.afterAll(() => previewServer?.kill("SIGTERM"));
test.use({ viewport: { width: 1180, height: 900 } });

test("impasse and pending states protect previews, privacy, map stability, and domain-neutral chrome", async ({ browser }) => {
  const browserContext = await browser.newContext({
    viewport: { width: 1180, height: 900 },
    reducedMotion: "reduce",
  });
  const page = await browserContext.newPage();
  const audit: string[] = [];
  const privateKey = "peer-secret-orchid-key";
  const privateValue = "peer-secret-orchid-value";
  const hiddenPrivateNeed = { key: privateKey, expect: privateValue };
  const previewNeed: Need = {
    id: "need-budget",
    label: "budget €15",
    ruledOut: 8,
    wouldReturn: 3,
    unknown: 0,
    active: true,
    visibility: "shared",
    hardness: "hard",
    ownerId: "p_org",
  };
  const state: MockState = {
    audit,
    context: fixture({
      matching: 0,
      impasse: true,
      activeNeeds: [previewNeed],
      privateEffects: [{ owner: "p_joe", ruledOut: PRIVATE_EFFECT_RULED_OUT }],
    }),
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
    command(request, current) {
      if (request.type === "SubmitRequirement") {
        current.context.revision += 1;
        current.context.activeNeeds.push({
          id: "mock-submitted",
          label: "somewhere calm",
          ruledOut: 0,
          wouldReturn: 0,
          unknown: 4,
          active: true,
          visibility: "shared",
          hardness: "hard",
          ownerId: "p_org",
        });
        applyEligibility(current.context, [], DEFAULT_UNCERTAIN_IDS);
      }
      if (request.type === "SetRequirementActive") {
        const input = request.input as {
          requirementId?: string;
          active?: boolean;
        };
        const need = current.context.activeNeeds.find(
          (candidate) => candidate.id === input.requirementId,
        );
        const nextActive = Boolean(input.active);
        if (need && need.active !== nextActive) {
          need.active = nextActive;
          if (need.id === "mock-submitted" && !nextActive) {
            applyEligibility(current.context, [], []);
          }
        }
        current.context.revision += 1;
      }
      return {
        ok: true,
        revision: current.context.revision,
        effect: "Done (mock).",
        outstanding: current.outstanding,
      };
    },
  };
  await mockApi(page, state);
  await page.goto(`${BASE}/?shim=webmcp#invite=deadbeef`);

  await expect(page.getByTestId("count-block")).toHaveAttribute("data-state", "impasse");
  await expect(page.getByTestId("ways-out")).toContainText("One way out");
  await expect(page.locator('[data-testid^="pin-"]')).toHaveCount(31);
  await expect(page.locator('[data-testid^="pin-"][data-state="out"]')).toHaveCount(31);
  await expect(page.getByTestId("private-effect")).toContainText("A private condition");
  await expect(page.getByTestId("private-effect")).toContainText(
    `−${PRIVATE_EFFECT_RULED_OUT}`,
  );
  await expect(page.locator("body")).not.toContainText(privateKey);
  await expect(page.locator("body")).not.toContainText(privateValue);

  const ownerAudit: string[] = [];
  const ownerPage = await browserContext.newPage();
  const ownerNeed: Need = {
    ...previewNeed,
    id: "need-owner-private",
    label: `owner view ${privateKey} ${privateValue}`,
    visibility: "application-private",
    ownerId: "p_joe",
  };
  await mockApi(ownerPage, {
    audit: ownerAudit,
    identity: { ...identity, participantId: "p_joe", displayName: "Joe", role: "member" },
    context: fixture({
      matching: 0,
      activeNeeds: [ownerNeed],
    }),
    outstanding: [],
    syncEvents: [
      {
        revision: 20,
        type: "requirement_submitted",
        level: "full",
        actorId: "p_joe",
        text: `You added a private need: ${privateKey}`,
        payload: { predicate: hiddenPrivateNeed },
      },
    ],
  });
  await ownerPage.goto(`${BASE}/#invite=cafedeadbeef`);
  await expect(ownerPage.getByTestId("need-need-owner-private")).toContainText(privateKey);
  await expect(ownerPage.getByTestId("need-need-owner-private")).toContainText(privateValue);
  expect(ownerAudit.join("\n")).toContain(privateKey);
  expect(ownerAudit.join("\n")).toContain(privateValue);

  const adjustment = page.getByTestId("adjustment-card");
  await expect(adjustment).toContainText("Widen the area from 800 m to 1.4 km?");
  await expect(adjustment).toContainText("only you see this");

  await expectDomainNeutralCopy(
    page.locator(".drawer-title, .drawer-section-title, .drawer-head .drawer-chip"),
  );
  await closeDrawer(page);
  await page.getByTestId("composer-scope").click();
  await expectDomainNeutralCopy(
    page.locator(
      ".header-subtitle, .count-label, .section-title, .composer-suggest-label, " +
        '[role="menuitemradio"], #consent .card-body, [data-testid="adjustment-card"] .card-body',
    ),
  );
  await page.getByTestId("composer-scope").click();

  const row = page.getByTestId("need-need-budget");
  const box = await row.boundingBox();
  if (!box) throw new Error("need row has no pointer target");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect(page.getByTestId("map-region")).toHaveAttribute("data-preview", "true");
  await expect(page.getByTestId("count-number")).toHaveText("3");
  const liveRegion = page.locator("#brief-preview-count");
  await expect(liveRegion).toHaveAttribute("role", "status");
  await expect(liveRegion).toHaveAttribute("aria-live", "polite");
  await expect(liveRegion).toHaveText("3 still work");
  await expect(page.locator('[data-testid^="pin-"][data-state="return"]')).toHaveCount(3);
  const reducedMotion = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const sticker = getComputedStyle(
      document.querySelector('[data-state="return"] .sticker-box')!,
    );
    return {
      settle: root.getPropertyValue("--spoke-dur-settle").trim(),
      pop: root.getPropertyValue("--spoke-dur-pop").trim(),
      breathe: root.getPropertyValue("--spoke-dur-breathe").trim(),
      busy: root.getPropertyValue("--spoke-dur-busy").trim(),
      animationName: sticker.animationName,
      animationDuration: sticker.animationDuration,
    };
  });
  expect(reducedMotion).toEqual({
    settle: "0ms",
    pop: "0ms",
    breathe: "0ms",
    busy: "0ms",
    animationName: "spoke-breathe",
    animationDuration: "0s",
  });
  await page.mouse.up();
  await expect(page.getByTestId("map-region")).not.toHaveAttribute("data-preview", "true");
  await expect(page.getByTestId("count-number")).toHaveText("0");
  await expect(page.locator('[data-testid^="pin-"][data-state="return"]')).toHaveCount(0);

  await row.focus();
  await page.keyboard.down("Space");
  await expect(page.getByTestId("map-region")).toHaveAttribute("data-preview", "true");
  await expect(page.getByTestId("count-number")).toHaveText("3");
  await expect(liveRegion).toHaveText("3 still work");
  await page.keyboard.up("Space");
  await expect(page.getByTestId("map-region")).not.toHaveAttribute("data-preview", "true");
  await expect(page.getByTestId("count-number")).toHaveText("0");
  await expect(page.locator('[data-testid^="pin-"][data-state="return"]')).toHaveCount(0);

  const markerIds = ["place_1", "place_10", "place_24", "place_31"];
  const transformsBefore = await markerTransforms(page, markerIds);
  await page.getByLabel("What matters to you?").fill("somewhere calm");
  await page.getByLabel("What matters to you?").press("Enter");
  await expect(page.getByTestId("need-mock-submitted")).toBeVisible();
  // The council's declared impasse still stands in this fixture, so the block
  // keeps reading impasse (a declared impasse wins over pending) while the
  // subline counts the unknowns the new need produced.
  await expect(page.getByTestId("count-block")).toHaveAttribute("data-state", "impasse");
  await expect(page.getByTestId("count-block")).toContainText("· 4 unsure");
  await expect(page.locator('[data-testid^="pin-"][data-state="unsure"]')).toHaveCount(4);
  await expect(page.getByTestId("need-mock-submitted")).toHaveAttribute("aria-pressed", "true");
  expect(await markerTransforms(page, markerIds)).toEqual(transformsBefore);
  await page.getByTestId("need-mock-submitted").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("need-mock-submitted")).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator('[data-testid^="pin-"][data-state="unsure"]')).toHaveCount(0);
  expect(await markerTransforms(page, markerIds)).toEqual(transformsBefore);

  expect(audit.join("\n")).not.toContain(privateKey);
  expect(audit.join("\n")).not.toContain(privateValue);
  await browserContext.close();
});

test("candidate batches settle in place, and only this viewer's centre action refits", async ({ page }) => {
  const localIds = ["place_1", "place_2", "place_3", "place_4"];
  const trackedIds = ["place_1", "place_10", "place_24", "place_31"];
  let peerCenter: { lat: number; lng: number } | null = null;
  const state: MockState = {
    context: fixture({ eligibleIds: localIds }),
    outstanding: [],
    command(request, current) {
      const input = request.input as Record<string, unknown>;
      current.context.revision += 1;
      if (request.type === "SubmitRequirement") {
        current.context.activeNeeds.push({
          id: "batch-need",
          label: "somewhere calm",
          ruledOut: 1,
          wouldReturn: 3,
          unknown: 2,
          active: true,
          visibility: "shared",
          hardness: "hard",
          ownerId: "p_org",
        });
        applyEligibility(current.context, ["place_1"], ["place_2", "place_3"]);
      } else if (request.type === "SetRequirementActive") {
        const need = current.context.activeNeeds.find(
          (candidate) => candidate.id === input.requirementId,
        );
        if (need) need.active = Boolean(input.active);
        applyEligibility(current.context, localIds, []);
        if (peerCenter) current.context.scope.area.center = peerCenter;
      } else if (request.type === "SetSearchScope") {
        const area = input.area as MockContext["scope"]["area"];
        current.context = fixture({
          revision: current.context.revision,
          radiusM: area.radiusM,
          scopeCenter: area.center,
          eligibleIds: [...localIds, ...DEFAULT_ELIGIBLE_IDS],
          activeNeeds: current.context.activeNeeds,
        });
      }
      return {
        ok: true,
        revision: current.context.revision,
        effect: "Done (mock).",
        outstanding: current.outstanding,
      };
    },
  };
  await mockApi(page, state);
  await page.goto(`${BASE}/?shim=webmcp#invite=deadbeef`);
  await closeDrawer(page);

  await expectDomainNeutralCopy(page.getByTestId("brief-empty"));
  await expect(page.locator('[data-testid^="pin-"][data-state="works"]')).toHaveCount(4);
  // The baseline is only meaningful once the basemap has loaded and the
  // on-load fit has run; before that a stability poll can pass between the
  // first paint and the fit (the bundled worker made the map load in
  // production builds, which is what this suite serves).
  await expect(page.getByTestId("map-region")).toHaveAttribute("data-loaded", "true", { timeout: 20_000 });
  const initialTransforms = await stableMarkerTransforms(page, trackedIds);

  await page.getByLabel("What matters to you?").fill("somewhere calm");
  await page.getByLabel("What matters to you?").press("Enter");
  await expect(page.getByTestId("need-batch-need")).toBeVisible();
  await expect(page.locator('[data-testid^="pin-"][data-state="works"]')).toHaveCount(1);
  await expect(page.locator('[data-testid^="pin-"][data-state="unsure"]')).toHaveCount(2);
  expect(await markerTransforms(page, trackedIds)).toEqual(initialTransforms);

  await page.getByTestId("need-batch-need").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("need-batch-need")).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator('[data-testid^="pin-"][data-state="works"]')).toHaveCount(4);
  await expect(page.locator('[data-testid^="pin-"][data-state="unsure"]')).toHaveCount(0);
  expect(await markerTransforms(page, trackedIds)).toEqual(initialTransforms);

  const setScope = (area: MockContext["scope"]["area"]) =>
    page.evaluate(async (nextArea) => {
      const shim = (window as never as {
        __webmcpTestShim: { executeTool(name: string, args: string): Promise<unknown> };
      }).__webmcpTestShim;
      return shim.executeTool(
        "set_search_scope",
        JSON.stringify({ baseRevision: 0, area: nextArea }),
      );
    }, area);

  await setScope({ kind: "circle", center, radiusM: 1400 });
  await expect(page.getByTestId("map-region")).toHaveAttribute("data-scope-radius", "1400");
  await expect(page.locator('[data-testid^="pin-"][data-state="works"]')).toHaveCount(8);
  await expect(page.locator('[data-testid^="pin-"][data-state="out"]')).toHaveCount(23);
  expect(await markerTransforms(page, trackedIds)).toEqual(initialTransforms);

  const shiftedCenter = { lat: center.lat + 0.004, lng: center.lng + 0.004 };
  await setScope({ kind: "circle", center: shiftedCenter, radiusM: 1400 });
  await expect
    .poll(async () => JSON.stringify(await markerTransforms(page, trackedIds)))
    .not.toBe(JSON.stringify(initialTransforms));
  const afterOwnCentre = await stableMarkerTransforms(page, trackedIds);

  // A peer's shared Search here lands alongside an unrelated local refresh:
  // the scope ring moves, but this viewer's camera must stay where they left it.
  peerCenter = { lat: center.lat - 0.004, lng: center.lng - 0.004 };
  await page.getByTestId("need-batch-need").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("need-batch-need")).toHaveAttribute("aria-pressed", "true");
  expect(await markerTransforms(page, trackedIds)).toEqual(afterOwnCentre);
});

test("panning reveals explorable places, bringing one in preserves the viewport, and the area is recoverable", async ({ page }) => {
  const explored = {
    ref: "node/explore-east",
    name: "Eastside Place",
    category: "community_centre",
    location: { lat: center.lat, lng: center.lng + 0.02 },
  };
  const context = fixture({ eligibleIds: dataset.venues.map((venue) => venue.candidateId) });
  for (const [candidateId, ref] of [["place_collocated_a", "node/collocated-a"], ["place_collocated_b", "node/collocated-b"]] as const) {
    context.candidates.push({
      candidateId,
      ref,
      name: candidateId.endsWith("a") ? "Together One" : "Together Two",
      category: "community_centre",
      location: { lat: center.lat + 0.001, lng: center.lng + 0.001 },
      eligibility: "eligible",
      why: "meets all evaluable requirements",
      walkMin: 2,
      priceLevel: null,
    });
  }
  context.pool = { size: context.candidates.length, cap: 400, explorable: true };
  const state: MockState = {
    context,
    outstanding: [],
    explore: [explored],
    exploreAtViewportCenter: true,
    exploreTruncated: true,
    command(request, current) {
      current.context.revision += 1;
      if (request.type === "AddCandidates") {
        current.context.candidates.push({
          candidateId: "pl_demo_032",
          ref: explored.ref,
          name: explored.name,
          category: explored.category,
          location: explored.location,
          eligibility: "excluded",
          why: "outside the current search area",
          walkMin: 45,
          priceLevel: null,
        });
        current.context.pool!.size += 1;
      }
      return {
        ok: true,
        revision: current.context.revision,
        effect: "Done (mock).",
        outstanding: current.outstanding,
      };
    },
  };
  await mockApi(page, state);
  await page.goto(`${BASE}/#invite=deadbeef`);
  await expect(page.getByTestId("map-region")).toHaveAttribute("data-loaded", "true", {
    timeout: 20_000,
  });
  await expect
    .poll(() => page.locator('[data-testid^="pin-"][data-named="true"]').count())
    .toBeGreaterThanOrEqual(6);
  const placement = await page.evaluate(() => {
    const map = document.querySelector('[data-testid="map-region"]')!.getBoundingClientRect();
    const cards = [...document.querySelectorAll('[data-named="true"] .sticker-box')]
      .map((card) => card.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0);
    return {
      count: cards.length,
      inside: cards.every((rect) => rect.left >= map.left - 1 && rect.right <= map.right + 1),
    };
  });
  expect(placement.count).toBeGreaterThanOrEqual(6);
  expect(placement.inside).toBe(true);
  const collocated = await markerTransforms(page, ["place_collocated_a", "place_collocated_b"]);
  expect(collocated.place_collocated_a).not.toBe(collocated.place_collocated_b);
  const canvas = page.locator(".maplibregl-canvas");
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width * 0.75, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + 40, box!.y + box!.height / 2, { steps: 12 });
  await page.mouse.up();

  await expect(page.getByTestId("back-to-area")).toBeVisible();
  await expect(page.getByTestId("search-here")).toBeVisible();
  await expect
    .poll(async () => Number(await page.getByTestId("map-region").getAttribute("data-explore-count")))
    .toBeGreaterThan(0);
  await expect(page.getByTestId("explore-truncated")).toHaveText(
    "Zoom in to see every place here.",
  );
  const pannedBefore = await stableMarkerTransforms(page, ["place_1", "place_24"]);

  // The GL layer also exposes its visible places through one native keyboard
  // control, avoiding a parallel DOM marker population.
  await page.getByLabel("Explore places in view").evaluate(
    (node, ref) => {
      const select = node as HTMLSelectElement;
      select.value = String(ref);
      select.dispatchEvent(new Event("change", { bubbles: true }));
    },
    explored.ref,
  );
  await expect(page.getByTestId("explore-card")).toContainText("Everyone in the room will see it.");
  const bringIn = page.getByRole("button", { name: "Bring into the room" });
  await expect(bringIn).toBeFocused();
  await expect(page.locator('.map-region > .sr-only[aria-live="polite"]')).toContainText(
    "Eastside Place opened.",
  );
  await bringIn.click();
  await expect(page.getByTestId("pin-pl_demo_032")).toBeVisible();
  expect(await markerTransforms(page, ["place_1", "place_24"])).toEqual(pannedBefore);

  await page.getByTestId("back-to-area").click();
  await expect(page.getByTestId("back-to-area")).toHaveCount(0);
  await expect(page.getByTestId("search-here")).toHaveCount(0);
});

test("deliberation draws unsure and proposed pins and exposes direct stance actions", async ({ page }) => {
  const state: MockState = {
    context: fixture({
      revision: 30,
      radiusM: 1400,
      matching: 4,
      uncertain: 2,
      activeNeeds: [
        {
          id: "need-step-free",
          label: "step-free access",
          ruledOut: 6,
          wouldReturn: 2,
          unknown: 2,
          active: true,
          visibility: "shared",
          hardness: "hard",
          ownerId: "p_sarah",
        },
      ],
      proposals: [
        {
          proposalId: "prop_1",
          candidateId: "place_30",
          status: "vetoed",
          stances: [
            { participantId: "p_org", stance: "veto" },
            { participantId: "p_sarah", stance: "accept" },
            { participantId: "p_joe", stance: "none" },
          ],
          vetoStands: true,
          ownStance: "veto",
        },
        {
          proposalId: "prop_2",
          candidateId: "place_24",
          status: "open",
          stances: [
            { participantId: "p_org", stance: "none" },
            { participantId: "p_sarah", stance: "accept" },
            { participantId: "p_joe", stance: "none" },
          ],
          vetoStands: false,
        },
      ],
    }),
    outstanding: [{ type: "stance_needed", proposalId: "prop_2" }],
  };
  await mockApi(page, state);
  await page.goto(`${BASE}/#invite=deadbeef`);

  await expect(page.getByTestId("count-block")).toContainText("· 2 unsure");
  // Two of the four matching pins carry a proposal: the open one draws
  // proposed, the one under a standing veto draws vetoed. Both outrank works,
  // and neither changes the count — a veto blocks agreement, it does not rule
  // the place out of the set.
  await expect(page.locator('[data-testid^="pin-"][data-state="works"]')).toHaveCount(2);
  await expect(page.locator('[data-testid^="pin-"][data-state="unsure"]')).toHaveCount(2);
  await expect(page.getByTestId("pin-place_24")).toHaveAttribute("data-state", "proposed");
  await expect(page.getByTestId("pin-place_30")).toHaveAttribute("data-state", "vetoed");
  await expect(page.getByTestId("pin-place_30")).toContainText("ruled out");
  await expect(page.getByTestId("pin-place_30")).toHaveAttribute("aria-label", /veto stands/);
  await expect(page.getByTestId("stance-card")).toContainText("The Barn is on the table");
  await expect(page.getByTestId("stage-card")).toContainText("Settle on The Barn?");
  const normalMotion = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const sticker = getComputedStyle(
      document.querySelector('[data-state="proposed"] .sticker-box')!,
    );
    return {
      settle: root.getPropertyValue("--spoke-dur-settle").trim(),
      pop: root.getPropertyValue("--spoke-dur-pop").trim(),
      breathe: root.getPropertyValue("--spoke-dur-breathe").trim(),
      animationName: sticker.animationName,
      animationDuration: sticker.animationDuration,
    };
  });
  for (const duration of [normalMotion.settle, normalMotion.pop, normalMotion.breathe]) {
    expect(Number.parseFloat(duration)).toBeGreaterThan(0);
  }
  expect(normalMotion.animationName).toBe("spoke-pop");
  expect(Number.parseFloat(normalMotion.animationDuration)).toBeGreaterThan(0);

  const pin = page.getByTestId("pin-place_24");
  await pin.click({ force: true, position: { x: 22, y: 22 } });
  const details = page.getByTestId("place-details");
  await expect(details).toHaveAttribute("aria-label", "The Barn");
  await expect(details.getByTestId("verdict")).toHaveAttribute("data-state", "works");
  await expect(details.getByTestId("verdict")).toContainText("Clears every need the room has stated");
  await expect(details.locator('.attr-row[data-status="verified_true"]').first()).toBeVisible();
  await expect(details.getByTestId("accept-btn")).toBeVisible();
  await expect(details.getByTestId("veto-btn")).toHaveText("Rule it out");
  await expectDomainNeutralCopy(
    page.locator(
      ".details-nav, .group-heading, .details-actions, " +
        '[data-testid="stance-card"] .card-body, [data-testid="stage-card"] .card-body',
    ),
  );
  const vetoResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/commands") &&
      response.request().method() === "POST" &&
      response.request().postDataJSON()?.type === "RespondToProposal",
  );
  await details.getByTestId("veto-btn").click();
  await vetoResponse;
  await expect(page.getByTestId("last-result")).toHaveCount(0);
});

test("arrival appears only for a committed agreement and offers mode and navigation handoff", async ({ page }) => {
  const state: MockState = {
    context: fixture({
      revision: 44,
      phase: "arrival",
      radiusM: 1400,
      proposals: [
        {
          proposalId: "prop_2",
          candidateId: "place_24",
          status: "committed",
          stances: participants.map((participant) => ({
            participantId: participant.participantId,
            stance: "accept",
          })),
          vetoStands: false,
          ownStance: "accept",
        },
      ],
      agreement: {
        proposalId: "prop_2",
        candidateId: "place_24",
        status: "committed",
        committedAtRevision: 43,
      },
      arrival: { mode: "walk" },
    }),
    outstanding: [],
    command(request, current) {
      current.context.revision += 1;
      if (request.type === "PlanArrival") {
        const input = request.input as { mode?: string };
        current.context.arrival = { mode: input.mode };
      }
      return {
        ok: true,
        revision: current.context.revision,
        effect: "Done (mock).",
        outstanding: current.outstanding,
      };
    },
  };
  await mockApi(page, state);
  await page.goto(`${BASE}/#invite=deadbeef`);

  await expect(page.getByTestId("room-title")).toHaveText("The Barn");
  await expect(page.getByTestId("arrival-banner")).toContainText("The Barn");
  await expect(page.getByTestId("composer")).toHaveCount(0);
  const modes = page.getByRole("group", { name: "How are you getting there?" });
  await expect(modes.getByRole("button", { name: "Walk" })).toHaveAttribute("aria-pressed", "true");
  await modes.getByRole("button", { name: "Bike" }).click();
  await expect(modes.getByRole("button", { name: "Bike" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByTestId("navigate-link")).toHaveAttribute(
    "href",
    "https://www.google.com/maps/dir/?api=1&destination=52.52,13.39",
  );
  await expect(page.getByTestId("pin-place_24")).toHaveAttribute("data-state", "settled");
  await expect(page.getByTestId("pin-place_24")).toContainText("· settled");
  await expect(page.getByTestId("count-block")).toHaveAttribute("data-state", "settled");
  await expectDomainNeutralCopy(
    page.locator(".arrival-sub, .arrival-go, .arrival-alt, .seg"),
  );
});

test("consent grant stages before confirmation and a staged agreement is not settled", async ({ page }) => {
  const stagedProposal = {
    proposalId: "prop_2",
    candidateId: "place_24",
    status: "staged",
    stances: participants.map((participant) => ({
      participantId: participant.participantId,
      stance: "accept",
    })),
    vetoStands: false,
    ownStance: "accept",
  };
  const state: MockState = {
    context: fixture({
      revision: 21,
      matching: 0,
      impasse: true,
      proposals: [stagedProposal],
      agreement: { proposalId: "prop_2", candidateId: "place_24", status: "staged" },
      activeNeeds: [
        {
          id: "need-budget",
          label: "budget €15",
          ruledOut: 8,
          wouldReturn: 3,
          unknown: 0,
          active: true,
          visibility: "shared",
          hardness: "hard",
          ownerId: "p_org",
        },
      ],
    }),
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
    command(request, current) {
      current.context.revision += 1;
      if (request.type === "ResolvePrivateRequest") {
        current.outstanding = current.outstanding.map((item) => ({ ...item, staged: true }));
      }
      return {
        ok: true,
        revision: current.context.revision,
        effect: "Confirmed (mock).",
        outstanding: current.outstanding,
      };
    },
  };
  await mockApi(page, state);
  await page.goto(`${BASE}/#invite=deadbeef`);

  await expect(page.getByTestId("commit-card")).toContainText("The Barn is staged");
  await expect(page.getByTestId("arrival-banner")).toHaveCount(0);
  await expect(page.getByTestId("composer")).toBeVisible();
  await expect(page.getByTestId("room-title")).not.toHaveText("The Barn");

  await page.getByTestId("grant-adj_2").click();
  const confirm = page.getByTestId("confirm-card");
  await expect(confirm).toContainText("Confirm here to apply it");
  await expect(confirm).toContainText("Widen the area from 800 m to 1.4 km?");
  await expect(confirm.getByTestId("confirm-grant")).toBeVisible();
  await expect(page.getByTestId("map-region")).toHaveAttribute("data-scope-radius", "800");
  await expectDomainNeutralCopy(
    page.locator('[data-testid="confirm-card"] .card-kicker, [data-testid="confirm-card"] .card-body'),
  );
  await expect(page.getByTestId("last-result")).toHaveCount(0);
});

/**
 * A scripted realtime channel. The page authenticates and gets a welcome; the
 * test then pushes presentation frames (lookups, facts) whenever it likes.
 * Nothing is forwarded to a server — there is none behind vite preview.
 */
async function scriptedSocket(page: Page, revision: number) {
  let route: { send(data: string): void } | null = null;
  let ready: () => void = () => {};
  const welcomed = new Promise<void>((resolve) => {
    ready = resolve;
  });
  await page.routeWebSocket("**/ws", (ws) => {
    route = ws;
    ws.onMessage((raw) => {
      const message = JSON.parse(String(raw)) as {
        type: string;
        clientToolContractVersion?: string;
      };
      if (message.type !== "auth") return;
      ws.send(
        JSON.stringify({
          type: "welcome",
          buildId: "mock-build",
          toolContractVersion: message.clientToolContractVersion,
          revision,
          participantId: identity.participantId,
          displayName: identity.displayName,
          role: identity.role,
        }),
      );
      ws.send(JSON.stringify({ type: "presence", present: ["p_org"], viewing: [] }));
      ready();
    });
  });
  return {
    welcomed,
    send(frame: Record<string, unknown>) {
      if (!route) throw new Error("socket not open yet");
      route.send(JSON.stringify(frame));
    },
  };
}

test("a need said is pending until the room settles it, and busy rings mark places being looked up", async ({ page }) => {
  const audit: string[] = [];
  const state: MockState = {
    audit,
    context: fixture({ matching: 4, revision: 30 }),
    outstanding: [],
    command(request, current) {
      if (request.type === "SubmitRequirement") {
        current.context.revision += 1;
        current.context.activeNeeds.push({
          id: "mock-pill",
          label: "outdoor seating",
          ruledOut: 2,
          wouldReturn: 2,
          unknown: 0,
          active: true,
          visibility: "shared",
          hardness: "hard",
          ownerId: "p_org",
        });
        applyEligibility(current.context, DEFAULT_UNCERTAIN_IDS.slice(0, 2), []);
      }
      return {
        ok: true,
        revision: current.context.revision,
        effect: "Done (mock).",
        outstanding: current.outstanding,
      };
    },
  };
  await mockApi(page, state);
  // The commit takes a moment, so the provisional row is observable.
  await page.route("**/api/commands", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 700));
    await route.fallback();
  });
  const socket = await scriptedSocket(page, 30);
  await page.goto(`${BASE}/#invite=deadbeef`);
  await socket.welcomed;
  // Nothing stated yet: the block counts places, not survivors.
  await expect(page.getByTestId("count-number")).toHaveText("21");
  await expect(page.getByTestId("map-region")).not.toHaveAttribute("aria-busy", "true");

  // Said: the row exists at once, in the person's words, dashed and busy.
  await page.getByTestId("pill-outdoor-seating").click();
  const provisional = page.getByTestId("need-provisional");
  await expect(provisional).toBeVisible();
  await expect(provisional).toHaveAttribute("data-pending", "true");
  await expect(provisional).toContainText("outdoor seating");
  await expect(provisional).toContainText("saying it…");
  await expect(page.getByTestId("brief")).toHaveAttribute("aria-busy", "true");
  await expect(page.locator("#brief-preview-count")).toHaveAttribute("aria-busy", "true");

  // The server starts looking places up for it before the commit lands.
  socket.send({
    type: "lookups",
    pending: ["place_1", "place_2"],
    reason: { kind: "need", label: "outdoor seating" },
  });
  await expect(page.getByTestId("pin-place_1")).toHaveAttribute("data-busy", "true");
  await expect(page.getByTestId("pin-place_2")).toHaveAttribute("data-busy", "true");
  await expect(page.getByTestId("pin-place_3")).not.toHaveAttribute("data-busy", "true");
  await expect(page.getByTestId("count-busy")).toHaveText("checking 2 for outdoor seating");
  await expect(page.getByTestId("map-region")).toHaveAttribute("aria-busy", "true");
  // The ring fades in over the settle duration; wait for it to land.
  await expect
    .poll(() =>
      page.evaluate(() => {
        // The ring sits on the sticker's dot when the place carries a name
        // card, on the anchor dot otherwise.
        const pin = document.querySelector('[data-testid="pin-place_1"]')!;
        const named = pin.getAttribute("data-named") === "true";
        const el = pin.querySelector(named ? ".sticker-busy" : ".marker-busy")!;
        const style = getComputedStyle(el);
        return { name: style.animationName, opacity: style.opacity, border: style.borderTopStyle };
      }),
    )
    .toEqual({ name: "spoke-busy", opacity: "1", border: "dashed" });

  // Committed: the real row takes over, still pending while the room looks.
  const row = page.getByTestId("need-mock-pill");
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute("data-pending", "true");
  await expect(row).toContainText("checking 2 places…");
  await expect(page.getByTestId("need-provisional")).toHaveCount(0);
  await expect(page.getByTestId("count-number")).toHaveText("2");

  // The lookups end: rings clear, the row settles, the count is announced.
  const contextCallsBefore = audit.filter((line) => line.includes('"revision":31')).length;
  socket.send({ type: "lookups", pending: [] });
  await expect(page.getByTestId("pin-place_1")).not.toHaveAttribute("data-busy", "true");
  await expect(page.getByTestId("count-busy")).toHaveCount(0);
  await expect(row).not.toHaveAttribute("data-pending", "true");
  await expect(row).toContainText("−2");
  await expect(page.getByTestId("brief")).not.toHaveAttribute("aria-busy", "true");
  await expect(page.locator("#brief-preview-count")).not.toHaveAttribute("aria-busy", "true");
  await expect(page.getByTestId("map-region")).not.toHaveAttribute("aria-busy", "true");

  // A facts frame re-reads the context without any commit.
  socket.send({ type: "facts", candidateIds: ["place_1"], reason: "lookup" });
  await expect
    .poll(() => audit.filter((line) => line.includes('"revision":31')).length)
    .toBeGreaterThan(contextCallsBefore);
});

test("place details read the server's verdicts, address and hours, and say when a lookup runs", async ({ page }) => {
  const needs = [
    { id: "need-veg", label: "vegetarian options", ruledOut: 3, wouldReturn: 3, unknown: 2, active: true, visibility: "shared" as const, hardness: "hard" as const, ownerId: "p_sarah" },
    { id: "need-budget", label: "budget €15", ruledOut: 1, wouldReturn: 1, unknown: 0, active: true, visibility: "shared" as const, hardness: "hard" as const, ownerId: "p_org" },
  ];
  const state: MockState = {
    context: fixture({ matching: 3, revision: 40, activeNeeds: needs, privateEffects: [{ owner: "p_joe", ruledOut: 1 }] }),
    outstanding: [],
  };
  await mockApi(page, state);
  await page.route("**/api/spatial/inspect", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        revision: 40,
        candidates: [
          {
            candidateId: "place_24",
            name: "The Barn",
            location: center,
            category: "cafe",
            priceLevel: 2,
            hours: [
              { day: "mon", open: "09:00", close: "18:00" },
              { day: "tue", open: "09:00", close: "18:00" },
              { day: "sat", open: "10:00", close: "14:00" },
            ],
            address: "Schiffbauerdamm 12, 10117 Berlin",
            phone: "+49 30 123456",
            needs: [
              { requirementId: "need-veg", label: "vegetarian options", verdict: "likely", confidence: 0.6 },
              { requirementId: "need-budget", label: "budget €15", verdict: "yes" },
              { requirementId: "req_private_joe", private: true, verdict: "unknown" },
            ],
            attributes: [
              { key: "vegetarian-options", status: "likely_true", source: "menu:example.org", observedAt: "2026-08-31T00:00:00Z", confidence: 0.6, note: "the menu mentions a vegan bowl" },
              { key: "outdoor-seating", status: "verified_true", source: "osm:outdoor_seating", observedAt: "2026-08-31T00:00:00Z", confidence: 0.8 },
              { key: "price-level", value: 2, status: "likely_true", source: "guess:amenity", observedAt: "2026-08-31T00:00:00Z", confidence: 0.4, note: "a café" },
              { key: "hours", status: "likely_true", source: "web:example.org", observedAt: "2026-08-31T00:00:00Z", confidence: 0.5 },
            ],
            mapRevision: 1,
          },
        ],
      }),
    }),
  );
  const socket = await scriptedSocket(page, 40);
  await page.goto(`${BASE}/#invite=deadbeef`);
  await socket.welcomed;

  await page.getByTestId("pin-place_24").click();
  const details = page.getByTestId("place-details");
  await expect(details).toBeVisible();
  await expect(details.getByTestId("details-lookup")).toHaveText("what the record says");
  await expect(details.locator(".details-nav-title")).toHaveCount(0);
  await expect(details.locator(".details-title")).toHaveText("The Barn");
  await expect(details.locator(".details-meta")).toContainText("likely about €");

  const ledger = details.getByTestId("fit-ledger");
  const rows = ledger.locator(".check-row");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toHaveAttribute("data-mark", "likely");
  await expect(rows.nth(0)).toContainText("vegetarian options");
  await expect(rows.nth(0)).toContainText("the menu mentions a vegan bowl");
  await expect(rows.nth(0).locator(".ledger-answer")).toHaveText(/^likely: likely$/);
  await expect(rows.nth(1)).toHaveAttribute("data-mark", "in");
  await expect(rows.nth(1)).toContainText("yes");
  await expect(rows.nth(2)).toHaveAttribute("data-mark", "unknown");
  await expect(rows.nth(2)).toContainText("A private condition");
  await expect(rows.nth(2)).toContainText("nobody could confirm");
  await expect(ledger).not.toContainText(/verified|unverified|pending|-options/);

  const whereWhen = details.getByTestId("where-when");
  await expect(whereWhen).toContainText("Schiffbauerdamm 12");
  await expect(whereWhen.locator(".details-phone")).toHaveAttribute("href", "tel:+4930123456");
  await expect(whereWhen.locator(".hours-row")).toHaveCount(2);
  await expect(whereWhen.locator(".hours-row").nth(0)).toContainText("Mon–Tue");
  await expect(whereWhen.locator(".hours-row").nth(0)).toContainText("09:00–18:00");
  await expect(whereWhen.locator(".hours-row").nth(1)).toContainText("Sat");

  // Facts nobody asked about: the verified one is a pill; the valueless
  // "hours" fact and the guessed price (said once, above) are not.
  const facts = details.getByTestId("facts");
  await expect(facts).toContainText("outdoor seating");
  await expect(facts).not.toContainText("hours");
  await expect(facts).not.toContainText("€");

  // A lookup on this place: the reserved line says so, with the ring.
  socket.send({ type: "lookups", pending: ["place_24"], reason: { kind: "place" } });
  await expect(details.getByTestId("details-lookup")).toHaveAttribute("data-state", "busy");
  await expect(details.getByTestId("details-lookup")).toHaveText("looking it up…");
  await expect(details.getByTestId("details-lookup-btn")).toBeDisabled();
  socket.send({ type: "lookups", pending: [] });
  await expect(details.getByTestId("details-lookup")).toHaveText("what the record says");
  await expect(details.getByTestId("details-lookup-btn")).toHaveText("Look it up");

  // The roster opens on tap and names everyone with their presence.
  await details.getByTestId("details-close").click();
  await page.getByTestId("avatars").click();
  const roster = page.getByTestId("roster-card");
  await expect(roster).toBeVisible();
  await expect(roster.getByTestId("roster-p_sarah")).toContainText("Sarah");
  await expect(roster.getByTestId("roster-p_sarah")).toContainText("here now");
  await expect(roster.getByTestId("roster-p_org")).toContainText("organizer");
  await page.keyboard.press("Escape");
  await expect(roster).toHaveCount(0);
  await expect(page.getByTestId("avatars")).toBeFocused();

  // The scopes explain themselves at the point of choice.
  await page.getByTestId("composer-scope").click();
  await expect(page.getByTestId("scope-application-private")).toContainText("the room sees only what it rules out");
  await expect(page.getByTestId("scope-agent-private")).toContainText("your agent holds it");
});
