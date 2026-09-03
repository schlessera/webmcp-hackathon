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
  eligibility: "eligible" | "likely" | "uncertain" | "unlikely" | "excluded";
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
  pool?: {
    size: number;
    cap: number;
    explorable: boolean;
    filling: boolean;
    target: number;
  };
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

function candidateAtMeters(
  candidateId: string,
  x: number,
  y: number,
  eligibility: Candidate["eligibility"],
): Candidate {
  return {
    candidateId,
    ref: `node/${candidateId}`,
    name: candidateId,
    category: "place",
    location: {
      lat: center.lat + y / 111_320,
      lng: center.lng + x / (111_320 * Math.cos((center.lat * Math.PI) / 180)),
    },
    eligibility,
    why: eligibility === "eligible" ? "meets all evaluable requirements" : "not confirmed",
    walkMin: Math.max(1, Math.round(Math.hypot(x, y) / 75)),
    priceLevel: null,
  };
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

function setWholeAreaPool(context: MockContext, size: number, target = 90) {
  context.candidates = Array.from({ length: size }, (_, index): Candidate => {
    const distance = 80 + index * 5;
    const angle = index * 2.399963229728653;
    const lat = center.lat + (Math.sin(angle) * distance) / 111_320;
    const lng =
      center.lng +
      (Math.cos(angle) * distance) /
        (111_320 * Math.cos((center.lat * Math.PI) / 180));
    return {
      candidateId: `pool-place-${String(index).padStart(3, "0")}`,
      name: `Place ${String(index + 1).padStart(3, "0")}`,
      location: { lat, lng },
      category: "place",
      eligibility: "eligible",
      why: "",
      walkMin: Math.max(1, Math.round(distance / 75)),
      priceLevel: null,
    };
  });
  context.total = size;
  context.matching = size;
  context.feasibility = {
    state: "feasible",
    eligible: size,
    uncertain: 0,
    excluded: 0,
  };
  context.pool = {
    size,
    cap: 2_500,
    explorable: true,
    filling: size < target,
    target,
  };
}

type MockState = {
  /** The last lookup the page asked for (force flag included). */
  lastLookup?: { candidateIds: string[]; force?: boolean };
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
  await page.route("**/api/spatial/lookup", (route) => {
    recordRequest(route.request());
    const body = route.request().postDataJSON() as { candidateIds: string[]; force?: boolean };
    state.lastLookup = body;
    return respond(route, {
      ok: true,
      revision: state.context.revision,
      candidates: dataset.venues.filter((venue) => body.candidateIds.includes(venue.candidateId)),
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
  await expect
    .poll(() => page.evaluate(() => window.__spokesMapStats?.()))
    .toMatchObject({ candidates: 31, domMarkers: 31, glFeatures: 31 });
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

test("a fresh whole-area pool stays fixed, caps DOM stickers, and leaves every GL place reachable", async ({ browser }) => {
  const browserContext = await browser.newContext({
    viewport: { width: 1180, height: 900 },
    reducedMotion: "reduce",
  });
  const page = await browserContext.newPage();
  const context = fixture({ matching: 0, revision: 1 });
  setWholeAreaPool(context, 60);
  const state: MockState = { context, outstanding: [] };
  await mockApi(page, state);
  const socket = await scriptedSocket(page, 1);
  await page.goto(`${BASE}/#invite=feedface`);
  await socket.welcomed;
  await expect(page.getByTestId("map-region")).toHaveAttribute("data-loaded", "true", {
    timeout: 20_000,
  });
  await expect(page.getByTestId("count-fill")).toHaveText("adding places · 60 of 90");

  await expect
    .poll(() => page.evaluate(() => window.__spokesMapStats?.()))
    .toMatchObject({
      candidates: 60,
      domMarkers: 60,
      glFeatures: 60,
      busyAnimating: false,
      settleDuration: 0,
      transitionDuration: 0,
    });
  const initialStats = await page.evaluate(() => window.__spokesMapStats!());

  setWholeAreaPool(state.context, 75);
  state.context.revision = 2;
  socket.send({
    type: "event",
    revision: 2,
    fromRevision: 1,
    events: [{
      revision: 2,
      type: "candidates_added",
      level: "existence",
      text: "15 more places on the map.",
    }],
  });
  await expect(page.getByTestId("count-fill")).toHaveText("adding places · 75 of 90");
  await expect.poll(() => page.evaluate(() => window.__spokesMapStats?.().glFeatures)).toBe(75);
  const midway = await page.evaluate(() => window.__spokesMapStats!());
  expect(midway.domMarkers).toBe(60);
  expect(midway.center[0]).toBeCloseTo(initialStats.center[0], 8);
  expect(midway.center[1]).toBeCloseTo(initialStats.center[1], 8);
  expect(midway.zoom).toBeCloseTo(initialStats.zoom, 8);

  const glOnly = midway.glOnly;
  if (!glOnly) throw new Error("the filled room has no GL-only place");
  expect(page.getByTestId(`pin-${glOnly.candidateId}`)).toHaveCount(0);

  socket.send({
    type: "lookups",
    pending: [glOnly.candidateId],
    reason: { kind: "pool" },
  });
  await expect(page.getByTestId("map-region")).toHaveAttribute("aria-busy", "true");
  await expect
    .poll(() => page.evaluate(() => window.__spokesMapStats?.().busyAnimating))
    .toBe(false);
  socket.send({ type: "lookups", pending: [] });

  const mapBox = await page.getByTestId("map-region").boundingBox();
  if (!mapBox) throw new Error("map has no pointer target");
  await page.mouse.click(mapBox.x + glOnly.point[0], mapBox.y + glOnly.point[1]);
  await expect
    .poll(() => page.evaluate(() => window.__spokesMapStats?.().selected))
    .toBe(glOnly.candidateId);

  const firstKeyboard = page.getByTestId("keyboard-place-pool-place-000");
  await firstKeyboard.focus();
  await page.keyboard.press("End");
  const lastKeyboard = page.getByTestId("keyboard-place-pool-place-074");
  await expect(lastKeyboard).toBeFocused();
  await page.keyboard.press("Enter");
  await expect
    .poll(() => page.evaluate(() => window.__spokesMapStats?.().selected))
    .toBe("pool-place-074");

  setWholeAreaPool(state.context, 90);
  state.context.revision = 3;
  socket.send({
    type: "event",
    revision: 3,
    fromRevision: 2,
    events: [{
      revision: 3,
      type: "candidates_added",
      level: "existence",
      text: "15 more places on the map.",
    }],
  });
  await expect(page.getByTestId("count-fill")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.__spokesMapStats?.().glFeatures)).toBe(90);
  const complete = await page.evaluate(() => window.__spokesMapStats!());
  expect(complete.domMarkers).toBe(60);
  expect(complete.center[0]).toBeCloseTo(initialStats.center[0], 8);
  expect(complete.center[1]).toBeCloseTo(initialStats.center[1], 8);
  expect(complete.zoom).toBeCloseTo(initialStats.zoom, 8);
  expect(complete.busyAnimating).toBe(false);
  expect(complete.settleDuration).toBe(0);
  expect(complete.transitionDuration).toBe(0);
  await browserContext.close();
});

test("name-card slots follow eligibility tiers before uncertainty", async ({ browser }) => {
  const browserContext = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    reducedMotion: "reduce",
  });
  const page = await browserContext.newPage();
  const context = fixture({ radiusM: 800, matching: 0 });
  const xs = [-700, -420, -140, 140, 420, 700];
  const ys = [-360, 0, 360];
  const eligible = ys.flatMap((y, row) =>
    xs.map((x, column) => {
      const candidate = candidateAtMeters(
        `tier-eligible-${row}-${column}`,
        x,
        y,
        "eligible",
      );
      candidate.name = `E${row}${column}`;
      return candidate;
    }),
  );
  const unsure = candidateAtMeters("tier-unsure", 0, 650, "uncertain");
  unsure.name = "Unsure";
  context.candidates = [...eligible, unsure];
  context.total = context.candidates.length;
  context.matching = eligible.length;
  context.feasibility = {
    state: "feasible",
    eligible: eligible.length,
    uncertain: 1,
    excluded: 0,
  };
  await mockApi(page, { context, outstanding: [] });
  await page.goto(`${BASE}/#invite=deadbeef`);
  await expect(page.getByTestId("map-region")).toHaveAttribute("data-loaded", "true", {
    timeout: 20_000,
  });

  await expect
    .poll(() => page.locator('[data-testid^="pin-tier-eligible-"][data-named="true"]').count())
    .toBe(18);
  await expect(page.getByTestId("pin-tier-unsure")).toHaveAttribute("data-named", "false");
  // A place that wins no slot loses its card onto its own dot: the box
  // collapses about the anchor and the dot itself does not move (§8).
  const yielded = await page.getByTestId("pin-tier-unsure").evaluate((marker) => {
    const box = marker.querySelector<HTMLElement>(".sticker-box")!;
    const style = getComputedStyle(box);
    const markerRect = marker.getBoundingClientRect();
    const dotRect = marker.querySelector<HTMLElement>(".marker-dot")!.getBoundingClientRect();
    return {
      scale: style.scale,
      opacity: getComputedStyle(marker.querySelector<HTMLElement>(".marker-sticker")!).opacity,
      dx: Math.abs(dotRect.left + dotRect.width / 2 - (markerRect.left + markerRect.width / 2)),
      dy: Math.abs(dotRect.top + dotRect.height / 2 - (markerRect.top + markerRect.height / 2)),
    };
  });
  expect(Number.parseFloat(yielded.scale)).toBeCloseTo(0.3, 5);
  expect(yielded.opacity).toBe("0");
  expect(yielded.dx).toBeLessThanOrEqual(1);
  expect(yielded.dy).toBeLessThanOrEqual(1);
  await browserContext.close();
});

test("mirrored name cards stay inside the band and keep every dot on its marker", async ({ browser }) => {
  const browserContext = await browser.newContext({
    viewport: { width: 480, height: 900 },
    reducedMotion: "no-preference",
  });
  const page = await browserContext.newPage();
  const context = fixture({ radiusM: 800, matching: 0 });
  const right = candidateAtMeters("anchor-right", 700, 0, "eligible");
  const left = candidateAtMeters("anchor-left", -700, 0, "eligible");
  const middle = candidateAtMeters("anchor-middle", 0, -300, "eligible");
  const standingVeto = candidateAtMeters("anchor-standing-veto", 0, 300, "excluded");
  const terminalVeto = candidateAtMeters("anchor-terminal-veto", 250, 500, "excluded");
  const outside = candidateAtMeters("anchor-outside", 810, 0, "eligible");
  right.name = "Right";
  left.name = "Left";
  middle.name = "Middle";
  standingVeto.name = "Standing";
  terminalVeto.name = "Terminal";
  outside.name = "Outside";
  context.candidates = [right, left, middle, standingVeto, terminalVeto, outside];
  context.total = context.candidates.length - 1;
  context.matching = 3;
  context.feasibility = { state: "feasible", eligible: 3, uncertain: 0, excluded: 2 };
  context.proposals = [
    {
      proposalId: "standing-veto",
      candidateId: standingVeto.candidateId,
      status: "open",
      stances: [{ participantId: "p_org", stance: "veto" }],
      vetoStands: true,
    },
    {
      proposalId: "terminal-veto",
      candidateId: terminalVeto.candidateId,
      status: "vetoed",
      stances: [{ participantId: "p_org", stance: "veto" }],
      vetoStands: true,
    },
    {
      proposalId: "outside-proposal",
      candidateId: outside.candidateId,
      status: "open",
      stances: [{ participantId: "p_org", stance: "accept" }],
      vetoStands: false,
    },
  ];
  await mockApi(page, { context, outstanding: [] });
  await page.goto(`${BASE}/#invite=deadbeef`);
  await expect(page.getByTestId("map-region")).toHaveAttribute("data-loaded", "true", {
    timeout: 20_000,
  });

  const rightPin = page.getByTestId("pin-anchor-right");
  await expect(rightPin).toHaveAttribute("data-named", "true");
  await expect(rightPin.locator(".marker-sticker")).toHaveAttribute("data-side", "right");
  await expect(page.getByTestId("pin-anchor-standing-veto")).toHaveAttribute(
    "data-named",
    "true",
  );
  await expect(page.getByTestId("pin-anchor-terminal-veto")).toHaveAttribute(
    "data-named",
    "false",
  );
  await expect(page.getByTestId("pin-anchor-outside")).toHaveAttribute("data-named", "false");

  const measure = () =>
    page.evaluate(() => {
      const map = document.querySelector('[data-testid="map-region"]')!.getBoundingClientRect();
      const cards = [...document.querySelectorAll<HTMLElement>('[data-named="true"]')].map(
        (marker) => {
          const markerRect = marker.getBoundingClientRect();
          const wrapper = marker.querySelector<HTMLElement>(".marker-sticker")!;
          const dotRect = marker.querySelector<HTMLElement>(".sticker-dot")!.getBoundingClientRect();
          const cardRect = marker.querySelector<HTMLElement>(".sticker-box")!.getBoundingClientRect();
          const markerX = markerRect.left + markerRect.width / 2;
          const markerY = markerRect.top + markerRect.height / 2;
          return {
            id: marker.dataset.testid,
            side: wrapper.dataset.side,
            dx: Math.abs(dotRect.left + dotRect.width / 2 - markerX),
            dy: Math.abs(dotRect.top + dotRect.height / 2 - markerY),
            distanceFromRight: map.right - markerX,
            inside: cardRect.left >= map.left - 1 && cardRect.right <= map.right + 1,
          };
        },
      );
      return cards;
    });

  let cards = await measure();
  expect(new Set(cards.map((card) => card.side))).toEqual(new Set(["left", "right"]));
  expect(cards.filter((card) => card.dx > 1 || card.dy > 1)).toEqual([]);
  const nearRight = cards.find((card) => card.id === "pin-anchor-right");
  expect(nearRight?.distanceFromRight).toBeLessThanOrEqual(120);
  expect(nearRight?.side).toBe("right");
  expect(nearRight?.inside).toBe(true);

  await rightPin.press("Enter");
  await expect(rightPin).toHaveAttribute("data-state", "selected");
  cards = await measure();
  const selected = cards.find((card) => card.id === "pin-anchor-right");
  expect(selected?.dx).toBeLessThanOrEqual(1);
  expect(selected?.dy).toBeLessThanOrEqual(1);
  expect(selected?.side).toBe("right");
  expect(selected?.inside).toBe(true);
  const selectedMotion = await rightPin.locator(".sticker-box").evaluate((element) => {
    const style = getComputedStyle(element);
    return { name: style.animationName, duration: style.animationDuration };
  });
  expect(selectedMotion.name).toBe("spoke-pop");
  expect(Number.parseFloat(selectedMotion.duration)).toBeGreaterThan(0);
  await browserContext.close();
});

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
        const unlikely = current.context.candidates.find(
          (candidate) => candidate.candidateId === "place_3",
        );
        if (unlikely) unlikely.eligibility = "unlikely";
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
  // At full motion the GL busy ring turns on its own image, one loop for
  // however many places are busy.
  await expect
    .poll(() => page.evaluate(() => window.__spokesMapStats?.().busyAnimating))
    .toBe(true);

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
  await expect
    .poll(() => page.evaluate(() => window.__spokesMapStats?.().busyAnimating))
    .toBe(false);
  await expect(page.getByTestId("count-busy")).toHaveCount(0);
  await expect(row).not.toHaveAttribute("data-pending", "true");
  await expect(row).toContainText("−2");
  await expect(
    page.locator('[data-testid^="pin-"][data-state="out"][data-named="true"]'),
  ).toHaveCount(0);
  await expect(
    page.locator('[data-testid^="pin-"][data-state="unlikely"][data-named="true"]'),
  ).toHaveCount(0);
  await expect(page.getByTestId("pin-place_3")).toHaveAttribute("data-named", "false");
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

  // Pressing the button forces a fresh lookup: the dot wears the busy ring
  // while the server says so, and afterwards the line says what changed.
  await details.getByTestId("details-lookup-btn").click();
  await expect.poll(() => state.lastLookup?.force).toBe(true);
  socket.send({ type: "lookups", pending: ["place_24"], reason: { kind: "place" } });
  await expect(page.getByTestId("pin-place_24")).toHaveAttribute("data-busy", "true");
  await expect(details.getByTestId("details-lookup")).toHaveAttribute("data-state", "busy");
  socket.send({ type: "lookups", pending: [] });
  await expect(page.getByTestId("pin-place_24")).not.toHaveAttribute("data-busy", "true");
  await expect(details.getByTestId("details-lookup")).toHaveText("looked up just now · nothing new");
  await expect(details.getByTestId("details-lookup-btn")).toHaveText("Look again");

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

test("two places a few metres apart are both reachable by tapping their own dot", async ({ page }) => {
  // Haferkater and Witty's sit 5.6 m apart in the Berlin dataset: at the
  // room's zoom that is under two pixels. Each dot fans out by a fixed few
  // pixels and a tap resolves to the nearest dot, whatever box is on top
  // (§13) — even after one of them is selected and wears a name card.
  const pair = dataset.venues.filter((venue) =>
    /^(Haferkater|Witty's Bio-Currywurst)$/.test(venue.name),
  );
  expect(pair).toHaveLength(2);
  const ids = pair.map((venue) => venue.candidateId);
  const state: MockState = {
    context: fixture({ eligibleIds: ids }),
    outstanding: [],
    command(_request, current) {
      current.context.revision += 1;
    },
  };
  await mockApi(page, state);
  await page.goto(`${BASE}/?shim=webmcp#invite=deadbeef`);
  await closeDrawer(page);
  await expect(page.getByTestId("map-region")).toHaveAttribute("data-loaded", "true", { timeout: 20_000 });
  await stableMarkerTransforms(page, ids);

  const dotCentre = async (id: string) => {
    const box = await page.locator(`[data-testid="pin-${id}"] .marker-dot`).boundingBox();
    if (!box) throw new Error(`no dot for ${id}`);
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  const [a, b] = await Promise.all(ids.map(dotCentre));
  expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(6);

  for (const [index, id] of ids.entries()) {
    const point = await dotCentre(id);
    await page.mouse.click(point.x, point.y);
    await expect(page.getByTestId("place-details")).toHaveAttribute("aria-label", pair[index].name);
    await page.getByTestId("details-close").click();
    await expect(page.getByTestId("place-details")).toHaveCount(0);
  }
});

test("the page says what the map is as of once the browser goes offline, and drops the line when the link is back", async ({ page, context }) => {
  const state: MockState = { context: fixture({ matching: 4, revision: 12 }), outstanding: [] };
  await mockApi(page, state);
  const socket = await scriptedSocket(page, 12);
  await page.goto(`${BASE}/#invite=deadbeef`);
  await socket.welcomed;
  await expect(page.getByTestId("count-number")).toHaveText("21");
  await expect(page.getByTestId("offline-line")).toHaveCount(0);

  // The browser knows first: the line appears at once, not after a wait.
  await context.setOffline(true);
  await expect(page.getByTestId("offline-line")).toBeVisible({ timeout: 2_000 });
  await expect(page.getByTestId("offline-line")).toContainText(/You're seeing the map as of .*Changes will sync\./);

  // Back online with a live socket (the next frame arrives): the line goes.
  await context.setOffline(false);
  socket.send({ type: "ping", at: new Date().toISOString() });
  await expect(page.getByTestId("offline-line")).toHaveCount(0);
});
