import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  PROTOCOL_VERSIONS,
  TOOL_CONTRACT_VERSION,
  type ProjectedEvent,
} from "@webmcp-hackathon/contracts";
import { submitCommand, syncSession } from "./api.ts";
import { clearSession, establishSession, inviteSecretFromFragment, type SessionState } from "./session.ts";
import { connectRealtime, fetchPageBuild } from "./ws-client.ts";
import { diagnostics } from "./diagnostics-store.ts";

interface FeedLine extends ProjectedEvent {}

/** Newest first, deduplicated by revision (live WS and catch-up can overlap). */
function mergeFeed(incoming: FeedLine[], prev: FeedLine[]): FeedLine[] {
  const seen = new Set<number>();
  return [...incoming, ...prev]
    .filter((e) => (seen.has(e.revision) ? false : (seen.add(e.revision), true)))
    .sort((a, b) => b.revision - a.revision)
    .slice(0, 30);
}

export function App() {
  const [session, setSession] = useState<SessionState | null>(null);
  const [revision, setRevision] = useState<number>(0);
  const [feed, setFeed] = useState<FeedLine[]>([]);
  const [staleBanner, setStaleBanner] = useState(false);
  const [lastResult, setLastResult] = useState<string>("");

  const diag = useSyncExternalStore(
    (cb) => diagnostics.subscribe(cb),
    () => diagnostics.state,
  );

  const lastSeenRevision = useRef(0);
  const catchUpRef = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    // Strict-Mode-safe: the flag cancels the in-flight async init of an
    // already-cleaned-up effect run so it never opens an untracked socket.
    let cancelled = false;
    let cleanup = () => {};
    (async () => {
      await fetchPageBuild();
      let established = await establishSession();
      if (cancelled) return;

      // A stored token can be dead (make demo-reset wipes the token table).
      // Probe it once; when the invite is still in the fragment, drop the
      // stale session and re-exchange instead of stranding the tab.
      if (established.token) {
        const probe = (await syncSession()) as {
          ok: boolean;
          error?: { code: string };
        };
        if (cancelled) return;
        if (
          !probe.ok &&
          probe.error?.code === "not_authenticated" &&
          inviteSecretFromFragment()
        ) {
          diagnostics.log("stored token dead — re-exchanging from fragment");
          clearSession();
          established = await establishSession();
          if (cancelled) return;
        }
      }
      setSession(established);
      if (!established.token) return;

      const advanceTo = (newRevision: number) => {
        lastSeenRevision.current = Math.max(
          lastSeenRevision.current,
          newRevision,
        );
        setRevision(lastSeenRevision.current);
      };

      /** Pull the delta for events this page missed (disconnects, races).
       * Revision 0 is a legitimate sinceRevision (freshly seeded room).
       * The floor is captured BEFORE the await: a live event arriving during
       * the round-trip advances the ref, and filtering against the moved ref
       * would silently drop the very events this fetch went out for
       * (mergeFeed dedups any overlap). */
      const catchUp = async () => {
        const since = lastSeenRevision.current;
        const sync = (await syncSession(since)) as {
          ok: boolean;
          revision?: number;
          delta?: { events: ProjectedEvent[] };
        };
        if (!sync.ok || sync.revision === undefined || cancelled) return;
        if (sync.delta && sync.revision > since) {
          const fresh = sync.delta.events.filter((e) => e.revision > since);
          setFeed((prev) => mergeFeed(fresh, prev));
        }
        advanceTo(sync.revision);
      };

      catchUpRef.current = catchUp;

      const first = (await syncSession()) as { ok: boolean; revision?: number };
      if (cancelled) return;
      if (first.ok && first.revision !== undefined) advanceTo(first.revision);

      cleanup = connectRealtime(established.token, {
        onWelcome(welcome) {
          // The server broadcasts only live commits: a welcome ahead of the
          // page means missed events — fetch them, don't skip them.
          if (welcome.revision > lastSeenRevision.current) void catchUp();
        },
        onEvents(newRevision, events) {
          setFeed((prev) => mergeFeed(events, prev));
          advanceTo(newRevision);
        },
        onStaleBundle() {
          setStaleBanner(true);
        },
      });
      if (cancelled) cleanup();
    })().catch((err) => {
      // Never strand the page on "Connecting…" without a visible cause.
      diagnostics.log(`init failed: ${String(err)}`);
      setSession({
        token: null,
        identity: null,
        error: `Initialization failed: ${String(err).slice(0, 200)}`,
      });
    });
    return () => {
      cancelled = true;
      cleanup();
    };
  }, []);

  const run = async (type: string, input: Record<string, unknown>) => {
    const result = (await submitCommand(type, {
      // The ref, not the render-time state: a WS event between paint and
      // click must not send a stale baseRevision.
      baseRevision: lastSeenRevision.current,
      ...input,
    })) as { ok: boolean; revision?: number; effect?: string; error?: { code: string; message: string } };
    if (result.ok && result.revision !== undefined) {
      lastSeenRevision.current = Math.max(
        lastSeenRevision.current,
        result.revision,
      );
      setRevision(lastSeenRevision.current);
      setLastResult(result.effect ?? "ok");
    } else {
      setLastResult(`${result.error?.code}: ${result.error?.message}`);
      // Stale base without a live WS would strand every later click on the
      // same revision — pull the delta and advance now.
      if (result.error?.code === "sync_required") {
        await catchUpRef.current?.();
      }
    }
  };

  if (!session) return <main style={styles.page}>Connecting…</main>;
  if (!session.identity) {
    return (
      <main style={styles.page}>
        <h1>Where To</h1>
        <p role="alert">{session.error}</p>
      </main>
    );
  }

  const id = session.identity;
  return (
    <main style={styles.page}>
      {staleBanner && (
        <div style={styles.banner} role="alert">
          Protocol updated —{" "}
          <button onClick={() => window.location.reload()}>
            tap to refresh
          </button>
        </div>
      )}
      <h1>Where To — shared planning</h1>
      <section data-testid="identity">
        <strong data-testid="display-name">{id.displayName}</strong>{" "}
        <span data-testid="role">({id.role})</span> · participant{" "}
        <code data-testid="participant-id">{id.participantId}</code> · room{" "}
        <code data-testid="room-id">{id.roomId}</code>
      </section>
      <section>
        revision <strong data-testid="revision">{revision}</strong> · build{" "}
        <code data-testid="build-id">{diag.buildId ?? "…"}</code> · contract v
        <span data-testid="contract-version">{TOOL_CONTRACT_VERSION}</span> · protocols{" "}
        <code data-testid="protocols">
          negotiation/{PROTOCOL_VERSIONS.negotiation} {PROTOCOL_VERSIONS.domain}
        </code>
      </section>

      <section style={styles.actions}>
        <button
          data-testid="submit-shared"
          onClick={() =>
            run("SubmitRequirement", {
              visibility: "shared",
              hardness: "hard",
              delegation: { mode: "approval_required" },
              payload: {
                kind: "attribute",
                key: "vegetarian-options",
                expect: "verified_true",
              },
            })
          }
        >
          Require vegetarian options (shared)
        </button>
        <button
          data-testid="submit-private"
          onClick={() =>
            run("SubmitRequirement", {
              visibility: "application-private",
              hardness: "hard",
              delegation: { mode: "approval_required" },
              payload: {
                kind: "budget",
                perPersonMax: { amount: 18, currency: "EUR" },
              },
            })
          }
        >
          Set private budget (application-private)
        </button>
        <button
          data-testid="declare-agent-private"
          onClick={() =>
            run("SubmitRequirement", {
              visibility: "agent-private",
              hardness: "hard",
              delegation: { mode: "approval_required" },
              scopeHint: { affects: "candidate-eligibility" },
            })
          }
        >
          Declare agent-private requirement
        </button>
        <button
          data-testid="toggle-ready"
          onClick={() => run("SetReadyState", { state: "ready" })}
        >
          I'm done adding
        </button>
      </section>
      <p data-testid="last-result">{lastResult}</p>

      <section>
        <h2>Room feed</h2>
        <ul data-testid="feed">
          {feed.map((line) => (
            <li key={`${line.revision}-${line.type}`} data-level={line.level}>
              <code>#{line.revision}</code> {line.text}
            </li>
          ))}
        </ul>
      </section>

      <details open data-testid="diagnostics">
        <summary>Diagnostics</summary>
        <ul style={styles.diag}>
          <li>
            document.modelContext:{" "}
            <strong data-testid="diag-modelcontext">
              {diag.modelContextPresent ? "present" : "absent"}
            </strong>
          </li>
          <li>
            tool registration:{" "}
            <strong data-testid="diag-registration">{diag.registration}</strong>
            {diag.registrationError && (
              <span role="alert"> — {diag.registrationError}</span>
            )}
          </li>
          <li>
            websocket: <span data-testid="diag-ws">{diag.wsState}</span>
          </li>
          <li>
            page build <code>{diag.buildId}</code> · server build{" "}
            <code data-testid="diag-server-build">{diag.serverBuildId}</code>
          </li>
        </ul>
        <pre style={styles.log} data-testid="diag-log">
          {diag.lines.join("\n")}
        </pre>
      </details>
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    fontFamily: "system-ui, sans-serif",
    maxWidth: 720,
    margin: "0 auto",
    padding: "1rem",
    lineHeight: 1.5,
  },
  banner: {
    background: "#ffe9a8",
    border: "1px solid #d4a017",
    padding: "0.5rem 1rem",
    borderRadius: 6,
    marginBottom: "1rem",
  },
  actions: {
    display: "flex",
    flexWrap: "wrap",
    gap: "0.5rem",
    margin: "1rem 0",
  },
  diag: { fontSize: "0.85rem" },
  log: {
    fontSize: "0.75rem",
    background: "#f4f4f4",
    padding: "0.5rem",
    maxHeight: 200,
    overflowY: "auto",
    whiteSpace: "pre-wrap",
  },
};
