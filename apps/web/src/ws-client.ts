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
  onPresence(
    present: string[],
    viewing: Array<{ participantId: string; candidateId: string }>,
    positions: Array<{
      participantId: string;
      lat: number;
      lng: number;
      updatedAt: string;
    }>,
  ): void;
  /** Which places the server is looking up right now (presentation only). */
  onLookups(
    pending: string[],
    reason: LookupReason | null,
    stages: Array<{ candidateId: string; stage: PipelineStage }>,
  ): void;
  /** The room's pipeline volume for the active needs (the progress ring). */
  onPipeline(frame: PipelineFrame): void;
  /** Facts about places changed outside the event stream: re-read. */
  onFacts(candidateIds: string[], reason: string, detail: FactsDetail): void;
}

export type PipelineStage = "queued" | "fetching" | "processing";
export type InteractiveStage = "site" | "needs" | "photos" | "web";
/** The optional open-fast-track fields of a `facts` frame. */
export interface FactsDetail {
  stage: InteractiveStage | null;
  done: boolean;
  steps: Array<{ stage: InteractiveStage; ms?: number }>;
  costUsd: number | null;
}
export interface PipelineFrame {
  outstanding: { fetch: number; process: number };
  inFlight: { fetch: number; process: number };
  done: number;
  total: number;
  etaMs?: number;
  paused: "budget" | "idle" | null;
}

export interface LookupReason {
  kind: "need" | "place" | "pool" | "refine";
  label?: string;
}

export interface RealtimeHandle {
  close(): void;
  /** Tell the room which place this page has open (null: none). Presence
   * only; dropped silently while the socket is down and re-sent on welcome. */
  setViewing(candidateId: string | null): void;
  /** The place about to be opened (debounced 250 ms), or null on blur. */
  setPreviewing(candidateId: string | null): void;
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
  /* A half-open socket never closes on its own. The server sends a visible
     keepalive every few seconds; ten seconds without any frame on an open
     socket is a dropped link as far as the page is concerned. */
  const STALE_MS = 10_000;
  let lastFrameAt = Date.now();
  const staleTimer = setInterval(() => {
    const stale =
      socket?.readyState === WebSocket.OPEN && Date.now() - lastFrameAt > STALE_MS;
    if (diagnostics.state.wsStale !== stale) diagnostics.update({ wsStale: stale });
  }, 1_000);

