import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import Fastify from "fastify";
import AjvModule from "ajv";
import {
  INSPECT_CANDIDATES_INPUT,
  FIND_LANDMARKS_INPUT,
  LOOK_UP_PLACES_INPUT,
  PREPARE_NAVIGATION_INPUT,
  SPATIAL_CONTEXT_INPUT,
  SYNC_SESSION_INPUT,
  TOOL_CONTRACT_VERSION,
  areaById,
} from "@webmcp-hackathon/contracts";

const Ajv = ((AjvModule as never as { default?: unknown }).default ??
  AjvModule) as typeof AjvModule.default;
const readAjv = new Ajv({ strict: false });
const validateSyncInput = readAjv.compile(SYNC_SESSION_INPUT);
// The route accepts one argument the TOOL surface deliberately does not: the
// press-and-hold preview is a pointer gesture on this page, not a decision an
// agent takes, and SPATIAL_CONTEXT_INPUT stays empty so the agent's context
// call has no knob that changes what it sees.
const validateContextInput = readAjv.compile({
  ...(SPATIAL_CONTEXT_INPUT as unknown as Record<string, unknown>),
  properties: { excludeRequirementId: { type: "string", maxLength: 40 } },
});
const validateInspectInput = readAjv.compile(INSPECT_CANDIDATES_INPUT);
const validateLookupInput = readAjv.compile(LOOK_UP_PLACES_INPUT);
const validateNavigationInput = readAjv.compile(PREPARE_NAVIGATION_INPUT);
const validateLandmarksInput = readAjv.compile(FIND_LANDMARKS_INPUT);
import { config } from "./config.ts";
import { authenticateToken, exchangeInviteSecret } from "./auth.ts";
import { submitCommand, type CommandOrigin } from "./engine.ts";
import { syncSession } from "./sync.ts";
import {
  areaSummaries,
  explorePlaces,
  loadSnapshot,
  type ExploreBbox,
} from "./places.ts";
import { haversineMeters } from "./eligibility.ts";
import { findRoomLandmarks } from "./landmarks.ts";
import { createRoom } from "./rooms.ts";
import { inspectCandidates, lookUpPlaces, prepareNavigation, spatialContext } from "./spatial.ts";
import { attachWebSocket } from "./ws.ts";
import { pool } from "./db.ts";
import { say } from "./nl/say.ts";
import { offlinePlan, planPreview } from "./nl/plan.ts";
import { runAgent } from "./nl/agent.ts";
import { heldFor, hold, release, screenPending } from "./nl/holder.ts";
import { consumeLookupToken, LOOKUP_RATE_LIMIT_ERROR } from "./lookup-budget.ts";
import { resumePoolFills } from "./pool-fill.ts";
import { loadPlaceImage } from "./enrich/images.ts";
import {
  outboundDiagnostics,
  outboundProviderCounts,
  startOutboundDiagnosticLogging,
} from "./net/outbound.ts";

/**
 * One Node process serves the production UI, API, and WebSocket endpoint.
 * Logging discipline (NEGOTIATION-PROTOCOL.md invariant 5): request bodies are
 * never logged; command log lines carry correlation ID, actor, type, outcome.
 */
const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? "info" },
  disableRequestLogging: true,
});
export { app };
startOutboundDiagnosticLogging((fields, message) => app.log.info(fields, message));

// HTTP payloads negotiate Brotli or gzip. This onSend-based plugin is
// registered before routes and does not participate in WebSocket upgrades.
await app.register(import("@fastify/compress"), {
  global: true,
  encodings: ["br", "gzip"],
});

app.addHook("onSend", async (req, reply, payload) => {
  if (config.originTrialToken) {
    reply.header("Origin-Trial", config.originTrialToken);
  }
  // The page's wire timeline pairs a request with its frames by correlation
  // id and splits the bar into network and server time. Same-origin app, so
  // no CORS exposure is needed for the headers to be readable. A request
  // that sent no id gets none back: a sentinel would read as a real id.
  const requestId = requestCorrelationId(req);
  if (requestId) reply.header("x-correlation-id", requestId);
  reply.header("x-server-ms", String(Math.round(reply.elapsedTime)));
  return payload;
});

app.get("/api/meta", async () => ({
  buildId: config.buildId,
  toolContractVersion: TOOL_CONTRACT_VERSION,
  /** Whether the composer may hand a sentence to the person's agent. */
  nl: config.nlEnabled,
}));

