import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ProjectedEvent } from "@webmcp-hackathon/contracts";
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
import type {
  ActiveNeed,
  CommandEnvelope,
  OutstandingAdjustment,
  OutstandingItem,
} from "./spatial-types.ts";
import { numberWord, stillWorkVerb } from "./ui/copy.ts";
import { Wordmark } from "./components/Wordmark.tsx";
import { Header, type HeaderSubtitle } from "./components/Header.tsx";
import { MapView } from "./components/MapView.tsx";
import {
  AgentReplies,
  Digest,
  History,
  NeedsSection,
  ReadyToggle,
  WaysOut,
} from "./components/Brief.tsx";
import { Composer } from "./components/Composer.tsx";
import { ConsentCards } from "./components/ConsentCards.tsx";
import { PlaceDetails } from "./components/PlaceDetails.tsx";
import { ArrivalBar } from "./components/ArrivalBar.tsx";
import { Drawer } from "./components/Drawer.tsx";
import { Start } from "./components/Start.tsx";
import { provenanceLine } from "./ui/copy.ts";

/**
 * The room is the whole app: one screen, no nav bar, no tab bar, no
 * hamburger (CLAUDE.md §11). Header, map and composer are fixed; only the
 * brief scrolls. Everything protocol-shaped lives behind `{ }`.
 */

interface FeedLine extends ProjectedEvent {}

/** Newest first, deduplicated by revision (live WS and catch-up can overlap). */
function mergeFeed(incoming: FeedLine[], prev: FeedLine[]): FeedLine[] {
  const seen = new Set<number>();
  return [...incoming, ...prev]
    .filter((e) => (seen.has(e.revision) ? false : (seen.add(e.revision), true)))
    .sort((a, b) => b.revision - a.revision)
    .slice(0, 40);
}

/** Events that state a need, newest first — the "just applied" highlight. */
const NEED_EVENTS = new Set([
  "requirement_submitted",
  "requirement_updated",
  "private_requirement_declared",
]);

const lastSeenKey = (roomId: string) => `spokes:lastSeen:${roomId}`;

/** Events after which this participant's outstanding list may have changed. */
const OUTSTANDING_EVENTS = new Set([
  "adjustment_proposed",
  "adjustment_resolved",
  "evaluation_requested",
  "impasse_detected",
  "impasse_resolved",
  "proposal_created",
  "proposal_withdrawn",
  "stance_submitted",
  "agreement_staged",
  "agreement_stage_aborted",
  "agreement_committed",
  "requirement_toggled",
  "requirement_withdrawn",
]);

function readLastSeen(roomId: string): number {
  try {
    return Number(sessionStorage.getItem(lastSeenKey(roomId)) ?? 0) || 0;
  } catch {
    return 0;
  }
}
function writeLastSeen(roomId: string, revision: number): void {
  try {
    sessionStorage.setItem(lastSeenKey(roomId), String(revision));
  } catch {
    /* private-mode surfaces simply never show a digest */
  }
}

