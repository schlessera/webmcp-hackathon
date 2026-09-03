import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ProjectedEvent } from "@webmcp-hackathon/contracts";
import { newIdempotencyKey, submitCommand, syncSession } from "./api.ts";
import {
  clearSession,
  establishSession,
  inviteSecretFromFragment,
  type SessionState,
} from "./session.ts";
import {
  connectRealtime,
  fetchPageBuild,
  hasRevisionGap,
} from "./ws-client.ts";
import { diagnostics } from "./diagnostics-store.ts";
import { registerCommandRunner, spatial } from "./spatial-store.ts";
import type {
  ActiveNeed,
  CommandEnvelope,
  OutstandingAdjustment,
  OutstandingItem,
} from "./spatial-types.ts";
import { COPY, numberWord, stillWorkVerb } from "./ui/copy.ts";
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
import { Landing } from "./components/Landing.tsx";
import { provenanceLine } from "./ui/copy.ts";
import { RevisionWatermarks } from "./revision-watermarks.ts";
import { mergeFeed, type FeedLine } from "./feed.ts";
import {
  shouldSendSharedPosition,
  type SentPosition,
} from "./origin-sharing.ts";

/**
 * The room is the whole app: one screen, no nav bar, no tab bar, no
 * hamburger (CLAUDE.md §11). Header, map and composer are fixed; only the
 * brief scrolls. Everything protocol-shaped lives behind `{ }`.
 */

/** Events that state a need, newest first — the "just applied" highlight. */
const NEED_EVENTS = new Set([
  "requirement_submitted",
  "requirement_updated",
  "private_requirement_declared",
]);

const lastSeenKey = (roomId: string) => `spokes:lastSeen:${roomId}`;

/** Command failures are also tool results. Keep the precise wire wording for
 * agents and the drawer, but never let it leak into the reader-facing alert. */
function readerFacingError(error: CommandEnvelope["error"]): string {
  if (!error) return "Something went wrong. Try again.";
  const wireWords =
    /\b(?:refs?|snapshot|explore layer|endpoints?|commands?|session|revisions?|baseRevision|candidateIds?|requirementIds?|proposalIds?|payload|phase|scope|stances?|visibility|protocol|versions?|sync_session|get_spatial_context)\b/i;
  const commandName = /\b[A-Z][a-z]+(?:[A-Z][A-Za-z]+)+\b/;
  if (!wireWords.test(error.message) && !commandName.test(error.message)) {
    return error.message;
  }
  switch (error.code) {
    case "not_authenticated":
      return "This room is still connecting. Try again in a moment.";
    case "not_authorized":
      return "You can’t make that change in this room.";
    case "not_found":
      return "That item is no longer available. Refresh the page and try again.";
    case "phase_unavailable":
      return "That action isn’t available at this point in the room.";
    case "sync_required":
      return "The room changed while you were acting. Try again.";
    default:
      return "That change couldn’t be applied. Check it and try again.";
  }
}