// Minimal exchange rate limit: invite secrets are bearer credentials and each
// successful call mints a token row — cap brute force and row growth per IP.
const exchangeAttempts = new Map<string, { count: number; windowStart: number }>();
const EXCHANGE_LIMIT = 30;
const EXCHANGE_WINDOW_MS = 60_000;

app.post("/api/session/exchange", async (req, reply) => {
  const now = Date.now();
  const entry = exchangeAttempts.get(req.ip);
  if (!entry || now - entry.windowStart > EXCHANGE_WINDOW_MS) {
    exchangeAttempts.set(req.ip, { count: 1, windowStart: now });
  } else if (++entry.count > EXCHANGE_LIMIT) {
    return reply.code(429).send({ error: "too many exchange attempts; retry later" });
  }
  const body = req.body as { inviteSecret?: string };
  if (typeof body?.inviteSecret !== "string") {
    return reply.code(400).send({ error: "inviteSecret required" });
  }
  const exchanged = await exchangeInviteSecret(body.inviteSecret);
  if (!exchanged) {
    req.log.info(
      { correlationId: correlationId(req), outcome: "invalid_invite" },
      "exchange rejected",
    );
    return reply.code(401).send({ error: "unknown invite secret" });
  }
  req.log.info(
    {
      correlationId: correlationId(req),
      participantId: exchanged.participant.id,
      outcome: "ok",
    },
    "invite exchanged",
  );
  return {
    participantToken: exchanged.token,
    participantId: exchanged.participant.id,
    displayName: exchanged.participant.displayName,
    role: exchanged.participant.role,
    roomId: exchanged.participant.roomId,
  };
});

// The area picker (docs/DATA-QUALITY.md): the registry joined with what was
// measured from each area's extract. Public and static; nothing per-user.
app.get("/api/areas", async () => ({ areas: areaSummaries() }));

// Room creation is unauthenticated and mints rows (room, participants,
// invite secrets, a candidate pool): cap it per IP like the exchange route.
const roomAttempts = new Map<string, { count: number; windowStart: number }>();
const ROOM_LIMIT = 10;
const ROOM_WINDOW_MS = 60 * 60_000;

/** One bucket for both halves of opening a room: reading a goal costs a model
 * call, and creating the room mints rows. True when the caller is over it. */
function overRoomBudget(ip: string): boolean {
  const now = Date.now();
  const entry = roomAttempts.get(ip);
  if (!entry || now - entry.windowStart > ROOM_WINDOW_MS) {
    roomAttempts.set(ip, { count: 1, windowStart: now });
    return false;
  }
  return ++entry.count > ROOM_LIMIT;
}

/**
 * Read a goal into one step before any room exists (UNDERSTANDING-ARCH.md
 * §10). Stateless: nothing is written, and the answer is what the room WOULD
 * open with, for the organizer to accept or drop.
 */
app.post("/api/plans/preview", async (req, reply) => {
  if (overRoomBudget(req.ip)) {
    return reply.code(429).send({ error: "too many rooms opened from here; retry later" });
  }
  const body = (req.body ?? {}) as { areaId?: unknown; goal?: unknown };
  const area = typeof body.areaId === "string" ? areaById(body.areaId) : undefined;
  if (!area) return reply.code(400).send({ error: "areaId required" });
  const goal = typeof body.goal === "string" ? body.goal.trim().replace(/\s+/g, " ") : "";
  if (goal.length < 1 || goal.length > 300) {
    return reply.code(400).send({ error: "goal must be 1-300 characters" });
  }
  if (!loadSnapshot(area.id)) {
    return reply.code(503).send({ error: "No place data is available for this area right now." });
  }
  const started = Date.now();
  try {
    const preview = await planPreview(goal, area);
    req.log.info(
      {
        correlationId: correlationId(req),
        areaId: area.id,
        placeClass: preview.steps[0]?.placeClass.key,
        needs: preview.steps[0]?.needs.length ?? 0,
        offline: preview.offline,
        ms: Date.now() - started,
        outcome: "ok",
      },
      "plan previewed",
    );
    return preview;
  } catch (err) {
    req.log.warn(
      { correlationId: correlationId(req), areaId: area.id, err: String(err) },
      "plan preview failed",
    );
    // A goal nobody could read still opens a room: the default step.
    return { ...offlinePlan(goal, area.id), offline: true };
  }
});

