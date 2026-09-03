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
  onEvents(
    revision: number,
    events: ProjectedEvent[],
    fromRevision?: number,
  ): void;
  /** The realtime channel is the ONLY route a confirmation nonce takes. */
  onConfirmation(grant: {
    kind: "agreement" | "private_request";
    subjectId: string;
    nonce: string;
    expiresInMs: number;
  }): void;
  onStaleBundle(): void;
  /** Who holds an open socket in the room right now, and who has which
   * place open. */
  onPresence(present: string[], viewing: Array<{ participantId: string; candidateId: string }>): void;
}

export interface RealtimeHandle {
  close(): void;
  /** Tell the room which place this page has open (null: none). Presence
   * only; dropped silently while the socket is down and re-sent on welcome. */
  setViewing(candidateId: string | null): void;
}

/** R10: an ordered frame must begin exactly where this client stopped. The
 * field is optional so a mixed deployment remains wire-compatible. */
export function hasRevisionGap(
  projectedThroughRevision: number,
  fromRevision?: number,
): boolean {
  return fromRevision !== undefined && fromRevision !== projectedThroughRevision;
}

/** R13: reconnecting clients share the same outage, so deterministic delays
 * create a synchronized retry wave. Half-to-full jitter keeps exponential
 * backoff while spreading attempts, capped at the existing 15 seconds. */
export function reconnectDelayMs(
  attempt: number,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(1000 * 2 ** Math.max(0, attempt), 15_000);
  return Math.round(exponential * (0.5 + Math.min(1, Math.max(0, random())) * 0.5));
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
        diagnostics.update({ buildId: pageBuildId, nlAvailable: meta.nl === true });
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
): RealtimeHandle {
  let closed = false;
  let socket: WebSocket | null = null;
  let retryAttempt = 0;
  let viewing: string | null = null;
  let welcomed = false;

  const sendViewing = () => {
    if (!welcomed || socket?.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: "viewing", candidateId: viewing }));
  };

  const connect = () => {
    if (closed) return;
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    socket = new WebSocket(`${proto}://${window.location.host}/ws`);
    diagnostics.update({ wsState: "connecting" });

    socket.onopen = () => {
      welcomed = false;
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
        retryAttempt = 0; // healthy connection resets the backoff
        diagnostics.update({ serverBuildId: message.buildId });
        callbacks.onWelcome(message);
        welcomed = true;
        // A reconnecting page still has its place open; the room should know.
        if (viewing !== null) sendViewing();
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
        callbacks.onEvents(message.revision, message.events, message.fromRevision);
      } else if (message.type === "presence") {
        callbacks.onPresence(message.present, message.viewing ?? []);
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
      setTimeout(connect, reconnectDelayMs(retryAttempt));
      retryAttempt += 1;
    };
  };
  connect();

  return {
    close() {
      closed = true;
      socket?.close();
    },
    setViewing(candidateId) {
      if (viewing === candidateId) return;
      viewing = candidateId;
      sendViewing();
    },
  };
}