/** Events after which this participant's outstanding list may have changed. */
const OUTSTANDING_EVENTS = new Set([
  "adjustment_proposed",
  "adjustment_grant_staged",
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

/**
 * The front door keys on the hash, re-read on every hashchange and popstate:
 * `#invite=` is a room, `#start` is the area picker, anything else is the
 * landing page. A room is rendered only while its invite is in the hash, so
 * Back from a freshly opened room returns to the picker and then to the
 * landing instead of leaving the room mounted under a stale URL. An agent
 * surface flag (`?surface=`) without an invite keeps going straight to the
 * picker. Decided before the session resolves so the first paint is the
 * page, not a splash.
 */
type Door = "room" | "start" | "landing";
function frontDoor(): Door {
  if (inviteSecretFromFragment()) return "room";
  if (window.location.hash === "#start") return "start";
  if (new URLSearchParams(window.location.search).has("surface")) return "start";
  return "landing";
}

export function App() {
  const [session, setSession] = useState<SessionState | null>(null);
  const [door, setDoor] = useState<Door>(frontDoor);
  useEffect(() => {
    const onNav = () => setDoor(frontDoor());
    window.addEventListener("hashchange", onNav);
    window.addEventListener("popstate", onNav);
    return () => {
      window.removeEventListener("hashchange", onNav);
      window.removeEventListener("popstate", onNav);
    };
  }, []);
  const [revision, setRevision] = useState<number>(0);
  const [feed, setFeed] = useState<FeedLine[]>([]);
  const [staleBanner, setStaleBanner] = useState(false);
  // Offline (COPY.md): after 10 s without a socket, say what the map is as
  // of. The line leaves on its own the moment the socket is back.
  const [offlineSince, setOfflineSince] = useState<Date | null>(null);
  const [errorLine, setErrorLine] = useState<string | null>(null);
  const [originEditing, setOriginEditing] = useState(false);
  const [originAnnouncement, setOriginAnnouncement] = useState("");
  const pendingOrigin = useRef<{ before: number; revision: number } | null>(null);
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
  useEffect(() => {
    const report = () => diagnostics.update({ online: navigator.onLine });
    window.addEventListener("online", report);
    window.addEventListener("offline", report);
    report();
    return () => {
      window.removeEventListener("online", report);
      window.removeEventListener("offline", report);
    };
  }, []);
  /* Three ways to learn the link is down, and the line shows from whichever
     fires first: the browser says offline (at once), the socket has been
     silent for ten seconds while claiming open (ws-client), or the socket is
     closed and has not come back within ten seconds. Any frame or a reopened
     socket takes the line away. */
  const linkDown = !diag.online || diag.wsStale || diag.wsState !== "open";
  const linkDownNow = !diag.online || diag.wsStale;
  useEffect(() => {
    if (!linkDown) {
      setOfflineSince(null);
      return;
    }
    const droppedAt = new Date();
    if (linkDownNow) {
      setOfflineSince((current) => current ?? droppedAt);
      return;
    }
    const timer = window.setTimeout(
      () => setOfflineSince((current) => current ?? droppedAt),
      10_000,
    );
    return () => window.clearTimeout(timer);
  }, [linkDown, linkDownNow]);

  const spatialState = useSyncExternalStore(
    (cb) => spatial.subscribe(cb),
    () => spatial.state,
  );

  // R5: command results prove room state, not event delivery. Only WS frames
  // and fully consumed delta pages advance projectedThroughRevision.
  const revisionWatermarks = useRef(new RevisionWatermarks()).current;
  const catchUpRef = useRef<(() => Promise<unknown>) | null>(null);
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
      let probedRevision = 0;
      if (established.token) {
        const probe = (await syncSession()) as {
          ok: boolean;
          revision?: number;
          error?: { code: string };
          lastSyncedRevision?: number | null;
        };
        if (cancelled) return;
        if (probe.ok) {
          serverSeen = probe.lastSyncedRevision ?? null;
          probedRevision = probe.revision ?? 0;
        }
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

      const advanceKnownTo = (newRevision: number) => {
        setRevision(revisionWatermarks.observeRoom(newRevision));
      };

      const advanceProjectionTo = (newRevision: number) => {
        const through = revisionWatermarks.consumeProjection(newRevision);
        writeLastSeen(roomId, through);
        setRevision(revisionWatermarks.knownRoomRevision);
      };

      const previouslySeen = Math.max(tabSeen, serverSeen ?? 0);
      const wasHere = tabSeen > 0 || serverSeen !== null;
      // R5: serverSeen may have been advanced by an agent or another tab. It
      // informs the away digest, but only this tab's persisted projection is
      // proof that this page consumed event frames.
      revisionWatermarks.reset(
        tabSeen,
        Math.max(previouslySeen, probedRevision),
      );
      setRevision(revisionWatermarks.knownRoomRevision);

      /** Pull the delta for events this page missed (disconnects, races).
       * Revision 0 is a legitimate sinceRevision (freshly seeded room).
       * The floor is captured BEFORE the await: a live event arriving during
       * the round-trip advances the ref, and filtering against the moved ref
       * would silently drop the very events this fetch went out for
       * (mergeFeed dedups any overlap). */
      let catchUpInFlight: Promise<{
        revision: number;
        lastSyncedRevision?: number | null;
      } | null> | null = null;
      const catchUp = () => {
        if (catchUpInFlight) return catchUpInFlight;
        catchUpInFlight = (async () => {
          let firstPage: {
            revision: number;
            lastSyncedRevision?: number | null;
          } | null = null;
          let cursor: string | undefined;
          // R1: continuation moves this local stored-event cursor. The page's
          // durable projection watermark is committed only after every page
          // through a room head has been consumed.
          let consumedThrough = revisionWatermarks.projectedThroughRevision;
          for (;;) {
            const since = consumedThrough;
            const sync = (await syncSession(
              cursor ? undefined : since,
              cursor,
            )) as {
              ok: boolean;
              revision?: number;
              delta?: {
                events: ProjectedEvent[];
                truncated: boolean;
                cursor?: string;
                throughRevision?: number;
                resyncRequired?: "backlog_too_large";
              };
              outstanding?: OutstandingItem[];
              lastSyncedRevision?: number | null;
            };
            if (!sync.ok || sync.revision === undefined || cancelled) return null;
            firstPage ??= {
              revision: sync.revision,
              lastSyncedRevision: sync.lastSyncedRevision,
            };
            advanceKnownTo(sync.revision);
            spatial.setOutstanding(sync.outstanding, sync.revision);
            if (!sync.delta) return firstPage;

            if (sync.delta.resyncRequired === "backlog_too_large") {
              // R1: this is an explicit loss of incremental history. Replace
              // the projection at the named room revision before moving the
              // consumed watermark; never silently jump over omitted events.
              diagnostics.log("sync backlog too large — replacing full projection");
              const context = await spatial.refetch(sync.revision);
              if (context && context.revision >= sync.revision) {
                setFeed([]);
                advanceProjectionTo(sync.revision);
              }
              return firstPage;
            }

            const fresh = sync.delta.events.filter(
              (e) => e.revision > revisionWatermarks.projectedThroughRevision,
            );
            if (fresh.length) setFeed((prev) => mergeFeed(fresh, prev));
            if (sync.delta.throughRevision !== undefined) {
              consumedThrough = Math.max(
                consumedThrough,
                sync.delta.throughRevision,
              );
            } else if (!sync.delta.truncated) {
              // Additive deployment compatibility: the old untruncated shape
              // represented the complete interval through sync.revision.
              consumedThrough = Math.max(consumedThrough, sync.revision);
            }
            if (sync.delta.truncated) {
              if (!sync.delta.cursor) {
                // Compatibility with a server that can report truncation but
                // cannot continue: retain the old watermark and retry later.
                diagnostics.log("sync delta truncated without a cursor");
                return firstPage;
              }
              cursor = sync.delta.cursor;
              continue;
            }
            cursor = undefined;
            if (consumedThrough < sync.revision) continue;
            advanceProjectionTo(consumedThrough);
            return firstPage;
          }
        })().finally(() => {
          catchUpInFlight = null;
        });
        return catchUpInFlight;
      };

      catchUpRef.current = catchUp;

      const first = await catchUp();
      if (cancelled) return;
      if (first) {
        // Seen revision 0 (an empty room) is a real floor; never-seen is not.
        if (wasHere && first.revision > previouslySeen) {
          setAway({ since: previouslySeen, until: first.revision });
        }
      }
      void spatial.refetch(revisionWatermarks.knownRoomRevision);

      realtime = connectRealtime(established.token, {
        onWelcome(welcome) {
          // R5: always catch up from the projection watermark. Equality with
          // the HTTP-known room revision does not prove its event frame landed.
          advanceKnownTo(welcome.revision);
          void catchUp();
          void spatial.refetch(welcome.revision);
        },
        onEvents(newRevision, events, fromRevision) {
          advanceKnownTo(newRevision);
          if (
            hasRevisionGap(
              revisionWatermarks.projectedThroughRevision,
              fromRevision,
            )
          ) {
            // R10: do not render across a hole or reordered frame. Paginated
            // sync is the one path that can prove every stored revision was
            // consumed, including viewer-omitted private events.
            diagnostics.log(
              `ws revision gap: projected ${revisionWatermarks.projectedThroughRevision}, frame from ${fromRevision}`,
            );
            void catchUp();
            void spatial.refetch(newRevision);
            return;
          }
          const fresh = events.filter(
            (e) => e.revision > revisionWatermarks.projectedThroughRevision,
          );
          if (fresh.length) setFeed((prev) => mergeFeed(fresh, prev));
          advanceProjectionTo(newRevision);
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
        onPresence(_present, viewing, positions) {
          // The roster is server truth; presence rides on it. Who has which
          // place open and opted-in live positions land as one ephemeral frame.
          spatial.setPresence(viewing, positions);
          void spatial.refetch();
        },
        onLookups(pending, reason) {
          // Presentation only: rings on the dots, a line in the panel.
          spatial.setLookups(pending, reason);
        },
        onFacts(ids) {
          // Facts changed without a commit: the counts may have moved and an
          // open panel may be looking at one of these places.
          spatial.noteFacts(ids);
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

  // A need this page said becomes real when the context first shows it: the
  // newest own need ids this tab has not seen bind to the pending rows, in
  // order. The first context seeds the set — nothing at boot is "just said".
  const seenNeedIds = useRef<Set<string> | null>(null);
  useEffect(() => {
    const ctx = spatialState.context;
    if (!ctx || !session?.identity) return;
    const own = ctx.activeNeeds
      .filter((n) => n.ownerId === session.identity!.participantId)
      .map((n) => n.id);
    if (seenNeedIds.current === null) {
      seenNeedIds.current = new Set(own);
      return;
    }
    const fresh = own.filter((id) => !seenNeedIds.current!.has(id));
    if (fresh.length === 0) return;
    // The commit's realtime event can bring the context before the HTTP
    // response marks the row committed. An id is burnt only once a row took
    // it, or when no row is still waiting to hear back — otherwise it stays
    // fresh for the next pass, which runs when the commit lands.
    const bound = new Set(spatial.bindPendingNeeds(fresh));
    for (const id of fresh) {
      if (bound.has(id) || !spatial.awaitingCommit) seenNeedIds.current.add(id);
    }
  }, [spatialState.context, spatialState.pendingNeeds, session]);

  const run = useCallback(
    async (
      type: string,
      input: Record<string, unknown>,
      signal?: AbortSignal,
      retried = false,
      idempotencyKey = newIdempotencyKey(),
    ): Promise<CommandEnvelope> => {
      const requestedArea = input.area as
        | { center?: { lat?: unknown; lng?: unknown } }
        | undefined;
      const requestedCenter =
        type === "SetSearchScope" &&
        typeof requestedArea?.center?.lat === "number" &&
        typeof requestedArea.center.lng === "number"
          ? { lat: requestedArea.center.lat, lng: requestedArea.center.lng }
          : null;
      if (requestedCenter) spatial.noteLocalScopeCenter(requestedCenter);
      const result = (await submitCommand(type, {
        // The ref, not render-time state: a WS event between paint and click
        // must not send a stale baseRevision. A tool caller's own baseRevision
        // (spread after) wins — agents carry revision discipline themselves.
        baseRevision: revisionWatermarks.knownRoomRevision,
        ...input,
      }, signal, idempotencyKey)) as CommandEnvelope;
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
        // X3: catching up changes the HTTP attempt, not the user's logical
        // gesture. Reusing the key makes an ambiguous first outcome safe.
        return run(type, input, signal, true, idempotencyKey);
      }
      if (result.ok && result.revision !== undefined) {
        // R5: HTTP proves only the room head. projectedThroughRevision moves
        // later, when WS delivery or catch-up consumes the event.
        setRevision(revisionWatermarks.observeRoom(result.revision));
        setErrorLine(null);
        spatial.setOutstanding(result.outstanding, result.revision);
        // The first move of their own is the moment someone is back: the
        // digest has done its job and the header stops saying "away".
        setAway(null);
        void spatial.refetch(result.revision);
      } else if (!result.ok) {
        if (requestedCenter) spatial.clearLocalScopeCenter();
        // Only failures are surfaced. A success is visible in the map and the
        // count block; a toast celebrating it would be noise.
        setErrorLine(
          readerFacingError(result.error),
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

  useEffect(() => {
    const pending = pendingOrigin.current;
    if (!pending || !rawContext || rawContext.revision < pending.revision) return;
    const delta = rawContext.matching - pending.before;
    const signed = delta > 0 ? `, +${delta}` : delta < 0 ? `, −${Math.abs(delta)}` : "";
    setOriginAnnouncement(
      `Starting point updated. ${rawContext.matching} ${stillWorkVerb(rawContext.matching)}${signed}.`,
    );
    pendingOrigin.current = null;
  }, [rawContext]);

  const setOwnOrigin = useCallback(
    async (
      position: { lat: number; lng: number },
      source: "device" | "stated",
      label?: string,
      announce = true,
    ): Promise<boolean> => {
      const before = spatial.state.context?.matching ?? 0;
      if (announce) {
        pendingOrigin.current = { before, revision: Number.POSITIVE_INFINITY };
      }
      const result = await run("SetOrigin", {
        position,
        source,
        ...(label ? { label } : {}),
      });
      if (!result.ok || result.revision === undefined) {
        if (announce) pendingOrigin.current = null;
        return false;
      }
      if (announce) {
        pendingOrigin.current = { before, revision: result.revision };
      }
      return true;
    },
    [run],
  );

  const participantId = session?.identity?.participantId;
  const ownOrigin = rawContext?.participants.find(
    (participant) => participant.participantId === participantId,
  )?.origin;
  const sharingOwnPosition = participantId !== undefined &&
    spatialState.positions[participantId] !== undefined;
  const setOwnOriginRef = useRef(setOwnOrigin);
  setOwnOriginRef.current = setOwnOrigin;

  // Device positions are ephemeral on the wire but overwrite the same
  // owner-only origin row. The two independent gates keep writes to at most
  // one per five seconds and ignore movement below fifteen metres.
  useEffect(() => {
    if (
      !sharingOwnPosition ||
      ownOrigin?.source !== "device" ||
      typeof navigator === "undefined" ||
      !("geolocation" in navigator)
    ) return;
    let previous: SentPosition | null = {
      lat: ownOrigin.lat,
      lng: ownOrigin.lng,
      sentAt: Date.now(),
    };
    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        const next = {
          lat: position.coords.latitude,
          lng: position.coords.longitude,
        };
        const now = Date.now();
        if (!shouldSendSharedPosition(previous, next, now)) return;
        previous = { ...next, sentAt: now };
        void setOwnOriginRef.current(next, "device", "your location", false);
      },
      () => {},
      { enableHighAccuracy: true, maximumAge: 5_000, timeout: 10_000 },
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, [sharingOwnPosition, ownOrigin?.source]);

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

  if (door === "landing") {
    return (
      <Landing
        onStart={() => {
          window.location.hash = "start";
          setDoor("start");
        }}
      />
    );
  }
  if (door === "start") {
    return (
      <Start
        onOpen={(inviteSecret) => {
          clearSession();
          window.location.assign(`/#invite=${inviteSecret}`);
          window.location.reload();
        }}
        onBack={() => {
          // Clear `#start` without leaving a `#` behind, then render the
          // landing; a popstate from a real Back lands in the same handler.
          window.history.pushState(null, "", window.location.pathname + window.location.search);
          setDoor("landing");
        }}
      />
    );
  }
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
  const busySet = new Set(spatialState.busy);
  const pendingNeeds = spatialState.pendingNeeds;

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
  // Unknown is not failure (CLAUDE.md §4): while places are still unchecked
  // the room has not run out of options, it has run out of confirmed ones.
  const unchecked = context?.feasibility?.uncertain ?? 0;
  const subtitle: HeaderSubtitle = settled
    ? { text: `agreed by all ${numberWord(people)}`, tone: "works" }
    : impasse
      ? unchecked > 0
        ? { text: `nothing confirmed yet · ${unchecked} still to check`, tone: "unsure" }
        : { text: `nothing works for all ${numberWord(people)}`, tone: "unsure" }
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
      {offlineSince && !staleBanner && (
        <div className="stale-banner" data-tone="quiet" role="status" data-testid="offline-line">
          {COPY.offline(offlineSince)}
        </div>
      )}
      {staleBanner && (
        <div className="stale-banner" role="alert">
          {COPY.stale.replace(/ Reload to catch up\.$/, "")}{" "}
          <button onClick={() => window.location.reload()}>Reload to catch up</button>
        </div>
      )}

      <Header
        title={settled && committedId ? candidateName(committedId) : null}
        subtitle={subtitle}
        participants={participants}
        meId={id.participantId}
        originEditing={originEditing}
        onOriginEditingChange={setOriginEditing}
        onSetOrigin={setOwnOrigin}
        sharedPositionIds={new Set(Object.keys(spatialState.positions))}
        onSetOriginSharing={async (shared) => {
          const result = await run("SetOriginSharing", { shared });
          return result.ok;
        }}
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
              localScopeCenterKey={spatialState.localScopeCenterKey}
              committedId={committedId}
              proposedRadiusM={proposedRadiusM}
              viewing={spatialState.viewing}
              positions={spatialState.positions}
              participants={participants}
              meId={id.participantId}
              busy={busySet}
              busyReason={spatialState.busyReason}
              pendingCount={pendingNeeds.length}
              roomId={id.roomId}
              isOrganizer={isOrganizer}
              explore={spatialState.explore}
              exploreTruncated={spatialState.exploreTruncated}
              run={run}
              origin={me?.origin}
              originEditing={originEditing}
              onSetOrigin={(position) => setOwnOrigin(position, "stated")}
              onSelect={(cid) => spatial.select(cid)}
            />
          ) : (
            <div className="map-region" data-testid="map-region">
              <div className="connect-screen">Loading the shared map…</div>
            </div>
          )}
        </div>

        <div className="rail">
          <div
            className="brief"
            data-testid="brief"
            aria-busy={pendingNeeds.length > 0 || undefined}
          >
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
              pendingNeeds={pendingNeeds}
              busyCount={busySet.size}
              noPlaces={context !== null && context.candidates.length === 0}
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
              from={me?.origin ? { lat: me.origin.lat, lng: me.origin.lng } : undefined}
            />
          ) : (
            <Composer
              facets={context?.facets ?? []}
              activeNeeds={activeNeeds}
              placeCount={context?.total ?? 0}
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
            busy={busySet.has(selected.candidateId)}
            factsFrame={spatialState.facts}
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

      <div className="sr-only" data-testid="origin-announcement" aria-live="polite" aria-atomic="true">
        {originAnnouncement}
      </div>

      {drawerOpen && (
        <Drawer
          identity={id}
          diagnostics={diag}
          context={context}
          revision={revision}
          busy={spatialState.busy}
          busyReason={spatialState.busyReason}
          pendingNeeds={pendingNeeds}
          onClose={() => setDrawerOpen(false)}
          run={run}
        />
      )}
    </div>
  );
}