app.post("/api/rooms", async (req, reply) => {
  if (overRoomBudget(req.ip)) {
    return reply.code(429).send({ error: "too many rooms opened from here; retry later" });
  }
  const body = (req.body ?? {}) as {
    areaId?: unknown;
    organizerName?: unknown;
    memberNames?: unknown;
    center?: unknown;
    goal?: unknown;
    step?: unknown;
  };
  if (typeof body.areaId !== "string") {
    return reply.code(400).send({ error: "areaId required" });
  }
  const step = body.step as { placeClass?: unknown; needs?: unknown } | undefined;
  const created = await createRoom({
    areaId: body.areaId,
    organizerName: typeof body.organizerName === "string" ? body.organizerName : "",
    memberNames: Array.isArray(body.memberNames) ? (body.memberNames as string[]) : [],
    ...(body.center !== undefined ? { center: body.center as { lat: number; lng: number } } : {}),
    ...(typeof body.goal === "string" ? { goal: body.goal } : {}),
    ...(step && typeof step === "object" && !Array.isArray(step) ? { step } : {}),
  });
  if (!created.ok) {
    return reply.code(created.status).send({ error: created.error });
  }
  req.log.info(
    {
      correlationId: correlationId(req),
      roomId: created.roomId,
      areaId: created.areaId,
      places: created.dataSource.poolSize,
      outcome: "ok",
    },
    "room created",
  );
  // Secrets ride in the body once, to the creator; they are never logged.
  return {
    roomId: created.roomId,
    areaId: created.areaId,
    invites: created.invites,
    dataSource: created.dataSource,
    goal: created.goal,
    step: created.step,
  };
});

async function bearer(req: { headers: Record<string, unknown> }) {
  const header = String(req.headers.authorization ?? "");
  if (!header.startsWith("Bearer ")) return null;
  return authenticateToken(header.slice(7));
}

const notAuthenticated = {
  ok: false,
  error: {
    code: "not_authenticated",
    message: "This session is not authenticated yet.",
    recovery:
      "Wait for the page to finish its invite-token exchange, then retry.",
  },
} as const;

app.get("/api/diag/outbound", async (req, reply) => {
  const actor = await bearer(req);
  if (!actor) return reply.code(401).send(notAuthenticated);
  return { ...outboundDiagnostics(), providers: outboundProviderCounts() };
});

// The OSM ref rides as two path segments (node/123), never as an encoded
// slash: proxies in front of the app decode %2F and the route stops matching.
app.get("/api/places/:kind/:id/images/:idx", async (req, reply) => {
  const actor = await bearer(req);
  if (!actor) return reply.code(401).send(notAuthenticated);
  const { kind, id, idx: rawIdx } = req.params as { kind?: string; id?: string; idx?: string };
  const idx = Number(rawIdx);
  const osmRef = kind && id && /^(node|way|relation)$/.test(kind) && /^[A-Za-z0-9_.-]{1,64}$/.test(id)
    ? `${kind}/${id}`
    : null;
  if (!osmRef || !Number.isInteger(idx) || idx < 0 || idx >= 3) {
    return reply.code(404).send({ error: "image not found" });
  }
  const image = await loadPlaceImage(pool, osmRef, idx);
  if (!image) return reply.code(404).send({ error: "image not found" });
  const etag = `"${createHash("sha256").update(image.bytes).digest("base64url")}"`;
  reply.header("cache-control", "public, max-age=86400");
  reply.header("etag", etag);
  if (req.headers["if-none-match"] === etag) return reply.code(304).send();
  return reply.type(image.mime).send(image.bytes);
});

app.post("/api/sync", async (req) => {
  const actor = await bearer(req);
  if (!actor) return notAuthenticated;
  const body = (req.body ?? {}) as { sinceRevision?: number; cursor?: string };
  // Browser schemas are guidance, not enforcement: re-validate server-side.
  if (!validateSyncInput(body)) {
    return {
      ok: false,
      error: {
        code: "invalid_input",
        message: "sinceRevision must be a non-negative integer and cursor a valid string when present.",
        recovery: "Omit both on first connection, pass sinceRevision to start catch-up, or return a cursor unchanged.",
      },
    };
  }
  const result = await syncSession(actor, body.sinceRevision, body.cursor);
  req.log.info(
    {
      correlationId: correlationId(req),
      participantId: actor.id,
      command: "SyncSession",
      sinceRevision: body.sinceRevision ?? null,
      continued: body.cursor !== undefined,
      outcome: result.ok ? "ok" : result.error.code,
      revision: result.ok ? result.revision : undefined,
    },
    "command executed",
  );
  return result;
});

