import type { Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import {
  TOOL_CONTRACT_VERSION,
  type AuthMessage,
  type PreviewingMessage,
  type ViewingMessage,
  type ServerMessage,
} from "@webmcp-hackathon/contracts";
import { pool } from "./db.ts";
import { authenticateToken } from "./auth.ts";
import { config } from "./config.ts";
import { onCommit, type CommitNotification } from "./commit-notifications.ts";
import { pendingConfirmations, reissueConfirmation } from "./confirmation.ts";
import { projectEvent } from "./projection.ts";
import { markClosed, markOpen, presentIn, setViewing, viewingIn } from "./presence.ts";
import { currentLookups, onFacts, onLookupProgress } from "./enrich/progress.ts";
import { pipelineScheduler } from "./pipeline/scheduler.ts";
import { openCandidate, previewCandidate } from "./spatial.ts";
import { prefetchKey, prefetchManager } from "./pipeline/prefetch.ts";
import { noteRefinementPresence } from "./refine/worker.ts";

interface Connection {
  socket: WebSocket;
  participantId: string;
  roomId: string;
  /** Per-socket identity for viewing state (two tabs, two places). */
  socketId: string;
  previewedCandidateId?: string;
}
let nextSocketId = 0;

const connections = new Set<Connection>();

const PING_INTERVAL_MS = Number(process.env.WS_PING_INTERVAL_MS ?? 30_000);
const PONG_TIMEOUT_MS = Number(process.env.WS_PONG_TIMEOUT_MS ?? 45_000);
/** Visible keepalive (PingMessage): the page treats > 10 s of silence on an
 * open socket as a dropped link, so this must arrive well inside that. */
const KEEPALIVE_MS = Number(process.env.WS_KEEPALIVE_MS ?? 4_000);

export function attachSocketErrorHandler(socket: {
  on(event: "error", listener: (error: Error) => void): unknown;
}): void {
  // X8: ws emits transport faults through EventEmitter. Having no listener
  // turns routine abrupt disconnects into uncaught process exceptions.
  socket.on("error", (error) => {
    console.warn("websocket transport error:", error.message);
  });
}

/** R10: one tail per room preserves commit order without coupling unrelated
 * rooms. A failed delivery is reported for that item but cannot poison the
 * room's later broadcasts. Exported so the ordering guarantee is unit-tested
 * with a deliberately delayed first delivery. */
export class RoomBroadcastQueue<T extends { roomId: string }> {
  private tails = new Map<string, Promise<void>>();
  private readonly deliver: (item: T) => Promise<void>;

  constructor(deliver: (item: T) => Promise<void>) {
    this.deliver = deliver;
  }

  enqueue(item: T): Promise<void> {
    const previous = this.tails.get(item.roomId) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(() => this.deliver(item));
    this.tails.set(item.roomId, task);
    void task.finally(() => {
      if (this.tails.get(item.roomId) === task) this.tails.delete(item.roomId);
    }).catch(() => undefined);
    return task;
  }
}

type QueuedBroadcast =
  | CommitNotification
  | { roomId: string; message: ServerMessage };

async function deliverQueued(item: QueuedBroadcast): Promise<void> {
  if ("message" in item) {
    broadcastRoomMessage(item.roomId, item.message);
    return;
  }
  await broadcast(item);
}

const broadcastQueue = new RoomBroadcastQueue<QueuedBroadcast>(deliverQueued);

export function attachWebSocket(server: Server): void {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (socket) => {
    attachSocketErrorHandler(socket);
    let connection: Connection | null = null;
    // R13: a half-open mobile connection never emits `close` on its own. A
    // pong deadline makes `terminate()` drive the ordinary cleanup path, so
    // stale presence and viewing state cannot survive indefinitely.
    let pongDeadline = setTimeout(() => socket.terminate(), PONG_TIMEOUT_MS);
    const resetPongDeadline = () => {
      clearTimeout(pongDeadline);
      pongDeadline = setTimeout(() => socket.terminate(), PONG_TIMEOUT_MS);
    };
    socket.on("pong", resetPongDeadline);
    const pingTimer = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) socket.ping();
    }, PING_INTERVAL_MS);
    const keepaliveTimer = setInterval(() => {
      if (connection && socket.readyState === WebSocket.OPEN) {
        send(socket, { type: "ping", at: new Date().toISOString() });
      }
    }, KEEPALIVE_MS);
    // Set synchronously before the async token lookup so a second auth frame
    // on the same socket cannot register a duplicate connection.
    let authenticating = false;
    // The socket authenticates with its first message (Gate 3 rule 5).
    const authTimer = setTimeout(() => {
      if (!connection) socket.close(4001, "auth timeout");
    }, 5000);

    socket.on("message", (raw) => {
      (async () => {
        let message: unknown;
        try {
          message = JSON.parse(String(raw));
        } catch {
          return send(socket, {
            type: "error",
            code: "invalid_message",
            message: "Messages must be JSON.",
          });
        }
        // The one post-auth message: which place this page has open. Presence
        // only — it changes no room state and is never persisted.
        if (connection && isViewingMessage(message)) {
          const candidateId = message.candidateId;
          if (candidateId !== null) {
            const candidate = await pool.query(
              "SELECT 1 FROM candidates WHERE room_id = $1 AND id = $2",
              [connection.roomId, candidateId],
            );
            if (candidate.rowCount !== 1) {
              send(socket, {
                type: "error",
                code: "invalid_message",
                message: "Unknown candidateId. Refresh the room before setting viewing state.",
              });
              return;
            }
          }
          if (setViewing(connection.roomId, connection.participantId, connection.socketId, candidateId)) {
            await broadcastPresence(connection.roomId);
          }
          if (candidateId !== null) {
            void openCandidate(connection.roomId, candidateId).catch(() => undefined);
          }
          return;
        }
        if (connection && isPreviewingMessage(message)) {
          const candidateId = message.candidateId;
          if (candidateId !== null) {
            const candidate = await pool.query(
              "SELECT 1 FROM candidates WHERE room_id = $1 AND id = $2",
              [connection.roomId, candidateId],
            );
            if (candidate.rowCount !== 1) {
              send(socket, {
                type: "error",
                code: "invalid_message",
                message: "Unknown candidateId. Refresh the room before previewing it.",
              });
              return;
            }
          }
          if (connection.previewedCandidateId && connection.previewedCandidateId !== candidateId) {
            prefetchManager.cancel(prefetchKey(connection.roomId, connection.previewedCandidateId));
          }
          connection.previewedCandidateId = candidateId ?? undefined;
          if (candidateId) previewCandidate(connection.roomId, candidateId);
          return;
        }
        if (
          connection &&
          message !== null &&
          typeof message === "object" &&
          ((message as { type?: unknown }).type === "viewing" ||
            (message as { type?: unknown }).type === "previewing")
        ) {
          // R17: malformed viewing state is not the same as clearing it. Only
          // an explicit null removes the current candidate.
          send(socket, {
            type: "error",
            code: "invalid_message",
            message: "viewing/previewing.candidateId must be null or a non-empty candidate ID up to 40 characters.",
          });
          return;
        }
        // Runtime validation: unauthenticated input must never throw.
        if (!isAuthMessage(message)) {
          if (!connection) {
            send(socket, {
              type: "error",
              code: "invalid_message",
              message: "First message must include type, token, clientBuildId, and clientToolContractVersion.",
            });
          }
          return;
        }
        if (connection || authenticating) return;
        if (
          message.clientBuildId !== config.buildId ||
          message.clientToolContractVersion !== TOOL_CONTRACT_VERSION
        ) {
          // R17: both advertised client versions are required and checked
          // before presence is registered; stale pages must reload, not join.
          send(socket, {
            type: "error",
            code: "upgrade_required",
            message: `Client ${message.clientBuildId}/${message.clientToolContractVersion} != server ${config.buildId}/${TOOL_CONTRACT_VERSION}. Reload the page.`,
          });
          socket.close(4002, "upgrade required");
          return;
        }
        authenticating = true;
        const participant = await authenticateToken(message.token);
        if (!participant) {
          authenticating = false;
          send(socket, {
            type: "error",
            code: "not_authenticated",
            message: "Unknown participant token. Re-exchange your invite.",
          });
          socket.close(4003, "not authenticated");
          return;
        }
        clearTimeout(authTimer);
        connection = {
          socket,
          participantId: participant.id,
          roomId: participant.roomId,
          socketId: `s${++nextSocketId}`,
        };
        connections.add(connection);
        const becamePresent = markOpen(participant.roomId, participant.id);
        // Ensure the room loop exists on every successful authentication.
        // The presence listener handles the transition too; this idempotent
        // call also covers later sockets and makes auth the explicit owner of
        // the production lifecycle guarantee.
        noteRefinementPresence(participant.roomId, presentIn(participant.roomId));
        const room = (
          await pool.query("SELECT revision FROM rooms WHERE id = $1", [
            participant.roomId,
          ])
        ).rows[0];
        // Gate 5: welcome carries buildId + toolContractVersion so stale
        // bundles reload (Chromium) or banner (ChatGPT surface).
        send(socket, {
          type: "welcome",
          buildId: config.buildId,
          toolContractVersion: TOOL_CONTRACT_VERSION,
          revision: room?.revision ?? 0,
          participantId: participant.id,
          displayName: participant.displayName,
          role: participant.role,
        });
        // A reconnecting page may have lost its nonce delivery, so re-issue
        // whatever is still staged without invalidating another tab's copy.
        for (const subject of await pendingConfirmations(pool, participant)) {
          send(socket, {
            type: "confirmation",
            ...reissueConfirmation(participant.roomId, participant.id, subject),
          });
        }
        // Presence: this socket learns who is here; the room learns of a
        // newcomer only when the set actually changed (a second tab is not
        // a second person).
        if (becamePresent) {
          await broadcastPresence(participant.roomId);
        } else {
          send(socket, await presenceMessage(participant.roomId));
        }
        // Presentation state follows presence on every authentication. An
        // empty frame is meaningful: it clears rings left by a dropped socket.
        send(socket, currentLookups(participant.roomId));
        send(socket, pipelineScheduler.frames.currentPipeline(participant.roomId));
      })().catch((err) => {
        // Unauthenticated input must never take the server down.
        console.error("ws message handling failed:", err);
        socket.close(1011, "internal error");
      });
    });

    socket.on("close", () => {
      clearTimeout(authTimer);
      clearInterval(pingTimer);
      clearInterval(keepaliveTimer);
      clearTimeout(pongDeadline);
      if (connection) {
        if (connection.previewedCandidateId) {
          prefetchManager.cancel(prefetchKey(connection.roomId, connection.previewedCandidateId));
        }
        connections.delete(connection);
        if (markClosed(connection.roomId, connection.participantId, connection.socketId)) {
          void broadcastPresence(connection.roomId).catch((err) => {
            console.error("presence broadcast failed:", err);
          });
        }
      }
    });
  });

  // Notifications are sent only after the database transaction commits
  // (Gate 4). A broadcast failure must never surface as an unhandled
  // rejection — the command has already committed and returned.
  onCommit((n) => {
    broadcastQueue.enqueue(n).catch((err) => {
      console.error("post-commit broadcast failed:", err);
    });
  });
  const enqueueRoomMessage = (roomId: string, message: ServerMessage) => {
    broadcastQueue.enqueue({ roomId, message }).catch((err) => {
      console.error("ordered room broadcast failed:", err);
    });
  };
  onLookupProgress(enqueueRoomMessage);
  pipelineScheduler.frames.onPipeline(enqueueRoomMessage);
  pipelineScheduler.frames.onLookups(enqueueRoomMessage);
  onFacts(enqueueRoomMessage);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isAuthMessage(value: unknown): value is AuthMessage {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "type", "token", "clientBuildId", "clientToolContractVersion",
  ])) return false;
  return value.type === "auth" &&
    typeof value.token === "string" && value.token.length > 0 && value.token.length <= 256 &&
    typeof value.clientBuildId === "string" && value.clientBuildId.length > 0 && value.clientBuildId.length <= 80 &&
    typeof value.clientToolContractVersion === "string" &&
    value.clientToolContractVersion.length > 0 && value.clientToolContractVersion.length <= 20;
}