export function App() {
  const [session, setSession] = useState<SessionState | null>(null);
  const [revision, setRevision] = useState<number>(0);
  const [feed, setFeed] = useState<FeedLine[]>([]);
  const [staleBanner, setStaleBanner] = useState(false);
  const [errorLine, setErrorLine] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(
    () => new URLSearchParams(window.location.search).has("shim"),
  );
  /** The revision span this tab missed: after what it last saw on a
   * previous visit, up to the room as found on this visit's first sync.
   * Bounded above so live events after the catch-up never read as "away". */
  const [away, setAway] = useState<{ since: number; until: number } | null>(null);

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
  const realtimeRef = useRef<{ setViewing(id: string | null): void } | null>(null);

  useEffect(() => {
    // Strict-Mode-safe: the flag cancels the in-flight async init of an
    // already-cleaned-up effect run so it never opens an untracked socket.
    let cancelled = false;
    let cleanup = () => {};
    let realtime: ReturnType<typeof connectRealtime> | null = null;
    (async () => {
      await fetchPageBuild();
      let established = await establishSession();
      if (cancelled) return;

      // A stored token can be dead (make demo-reset wipes the token table).
      // Probe it once; when the invite is still in the fragment, drop the
      // stale session and re-exchange instead of stranding the tab.
      // The server remembers the revision this person's previous sync had
      // seen (any tab, any surface); the FIRST contact of this page load is
      // the one that still reports it, since every sync stamps it afresh.
      let serverSeen: number | null = null;
      let probed = false;
      if (established.token) {
        probed = true;
        const probe = (await syncSession()) as {
          ok: boolean;
          error?: { code: string };
          lastSyncedRevision?: number | null;
        };
        if (cancelled) return;
        if (probe.ok) serverSeen = probe.lastSyncedRevision ?? null;
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
      if (!established.token || !established.identity) return;

      const roomId = established.identity.roomId;
      spatial.beginRoom(roomId);
      // Captured BEFORE the first advance overwrites it: this is what makes
      // "while you were away" a fact rather than a guess. The tab's own
      // floor can run ahead of the server's (live events advance it without
      // a sync), so the larger of the two is what this person has seen.
      const tabSeen = readLastSeen(roomId);

      const advanceTo = (newRevision: number) => {
        lastSeenRevision.current = Math.max(
          lastSeenRevision.current,
          newRevision,
        );
        setRevision(lastSeenRevision.current);
        writeLastSeen(roomId, lastSeenRevision.current);
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
        lastSyncedRevision?: number | null;
      };
      if (cancelled) return;
      if (first.ok && first.revision !== undefined) {
        if (first.delta) setFeed((prev) => mergeFeed(first.delta!.events, prev));
        spatial.setOutstanding(first.outstanding);
        // Only the first server contact of this load still reports the
        // previous value; the probe, when it ran, was that contact.
        const remembered =
          serverSeen !== null || probed ? serverSeen : (first.lastSyncedRevision ?? null);
        // Seen revision 0 (an empty room) is a real floor; never-seen is not.
        const wasHere = tabSeen > 0 || remembered !== null;
        const previouslySeen = Math.max(tabSeen, remembered ?? 0);
        if (wasHere && first.revision > previouslySeen) {
          setAway({ since: previouslySeen, until: first.revision });
        }
        advanceTo(first.revision);
      }
      void spatial.refetch();

      realtime = connectRealtime(established.token, {
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
          // What is pending for THIS person only travels on sync; a peer's
          // or the council's move can put a card on this page.
          if (events.some((e) => OUTSTANDING_EVENTS.has(e.type))) void catchUp();
        },
        onConfirmation(grant) {
          spatial.putConfirmation(
            grant.kind,
            grant.subjectId,
            grant.nonce,
            grant.expiresInMs,
          );
        },
        onPresence(_present, viewing) {
          // The roster is server truth; presence rides on it. Who has which
          // place open is page-local presence and lands in the store as is.
          spatial.setViewing(viewing);
          void spatial.refetch();
        },
        onLookups(pending) {
          spatial.setLookupPending(pending);
        },
        onFacts() {
          void spatial.refetch();
        },
        onStaleBundle() {
          setStaleBanner(true);
        },
      });
      realtimeRef.current = realtime;
      cleanup = () => realtime?.close();
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
      realtimeRef.current = null;
      cleanup();
    };
  }, []);

  // The place this page has open is presence the room may see (D4, extended):
  // peers draw this person's initials behind that place's name.
  useEffect(() => {
    realtimeRef.current?.setViewing(spatialState.selectedId);
  }, [spatialState.selectedId]);

  const run = useCallback(
    async (
      type: string,
      input: Record<string, unknown>,
      retried = false,
    ): Promise<CommandEnvelope> => {
      const result = (await submitCommand(type, {
        // The ref, not render-time state: a WS event between paint and click
        // must not send a stale baseRevision. A tool caller's own baseRevision
        // (spread after) wins — agents carry revision discipline themselves.
        baseRevision: lastSeenRevision.current,
        ...input,
      })) as CommandEnvelope;
      // A gesture that lost the race to someone else's commit is retried once
      // against the caught-up room: the person's intent ("works for me") does
      // not go stale the way an agent's plan does, and asking them to click
      // again would only teach them the button is flaky. Tool callers bring
      // their own baseRevision and get the honest sync_required instead.
      if (
        !result.ok &&
        result.error?.code === "sync_required" &&
        !retried &&
        !("baseRevision" in input)
      ) {
        await catchUpRef.current?.();
        return run(type, input, true);
      }
      if (result.ok && result.revision !== undefined) {
        lastSeenRevision.current = Math.max(
          lastSeenRevision.current,
          result.revision,
        );
        setRevision(lastSeenRevision.current);
        setErrorLine(null);
        spatial.setOutstanding(result.outstanding);
        // The first move of their own is the moment someone is back: the
        // digest has done its job and the header stops saying "away".
        setAway(null);
        void spatial.refetch();
      } else if (!result.ok) {
        // Only failures are surfaced. A success is visible in the map and the
        // count block; a toast celebrating it would be noise.
        setErrorLine(
          result.error?.message ?? result.error?.code ?? "Something went wrong.",
        );
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

  const rawContext = spatialState.context;
  // A room can exist without a spatial scope (bare negotiation fixtures);
  // the map and scope-dependent chrome simply stay off in that case.
  const context = rawContext?.scope?.area?.center ? rawContext : null;

  const candidateName = useCallback(
    (candidateId: string) =>
      context?.candidates.find((c) => c.candidateId === candidateId)?.name ??
      candidateId,
    [context],
  );

  /** The newest need this page has seen stated — drawn with the works border
   * for a moment so the row that just changed the count is findable. */
  const justAppliedId = useMemo(() => {
    for (const e of feed) {
      if (!NEED_EVENTS.has(e.type)) continue;
      const id = (e.payload as { requirementId?: string } | undefined)?.requirementId;
      return id ?? null;
    }
    return null;
  }, [feed]);

  const awayEvents = useMemo(
    () =>
      away
        ? feed.filter((e) => e.revision > away.since && e.revision <= away.until)
        : [],
    [feed, away],
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
    // No invite anywhere: this is someone arriving cold, so offer to open a
    // room. An invite that failed to exchange is still an error to show.
    if (!inviteSecretFromFragment()) {
      return (
        <Start
          onOpen={(inviteSecret) => {
            clearSession();
            window.location.assign(`/#invite=${inviteSecret}`);
            window.location.reload();
          }}
        />
      );
    }
    return (
      <div className="connect-screen">
        <Wordmark />
        <p role="alert">{session.error}</p>
      </div>
    );
  }

  const id = session.identity;
  const isOrganizer = id.role === "organizer";
  /* Settled means COMMITTED. `agreement` is also present while a proposal is
     merely staged (organizer consent pending), and that must not hide the
     composer or announce agreement. */
  const committedId =
    (context?.agreement?.status === "committed"
      ? context.agreement.candidateId
      : undefined) ??
    context?.proposals.find((p) => p.status === "committed")?.candidateId ??
    null;
  const selected = context?.candidates.find(
    (c) => c.candidateId === spatialState.selectedId,
  );
  const participants = context?.participants ?? [];
  const me = participants.find((p) => p.participantId === id.participantId);
  const activeNeeds = context?.activeNeeds ?? [];
  const settled = committedId !== null;
  const impasse = context?.impasse?.active === true;
  const shown = spatialState.preview ?? context;
  const matching = shown?.matching ?? 0;

  const proposedRadiusM = (() => {
    const widen = spatialState.outstanding.find(
      (i): i is OutstandingAdjustment =>
        i.type === "adjustment_request" &&
        (i.change as { dimension?: string }).dimension === "radius_m",
    );
    const to = widen ? Number((widen.change as { to?: unknown }).to) : NaN;
    return Number.isFinite(to) ? to : null;
  })();

  /* The subtitle is state, not metadata: the cheapest signal the room has for
     "where are we". Derived — never a hardcoded name, never a domain word.
     "In the room" counts the people who have actually opened it. */
  const people = participants.length;
  const here = participants.filter((p) => p.arrived).length;
  const absent = participants
    .filter((p) => !p.arrived && p.participantId !== id.participantId)
    .map((p) => p.displayName);
  const subtitle: HeaderSubtitle = settled
    ? { text: `agreed by all ${numberWord(people)}`, tone: "works" }
    : impasse
      ? { text: `nothing works for all ${numberWord(people)}`, tone: "unsure" }
      : awayEvents.length > 0
        ? { text: "you were away", tone: "quiet" }
        : here <= 1
          ? { text: "you're first here", tone: "quiet" }
          : activeNeeds.length === 0
            ? { text: `${numberWord(here)} in the room`, tone: "quiet" }
            : {
                text: `${numberWord(here)} in the room · ${matching} ${stillWorkVerb(matching)}`,
                tone: "quiet",
              };

  const toggleNeed = (need: ActiveNeed) =>
    void run("SetRequirementActive", {
      requirementId: need.id,
      active: !need.active,
    });

  return (
    <div className="app">
      {staleBanner && (
        <div className="stale-banner" role="alert">
          This room is running an older version.{" "}
          <button onClick={() => window.location.reload()}>Reload to catch up</button>
        </div>
      )}

      <Header
        title={settled && committedId ? candidateName(committedId) : null}
        subtitle={subtitle}
        participants={participants}
        onOpenDrawer={() => setDrawerOpen(true)}
      />

      <div className="app-body">
        <div className="map-column">
          {context ? (
            <MapView
              context={context}
              preview={spatialState.preview}
              selectedId={spatialState.selectedId}
              focusNonce={spatialState.focusNonce}
              committedId={committedId}
              proposedRadiusM={proposedRadiusM}
              viewing={spatialState.viewing}
              participants={participants}
              meId={id.participantId}
              roomId={id.roomId}
              isOrganizer={isOrganizer}
              explore={spatialState.explore}
              exploreTruncated={spatialState.exploreTruncated}
              lookupPending={spatialState.lookupPending}
              run={run}
              onSelect={(cid) => spatial.select(cid)}
            />
          ) : (
            <div className="map-region" data-testid="map-region">
              <div className="connect-screen">Loading the shared map…</div>
            </div>
          )}
        </div>

        <div className="rail">
          <div className="brief" data-testid="brief">
            {context && (
              <ConsentCards
                context={context}
                outstanding={spatialState.outstanding}
                isOrganizer={isOrganizer}
                candidateName={candidateName}
                onOpenCandidate={(cid) => spatial.focus(cid)}
                run={run}
                meId={id.participantId}
              />
            )}

            <AgentReplies
              replies={spatialState.agentReplies}
              onDismiss={(rid) => spatial.dismissAgentReply(rid)}
            />

            {context && impasse && (
              <WaysOut
                needs={activeNeeds}
                participants={participants}
                meId={id.participantId}
                onRelax={(n) =>
                  void run("SetRequirementActive", {
                    requirementId: n.id,
                    active: false,
                  })
                }
              />
            )}

            {awayEvents.length > 0 && (
              <Digest
                events={awayEvents}
                privateEffects={context?.privateEffects ?? []}
                participants={participants}
                meId={id.participantId}
              />
            )}

            {/* Once settled the record leads (mockup 7c); the needs it was
                built from follow. */}
            {settled && <History events={feed} meId={id.participantId} />}

            <NeedsSection
              needs={activeNeeds}
              privateEffects={context?.privateEffects ?? []}
              participants={participants}
              absent={absent}
              meId={id.participantId}
              justAppliedId={justAppliedId}
              previewNeedId={spatialState.previewNeedId}
              matching={matching}
              onToggle={toggleNeed}
              onHoldStart={(n) => spatial.startPreview(n.id)}
              onHoldEnd={() => spatial.endPreview()}
            />

            {!settled && (
              <ReadyToggle ready={me?.readyState === "ready"} run={run} />
            )}

            {context?.area && (
              <p className="brief-provenance" data-testid="provenance">
                {provenanceLine(context.area)}
              </p>
            )}
          </div>

          {settled && committedId ? (
            <ArrivalBar
              destinationName={candidateName(committedId)}
              arrival={context?.arrival}
              walkMin={
                context?.candidates.find((c) => c.candidateId === committedId)?.walkMin
              }
              run={run}
            />
          ) : (
            <Composer
              facets={context?.facets ?? []}
              activeNeeds={activeNeeds}
              disabled={!context}
              run={run}
            />
          )}
        </div>

        {context && selected && (
          <PlaceDetails
            candidate={selected}
            proposal={context.proposals.find(
              (p) => p.candidateId === selected.candidateId && p.status !== "withdrawn",
            )}
            activeNeeds={activeNeeds}
            privateEffects={context.privateEffects}
            participants={participants}
            meId={id.participantId}
            phase={context.phase}
            viewing={spatialState.viewing}
            onClose={() => spatial.select(null)}
            run={run}
          />
        )}
      </div>

      {errorLine && (
        <div className="error-line" role="alert" data-testid="last-result">
          {errorLine}
          <button onClick={() => setErrorLine(null)}>Dismiss</button>
        </div>
      )}

      {drawerOpen && (
        <Drawer
          identity={id}
          diagnostics={diag}
          context={context}
          revision={revision}
          onClose={() => setDrawerOpen(false)}
          run={run}
        />
      )}
    </div>
  );
}