  const sendViewing = () => {
    if (!welcomed || socket?.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: "viewing", candidateId: viewing }));
  };
  /* Previewing: the place under the pointer or keyboard focus, debounced so
     a sweep across the map sends nothing and a rest sends one frame. */
  let previewing: string | null = null;
  let previewSent: string | null = null;
  let previewTimer: ReturnType<typeof setTimeout> | null = null;
  const PREVIEW_DEBOUNCE_MS = 250;
  const flushPreviewing = () => {
    previewTimer = null;
    if (previewSent === previewing) return;
    if (!welcomed || socket?.readyState !== WebSocket.OPEN) return;
    previewSent = previewing;
    socket.send(JSON.stringify({ type: "previewing", candidateId: previewing }));
  };

  const connect = () => {
    if (closed) return;
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    socket = new WebSocket(`${proto}://${window.location.host}/ws`);
    diagnostics.update({ wsState: "connecting" });

    socket.onopen = () => {
      welcomed = false;
      lastFrameAt = Date.now();
      diagnostics.update({ wsState: "open", wsStale: false });
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
      lastFrameAt = Date.now();
      if (diagnostics.state.wsStale) diagnostics.update({ wsStale: false });
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
        callbacks.onPresence(message.present, message.viewing ?? [], message.positions ?? []);
      } else if (message.type === "lookups") {
        const pending = Array.isArray(message.pending) ? message.pending : [];
        diagnostics.log(`lookups: ${pending.length} pending${message.reason ? ` (${message.reason.kind})` : ""}`);
        const stages = Array.isArray(message.stages)
          ? message.stages.filter(
              (row): row is { candidateId: string; stage: PipelineStage } =>
                typeof row?.candidateId === "string" &&
                (row.stage === "queued" || row.stage === "fetching" || row.stage === "processing"),
            )
          : [];
        callbacks.onLookups(pending, message.reason ?? null, stages);
      } else if (message.type === "pipeline") {
        const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0);
        const pair = (value: unknown) => {
          const v = (value ?? {}) as { fetch?: unknown; process?: unknown };
          return { fetch: count(v.fetch), process: count(v.process) };
        };
        const frame: PipelineFrame = {
          outstanding: pair(message.outstanding),
          inFlight: pair(message.inFlight),
          done: count(message.done),
          total: count(message.total),
          ...(typeof message.etaMs === "number" ? { etaMs: message.etaMs } : {}),
          paused: message.paused === "budget" || message.paused === "idle" ? message.paused : null,
        };
        diagnostics.log(
          `pipeline: ${frame.done} of ${frame.total} · ${frame.inFlight.fetch} reading · ${frame.inFlight.process} checking${frame.paused ? ` (${frame.paused})` : ""}`,
        );
        callbacks.onPipeline(frame);
        // A pipeline frame may carry per-place stage deltas too.
        if (Array.isArray(message.stages)) {
          const rows = message.stages.filter(
            (row): row is { candidateId: string; stage: PipelineStage } =>
              typeof row?.candidateId === "string" &&
              (row.stage === "queued" || row.stage === "fetching" || row.stage === "processing"),
          );
          if (message.reset || rows.length) {
            callbacks.onLookups(rows.map((row) => row.candidateId), message.reason ?? null, rows);
          }
        }
      } else if (message.type === "facts") {
        const ids = Array.isArray(message.candidateIds) ? message.candidateIds : [];
        diagnostics.log(`facts: ${ids.length} changed (${message.reason})`);
        const isStage = (v: unknown): v is InteractiveStage =>
          v === "site" || v === "needs" || v === "photos" || v === "web";
        callbacks.onFacts(ids, message.reason, {
          stage: isStage(message.stage) ? message.stage : null,
          done: message.done === true,
          steps: Array.isArray(message.steps)
            ? message.steps
                .filter((step): step is { stage: InteractiveStage; ms?: number } => isStage(step?.stage))
                .map((step) => ({ stage: step.stage, ...(typeof step.ms === "number" ? { ms: step.ms } : {}) }))
            : [],
          costUsd: typeof message.costUsd === "number" ? message.costUsd : null,
        });
      } else if (message.type === "confirmation") {
        // Never logged: the nonce is a credential for one page gesture.
        callbacks.onConfirmation(message);
      } else if (message.type === "error") {
        diagnostics.log(`ws error: ${message.code}`);
        if (message.code === "upgrade_required") {
          // The server refuses a stale page before any welcome (R17), so the
          // Gate 5 silent reload has to happen here, not on the welcome path.
          if (reloadIsProvenSafe()) window.location.reload();
          else callbacks.onStaleBundle();
        }
      }
    };
    socket.onclose = (event) => {
      diagnostics.update({ wsState: "closed" });
      if (closed) return;
      if (event.code === 4002 || event.code === 4003) {
        // Dead token: retrying cannot help — the page must re-exchange.
        diagnostics.log(`ws: unrecoverable close (${event.code}), reconnect stopped`);
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
      clearInterval(staleTimer);
      socket?.close();
    },
    setViewing(candidateId) {
      if (viewing === candidateId) return;
      viewing = candidateId;
      sendViewing();
    },
    setPreviewing(candidateId) {
      previewing = candidateId;
      if (previewTimer !== null) clearTimeout(previewTimer);
      previewTimer = setTimeout(flushPreviewing, PREVIEW_DEBOUNCE_MS);
    },
  };
}
