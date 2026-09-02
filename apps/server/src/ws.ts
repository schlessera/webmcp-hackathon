import type { Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import {
  TOOL_CONTRACT_VERSION,
  type ClientMessage,
  type ServerMessage,
} from "@webmcp-hackathon/contracts";
import { pool } from "./db.ts";
import { authenticateToken } from "./auth.ts";
import { config } from "./config.ts";
import { onCommit, type CommitNotification } from "./engine.ts";
import { mintConfirmation, pendingConfirmations } from "./confirmation.ts";
import { projectEvent } from "./projection.ts";
import { markClosed, markOpen, presentIn, setViewing, viewingIn } from "./presence.ts";

interface Connection {
  socket: WebSocket;
  participantId: string;
  roomId: string;
  /** Per-socket identity for viewing state (two tabs, two places). */
  socketId: string;
}
let nextSocketId = 0;

const connections = new Set<Connection>();

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

const broadcastQueue = new RoomBroadcastQueue<CommitNotification>(broadcast);

export function attachWebSocket(server: Server): void {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (socket) => {
    let connection: Connection | null = null;
    // Set synchronously before the async token lookup so a second auth frame
    // on the same socket cannot register a duplicate connection.
    let authenticating = false;
    // The socket authenticates with its first message (Gate 3 rule 5).
    const authTimer = setTimeout(() => {
      if (!connection) socket.close(4001, "auth timeout");
    }, 5000);

    socket.on("message", (raw) => {
      (async () => {
        let message: ClientMessage;
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
        if (
          connection &&
          message !== null &&
          typeof message === "object" &&
          message.type === "viewing"
        ) {
          const candidateId =
            typeof message.candidateId === "string" && message.candidateId.length <= 40
              ? message.candidateId
              : null;
          if (setViewing(connection.roomId, connection.participantId, connection.socketId, candidateId)) {
            broadcastPresence(connection.roomId);
          }
          return;
        }
        // Runtime validation: unauthenticated input must never throw.
        if (
          message === null ||
          typeof message !== "object" ||
          message.type !== "auth" ||
          typeof message.token !== "string"
        ) {
          if (!connection) {
            send(socket, {
              type: "error",
              code: "invalid_message",
              message: "First message must be { type: 'auth', token }.",
            });
          }
          return;
        }
        if (connection || authenticating) return;
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
        // A reconnecting page has lost any confirmation nonce it held, and the
        // nonce has no other delivery route — re-mint whatever is still
        // staged for this participant so a dropped socket cannot wedge it.
        for (const subject of await pendingConfirmations(pool, participant)) {
          send(socket, {
            type: "confirmation",
            ...mintConfirmation(participant.roomId, participant.id, subject),
          });
        }
        // Presence: this socket learns who is here; the room learns of a
        // newcomer only when the set actually changed (a second tab is not
        // a second person).
        if (becamePresent) {
          broadcastPresence(participant.roomId);
        } else {
          send(socket, presenceMessage(participant.roomId));
        }
        // Belt-and-braces: also tell a contract-stale client explicitly.
        if (
          typeof message.clientToolContractVersion === "string" &&
          message.clientToolContractVersion !== TOOL_CONTRACT_VERSION
        ) {
          send(socket, {
            type: "error",
            code: "upgrade_required",
            message: `Client contract v${message.clientToolContractVersion} != server v${TOOL_CONTRACT_VERSION}. Reload the page.`,
          });
        }
      })().catch((err) => {
        // Unauthenticated input must never take the server down.
        console.error("ws message handling failed:", err);
        socket.close(1011, "internal error");
      });
    });

    socket.on("close", () => {
      clearTimeout(authTimer);
      if (connection) {
        connections.delete(connection);
        if (markClosed(connection.roomId, connection.participantId, connection.socketId)) {
          broadcastPresence(connection.roomId);
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
    });
  }
}

function presenceMessage(roomId: string): ServerMessage {
  return { type: "presence", present: [...presentIn(roomId)], viewing: viewingIn(roomId) };
}

function broadcastPresence(roomId: string): void {
  const message = presenceMessage(roomId);
  for (const connection of connections) {
    if (connection.roomId !== roomId) continue;
    if (connection.socket.readyState !== WebSocket.OPEN) continue;
    send(connection.socket, message);
  }
}

function send(socket: WebSocket, message: ServerMessage): void {
  socket.send(JSON.stringify(message));
}