// Spatial read paths — same auth and validation discipline as /api/sync.
// Reads carry no baseRevision and no contract-version gate (they cannot act
// on stale intent; results carry the current revision).
function invalidInput(message: string, recovery: string) {
  return { ok: false, error: { code: "invalid_input", message, recovery } };
}

app.post("/api/spatial/context", async (req) => {
  const actor = await bearer(req);
  if (!actor) return notAuthenticated;
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (!validateContextInput(body)) {
    return invalidInput(
      "get_spatial_context takes no arguments beyond an optional excludeRequirementId.",
      "Call it with an empty object.",
    );
  }
  const result = await spatialContext(actor, {
    ...(typeof body.excludeRequirementId === "string"
      ? { excludeRequirementId: body.excludeRequirementId }
      : {}),
  });
  logRead(req, actor.id, "GetSpatialContext", result.ok);
  return result;
});

const MAX_EXPLORE_SIDE_M = 6000;

app.get("/api/landmarks", async (req, reply) => {
  const actor = await bearer(req);
  if (!actor) return reply.code(401).send(notAuthenticated);
  const query = (req.query as { q?: unknown }).q;
  if (typeof query !== "string" || !validateLandmarksInput({ query: query.trim() })) {
    return reply.code(400).send(invalidInput(
      "q must be a 1-100 character landmark name.",
      "Use a shorter landmark or public place name.",
    ));
  }
  const result = await findRoomLandmarks(pool, actor.roomId, query.trim(), 8);
  logRead(req, actor.id, "FindLandmarks", true);
  return result;
});

app.get("/api/rooms/:id/places", async (req, reply) => {
  const actor = await bearer(req);
  if (!actor) return reply.code(401).send(notAuthenticated);
  const roomId = (req.params as { id?: string }).id;
  if (!roomId || roomId !== actor.roomId) {
    return reply.code(404).send({ error: "Room not found." });
  }
  const raw = (req.query as { bbox?: unknown }).bbox;
  const bbox = parseExploreBbox(raw);
  if (!bbox) {
    return reply.code(400).send({ error: "bbox must be south,west,north,east." });
  }
  const [south, west, north, east] = bbox;
  const middleLat = (south + north) / 2;
  const middleLng = (west + east) / 2;
  const width = haversineMeters(
    { lat: middleLat, lng: west },
    { lat: middleLat, lng: east },
  );
  const height = haversineMeters(
    { lat: south, lng: middleLng },
    { lat: north, lng: middleLng },
  );
  if (width > MAX_EXPLORE_SIDE_M || height > MAX_EXPLORE_SIDE_M) {
    return reply.code(400).send({ error: "bbox must be no more than 6 km on either side." });
  }
  const room = (
    await pool.query("SELECT area_id FROM rooms WHERE id = $1", [roomId])
  ).rows[0] as { area_id: string | null } | undefined;
  const area = room?.area_id ? areaById(room.area_id) : undefined;
  const snapshot = area ? loadSnapshot(area.id) : null;
  if (!area || !snapshot) {
    return { ok: true as const, places: [], truncated: false };
  }
  const result = explorePlaces(area, snapshot, bbox, 600);
  const refs = result.places.map((place) => place.ref);
  const existing = refs.length
    ? (
        await pool.query(
          "SELECT id, osm_ref FROM candidates WHERE room_id = $1 AND osm_ref = ANY($2)",
          [roomId, refs],
        )
      ).rows as Array<{ id: string; osm_ref: string }>
    : [];
  const candidateByRef = new Map(existing.map((row) => [row.osm_ref, row.id]));
  logRead(req, actor.id, "ExplorePlaces", true);
  return {
    ...result,
    places: result.places.map((place) => {
      const candidateId = candidateByRef.get(place.ref);
      return candidateId ? { ...place, candidateId } : place;
    }),
  };
});