function isViewingMessage(value: unknown): value is ViewingMessage {
  if (!isRecord(value) || !hasOnlyKeys(value, ["type", "candidateId"])) return false;
  return value.type === "viewing" &&
    (value.candidateId === null ||
      (typeof value.candidateId === "string" &&
        value.candidateId.length > 0 && value.candidateId.length <= 40));
}

function isPreviewingMessage(value: unknown): value is PreviewingMessage {
  if (!isRecord(value) || !hasOnlyKeys(value, ["type", "candidateId"])) return false;
  return value.type === "previewing" &&
    (value.candidateId === null ||
      (typeof value.candidateId === "string" &&
        value.candidateId.length > 0 && value.candidateId.length <= 40));
}

async function broadcast(n: CommitNotification): Promise<void> {
  // Confirmation nonces first and unconditionally. Each goes to its owner's
  // sockets only; idempotent no-event outcomes still must not affect this path.
  for (const grant of n.confirmations) {
    const { participantId, ...message } = grant;
    for (const connection of connections) {
      if (connection.roomId !== n.roomId) continue;
      if (connection.participantId !== participantId) continue;
      if (connection.socket.readyState !== WebSocket.OPEN) continue;
      send(connection.socket, { type: "confirmation", ...message });
    }
  }
  if (n.storedRevisions.length === 0) return;
  const rows = (
    await pool.query(
      `SELECT revision, type, actor_id, visibility, payload FROM events
        WHERE room_id = $1 AND revision = ANY($2) ORDER BY revision`,
      [n.roomId, n.storedRevisions],
    )
  ).rows;
  for (const connection of connections) {
    if (connection.roomId !== n.roomId) continue;
    if (connection.socket.readyState !== WebSocket.OPEN) continue;
    const events = rows
      .map((row) =>
        projectEvent(
          {
            revision: row.revision,
            type: row.type,
            actorId: row.actor_id,
            visibility: row.visibility,
            payload: row.payload,
          },
          connection.participantId,
        ),
      )
      .filter((e) => e !== null);
    send(connection.socket, {
      type: "event",
      revision: n.revision,
      // R10: clients can prove continuity even when every event in this frame
      // is omitted by their privacy projection.
      fromRevision: n.storedRevisions[0] - 1,
      events,
      // Only the actor's own sockets learn which request caused the frame.
      // The projection hides the actor of a private move from peers, and an
      // ungated causedBy would hand it back.
      ...(n.causedBy && connection.participantId === n.causedBy.actorId
        ? { causedBy: { correlationId: n.causedBy.correlationId, command: n.causedBy.command } }
        : {}),
    });
  }
  // Position sharing is presentation state: after its durable owner-only
  // write commits, peers receive the latest opted-in coordinates only through
  // the presence frame. Both moving and switching off replace the frame.
  for (const row of rows) {
    if (row.type !== "origin_sharing_changed") continue;
    noteSharingChange(n.roomId, row.actor_id, row.payload?.shared === true);
  }
  if (rows.some((row) =>
    row.type === "origin_updated" || row.type === "origin_sharing_changed"
  )) {
    await broadcastPresence(n.roomId);
  }
}

