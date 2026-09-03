import { TOOL_CONTRACT_VERSION } from "@webmcp-hackathon/contracts";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import { config } from "../../apps/server/src/config.ts";

export const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://webmcp:webmcp@127.0.0.1:5432/webmcp";

/** Global evidence caches are intentionally shared between production rooms,
 * so API runs must reset them as a lane-level fixture rather than pretending
 * room teardown owns their rows. */
export async function resetApiCacheState(
  queryable: Pick<pg.Pool, "query">,
): Promise<void> {
  await queryable.query(
    "TRUNCATE page_cache, search_cache, matrix_cache, outbound_metadata_cache",
  );
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Let the kernel allocate a free port. Fixed worker slices collide when
 * independent API lanes run concurrently in separate repository worktrees. */
function nextServerPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const reservation = createNetServer();
    reservation.once("error", reject);
    reservation.listen(0, "0.0.0.0", () => {
      const address = reservation.address();
      if (!address || typeof address === "string") {
        reservation.close();
        reject(new Error("could not reserve an API test port"));
        return;
      }
      reservation.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

export interface TestServer {
  baseUrl: string;
  logs: () => string;
  stop: () => Promise<void>;
}

export interface TestServerOptions {
  /** Repo-relative bootstrap entrypoint; defaults to the production server. */
  entrypoint?: string;
  env?: Record<string, string>;
}

/** Spawn a real server process, capturing its log output for invariant checks. */
export async function startServer(options: TestServerOptions = {}): Promise<TestServer> {
  const port = await nextServerPort();
  let captured = "";
  const child: ChildProcess = spawn(
    "node",
    [join(repoRoot, options.entrypoint ?? "apps/server/src/server.ts")],
    {
      env: {
        ...process.env,
        DATABASE_URL,
        PORT: String(port),
        SERVE_STATIC: "1", // skip Vite middleware in API tests
        ENRICH_NETWORK: "0", // no venue or Wikidata lookups from a test server
        // A server must opt into the global background filler. Otherwise a
        // parallel suite can discover and mutate another suite's area rooms.
        POOL_FILL: "0",
        LOG_LEVEL: "info",
        ...options.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout!.on("data", (chunk) => (captured += String(chunk)));
  child.stderr!.on("data", (chunk) => (captured += String(chunk)));

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      const response = await fetch(`${baseUrl}/api/meta`);
      if (response.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      throw new Error(`server did not start:\n${captured}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return {
    baseUrl,
    logs: () => captured,
    stop: () =>
      new Promise((resolve) => {
        child.once("exit", () => resolve());
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 3000).unref();
      }),
  };
}

export interface TestRoom {
  roomId: string;
  tokens: Record<"org" | "sarah" | "joe", string>;
  participantIds: Record<"org" | "sarah" | "joe", string>;
  /** Raw invite secrets, for e2e flows that exchange via the page itself. */
  inviteSecrets: Record<"org" | "sarah" | "joe", string>;
  /** The seeded open proposal. */
  proposalId: string;
  pool: pg.Pool;
  cleanup: () => Promise<void>;
}

export interface TestRoomOptions {
  /** Load the real Berlin Mitte dataset + demo scope instead of the three
   * synthetic candidates (and seed no proposal). */
  berlin?: boolean;
}

/** Create one fresh room and three exchanged tokens straight against the DB. */
export async function createTestRoom(
  baseUrl: string,
  options: TestRoomOptions = {},
): Promise<TestRoom> {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  const suffix = randomBytes(4).toString("hex");
  const roomId = `room_test_${suffix}`;
  const members = [
    { key: "org", id: `p_org_${suffix}`, name: "Alex", role: "organizer" },
    { key: "sarah", id: `p_sarah_${suffix}`, name: "Sarah", role: "member" },
    { key: "joe", id: `p_joe_${suffix}`, name: "Joe", role: "member" },
  ] as const;

  const berlin = options.berlin
    ? (JSON.parse(
        readFileSync(
          join(repoRoot, "packages", "contracts", "data", "berlin-mitte-venues.json"),
          "utf8",
        ),
      ) as {
        manifest: { demoCenter: { lat: number; lng: number }; demoRadii: { narrow: number } };
        venues: Array<{
          candidateId: string; name: string; category: string;
          priceLevel: number | null; location: { lat: number; lng: number };
          attributes: unknown[]; hours: unknown[];
        }>;
      })
    : null;

  await pool.query(
    `INSERT INTO rooms (id, goal, phase, domain, revision, policy, scope, scope_seq)
     VALUES ($1, 'test dinner', 'gathering', 'spatial-destination/v1', 0, '{}', $2, $3)`,
    [
      roomId,
      berlin
        ? JSON.stringify({
            scopeId: "scope_1",
            area: {
              kind: "circle",
              center: berlin.manifest.demoCenter,
              radiusM: berlin.manifest.demoRadii.narrow,
            },
            transport: ["walk", "bike", "car"],
            category: "food",
          })
        : null,
      berlin ? 1 : 0,
    ],
  );
  const secrets: Record<string, string> = {};
  for (const m of members) {
    await pool.query(
      `INSERT INTO participants (id, room_id, display_name, role) VALUES ($1, $2, $3, $4)`,
      [m.id, roomId, m.name, m.role],
    );
    const secret = randomBytes(16).toString("hex");
    secrets[m.key] = secret;
    await pool.query(
      `INSERT INTO invite_secrets (secret_hash, participant_id, room_id) VALUES ($1, $2, $3)`,
      [createHash("sha256").update(secret).digest("hex"), m.id, roomId],
    );
  }
  if (berlin) {
    for (const v of berlin.venues) {
      // candidates.id is a global PK: suffix per room so parallel test rooms
      // (and a seeded room_demo) never collide.
      await pool.query(
        `INSERT INTO candidates (id, room_id, name, category, price_level, walk_min, location, attributes, hours)
         VALUES ($1, $2, $3, $4, $5, 5, $6, $7, $8)`,
        [
          `${v.candidateId}_${suffix}`, roomId, v.name, v.category, v.priceLevel,
          JSON.stringify(v.location), JSON.stringify(v.attributes),
          JSON.stringify(v.hours ?? []),
        ],
      );
    }
  } else {
    for (const c of [
      { id: `place_a_${suffix}`, name: "Alpha", attrs: [{ key: "vegetarian-options", status: "verified_true" }] },
      { id: `place_b_${suffix}`, name: "Beta", attrs: [{ key: "vegetarian-options", status: "verified_false" }] },
      { id: `place_c_${suffix}`, name: "Gamma", attrs: [{ key: "vegetarian-options", status: "unverified" }] },
    ]) {
      await pool.query(
        `INSERT INTO candidates (id, room_id, name, category, price_level, walk_min, location, attributes)
         VALUES ($1, $2, $3, 'cafe', 2, 5, '{"lat":52.5,"lng":13.4}', $4)`,
        [c.id, roomId, c.name, JSON.stringify(c.attrs)],
      );
    }

    // An open proposal so RespondToProposal and stance_needed are exercisable.
    await pool.query(
      `INSERT INTO proposals (id, room_id, candidate_id, created_by, created_at_revision, status)
       VALUES ($1, $2, $3, $4, 0, 'open')`,
      [`prop_${suffix}`, roomId, `place_a_${suffix}`, members[0].id],
    );
  }

  const tokens = {} as TestRoom["tokens"];
  const participantIds = {} as TestRoom["participantIds"];
  for (const m of members) {
    const response = await fetch(`${baseUrl}/api/session/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ inviteSecret: secrets[m.key] }),
    });
    const body = await response.json();
    if (!response.ok || typeof body.participantToken !== "string") {
      throw new Error(`invite exchange failed (${response.status}): ${JSON.stringify(body)}`);
    }
    tokens[m.key] = body.participantToken;
    participantIds[m.key] = body.participantId;
  }

  return {
    roomId,
    tokens,
    participantIds,
    inviteSecrets: secrets as TestRoom["inviteSecrets"],
    proposalId: `prop_${suffix}`,
    pool,
    cleanup: async () => {
      for (const table of ["stances", "proposals", "verdicts", "requirements", "adjustments", "arrival_plans", "attestations", "events", "candidates", "invite_secrets"]) {
        await pool.query(`DELETE FROM ${table} WHERE room_id = $1`, [roomId]);
      }
      await pool.query(
        `DELETE FROM participant_tokens WHERE participant_id IN
           (SELECT id FROM participants WHERE room_id = $1)`,
        [roomId],
      );
      await pool.query("DELETE FROM participants WHERE room_id = $1", [roomId]);
      await pool.query("DELETE FROM rooms WHERE id = $1", [roomId]);
      await pool.end();
    },
  };
}

export interface TestRealtime {
  /** The nonce the server pushed for one staged subject. */
  nonce(
    kind: "agreement" | "private_request",
    subjectId: string,
    timeoutMs?: number,
  ): Promise<string>;
  /** Every raw frame this participant's socket received. */
  frames(): string[];
  /** A post-auth client frame (the viewing message). */
  send(message: Record<string, unknown>): void;
  close(): void;
}

/**
 * A participant's realtime channel, the only route a confirmation nonce takes
 * (INTERACTION-AND-BINDING.md §5.4). Uses Node's global WebSocket.
 */
export async function openRealtime(
  baseUrl: string,
  token: string,
): Promise<TestRealtime> {
  // Most API tests connect to a full server and authenticate against its
  // advertised build. A few live-path tests attach only the WebSocket layer
  // to an in-process bare HTTP server; that socket uses this process's config
  // and deliberately has no /api/meta handler.
  let buildId = config.buildId;
  try {
    const response = await fetch(`${baseUrl}/api/meta`, {
      signal: AbortSignal.timeout(250),
    });
    if (response.ok) {
      const meta = await response.json() as { buildId?: unknown };
      if (typeof meta.buildId === "string") buildId = meta.buildId;
    }
  } catch {
    /* bare in-process WebSocket server */
  }
  const socket = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/ws`);
  const received: string[] = [];
  const grants: Array<{ kind: string; subjectId: string; nonce: string }> = [];
  let waiters: Array<() => void> = [];
  let welcomed: () => void = () => {};
  const welcome = new Promise<void>((resolve) => (welcomed = resolve));

  socket.addEventListener("message", (event) => {
    const raw = String((event as MessageEvent).data);
    received.push(raw);
    const message = JSON.parse(raw) as { type: string } & Record<string, string>;
    if (message.type === "welcome") welcomed();
    if (message.type === "confirmation") {
      grants.push(message as never);
      const woken = waiters;
      waiters = [];
      for (const wake of woken) wake();
    }
  });

  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("ws failed")), { once: true });
  });
  socket.send(
    JSON.stringify({
      type: "auth",
      token,
      clientBuildId: buildId,
      clientToolContractVersion: TOOL_CONTRACT_VERSION,
    }),
  );
  await welcome;

  return {
    frames: () => [...received],
    send: (message) => socket.send(JSON.stringify(message)),
    close: () => socket.close(),
    async nonce(kind, subjectId, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const index = grants.findIndex(
          (g) => g.kind === kind && g.subjectId === subjectId,
        );
        if (index >= 0) return grants.splice(index, 1)[0].nonce;
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new Error(`no ${kind} confirmation for ${subjectId} within ${timeoutMs}ms`);
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, Math.min(remaining, 100));
          waiters.push(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    },
  };
}

export interface RawResult<T> {
  body: T;
  status: number;
  /** The exact serialized network payload, for redaction assertions. */
  raw: string;
}

export async function apiPost<T = Record<string, unknown>>(
  baseUrl: string,
  path: string,
  token: string | null,
  body: unknown,
): Promise<RawResult<T>> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-tool-contract-version": TOOL_CONTRACT_VERSION,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  return { body: JSON.parse(raw) as T, raw, status: response.status };
}
