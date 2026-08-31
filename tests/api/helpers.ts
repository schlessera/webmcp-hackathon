import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

export const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://webmcp:webmcp@127.0.0.1:5432/webmcp";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface TestServer {
  baseUrl: string;
  logs: () => string;
  stop: () => Promise<void>;
}

/** Spawn a real server process, capturing its log output for invariant checks. */
export async function startServer(): Promise<TestServer> {
  const port = 42000 + Math.floor(Math.random() * 2000);
  let captured = "";
  const child: ChildProcess = spawn(
    "node",
    [join(repoRoot, "apps", "server", "src", "server.ts")],
    {
      env: {
        ...process.env,
        DATABASE_URL,
        PORT: String(port),
        SERVE_STATIC: "1", // skip Vite middleware in API tests
        LOG_LEVEL: "info",
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

/** Create one fresh room and three exchanged tokens straight against the DB. */
export async function createTestRoom(baseUrl: string): Promise<TestRoom> {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  const suffix = randomBytes(4).toString("hex");
  const roomId = `room_test_${suffix}`;
  const members = [
    { key: "org", id: `p_org_${suffix}`, name: "Alex", role: "organizer" },
    { key: "sarah", id: `p_sarah_${suffix}`, name: "Sarah", role: "member" },
    { key: "joe", id: `p_joe_${suffix}`, name: "Joe", role: "member" },
  ] as const;

  await pool.query(
    `INSERT INTO rooms (id, goal, phase, domain, revision, policy)
     VALUES ($1, 'test dinner', 'gathering', 'spatial-destination/v1', 0, '{}')`,
    [roomId],
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

  const tokens = {} as TestRoom["tokens"];
  const participantIds = {} as TestRoom["participantIds"];
  for (const m of members) {
    const response = await fetch(`${baseUrl}/api/session/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ inviteSecret: secrets[m.key] }),
    });
    const body = await response.json();
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
      for (const table of ["stances", "proposals", "verdicts", "requirements", "events", "candidates", "invite_secrets"]) {
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

export interface RawResult<T> {
  body: T;
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
      "x-tool-contract-version": "1",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  return { body: JSON.parse(raw) as T, raw };
}
