import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  PROTOCOL_VERSIONS,
  TOOL_CONTRACT_VERSION,
  type ProjectedEvent,
} from "@webmcp-hackathon/contracts";
import { submitCommand, syncSession } from "./api.ts";
import {
  clearSession,
  establishSession,
  inviteSecretFromFragment,
  type SessionState,
} from "./session.ts";
import { connectRealtime, fetchPageBuild } from "./ws-client.ts";
import { diagnostics } from "./diagnostics-store.ts";
import { registerCommandRunner, spatial } from "./spatial-store.ts";
import type { CommandEnvelope, OutstandingItem } from "./spatial-types.ts";
import { requirementsFromFeed } from "./requirements.ts";
import { Wordmark } from "./components/Wordmark.tsx";
import { MapView } from "./components/MapView.tsx";
import { CandidateSheet } from "./components/CandidateSheet.tsx";
import { RequirementsPanel } from "./components/RequirementsPanel.tsx";
import { DecisionsPanel } from "./components/DecisionsPanel.tsx";
import { ArrivalBanner } from "./components/ArrivalBanner.tsx";

interface FeedLine extends ProjectedEvent {}

/** Newest first, deduplicated by revision (live WS and catch-up can overlap). */
function mergeFeed(incoming: FeedLine[], prev: FeedLine[]): FeedLine[] {
  const seen = new Set<number>();
  return [...incoming, ...prev]
    .filter((e) => (seen.has(e.revision) ? false : (seen.add(e.revision), true)))
    .sort((a, b) => b.revision - a.revision)
    .slice(0, 40);
}

const FEASIBILITY_CHIP: Record<string, { className: string; label: (e: number, t: number) => string }> = {
  feasible: { className: "chip-feasible", label: (e, t) => `${e} of ${t} eligible` },
  fragile: { className: "chip-fragile", label: (e, t) => `only ${e} of ${t} left` },
  infeasible: { className: "chip-infeasible", label: () => "impasse" },
  uncertain: { className: "chip-uncertain", label: (e, t) => `${e} of ${t} · checking` },
};

