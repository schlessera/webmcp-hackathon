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
import { markClosed, markOpen, presentIn } from "./presence.ts";

interface Connection {
  socket: WebSocket;
  participantId: string;
  roomId: string;
}

const connections = new Set<Connection>();

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
          send(socket, {
            type: "presence",
            present: [...presentIn(participant.roomId)],
          });
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
        if (markClosed(connection.roomId, connection.participantId)) {
          broadcastPresence(connection.roomId);
        }
      }
    });
  });

  // Notifications are sent only after the database transaction commits
  // (Gate 4). A broadcast failure must never surface as an unhandled
  // rejection — the command has already committed and returned.
  onCommit((n) => {
    broadcast(n).catch((err) => {
      console.error("post-commit broadcast failed:", err);
    });
  });
}

async function broadcast(n: CommitNotification): Promise<void> {
  // Confirmation nonces first, and unconditionally: staging an over-bound
  // grant commits no events at all, so this must not sit behind the
  // event-broadcast early return. Each goes to its owner's sockets only.
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
    send(connection.socket, { type: "event", revision: n.revision, events });
  }
}

function broadcastPresence(roomId: string): void {
  const message: ServerMessage = { type: "presence", present: [...presentIn(roomId)] };
  for (const connection of connections) {
    if (connection.roomId !== roomId) continue;
    if (connection.socket.readyState !== WebSocket.OPEN) continue;
    send(connection.socket, message);
  }
}

function send(socket: WebSocket, message: ServerMessage): void {
  socket.send(JSON.stringify(message));
}