/**
 * Who has sharing switched on, per room. Presence frames go out on every
 * socket open, close and viewing change, and sharing is off by default — so
 * without this the common case would pay a database round trip per frame to
 * learn that nobody shares. Process-local, like the rest of presence: the
 * demo runs one server. `null` means "not read yet".
 */
const sharers = new Map<string, Set<string>>();

async function sharersIn(roomId: string): Promise<Set<string>> {
  const known = sharers.get(roomId);
  if (known) return known;
  const rows = (
    await pool.query(
      "SELECT id FROM participants WHERE room_id = $1 AND origin_shared = true",
      [roomId],
    )
  ).rows as Array<{ id: string }>;
  const set = new Set(rows.map((row) => row.id));
  sharers.set(roomId, set);
  return set;
}

/** Keep the cache honest when a participant flips their own switch. */
function noteSharingChange(roomId: string, participantId: string, shared: boolean): void {
  const set = sharers.get(roomId);
  if (!set) return;
  if (shared) set.add(participantId);
  else set.delete(participantId);
}

async function presenceMessage(roomId: string): Promise<ServerMessage> {
  const present = [...presentIn(roomId)];
  const positions: Array<{
    participantId: string;
    lat: number;
    lng: number;
    updatedAt: string;
  }> = [];
  // An empty room forgets its cache, so the next arrival re-reads the truth.
  if (present.length === 0) sharers.delete(roomId);
  const sharing = present.length > 0 ? await sharersIn(roomId) : new Set<string>();
  if (present.some((id) => sharing.has(id))) {
    const rows = (
      await pool.query(
        `SELECT id, origin
           FROM participants
          WHERE room_id = $1 AND id = ANY($2) AND origin_shared = true`,
        [roomId, present],
      )
    ).rows as Array<{
      id: string;
      origin: { lat?: unknown; lng?: unknown; updatedAt?: unknown } | null;
    }>;
    for (const row of rows) {
      if (
        typeof row.origin?.lat === "number" && Number.isFinite(row.origin.lat) &&
        typeof row.origin?.lng === "number" && Number.isFinite(row.origin.lng) &&
        typeof row.origin?.updatedAt === "string"
      ) {
        positions.push({
          participantId: row.id,
          lat: row.origin.lat,
          lng: row.origin.lng,
          updatedAt: row.origin.updatedAt,
        });
      }
    }
  }
  return {
    type: "presence",
    present,
    viewing: viewingIn(roomId),
    positions,
  };
}

async function broadcastPresence(roomId: string): Promise<void> {
  const message = await presenceMessage(roomId);
  for (const connection of connections) {
    if (connection.roomId !== roomId) continue;
    if (connection.socket.readyState !== WebSocket.OPEN) continue;
    send(connection.socket, message);
  }
}

function broadcastRoomMessage(roomId: string, message: ServerMessage): void {
  for (const connection of connections) {
    if (connection.roomId !== roomId) continue;
    if (connection.socket.readyState !== WebSocket.OPEN) continue;
    send(connection.socket, message);
  }
}

function send(socket: WebSocket, message: ServerMessage): void {
  socket.send(JSON.stringify(message));
}