export function App() {
  const [session, setSession] = useState<SessionState | null>(null);
  const [revision, setRevision] = useState<number>(0);
  const [feed, setFeed] = useState<FeedLine[]>([]);
  const [staleBanner, setStaleBanner] = useState(false);
  const [lastResult, setLastResult] = useState<{ text: string; kind: "ok" | "error" } | null>(null);
  const [tab, setTab] = useState<"needs" | "activity" | "decisions">("needs");
  const [ready, setReady] = useState(false);

  const diag = useSyncExternalStore(
    (cb) => diagnostics.subscribe(cb),
    () => diagnostics.state,
  );
  const spatialState = useSyncExternalStore(
    (cb) => spatial.subscribe(cb),
    () => spatial.state,
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
          outstanding?: OutstandingItem[];
        };
        if (!sync.ok || sync.revision === undefined || cancelled) return;
        if (sync.delta && sync.revision > since) {
          const fresh = sync.delta.events.filter((e) => e.revision > since);
          setFeed((prev) => mergeFeed(fresh, prev));
        }
        spatial.setOutstanding(sync.outstanding);
        advanceTo(sync.revision);
      };

      catchUpRef.current = catchUp;

      const first = (await syncSession(0)) as {
        ok: boolean;
        revision?: number;
        delta?: { events: ProjectedEvent[] };
        outstanding?: OutstandingItem[];
      };
      if (cancelled) return;
      if (first.ok && first.revision !== undefined) {
        if (first.delta) setFeed((prev) => mergeFeed(first.delta!.events, prev));
        spatial.setOutstanding(first.outstanding);
        advanceTo(first.revision);
      }
      void spatial.refetch();

      cleanup = connectRealtime(established.token, {
        onWelcome(welcome) {
          // The server broadcasts only live commits: a welcome ahead of the
          // page means missed events — fetch them, don't skip them.
          if (welcome.revision > lastSeenRevision.current) {
            void catchUp();
            void spatial.refetch();
          }
        },
        onEvents(newRevision, events) {
          setFeed((prev) => mergeFeed(events, prev));
          advanceTo(newRevision);
          // Any commit can change eligibility/proposals/scope — the store
          // coalesces bursts into one fetch.
          void spatial.refetch();
        },
        onConfirmation(grant) {
          spatial.putConfirmation(
            grant.kind,
            grant.subjectId,
            grant.nonce,
            grant.expiresInMs,
          );
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

  const run = useCallback(
    async (type: string, input: Record<string, unknown>): Promise<CommandEnvelope> => {
      const result = (await submitCommand(type, {
        // The ref, not render-time state: a WS event between paint and click
        // must not send a stale baseRevision. A tool caller's own baseRevision
        // (spread after) wins — agents carry revision discipline themselves.
        baseRevision: lastSeenRevision.current,
        ...input,
      })) as CommandEnvelope;
      if (result.ok && result.revision !== undefined) {
        lastSeenRevision.current = Math.max(
          lastSeenRevision.current,
          result.revision,
        );
        setRevision(lastSeenRevision.current);
        setLastResult({ text: result.effect ?? "Done.", kind: "ok" });
        spatial.setOutstanding(result.outstanding);
        void spatial.refetch();
      } else if (!result.ok) {
        setLastResult({
          text: `${result.error?.message ?? result.error?.code ?? "Something went wrong."}`,
          kind: "error",
        });
        // Stale base without a live WS would strand every later click on the
        // same revision — pull the delta and advance now.
        if (result.error?.code === "sync_required") {
          await catchUpRef.current?.();
        }
      }
      return result;
    },
    [],
  );

  // Tool callbacks dispatch through the exact same runner (one command model).
  useEffect(() => {
    registerCommandRunner(run);
  }, [run]);

  // Toast auto-dismiss.
  useEffect(() => {
    if (!lastResult) return;
    const t = setTimeout(() => setLastResult(null), 8000);
    return () => clearTimeout(t);
  }, [lastResult]);

  const rawContext = spatialState.context;
  // A room can exist without a spatial scope (bare negotiation fixtures);
  // the map and scope-dependent chrome simply stay off in that case.
  const context = rawContext?.scope?.area?.center ? rawContext : null;
  const requirements = useMemo(() => requirementsFromFeed(feed), [feed]);
  const candidateName = useCallback(
    (candidateId: string) =>
      context?.candidates.find((c) => c.candidateId === candidateId)?.name ?? candidateId,
    [context],
  );

  if (!session) {
    return (
      <div className="connect-screen">
        <Wordmark />
        <span>Connecting…</span>
      </div>
    );
  }
  if (!session.identity) {
    return (
      <div className="connect-screen">
        <Wordmark />
        <p role="alert">{session.error}</p>
      </div>
    );
  }

  const id = session.identity;
  const isOrganizer = id.role === "organizer";
  const committedId =
    context?.agreement?.candidateId ??
    context?.proposals.find((p) => p.status === "committed")?.candidateId ??
    null;
  const selected = context?.candidates.find(
    (c) => c.candidateId === spatialState.selectedId,
  );
  const decisionsCount =
    spatialState.outstanding.filter((i) => i.type === "adjustment_request").length +
    (context
      ? context.proposals.filter((p) => p.status === "open" && !p.ownStance).length
      : 0) +
    (context && isOrganizer
      ? context.proposals.filter((p) => p.status === "staged").length
      : 0);
  const feasibility = context ? FEASIBILITY_CHIP[context.feasibility.state] : null;
  const total = context ? context.candidates.length : 0;

  return (
    <div className="app">
      {staleBanner && (
        <div className="stale-banner" role="alert">
          Protocol updated —{" "}
          <button onClick={() => window.location.reload()}>tap to refresh</button>
        </div>
      )}
      <header className="header">
        <Wordmark />
        {context && (
          <span className="header-goal">
            {context.scope.category} · Berlin Mitte
          </span>
        )}
        {context && (
          <span className="chip chip-phase" data-testid="phase-chip">
            {context.phase}
          </span>
        )}
        {context && feasibility && (
          <span
            className={`chip ${feasibility.className}`}
            data-testid="feasibility-chip"
          >
            {feasibility.label(context.feasibility.eligible, total)}
          </span>
        )}
        <div className="header-right">
          <span>
            <span className="identity-name" data-testid="display-name">
              {id.displayName}
            </span>{" "}
            <span className="identity-role" data-testid="role">
              {id.role}
            </span>
          </span>
          <button
            className="ready-toggle"
            data-testid="toggle-ready"
            data-ready={ready}
            onClick={() => {
              const next = !ready;
              setReady(next);
              void run("SetReadyState", { state: next ? "ready" : "contributing" });
            }}
          >
            {ready ? "✓ Ready" : "I'm done adding"}
          </button>
        </div>
      </header>

      {(context?.phase === "agreed" || context?.phase === "arrival") && committedId && (
        <ArrivalBanner
          destinationName={candidateName(committedId)}
          arrival={context.arrival}
          run={run}
        />
      )}

      <main className="app-main">
        <section className="map-column">
          {context ? (
            <MapView
              context={context}
              selectedId={spatialState.selectedId}
              focusNonce={spatialState.focusNonce}
              committedId={committedId}
              onSelect={(cid) => spatial.select(cid)}
            />
          ) : (
            <div className="map-region" data-testid="map-region">
              <div className="connect-screen">Loading the shared map…</div>
            </div>
          )}
          {context && selected && (
            <CandidateSheet
              candidate={selected}
              proposal={context.proposals.find(
                (p) =>
                  p.candidateId === selected.candidateId &&
                  p.status !== "withdrawn",
              )}
              phase={context.phase}
              onClose={() => spatial.select(null)}
              run={run}
            />
          )}
        </section>

        <section className="panel-region">
          {context?.impasse?.active && (
            <div className="impasse-banner" data-testid="impasse-banner" role="status">
              <strong>Impasse.</strong> No option satisfies every confirmed need. The
              council is privately checking possible adjustments.
            </div>
          )}
          <div className="tabs" role="tablist">
            <button
              className="tab"
              role="tab"
              aria-selected={tab === "needs"}
              data-testid="tab-needs"
              onClick={() => setTab("needs")}
            >
              Needs
            </button>
            <button
              className="tab"
              role="tab"
              aria-selected={tab === "activity"}
              data-testid="tab-activity"
              onClick={() => setTab("activity")}
            >
              Activity
            </button>
            <button
              className="tab"
              role="tab"
              aria-selected={tab === "decisions"}
              data-testid="tab-decisions"
              onClick={() => setTab("decisions")}
            >
              Decisions
              {decisionsCount > 0 && <span className="tab-badge">{decisionsCount}</span>}
            </button>
          </div>
          <div className="panel-body">
            <div hidden={tab !== "needs"}>
              <RequirementsPanel
                requirements={requirements}
                ownDisplayName={id.displayName}
                phase={context?.phase ?? "gathering"}
                run={run}
              />
            </div>
            <div hidden={tab !== "activity"}>
              <ul className="feed-list" data-testid="feed">
                {feed.map((line) => (
                  <li
                    className="feed-item"
                    key={`${line.revision}-${line.type}`}
                    data-level={line.level}
                  >
                    <span className="feed-rev">#{line.revision}</span>
                    <span className="feed-text">{line.text}</span>
                  </li>
                ))}
              </ul>
              {feed.length === 0 && (
                <p className="empty-note">Quiet so far — the room's story lands here.</p>
              )}
            </div>
            <div hidden={tab !== "decisions"}>
              {context ? (
                <DecisionsPanel
                  context={context}
                  outstanding={spatialState.outstanding}
                  isOrganizer={isOrganizer}
                  candidateName={candidateName}
                  onSelectCandidate={(cid) => spatial.focus(cid)}
                  run={run}
                />
              ) : (
                <p className="empty-note">Waiting for the shared map…</p>
              )}
            </div>
          </div>
        </section>
      </main>

      {lastResult && (
        <div className="toast" data-kind={lastResult.kind} role="status" data-testid="last-result">
          {lastResult.text}
        </div>
      )}

      <details
        className="dev-tools"
        data-testid="diagnostics"
        // Test lanes (?shim=webmcp) read identity/build/protocol values from
        // here; keep it expanded there so assertions see visible text.
        open={
          new URLSearchParams(window.location.search).has("shim") || undefined
        }
      >
        <summary>Session details &amp; diagnostics</summary>
        <div>
          participant <code data-testid="participant-id">{id.participantId}</code> · room{" "}
          <code data-testid="room-id">{id.roomId}</code> · revision{" "}
          <strong data-testid="revision">{revision}</strong> · build{" "}
          <code data-testid="build-id">{diag.buildId ?? "…"}</code> · contract v
          <span data-testid="contract-version">{TOOL_CONTRACT_VERSION}</span> ·{" "}
          <code data-testid="protocols">
            negotiation/{PROTOCOL_VERSIONS.negotiation} {PROTOCOL_VERSIONS.domain}
          </code>
        </div>
        <div className="actions">
          <button
            className="btn"
            data-testid="submit-shared"
            onClick={() =>
              void run("SubmitRequirement", {
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
            Require vegetarian (shared)
          </button>
          <button
            className="btn"
            data-testid="submit-private"
            onClick={() =>
              void run("SubmitRequirement", {
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
            Private budget €18
          </button>
          <button
            className="btn"
            data-testid="declare-agent-private"
            onClick={() =>
              void run("SubmitRequirement", {
                visibility: "agent-private",
                hardness: "hard",
                delegation: { mode: "approval_required" },
                scopeHint: { affects: "candidate-eligibility" },
              })
            }
          >
            Declare agent-private
          </button>
        </div>
        <ul>
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
        <pre data-testid="diag-log">{diag.lines.join("\n")}</pre>
      </details>
    </div>
  );
}