function parseExploreBbox(value: unknown): ExploreBbox | null {
  if (typeof value !== "string") return null;
  const parts = value.split(",").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isFinite(part)) ||
    parts[0] < -90 ||
    parts[2] > 90 ||
    parts[1] < -180 ||
    parts[3] > 180 ||
    parts[0] >= parts[2] ||
    parts[1] >= parts[3]
  ) {
    return null;
  }
  return parts as ExploreBbox;
}

app.post("/api/spatial/inspect", async (req) => {
  const actor = await bearer(req);
  if (!actor) return notAuthenticated;
  const body = (req.body ?? {}) as {
    candidateIds?: string[];
    intent?: "open" | "read";
    force?: boolean;
  };
  const intent = body.intent;
  // Read before the guard: the compiled validator narrows the body to the
  // schema's static type, which erases the optional flags.
  const force = body.force === true;
  if (!validateInspectInput(body)) {
    return invalidInput(
      "candidateIds must be 1-3 candidate ID strings.",
      "Pass candidateIds from get_spatial_context.",
    );
  }
  const result = await inspectCandidates(actor, body.candidateIds!, {
    intent,
    force,
  });
  logRead(req, actor.id, "InspectCandidates", result.ok);
  return result;
});

app.post("/api/spatial/lookup", async (req, reply) => {
  const actor = await bearer(req);
  if (!actor) return notAuthenticated;
  const body = (req.body ?? {}) as { candidateIds?: string[]; keys?: string[]; force?: boolean };
  // Held before validation: the compiled guard narrows `body` to its required
  // properties only, which would drop the optional `keys` from the type.
  const keys = body.keys;
  const intent = body.force === true ? "interactive" : "background";
  if (!validateLookupInput(body)) {
    return invalidInput(
      "candidateIds must be 1-3 candidate ID strings and keys, when present, 1-6 attribute keys.",
      "Pass candidateIds from get_spatial_context and optional facet keys.",
    );
  }
  if (!consumeLookupToken(actor.id)) {
    reply.header("retry-after", "10");
    return reply.code(429).send({ ok: false, error: LOOKUP_RATE_LIMIT_ERROR });
  }
  const result = await lookUpPlaces(actor, body.candidateIds!, keys, intent);
  logRead(req, actor.id, "LookUpPlaces", result.ok);
  return result;
});

app.post("/api/spatial/navigation", async (req) => {
  const actor = await bearer(req);
  if (!actor) return notAuthenticated;
  const body = (req.body ?? {}) as {
    candidateId?: string;
    from?: { lat: number; lng: number };
  };
  if (!validateNavigationInput(body)) {
    return invalidInput(
      "candidateId must be a string and from a valid position when present.",
      "Pass a candidateId and optional starting position, or omit it to navigate to the committed destination.",
    );
  }
  const result = await prepareNavigation(actor, body.candidateId, body.from);
  logRead(req, actor.id, "PrepareNavigation", result.ok);
  return result;
});

function logRead(
  req: { log: { info: (o: object, m: string) => void }; headers: Record<string, unknown> },
  participantId: string,
  command: string,
  ok: boolean,
) {
  req.log.info(
    { correlationId: correlationId(req), participantId, command, outcome: ok ? "ok" : "error" },
    "command executed",
  );
}

app.post("/api/commands", async (req) => {
  const actor = await bearer(req);
  if (!actor) return notAuthenticated;
  // Gate 5: reject commands from incompatible client contract versions.
  // A missing header counts as incompatible — defaulting it to the server's
  // own version would let stale non-browser clients bypass the gate.
  const clientContract = String(req.headers["x-tool-contract-version"] ?? "");
  if (clientContract !== TOOL_CONTRACT_VERSION) {
    return {
      ok: false,
      error: {
        code: "upgrade_required",
        message: `Client contract v${clientContract} != server v${TOOL_CONTRACT_VERSION}.`,
        recovery: "Reload the page to load the current tool contract.",
      },
    };
  }
  const body = req.body as { type?: string; input?: unknown };
  const rawIdempotencyKey = req.headers["idempotency-key"];
  if (
    rawIdempotencyKey !== undefined &&
    (typeof rawIdempotencyKey !== "string" ||
      rawIdempotencyKey.length < 1 ||
      rawIdempotencyKey.length > 128)
  ) {
    return invalidInput(
      "Idempotency-Key must be a 1-128 character header value.",
      "Reuse one key only for retries of the same mutation.",
    );
  }
  const requestHash = rawIdempotencyKey
    ? createHash("sha256").update(stableJson(body)).digest("hex")
    : undefined;
  const result = await submitCommand(
    actor,
    String(body?.type),
    body?.input ?? {},
    rawIdempotencyKey && requestHash
      ? { key: rawIdempotencyKey, requestHash }
      : undefined,
    commandOrigin(req),
  );
  req.log.info(
    {
      correlationId: correlationId(req),
      participantId: actor.id,
      command: body?.type,
      outcome: result.ok ? "ok" : result.error.code,
      revision: result.ok ? result.revision : undefined,
    },
    "command executed",
  );
  return result;
});

