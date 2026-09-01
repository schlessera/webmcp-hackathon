import {
  TOOL_CONTRACT_VERSION,
  type ProjectedEvent,
  type ServerMessage,
} from "@webmcp-hackathon/contracts";
import { diagnostics } from "./diagnostics-store.ts";
import { reloadIsProvenSafe } from "./surface.ts";

export interface RealtimeCallbacks {
  onWelcome(message: {
    buildId: string;
    toolContractVersion: string;
    revision: number;
    participantId: string;
  }): void;
  onEvents(revision: number, events: ProjectedEvent[]): void;
  /** The realtime channel is the ONLY route a confirmation nonce takes. */
  onConfirmation(grant: {
    kind: "agreement" | "private_request";
    subjectId: string;
    nonce: string;
    expiresInMs: number;
  }): void;
  onStaleBundle(): void;
  /** Who holds an open socket in the room right now. */
  onPresence(present: string[]): void;
}

let pageBuildId: string | null = null;
let pageBuildFetch: Promise<string> | null = null;

/**
 * The page's own buildId, fetched once at boot from the serving process.
 * Concurrent callers share one in-flight fetch; a failure (e.g. the page
 * loaded mid-restart) retries a few times and then degrades gracefully —
 * a null pageBuildId simply disables the buildId half of the staleness check.
 */
export function fetchPageBuild(): Promise<string> {
  if (pageBuildId) return Promise.resolve(pageBuildId);
  pageBuildFetch ??= (async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const meta = await (await fetch("/api/meta")).json();
        pageBuildId = meta.buildId as string;
        diagnostics.update({ buildId: pageBuildId });
        return pageBuildId;
      } catch {
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
    }
    diagnostics.log("could not fetch /api/meta — buildId staleness check off");
    return "";
  })();
  return pageBuildFetch;
}

export function connectRealtime(
  token: string,
  callbacks: RealtimeCallbacks,
): () => void {
  let closed = false;
  let socket: WebSocket | null = null;
  let retryMs = 1000;

  const connect = () => {
    if (closed) return;
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    socket = new WebSocket(`${proto}://${window.location.host}/ws`);
    diagnostics.update({ wsState: "connecting" });

    socket.onopen = () => {
      diagnostics.update({ wsState: "open" });
      socket!.send(
        JSON.stringify({
          type: "auth",
          token,
          clientBuildId: pageBuildId ?? "unknown",
          clientToolContractVersion: TOOL_CONTRACT_VERSION,
        }),
      );
    };
    socket.onmessage = (raw) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(String(raw.data)) as ServerMessage;
      } catch {
        diagnostics.log("ws: dropped unparseable frame");
        return;
      }
      if (message.type === "welcome") {
        retryMs = 1000; // healthy connection resets the backoff
        diagnostics.update({ serverBuildId: message.buildId });
        callbacks.onWelcome(message);
        const stale =
          (pageBuildId !== null && message.buildId !== pageBuildId) ||
          message.toolContractVersion !== TOOL_CONTRACT_VERSION;
        if (stale) {
          diagnostics.log(
            `stale bundle: page ${pageBuildId}/${TOOL_CONTRACT_VERSION} vs server ${message.buildId}/${message.toolContractVersion}`,
          );
          if (reloadIsProvenSafe()) {
            // Participant token survives in sessionStorage; the reload
            // reauthenticates, re-registers the full tool catalog, and
            // fetches the latest projection.
            window.location.reload();
          } else {
            callbacks.onStaleBundle();
          }
        }
      } else if (message.type === "event") {
        callbacks.onEvents(message.revision, message.events);
      } else if (message.type === "presence") {
        callbacks.onPresence(message.present);
      } else if (message.type === "confirmation") {
        // Never logged: the nonce is a credential for one page gesture.
        callbacks.onConfirmation(message);
      } else if (message.type === "error") {
        diagnostics.log(`ws error: ${message.code}`);
      }
    };
    socket.onclose = (event) => {
      diagnostics.update({ wsState: "closed" });
      if (closed) return;
      if (event.code === 4003) {
        // Dead token: retrying cannot help — the page must re-exchange.
        diagnostics.log("ws: token rejected (4003), reconnect stopped");
        return;
      }
      setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, 15000);
    };
  };
  connect();

  return () => {
    closed = true;
    socket?.close();
  };
}
