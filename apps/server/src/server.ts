import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import Fastify from "fastify";
import AjvModule from "ajv";
import {
  SYNC_SESSION_INPUT,
  TOOL_CONTRACT_VERSION,
} from "@webmcp-hackathon/contracts";

const Ajv = ((AjvModule as never as { default?: unknown }).default ??
  AjvModule) as typeof AjvModule.default;
const validateSyncInput = new Ajv({ strict: false }).compile(SYNC_SESSION_INPUT);
import { config } from "./config.ts";
import { authenticateToken, exchangeInviteSecret } from "./auth.ts";
import { submitCommand } from "./engine.ts";
import { syncSession } from "./sync.ts";
import { attachWebSocket } from "./ws.ts";

/**
 * One Node process serves the production UI, API, and WebSocket endpoint.
 * Logging discipline (NEGOTIATION-PROTOCOL.md invariant 5): request bodies are
 * never logged; command log lines carry correlation ID, actor, type, outcome.
 */
const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? "info" },
  disableRequestLogging: true,
});

app.addHook("onSend", async (_req, reply, payload) => {
  if (config.originTrialToken) {
    reply.header("Origin-Trial", config.originTrialToken);
  }
  return payload;
});

app.get("/api/meta", async () => ({
  buildId: config.buildId,
  toolContractVersion: TOOL_CONTRACT_VERSION,
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

app.post("/api/sync", async (req) => {
  const actor = await bearer(req);
  if (!actor) return notAuthenticated;
  const body = (req.body ?? {}) as { sinceRevision?: number };
  // Browser schemas are guidance, not enforcement: re-validate server-side.
  if (!validateSyncInput(body)) {
    return {
      ok: false,
      error: {
        code: "invalid_input",
        message: "sinceRevision must be a non-negative integer when present.",
        recovery: "Omit sinceRevision on first connection, or pass the integer revision from your last sync.",
      },
    };
  }
  const result = await syncSession(actor, body.sinceRevision);
  req.log.info(
    {
      correlationId: correlationId(req),
      participantId: actor.id,
      command: "SyncSession",
      sinceRevision: body.sinceRevision ?? null,
      outcome: result.ok ? "ok" : result.error.code,
      revision: result.ok ? result.revision : undefined,
    },
    "command executed",
  );
  return result;
});

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
  const result = await submitCommand(actor, String(body?.type), body?.input ?? {});
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

function correlationId(req: { headers: Record<string, unknown> }): string {
  return String(req.headers["x-correlation-id"] ?? "none");
}

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
app.log.info(
  { buildId: config.buildId, toolContractVersion: TOOL_CONTRACT_VERSION },
  `listening on ${config.host}:${config.port}`,
);