/** R6: semantically identical JSON hashes identically even if property order
 * changes between a retrying transport and the first request. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** The page's own id for this request, when it sent one. First value only
 * if the header was repeated, and bounded so a hostile header cannot come
 * back as a 16KB response header. */
function requestCorrelationId(req: { headers: Record<string, unknown> }): string | undefined {
  const raw = req.headers["x-correlation-id"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value.slice(0, 128);
}

/** Log form: every command line carries a correlation id, `none` included. */
function correlationId(req: { headers: Record<string, unknown> }): string {
  return requestCorrelationId(req) ?? "none";
}

/** Wire form: only a request that identified itself can be named as the
 * cause of a frame. */
function commandOrigin(req: { headers: Record<string, unknown> }): CommandOrigin | undefined {
  const id = requestCorrelationId(req);
  return id ? { correlationId: id } : undefined;
}

/**
 * Serialize duplicate turns for one participant and key.
 *
 * This used to be a session-scoped Postgres advisory lock, which meant
 * holding a pool client for the whole turn — across a language-model call and
 * across `submitCommand`, which needs a client of its own. Twenty concurrent
 * turns would take every client in the pool and then wait for a twenty-first,
 * which is the boot deadlock in a different building. The lock is process
 * local now, and the durable idempotency row is what survives a restart, as
 * it always was.
 */
const nlTurnGate = new Map<string, Promise<unknown>>();

async function runIdempotentNlTurn(
  participantId: string,
  key: string,
  requestHash: string,
  work: () => Promise<unknown>,
): Promise<unknown> {
  const gateKey = `${participantId}\u0000${key}`;
  const queued = nlTurnGate.get(gateKey);
  // Wait for an in-flight duplicate, then read its stored answer below.
  if (queued) await queued.catch(() => undefined);
  const turn = nlTurn(participantId, key, requestHash, work);
  nlTurnGate.set(gateKey, turn);
  try {
    return await turn;
  } finally {
    if (nlTurnGate.get(gateKey) === turn) nlTurnGate.delete(gateKey);
  }
}

async function nlTurn(
  participantId: string,
  key: string,
  requestHash: string,
  work: () => Promise<unknown>,
): Promise<unknown> {
  await pool.query(
    `DELETE FROM command_idempotency
      WHERE participant_id = $1 AND idempotency_key = $2 AND expires_at <= now()`,
    [participantId, key],
  );
  const stored = await storedTurn(participantId, key);
  if (stored) {
    return stored.request_hash === requestHash
      ? asReplay(stored.response)
      : invalidInput(
          "Idempotency-Key was already used with a different natural-language turn.",
          "Use a new key for different words or visibility.",
        );
  }
  const result = await work();
  // Another process may have finished the same turn while this one ran. The
  // first answer stands, so this one yields to it rather than failing.
  const inserted = await pool.query(
    `INSERT INTO command_idempotency
       (participant_id, idempotency_key, request_hash, response, expires_at)
     VALUES ($1, $2, $3, $4, now() + interval '10 minutes')
     ON CONFLICT (participant_id, idempotency_key) DO NOTHING`,
    [participantId, key, requestHash, result],
  );
  if (inserted.rowCount === 1) return result;
  const winner = await storedTurn(participantId, key);
  return winner && winner.request_hash === requestHash ? asReplay(winner.response) : result;
}

/** A stored turn served again is marked the way a replayed command is, so
 * the page reads both the same way. The row itself stays as written. */
function asReplay(response: unknown): unknown {
  return response && typeof response === "object" && (response as { ok?: unknown }).ok === true
    ? { ...(response as Record<string, unknown>), replayed: true }
    : response;
}

async function storedTurn(
  participantId: string,
  key: string,
): Promise<{ request_hash: string; response: unknown } | undefined> {
  return (
    await pool.query(
      `SELECT request_hash, response FROM command_idempotency
        WHERE participant_id = $1 AND idempotency_key = $2`,
      [participantId, key],
    )
  ).rows[0] as { request_hash: string; response: unknown } | undefined;
}

/**
 * The natural-language surface (docs/NL-AGENT.md). Page-only routes: an
 * agent on the WebMCP side has its own language model and needs none of
 * this. Nothing here bypasses the command bus — a need the deployment model
 * parses goes back to the page, which submits it like a typed one; a move its
 * participant agent makes goes through submitCommand as this actor.
 */
const agentUnavailable = {
  ok: false,
  error: {
    code: "phase_unavailable",
    message: "Your agent could not answer just now.",
    recovery: "Say it again in a moment, or state the need in fewer words.",
  },
} as const;

function sentence(body: unknown): string | null {
  const text = (body as { text?: unknown } | null)?.text;
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  return trimmed.length >= 1 && trimmed.length <= 300 ? trimmed : null;
}

app.post("/api/nl/say", async (req) => {
  const actor = await bearer(req);
  if (!actor) return notAuthenticated;
  if (!config.nlEnabled) return agentUnavailable;
  const text = sentence(req.body);
  if (!text) return invalidInput("text must be 1-300 characters.", "Say it in a sentence.");
  const scope = String((req.body as { scope?: unknown })?.scope ?? "shared");
  const rawKey = req.headers["idempotency-key"];
  if (
    rawKey !== undefined &&
    (typeof rawKey !== "string" || rawKey.length < 1 || rawKey.length > 128)
  ) {
    return invalidInput(
      "Idempotency-Key must be a 1-128 character header value.",
      "Reuse one key only for retries of the same turn.",
    );
  }
  const execute = async (): Promise<unknown> => {
    const started = Date.now();
    try {
      const context = await spatialContext(actor);
      if (!context.ok) return context;
      const rawClarify = (req.body as { clarifyOf?: unknown }).clarifyOf as
        | { said?: unknown; question?: unknown }
        | undefined;
      const clarifyOf = rawClarify && typeof rawClarify.said === "string" && typeof rawClarify.question === "string"
        && rawClarify.said.length <= 300 && rawClarify.question.length <= 120
        ? { said: rawClarify.said, question: rawClarify.question }
        : undefined;
      const routed = await say(text, scope, context, new Date(), clarifyOf, actor.id);
      let result: Record<string, unknown>;
      if (routed.intent === "ask" || routed.intent === "act") {
        const outcome = await runAgent(actor, text, heldFor(actor.id), {
          correlationId: requestCorrelationId(req),
        });
        result = {
          ok: true,
          intent: routed.intent,
          ...(routed.needs.length ? { needs: routed.needs } : {}),
          reply: outcome.reply,
          actions: outcome.actions,
          // R7: additive page-private fields preserve already committed steps
          // and tell the composer to retain the person's words for retry.
          ...(outcome.partial
            ? { partial: true, failureCategory: outcome.failureCategory }
            : {}),
          meta: { route: routed.meta, agent: outcome.meta },
        };
      } else {
        result = {
          ok: true,
          intent: routed.intent,
          needs: routed.needs,
          clarify: routed.clarify,
          ...(routed.suggestions ? { suggestions: routed.suggestions } : {}),
          reply: routed.reply,
          meta: { route: routed.meta },
        };
      }
      req.log.info(
        {
          correlationId: correlationId(req),
          participantId: actor.id,
          command: "NlSay",
          intent: routed.intent,
          ms: Date.now() - started,
          outcome: "ok",
        },
        "command executed",
      );
      return result;
    } catch (err) {
      req.log.warn(
        { correlationId: correlationId(req), participantId: actor.id, command: "NlSay", err: String(err) },
        "agent failed",
      );
      return agentUnavailable;
    }
  };
  if (!rawKey || typeof rawKey !== "string") return execute();
  const requestHash = createHash("sha256")
    .update(stableJson({ route: "/api/nl/say", body: req.body }))
    .digest("hex");
  return runIdempotentNlTurn(actor.id, rawKey, requestHash, execute);
});

app.post("/api/nl/condition", async (req) => {
  const actor = await bearer(req);
  if (!actor) return notAuthenticated;
  if (!config.nlEnabled) return agentUnavailable;
  const text = sentence(req.body);
  if (!text) return invalidInput("text must be 1-300 characters.", "Say it in a sentence.");
  try {
    // The condition goes to the agent; the room gets a content-free
    // declaration. The model's topic reading is returned to the page but
    // NOT attached as a scope hint: disclosing a category is the owner's
    // opt-in (FACETS.md §4), and nobody asked them.
    const context = await spatialContext(actor);
    if (!context.ok) return context;
    const routed = await say(text, "agent-private", context);
    const topic = routed.needs[0]?.topic;
    hold(actor.id, actor.roomId, text);
    const room = (
      await pool.query("SELECT revision FROM rooms WHERE id = $1", [actor.roomId])
    ).rows[0];
    // A restated condition updates the one declaration this person holds
    // (which also clears the old verdicts, engine.ts) rather than stacking a
    // second need the room could never tell apart from the first.
    const existing = (
      await pool.query(
        `SELECT id FROM requirements
          WHERE room_id = $1 AND owner_id = $2 AND visibility = 'agent-private' AND NOT withdrawn
          ORDER BY created_at_revision DESC LIMIT 1`,
        [actor.roomId, actor.id],
      )
    ).rows[0];
    const declared = await submitCommand(actor, "SubmitRequirement", {
      baseRevision: Number(room?.revision ?? 0),
      ...(existing ? { requirementId: existing.id as string } : {}),
      visibility: "agent-private",
      hardness: "hard",
      delegation: { mode: "approval_required" },
      scopeHint: { affects: "candidate-eligibility" },
    }, undefined, commandOrigin(req));
    if (!declared.ok) {
      release(actor.id);
      return declared;
    }
    // Screening runs in the background; the map settles as verdicts land.
    void screenPending(actor);
    req.log.info(
      { correlationId: correlationId(req), participantId: actor.id, command: "NlCondition", outcome: "ok" },
      "command executed",
    );
    return { ok: true, revision: declared.revision, topic: topic ?? null, meta: { route: routed.meta } };
  } catch (err) {
    req.log.warn(
      { correlationId: correlationId(req), participantId: actor.id, command: "NlCondition", err: String(err) },
      "agent failed",
    );
    return agentUnavailable;
  }
});

// UI serving: Vite middleware in development (HMR), static dist in production.
const webRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..", "..", "web",
);
if (config.dev && process.env.SERVE_STATIC !== "1") {
  const { createServer: createViteServer } = await import("vite");
  const vite = await createViteServer({
    root: webRoot,
    server: { middlewareMode: true },
    appType: "spa",
  });
  await app.register(import("@fastify/middie"));
  // Vite's SPA fallback would swallow API routes; keep it off /api and /ws.
  app.use((req, res, next) => {
    const url = String(req.url ?? "");
    if (url.startsWith("/api/") || url.startsWith("/ws")) return next();
    // Vite answers these directly, bypassing Fastify's onSend hook — the
    // origin-trial header must ride on the document response too.
    if (config.originTrialToken) {
      res.setHeader("Origin-Trial", config.originTrialToken);
    }
    return vite.middlewares(req, res, next);
  });
} else {
  const dist = join(webRoot, "dist");
  if (existsSync(dist)) {
    await app.register(import("@fastify/static"), {
      root: dist,
      wildcard: false,
    });
    app.setNotFoundHandler(async (req, reply) => {
      if (req.url.startsWith("/api/")) {
        return reply.code(404).send({ error: "not found" });
      }
      return reply.sendFile("index.html");
    });
  }
}

// Attach the upgrade handler BEFORE the port opens — no window where /ws
// connections land on a bare HTTP server.
await app.ready();
attachWebSocket(app.server);
await app.listen({ port: config.port, host: config.host });
void resumePoolFills().catch((error) => {
  app.log.error({ error: String(error) }, "pool fill recovery failed");
});
app.log.info(
  { buildId: config.buildId, toolContractVersion: TOOL_CONTRACT_VERSION },
  `listening on ${config.host}:${config.port}`,
);
